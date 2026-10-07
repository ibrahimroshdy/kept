// Which routes a personal token may call (step-6 plan T10, Q20; D63, D71, D180). The token's own
// column of the route catalogue: a route is **closed to tokens unless it is listed here**, as
// `'read'` (any token) or `'write'` (a read+write token only). Kept in one table, not on each
// route's options, so the whole surface a leaked token reaches is reviewable in one place, and
// the test (tokens/access.test.ts) checks every entry against the app's real routes and the
// "never" list below.
//
// The first wave (plan T10): things, places, search, history, meters and readings, labels (read),
// files' metadata (read), and undo of the token's own changes. Writes are the everyday ones a
// Shortcut or a script makes (add, edit, move, mark seen, a place, a reading); nothing that
// trashes, merges, converts, empties, reveals or claims is open to a token (D58, D124: the same
// line the MCP tools hold). A token reads only its own locations whatever the route says: RLS
// intersects them on every call (0070).

export type TokenAccess = 'none' | 'read' | 'write';

/** `METHOD url` → the access it grants. `url` is the route's pattern, as Fastify registers it. */
export const TOKEN_ROUTES: Readonly<Record<string, Exclude<TokenAccess, 'none'>>> = Object.freeze({
  // Locations: which ones the token reaches (its own, intersected).
  'GET /api/v1/locations': 'read',
  'GET /api/v1/locations/:id': 'read',
  // Things.
  'GET /api/v1/things': 'read',
  'GET /api/v1/things/:id': 'read',
  'GET /api/v1/things/:id/history': 'read',
  'GET /api/v1/things/:id/attachments': 'read',
  'GET /api/v1/things/:id/codes': 'read',
  'POST /api/v1/things': 'write',
  'PATCH /api/v1/things/:id': 'write',
  'POST /api/v1/things/:id/seen': 'write',
  'POST /api/v1/things/move': 'write',
  'POST /api/v1/things/move/preview': 'write',
  // Places.
  'GET /api/v1/locations/:locationId/places': 'read',
  'GET /api/v1/places/:id': 'read',
  'GET /api/v1/places/:id/contents': 'read',
  'GET /api/v1/places/:id/history': 'read',
  'GET /api/v1/places/:id/attachments': 'read',
  'GET /api/v1/places/:id/codes': 'read',
  'POST /api/v1/locations/:locationId/places': 'write',
  'PATCH /api/v1/places/:id': 'write',
  // Brands (2026-10-07, the maintainer's call): a script adding things can name their make. List,
  // read and create only; editing, deleting and merging stay with the app.
  'GET /api/v1/accounts/:accountId/brands': 'read',
  'GET /api/v1/brands/:id': 'read',
  'POST /api/v1/accounts/:accountId/brands': 'write',
  // Search, codes and the activity feed.
  'GET /api/v1/search': 'read',
  'GET /api/v1/codes/:code': 'read',
  'GET /api/v1/activity': 'read',
  // Meters and readings (the odometer Shortcut, D63, master plan 9.5).
  'GET /api/v1/meters/:id/readings': 'read',
  'GET /api/v1/meters/:id/series': 'read',
  'POST /api/v1/meters/:id/readings': 'write',
  'PATCH /api/v1/readings/:id': 'write',
  // Labels (read).
  'GET /api/v1/labels/summary': 'read',
  'GET /api/v1/labels/batches': 'read',
  'GET /api/v1/labels/batches/:id': 'read',
  // Files' metadata (read): never the bytes or a signed URL.
  'GET /api/v1/locations/:id/attachments': 'read',
  // Undo: a token undoes only its own changes (audit/undo.ts).
  'POST /api/v1/audit/:eventId/undo': 'write',
});

/**
 * Never open to a token, whatever the table says (D63, D71, D180; plan ground rules): sign-in,
 * the person's own settings and profile, tokens and OAuth grants, the assistant, AI keys and
 * providers, secret values, exports, admin, setup, invites, members and webhooks. The test fails
 * if an entry above matches one.
 */
export const NEVER_FOR_TOKENS: readonly RegExp[] = [
  /^\/api\/v1\/auth(\/|$)/,
  /^\/api\/v1\/me(\/|$)/,
  /^\/api\/v1\/tokens(\/|$)/,
  /^\/api\/v1\/connections(\/|$)/,
  /^\/api\/v1\/oauth(\/|$)/,
  /^\/api\/v1\/assistant(\/|$)/,
  /^\/api\/v1\/ai(\/|$)/,
  /\/secrets(\/|$)/,
  /\/exports?(\/|$)/,
  /^\/api\/v1\/admin(\/|$)/,
  /^\/api\/v1\/setup(\/|$)/,
  /\/invites(\/|$)/,
  /\/members(\/|$)/,
  /\/managed-accounts(\/|$)/,
  /\/webhooks(\/|$)/,
  /^\/mcp(\/|$)/,
];

/** The access a token has to a route (`HEAD` as its `GET`). */
export function tokenAccessOf(method: string, url: string): TokenAccess {
  const m = method === 'HEAD' ? 'GET' : method;
  if (NEVER_FOR_TOKENS.some((re) => re.test(url))) return 'none';
  return TOKEN_ROUTES[`${m} ${url}`] ?? 'none';
}
