import type { SquareErrorBody, SquareErrorResponse } from './types';

// Square API constants. Single source of truth — every Square call in this
// project goes through squareFetch().
const SQUARE_BASE_URL = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-10-16';

export class SquareApiError extends Error {
  readonly status: number;
  readonly category: string;
  readonly code: string;
  readonly detail: string;
  readonly errors: SquareErrorBody[];

  constructor(
    message: string,
    status: number,
    errors: SquareErrorBody[],
  ) {
    super(message);
    this.name = 'SquareApiError';
    this.status = status;
    this.errors = errors;
    const first = errors[0];
    this.category = first?.category ?? 'UNKNOWN';
    this.code = first?.code ?? 'UNKNOWN';
    this.detail = first?.detail ?? message;
  }
}

interface SquareFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

function getToken(): string {
  // Server-side guard. import.meta.env on the client has been stripped of
  // anything not prefixed PUBLIC_; SQUARE_ACCESS_TOKEN should never be there.
  // Belt-and-suspenders check:
  if (typeof window !== 'undefined') {
    throw new Error('Square client is server-only — refusing to read token in browser context.');
  }
  const token = import.meta.env.SQUARE_ACCESS_TOKEN;
  if (!token || typeof token !== 'string') {
    throw new Error(
      'SQUARE_ACCESS_TOKEN is not set. Add it to .env (local) or Vercel env vars (deploy).',
    );
  }
  return token;
}

function buildUrl(path: string, query?: SquareFetchOptions['query']): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, SQUARE_BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export async function squareFetch<T>(
  path: string,
  options: SquareFetchOptions = {},
): Promise<T> {
  const token = getToken();
  const url = buildUrl(path, options.query);
  const method = options.method ?? 'GET';

  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    signal: options.signal,
  };

  if (options.body !== undefined && method !== 'GET') {
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, init);
  const text = await res.text();

  if (!res.ok) {
    let errors: SquareErrorBody[] = [];
    try {
      const parsed = JSON.parse(text) as SquareErrorResponse;
      if (Array.isArray(parsed.errors)) errors = parsed.errors;
    } catch {
      errors = [
        {
          category: 'API_ERROR',
          code: 'NON_JSON_RESPONSE',
          detail: text.slice(0, 200),
        },
      ];
    }
    throw new SquareApiError(
      `Square ${method} ${path} → ${res.status}`,
      res.status,
      errors,
    );
  }

  if (!text) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new SquareApiError(
      `Square ${method} ${path} returned invalid JSON`,
      res.status,
      [
        {
          category: 'API_ERROR',
          code: 'INVALID_JSON',
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      ],
    );
  }
}
