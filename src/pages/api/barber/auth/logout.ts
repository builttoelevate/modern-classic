import type { APIRoute } from 'astro';
import { buildClearBarberSessionCookie } from '../../../../lib/auth/barberSession';

export const prerender = false;

export const POST: APIRoute = async () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildClearBarberSessionCookie(),
    },
  });
};
