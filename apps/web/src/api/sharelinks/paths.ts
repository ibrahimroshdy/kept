/**
 * Share links' paths (1.5, D233; `apps/server/src/sharelinks/routes.ts`): a location's links, one
 * link's revoke and preview, and the public page's API. A path the server names differently is
 * fixed here and nowhere else.
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const sharelinkPaths = {
  links: (locationId: string) => `${V1}/locations/${seg(locationId)}/share-links`,
  link: (id: string) => `${V1}/share-links/${seg(id)}`,
  preview: (id: string) => `${V1}/share-links/${seg(id)}/preview`,
  shared: (token: string) => `${V1}/shared/${seg(token)}`,
};

export const SHARELINK_METHODS: Record<keyof typeof sharelinkPaths, readonly string[]> = {
  links: ['GET', 'POST'],
  link: ['DELETE'],
  preview: ['GET'],
  shared: ['GET'],
};
