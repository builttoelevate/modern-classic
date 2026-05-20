// Phase 7 — unsubscribe / resubscribe handler.
//
// We render a small HTML confirmation page directly from this endpoint
// (rather than redirecting to /unsubscribe.astro) so that one-click
// unsubscribe (RFC 8058) works without a follow-up navigation. Gmail and
// Apple Mail honor List-Unsubscribe-Post: List-Unsubscribe=One-Click by
// POSTing to the URL — we accept POST as well as GET and treat them
// identically.
//
// Auth model: the token is itself the credential. No login required —
// CAN-SPAM mandates that unsubscribe must work without forcing a login or
// account creation.

import type { APIRoute } from 'astro';
import { verifyUnsubscribeToken } from '../../../lib/marketing/unsubscribeToken';
import {
  MARKETING_UNSUBSCRIBED_AT_KEY,
  REVIEW_REQUESTS_UNSUBSCRIBED_AT_KEY,
  setCustomAttribute,
} from '../../../lib/square/customAttributes';
import { SquareApiError } from '../../../lib/square/client';

export const prerender = false;

type Action = 'unsubscribe' | 'resubscribe';
type Scope = 'marketing' | 'review';

function parseScope(raw: string | null): Scope {
  return raw?.toLowerCase() === 'review' ? 'review' : 'marketing';
}

function attributeKeyFor(scope: Scope): string {
  return scope === 'review'
    ? REVIEW_REQUESTS_UNSUBSCRIBED_AT_KEY
    : MARKETING_UNSUBSCRIBED_AT_KEY;
}

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const COLORS = {
  bg: '#0b0a08',
  card: '#161311',
  border: '#2a2520',
  gold: '#c9a35c',
  goldLight: '#e6c785',
  text: '#f3ece0',
  textMuted: '#b0a695',
};

function pageShell(opts: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${opts.title} — Modern Classic Barbershop</title>
    <style>
      *,*::before,*::after{box-sizing:border-box}
      body{margin:0;background:${COLORS.bg};color:${COLORS.text};font-family:'Helvetica Neue',Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:2rem 1rem;}
      .card{width:min(32rem,100%);background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;padding:clamp(1.5rem,5vw,2.5rem);text-align:center;}
      .eyebrow{font-size:0.75rem;letter-spacing:0.2em;text-transform:uppercase;color:${COLORS.gold};margin-bottom:0.75rem;}
      h1{font-family:Georgia,'Times New Roman',serif;font-size:clamp(1.5rem,4.5vw,2rem);font-weight:400;margin:0 0 1rem;}
      p{color:${COLORS.textMuted};line-height:1.6;margin:0 0 1rem;}
      .actions{margin-top:1.5rem;}
      a.btn{display:inline-block;padding:0.85rem 1.4rem;background:${COLORS.gold};color:${COLORS.card};text-decoration:none;font-size:0.78rem;letter-spacing:0.16em;text-transform:uppercase;font-weight:700;border-radius:3px;}
      a.btn:hover{background:${COLORS.goldLight};}
      a.link{color:${COLORS.goldLight};text-decoration:underline;font-size:0.95rem;}
      footer{margin-top:1.75rem;font-size:0.78rem;color:${COLORS.textMuted};line-height:1.55;}
    </style>
  </head>
  <body>
    <main class="card">
      ${opts.body}
      <footer>
        Modern Classic Barbershop &amp; Shave Parlor<br />
        819 Linden Avenue · Zanesville, OH 43701
      </footer>
    </main>
  </body>
</html>`;
}

function renderError(message: string): string {
  return pageShell({
    title: 'Unsubscribe link is invalid',
    body: `
      <div class="eyebrow">Modern Classic</div>
      <h1>This link isn't valid</h1>
      <p>${message}</p>
      <p>If you'd like to unsubscribe but the link won't load, please reply to one of our emails and we'll handle it manually within a day.</p>
      <div class="actions">
        <a class="btn" href="https://mdrnclassic.com/">Back to Modern Classic</a>
      </div>
    `,
  });
}

function renderUnsubscribed(token: string, scope: Scope): string {
  const resubUrl =
    `/api/marketing/unsubscribe?token=${encodeURIComponent(token)}` +
    `&action=resubscribe&scope=${scope}`;
  if (scope === 'review') {
    return pageShell({
      title: "You won't get review requests anymore",
      body: `
        <div class="eyebrow">Modern Classic</div>
        <h1>You won't get review requests anymore</h1>
        <p>We won't email you a "how'd we do?" request after your visits. Thanks for being a customer.</p>
        <p>You'll still get booking confirmations, sign-in links, and anything else you actively request — and you're not opted in to any marketing list either.</p>
        <div class="actions">
          <a class="link" href="${resubUrl}">I changed my mind — let me get review requests again</a>
        </div>
      `,
    });
  }
  return pageShell({
    title: "You've been unsubscribed",
    body: `
      <div class="eyebrow">Modern Classic</div>
      <h1>You've been unsubscribed</h1>
      <p>You won't receive any more marketing emails from Modern Classic Barbershop. Sorry to see you go — thanks for stopping by the shop.</p>
      <p>You'll still get transactional emails (booking confirmations, sign-in links, anything you actively requested).</p>
      <div class="actions">
        <a class="link" href="${resubUrl}">I changed my mind — resubscribe me</a>
      </div>
    `,
  });
}

function renderResubscribed(scope: Scope): string {
  if (scope === 'review') {
    return pageShell({
      title: "Review requests are back on",
      body: `
        <div class="eyebrow">Modern Classic</div>
        <h1>Review requests are back on</h1>
        <p>We'll send you the occasional post-visit "how'd we do?" email again. Thanks for the second chance.</p>
        <div class="actions">
          <a class="btn" href="https://mdrnclassic.com/">Back to Modern Classic</a>
        </div>
      `,
    });
  }
  return pageShell({
    title: "You're back on the list",
    body: `
      <div class="eyebrow">Modern Classic</div>
      <h1>Welcome back</h1>
      <p>You're resubscribed to Modern Classic marketing emails — the occasional offer, product launch, or shop update.</p>
      <div class="actions">
        <a class="btn" href="https://mdrnclassic.com/">Back to Modern Classic</a>
      </div>
    `,
  });
}

async function handle(request: Request): Promise<Response> {
  const secret = import.meta.env.UNSUBSCRIBE_SECRET;
  if (!secret) {
    return htmlResponse(
      renderError('Our unsubscribe system is temporarily misconfigured. Please email us at modernclassicbarbershop@protonmail.com.'),
      503,
    );
  }

  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  const actionParam = (url.searchParams.get('action') ?? 'unsubscribe').toLowerCase();
  const action: Action = actionParam === 'resubscribe' ? 'resubscribe' : 'unsubscribe';
  const scope: Scope = parseScope(url.searchParams.get('scope'));
  const attributeKey = attributeKeyFor(scope);

  if (!token) {
    return htmlResponse(renderError('No unsubscribe token was supplied.'), 400);
  }

  const verified = verifyUnsubscribeToken(token);
  if (!verified) {
    return htmlResponse(
      renderError("This unsubscribe link isn't valid. It may have been mistyped or tampered with."),
      400,
    );
  }

  try {
    if (action === 'unsubscribe') {
      await setCustomAttribute(
        verified.customerId,
        attributeKey,
        new Date().toISOString(),
      );
      logUnsub({ phase: 'unsubscribe', scope, customerId: verified.customerId });
      return htmlResponse(renderUnsubscribed(token, scope), 200);
    }
    await setCustomAttribute(verified.customerId, attributeKey, null);
    logUnsub({ phase: 'resubscribe', scope, customerId: verified.customerId });
    return htmlResponse(renderResubscribed(scope), 200);
  } catch (err) {
    const detail =
      err instanceof SquareApiError
        ? `${err.code}: ${err.detail}`
        : err instanceof Error
          ? err.message
          : 'Unknown error';
    logUnsub({ phase: 'error', customerId: verified.customerId, errorDetail: detail });
    return htmlResponse(
      renderError(
        "Something went wrong saving your preference. Please reply to any Modern Classic email and we'll handle it manually.",
      ),
      502,
    );
  }
}

function logUnsub(payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`[UNSUB] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}`);
}

export const GET: APIRoute = ({ request }) => handle(request);
export const POST: APIRoute = ({ request }) => handle(request);
