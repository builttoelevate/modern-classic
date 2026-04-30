import type { APIRoute } from 'astro';
import { getServices } from '../../../lib/square/catalog';
import { getLocation } from '../../../lib/square/locations';
import { getBarbers } from '../../../lib/square/team';
import { findCustomerByEmail } from '../../../lib/square/customers';
import { SquareApiError } from '../../../lib/square/client';

export const prerender = false;

interface HealthOk {
  ok: true;
  locationName: string;
  barberCount: number;
  serviceCount: number;
  scopesOk: boolean;
}

interface HealthFail {
  ok: false;
  error: { code: string; detail: string };
}

export const GET: APIRoute = async () => {
  try {
    const [location, barbers, services] = await Promise.all([
      getLocation(),
      getBarbers(),
      getServices(),
    ]);

    // Phase 4 D.4 — verify the customers scope by hitting /v2/customers/search
    // with a deliberately-not-present email. Empty result = scope OK; an
    // AUTHENTICATION_ERROR or 403 would indicate a missing scope.
    let scopesOk = true;
    try {
      await findCustomerByEmail('healthcheck-no-such-customer@modernclassicbarbershop.com');
    } catch (err) {
      if (err instanceof SquareApiError) scopesOk = false;
      else throw err;
    }

    const body: HealthOk = {
      ok: true,
      locationName: location.name,
      barberCount: barbers.length,
      serviceCount: services.length,
      scopesOk,
    };
    return Response.json(body, { status: 200 });
  } catch (err) {
    const code = err instanceof SquareApiError ? err.code : 'INTERNAL';
    const detail = err instanceof Error ? err.message : 'Unknown error';
    const body: HealthFail = { ok: false, error: { code, detail } };
    return Response.json(body, { status: 500 });
  }
};
