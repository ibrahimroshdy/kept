/**
 * Email-in's paths (1.4, D231; `apps/server/src/mailin/routes.ts`): a location's mailbox and its
 * connection check. A path the server names differently is fixed here and nowhere else.
 */

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export const mailinPaths = {
  mailbox: (locationId: string) => `${V1}/locations/${seg(locationId)}/mailbox`,
  mailboxCheck: (locationId: string) => `${V1}/locations/${seg(locationId)}/mailbox/check`,
};

export const MAILIN_METHODS: Record<keyof typeof mailinPaths, readonly string[]> = {
  mailbox: ['GET', 'PUT', 'DELETE'],
  mailboxCheck: ['POST'],
};
