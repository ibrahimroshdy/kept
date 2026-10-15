/**
 * The location map's paths (1.x, D237; `apps/server/src/map/routes.ts`).
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const mapPaths = {
  map: (locationId: string) => `${V1}/locations/${seg(locationId)}/map`,
  layout: (locationId: string) => `${V1}/locations/${seg(locationId)}/layout`,
};
