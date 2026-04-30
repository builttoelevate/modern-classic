import { squareFetch } from './client';
import type { ListLocationsResponse, Location } from './types';

export const MODERN_CLASSIC_LOCATION_ID = '523GMGEC1FY0Z';

export async function getLocation(): Promise<Location> {
  const res = await squareFetch<ListLocationsResponse>('/v2/locations');
  const match = res.locations?.find((l) => l.id === MODERN_CLASSIC_LOCATION_ID);
  if (!match) {
    throw new Error(
      `Modern Classic location (${MODERN_CLASSIC_LOCATION_ID}) not found in /v2/locations response.`,
    );
  }
  return match;
}
