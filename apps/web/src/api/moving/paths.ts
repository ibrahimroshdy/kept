/**
 * Moving mode's paths (1.x, D251; `apps/server/src/moving/routes.ts`, and the contents sheets' in
 * `apps/server/src/reports/routes.ts`). A path the server names differently is fixed here and
 * nowhere else.
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const movingPaths = {
  moves: `${V1}/moves`,
  move: (id: string) => `${V1}/moves/${seg(id)}`,
  locationMoves: (locationId: string) => `${V1}/locations/${seg(locationId)}/moves`,
  boxes: (id: string) => `${V1}/moves/${seg(id)}/boxes`,
  box: (id: string, containerId = id) => `${V1}/moves/${seg(id)}/boxes/${seg(containerId)}`,
  unpack: (id: string, containerId = id) =>
    `${V1}/moves/${seg(id)}/boxes/${seg(containerId)}/unpack`,
  boxOf: (containerId: string) => `${V1}/move-boxes/${seg(containerId)}`,
  sheets: `${V1}/reports/move`,
};

export const MOVING_METHODS: Record<keyof typeof movingPaths, readonly string[]> = {
  moves: ['GET'],
  move: ['GET', 'PATCH', 'DELETE'],
  locationMoves: ['POST'],
  boxes: ['POST'],
  box: ['PATCH', 'DELETE'],
  unpack: ['POST'],
  boxOf: ['GET'],
  sheets: ['POST'],
};
