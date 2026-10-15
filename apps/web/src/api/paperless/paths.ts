/**
 * Paperless-ngx's paths (1.x, D248; `apps/server/src/paperless/routes.ts`): a location's
 * connection, its status and search, and a thing's or place's links. A path the server names
 * differently is fixed here and nowhere else.
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const paperlessPaths = {
  connection: (locationId: string) => `${V1}/locations/${seg(locationId)}/paperless`,
  check: (locationId: string) => `${V1}/locations/${seg(locationId)}/paperless/check`,
  status: (locationId: string) => `${V1}/locations/${seg(locationId)}/paperless/status`,
  documents: (locationId: string) => `${V1}/locations/${seg(locationId)}/paperless/documents`,
  documentThumb: (locationId: string, documentId: number | string) =>
    `${V1}/locations/${seg(locationId)}/paperless/documents/${seg(String(documentId))}/thumb`,
  links: () => `${V1}/paperless-links`,
  link: (id: string) => `${V1}/paperless-links/${seg(id)}`,
  linkThumb: (id: string) => `${V1}/paperless-links/${seg(id)}/thumb`,
  linkPreview: (id: string) => `${V1}/paperless-links/${seg(id)}/preview`,
  linkCopy: (id: string) => `${V1}/paperless-links/${seg(id)}/copy`,
};

export const PAPERLESS_METHODS: Record<keyof typeof paperlessPaths, readonly string[]> = {
  connection: ['GET', 'PUT', 'DELETE'],
  check: ['POST'],
  status: ['GET'],
  documents: ['GET'],
  documentThumb: ['GET'],
  links: ['GET', 'POST'],
  link: ['DELETE'],
  linkThumb: ['GET'],
  linkPreview: ['GET'],
  linkCopy: ['POST'],
};
