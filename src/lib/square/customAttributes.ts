// Phase 7 — Square Customer Custom Attributes wrapper.
//
// Square's `email_unsubscribed` flag on Customer.preferences is READ-ONLY
// from the API — we cannot write to it. So we keep our own marketing
// consent state on the customer record via Custom Attributes:
//   - marketing_consent (boolean)         — opted-in via our booking flow
//   - marketing_consented_at (datetime)   — when they opted in
//   - marketing_consent_source (string)   — which surface (booking, etc.)
//   - marketing_unsubscribed_at (datetime, nullable)
//                                          — set when they click our
//                                            unsubscribe link, cleared on
//                                            resubscribe
//
// We also store per-customer rate-limit state for review-request emails
// here so that our cron stays idempotent even without the KV store
// (LAST_REVIEW_REQUEST_SENT_AT_KEY). Definitions are created once via
// /api/admin/init-custom-attributes; runtime calls just GET/PUT values.

import { squareFetch, SquareApiError } from './client';

export const MARKETING_CONSENT_KEY = 'marketing_consent';
export const MARKETING_CONSENTED_AT_KEY = 'marketing_consented_at';
export const MARKETING_CONSENT_SOURCE_KEY = 'marketing_consent_source';
export const MARKETING_UNSUBSCRIBED_AT_KEY = 'marketing_unsubscribed_at';
export const LAST_REVIEW_REQUEST_SENT_AT_KEY = 'last_review_request_sent_at';

export interface MarketingAttributes {
  consent: boolean;
  consentedAt: string | null;
  consentSource: string | null;
  unsubscribedAt: string | null;
  lastReviewRequestSentAt: string | null;
}

interface CustomAttributeDefinitionDescriptor {
  key: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  visibility: 'VISIBILITY_HIDDEN' | 'VISIBILITY_READ_ONLY' | 'VISIBILITY_READ_WRITE_VALUES';
}

// Square's Custom Attributes API expects a `$ref` to one of its built-in
// schemas with a dotted-path fragment (NOT JSON-pointer style). The host
// is `developer-production-s.squarecdn.com`.
const SQUARE_SCHEMA_REF =
  'https://developer-production-s.squarecdn.com/schemas/v1/common.json';
const BOOLEAN_SCHEMA = { $ref: `${SQUARE_SCHEMA_REF}#squareup.common.Boolean` };
const STRING_SCHEMA = { $ref: `${SQUARE_SCHEMA_REF}#squareup.common.String` };

const DEFINITIONS: CustomAttributeDefinitionDescriptor[] = [
  {
    key: MARKETING_CONSENT_KEY,
    name: 'Marketing consent',
    description:
      'True when this customer opted in to marketing emails (review requests, reminders, offers) on the website booking flow.',
    schema: BOOLEAN_SCHEMA,
    visibility: 'VISIBILITY_READ_WRITE_VALUES',
  },
  {
    key: MARKETING_CONSENTED_AT_KEY,
    name: 'Marketing consented at',
    description: 'ISO 8601 timestamp of when the customer opted in to marketing emails.',
    schema: STRING_SCHEMA,
    visibility: 'VISIBILITY_READ_WRITE_VALUES',
  },
  {
    key: MARKETING_CONSENT_SOURCE_KEY,
    name: 'Marketing consent source',
    description: 'Which surface captured the consent (e.g. booking_flow_step_4).',
    schema: STRING_SCHEMA,
    visibility: 'VISIBILITY_READ_WRITE_VALUES',
  },
  {
    key: MARKETING_UNSUBSCRIBED_AT_KEY,
    name: 'Marketing unsubscribed at',
    description:
      'ISO 8601 timestamp of when the customer unsubscribed from our marketing emails. Empty when they have not unsubscribed.',
    schema: STRING_SCHEMA,
    visibility: 'VISIBILITY_READ_WRITE_VALUES',
  },
  {
    key: LAST_REVIEW_REQUEST_SENT_AT_KEY,
    name: 'Last review request sent at',
    description:
      'ISO 8601 timestamp of the last automated review-request email sent. Used by the daily cron to enforce the per-customer cooldown.',
    schema: STRING_SCHEMA,
    visibility: 'VISIBILITY_READ_WRITE_VALUES',
  },
];

interface ListDefinitionsResponse {
  custom_attribute_definitions?: Array<{ key: string }>;
  cursor?: string;
}

interface CreateDefinitionResponse {
  custom_attribute_definition?: { key: string };
}

interface CustomAttributeValue {
  key?: string;
  value?: unknown;
}

interface RetrieveAttributeResponse {
  custom_attribute?: CustomAttributeValue;
}

interface ListAttributesResponse {
  custom_attributes?: CustomAttributeValue[];
  cursor?: string;
}

interface UpsertAttributeResponse {
  custom_attribute?: CustomAttributeValue;
}

export async function ensureCustomAttributeDefinitions(): Promise<{
  created: string[];
  existed: string[];
}> {
  const created: string[] = [];
  const existed: string[] = [];

  const existing = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await squareFetch<ListDefinitionsResponse>(
      '/v2/customers/custom-attribute-definitions',
      { query: { cursor, limit: 100 } },
    );
    for (const def of res.custom_attribute_definitions ?? []) {
      if (def.key) existing.add(def.key);
    }
    cursor = res.cursor;
  } while (cursor);

  for (const def of DEFINITIONS) {
    if (existing.has(def.key)) {
      existed.push(def.key);
      continue;
    }
    const res = await squareFetch<CreateDefinitionResponse>(
      '/v2/customers/custom-attribute-definitions',
      {
        method: 'POST',
        body: {
          custom_attribute_definition: {
            key: def.key,
            name: def.name,
            description: def.description,
            schema: def.schema,
            visibility: def.visibility,
          },
        },
      },
    );
    if (res.custom_attribute_definition?.key) {
      created.push(res.custom_attribute_definition.key);
    } else {
      created.push(def.key);
    }
  }

  return { created, existed };
}

export async function getCustomAttribute(
  customerId: string,
  key: string,
): Promise<string | boolean | null> {
  try {
    const res = await squareFetch<RetrieveAttributeResponse>(
      `/v2/customers/${customerId}/custom-attributes/${encodeURIComponent(key)}`,
    );
    return normalizeValue(res.custom_attribute?.value);
  } catch (err) {
    if (err instanceof SquareApiError && err.status === 404) return null;
    throw err;
  }
}

export async function setCustomAttribute(
  customerId: string,
  key: string,
  value: string | boolean | null,
): Promise<void> {
  if (value === null) {
    // Clearing the value — DELETE the attribute (definition stays).
    try {
      await squareFetch<unknown>(
        `/v2/customers/${customerId}/custom-attributes/${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
    } catch (err) {
      if (err instanceof SquareApiError && err.status === 404) return;
      throw err;
    }
    return;
  }
  await squareFetch<UpsertAttributeResponse>(
    `/v2/customers/${customerId}/custom-attributes/${encodeURIComponent(key)}`,
    {
      method: 'POST',
      body: {
        custom_attribute: { key, value },
      },
    },
  );
}

export async function getAllMarketingAttributes(
  customerId: string,
): Promise<MarketingAttributes> {
  const map = new Map<string, string | boolean | null>();
  let cursor: string | undefined;
  try {
    do {
      const res = await squareFetch<ListAttributesResponse>(
        `/v2/customers/${customerId}/custom-attributes`,
        { query: { cursor, limit: 100 } },
      );
      for (const attr of res.custom_attributes ?? []) {
        if (typeof attr.key === 'string') {
          map.set(attr.key, normalizeValue(attr.value));
        }
      }
      cursor = res.cursor;
    } while (cursor);
  } catch (err) {
    if (err instanceof SquareApiError && err.status === 404) {
      // Customer has no custom attributes set yet.
      return emptyMarketingAttributes();
    }
    throw err;
  }

  const consent = map.get(MARKETING_CONSENT_KEY);
  const consentedAt = map.get(MARKETING_CONSENTED_AT_KEY);
  const consentSource = map.get(MARKETING_CONSENT_SOURCE_KEY);
  const unsubscribedAt = map.get(MARKETING_UNSUBSCRIBED_AT_KEY);
  const lastReviewRequestSentAt = map.get(LAST_REVIEW_REQUEST_SENT_AT_KEY);

  return {
    consent: consent === true,
    consentedAt: stringOrNull(consentedAt),
    consentSource: stringOrNull(consentSource),
    unsubscribedAt: stringOrNull(unsubscribedAt),
    lastReviewRequestSentAt: stringOrNull(lastReviewRequestSentAt),
  };
}

function emptyMarketingAttributes(): MarketingAttributes {
  return {
    consent: false,
    consentedAt: null,
    consentSource: null,
    unsubscribedAt: null,
    lastReviewRequestSentAt: null,
  };
}

function normalizeValue(value: unknown): string | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function stringOrNull(value: string | boolean | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return null;
  return value;
}
