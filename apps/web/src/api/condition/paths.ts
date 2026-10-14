/**
 * Condition reports' paths (1.x, D235; `apps/server/src/condition/routes.ts`, and the PDF's in
 * `apps/server/src/reports/routes.ts`). A path the server names differently is fixed here and
 * nowhere else. A room's photos go through the attachment routes (inventoryPaths.attachments).
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const conditionPaths = {
  reports: `${V1}/condition-reports`,
  report: (id: string) => `${V1}/condition-reports/${seg(id)}`,
  locationReports: (locationId: string) => `${V1}/locations/${seg(locationId)}/condition-reports`,
  finish: (id: string) => `${V1}/condition-reports/${seg(id)}/finish`,
  rooms: (id: string) => `${V1}/condition-reports/${seg(id)}/rooms`,
  room: (id: string) => `${V1}/condition-rooms/${seg(id)}`,
  pdf: `${V1}/reports/condition`,
};

export const CONDITION_METHODS: Record<keyof typeof conditionPaths, readonly string[]> = {
  reports: ['GET'],
  report: ['GET', 'PATCH', 'DELETE'],
  locationReports: ['POST'],
  finish: ['POST'],
  rooms: ['POST'],
  room: ['PATCH', 'DELETE'],
  pdf: ['POST'],
};
