/**
 * The optional Homebox connection (D146; step-7 plan T11; spike H3,
 * docs/spikes/2026-09-30-step7-homebox.md). A Homebox export ZIP holds no version, no currency and
 * no members; a connection to the old server reads those three and nothing else. It is only ever
 * a prefill: the import itself reads the ZIP.
 *
 * The calls, exactly as H3 recorded them against v0.26.2 (unchanged in v0.27.0-rc.1):
 * - `GET /api/v1/status`, no auth → `build.version` ("v0.26.2");
 * - with a password, `POST /api/v1/users/login {username, password, stayLoggedIn: false}` once,
 *   for a session token (the spike's client, docs/spikes/code/step7/hb_client.py `login()`);
 * - `GET /api/v1/groups/all` → every collection the key's owner is in, `[{id, name, currency}]`;
 * - `GET /api/v1/groups/members` with `X-Tenant: <collection id>` → `[{id, name, email}]`, no
 *   roles (the report prefills each email and asks for a role, default member).
 * Each sends `Authorization: Bearer <key or token>`. The plan's per-collection `GET /groups` is
 * not called: `/groups/all` already carries each collection's currency (H3), in the same shape.
 *
 * - **Through the SSRF guard** (net/ssrf.ts `guardedFetch`): redirects refused, private addresses
 *   refused unless `instance_settings.ssrf_allow_private` (a Homebox on the LAN is the usual case,
 *   step-3 Q9; the 400 `private_address` hint names the admin's switch).
 * - **10 s for the whole connection**, answers read up to 1 MiB each.
 * - **The key, password and token are never stored, logged or audited** (D146). The route runs
 *   with no transaction open during the calls, and outside the Idempotency-Key store (which would
 *   keep a hash of the body); the audit row holds the host and the version only.
 * - A collection's currency comes back upper-case (H3); it is normalised anyway (the research saw
 *   `usd`). The ZIP's collection is `manifest.groupId` (H1), which inspection stores as
 *   `inspect.collections[0].id`: that collection is listed first and its members are read.
 *
 * Failures: an address that isn't http(s) is 400 `validation`; a private one 400
 * `private_address`; anything Homebox (or whatever answers) does wrong is 502
 * `homebox_unreachable`, with a hint that names what happened and never a credential.
 */
import type pg from 'pg';
import { z } from 'zod';
import { allowPrivateAddresses } from '../../ai/runtime.js';
import { audited } from '../../audit/audited.js';
import { requireScope } from '../../auth/http.js';
import { withScope } from '../../db/scope.js';
import type { KeptApp } from '../../http/app.js';
import { AppError, conflict, invalid, notFound } from '../../http/errors.js';
import type { InventoryDeps } from '../../http/routes.js';
import { guardedFetch, PrivateAddressError } from '../../net/ssrf.js';
import { requireRole } from '../../things/service.js';

/** The whole connection's time limit (plan T11). */
export const CONNECT_TIMEOUT_MS = 10_000;
/** The most of one answer read; Homebox's are a few KiB. */
export const MAX_ANSWER_BYTES = 1 << 20;
const API = '/api/v1';

export type HomeboxCredentials = { apiKey: string } | { username: string; password: string };

/** The web's `HomeboxConnection` (apps/web/src/api/portability/types.ts). */
export type HomeboxConnection = {
  version: string;
  collections: { id: string; name: string; currency: string }[];
  members?: { name: string; email: string }[];
};

const unreachable = (hint: string) => new AppError('homebox_unreachable', 502, hint);

/**
 * The server's root from what a person typed: http or https, no user name or password in it, no
 * query or fragment; a trailing `/api/v1` (or `/`) is dropped, so both the web address and the
 * API's work. A path prefix (Homebox behind a proxy at `/homebox`) is kept.
 */
export function homeboxRoot(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid('Check body.baseUrl: an address like http://homebox.local:7745.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('Check body.baseUrl: it starts with http:// or https://.');
  }
  if (url.username || url.password) {
    throw invalid('Check body.baseUrl: no user name or password in the address.');
  }
  if (url.search || url.hash) throw invalid('Check body.baseUrl: no query or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
  return url;
}

const Status = z.object({ build: z.object({ version: z.string().trim().min(1).max(40) }) });
const Login = z.object({ token: z.string().min(1).max(4096) });
const Groups = z.array(
  z.object({
    id: z.string().trim().min(1).max(64),
    name: z.string().max(255),
    currency: z
      .string()
      .trim()
      .transform((c) => c.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{3}$/)),
  }),
);
const Members = z.array(z.object({ name: z.string().max(255), email: z.string().max(320) }));

/** An answer's text, at most MAX_ANSWER_BYTES. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {});
      throw unreachable('That address answered with far more than Homebox would.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Whether `e` (or its cause) is a refused redirect (undici: "unexpected redirect"). */
function isRedirect(e: unknown): boolean {
  for (let c: unknown = e, i = 0; c && i < 4; c = (c as { cause?: unknown }).cause, i++) {
    if (/redirect/i.test(String((c as { message?: unknown }).message ?? ''))) return true;
  }
  return false;
}

type Call = {
  fetch: typeof fetch;
  root: URL;
  signal: AbortSignal;
  token?: string;
  tenant?: string;
};

async function homebox<T>(
  c: Call,
  method: 'GET' | 'POST',
  route: string,
  schema: z.ZodType<T>,
  body?: object,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (c.token) headers.authorization = `Bearer ${c.token.replace(/^Bearer\s+/i, '')}`;
  if (c.tenant) headers['x-tenant'] = c.tenant;
  if (body) headers['content-type'] = 'application/json';
  const url = new URL(c.root.href);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${API}${route}`;
  let res: Response;
  try {
    res = await c.fetch(url, {
      method,
      headers,
      signal: c.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    if (e instanceof PrivateAddressError) throw e;
    if (c.signal.aborted) throw unreachable("Homebox didn't answer within 10 seconds.");
    if (isRedirect(e)) {
      throw unreachable('That address answered with a redirect: use the address it leads to.');
    }
    throw unreachable("Kept couldn't reach that address.");
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw unreachable(
      route === '/users/login'
        ? "Homebox didn't accept that sign-in."
        : "Homebox didn't accept that key or sign-in, or it can't see this collection.",
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw unreachable(
      route === '/status'
        ? `That address doesn't answer like Homebox (${res.status} for ${API}/status).`
        : `Homebox answered ${res.status} for ${API}${route}.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(await readCapped(res));
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (c.signal.aborted) throw unreachable("Homebox didn't answer within 10 seconds.");
    throw unreachable(`That address didn't answer ${API}${route} like Homebox.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw unreachable(`That address didn't answer ${API}${route} like Homebox.`);
  return parsed.data;
}

/**
 * Reads the version, the collections with their currencies and one collection's members. The
 * credentials are used for these calls only. `collectionId` is the ZIP's (`manifest.groupId`):
 * listed first, its members read; when the key's owner can't see it, 409. Without one, the first
 * collection's members.
 */
export async function readHomebox(opts: {
  root: URL;
  credentials: HomeboxCredentials;
  collectionId: string | null;
  fetch: typeof fetch;
  timeoutMs?: number;
}): Promise<HomeboxConnection> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? CONNECT_TIMEOUT_MS);
  const base: Call = { fetch: opts.fetch, root: opts.root, signal };
  const status = await homebox(base, 'GET', '/status', Status);
  const token =
    'apiKey' in opts.credentials
      ? opts.credentials.apiKey
      : (
          await homebox(base, 'POST', '/users/login', Login, {
            username: opts.credentials.username,
            password: opts.credentials.password,
            stayLoggedIn: false,
          })
        ).token;
  const authed: Call = { ...base, token };
  const groups = await homebox(authed, 'GET', '/groups/all', Groups);
  const wanted = opts.collectionId?.toLowerCase() ?? null;
  const match = wanted ? groups.find((g) => g.id.toLowerCase() === wanted) : undefined;
  if (wanted && !match) {
    throw conflict(
      "This Homebox account can't see the collection this export came from. Connect as one of its members.",
    );
  }
  const ordered = match ? [match, ...groups.filter((g) => g !== match)] : groups;
  const first = ordered[0];
  const members = first
    ? await homebox({ ...authed, tenant: first.id }, 'GET', '/groups/members', Members)
    : undefined;
  return {
    version: status.build.version,
    collections: ordered.map((g) => ({ id: g.id, name: g.name, currency: g.currency })),
    ...(members
      ? { members: members.map((m) => ({ name: m.name.trim(), email: m.email.trim() })) }
      : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------

const Params = z.object({ id: z.uuid() });
const BaseUrl = z.string().trim().min(1).max(2048);
const ConnectBody = z.union([
  z.strictObject({ baseUrl: BaseUrl, apiKey: z.string().min(1).max(4096) }),
  z.strictObject({
    baseUrl: BaseUrl,
    username: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(4096),
  }),
]);
const Connection = z.object({
  version: z.string(),
  collections: z.array(z.object({ id: z.string(), name: z.string(), currency: z.string() })),
  members: z.array(z.object({ name: z.string(), email: z.string() })).optional(),
});

type ConnectRun = {
  id: string;
  location_id: string | null;
  source: string;
  status: string;
  collection_id: string | null;
};

/** The run, if the caller may connect it: its creator before a target, an owner or admin of the
 * target after (0080's policies; 404 otherwise). Only a Homebox run before it starts. */
async function connectableRun(
  client: pg.ClientBase,
  id: string,
  lock: boolean,
): Promise<ConnectRun> {
  const { rows } = await client.query<ConnectRun>(
    `SELECT id, location_id, source, status, inspect #>> '{collections,0,id}' AS collection_id
       FROM public.import_runs WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  const run = rows[0];
  if (!run) throw notFound();
  if (run.location_id) await requireRole(client, run.location_id, 'location.export-import');
  if (run.source !== 'homebox_zip') throw conflict('Only a Homebox export connects to Homebox.');
  if (run.status !== 'draft' && run.status !== 'checked') {
    throw conflict(`This import is ${run.status}; connect before it starts.`);
  }
  return run;
}

/** POST /api/v1/imports/:id/homebox-connect (T11). Registered by imports/archive.ts. */
export async function homeboxConnectRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  app.post(
    '/api/v1/imports/:id/homebox-connect',
    { schema: { params: Params, body: ConnectBody, response: { 200: Connection } } },
    async (req) => {
      const scope = requireScope(req);
      const id = req.params.id.toLowerCase();
      const run = await withScope(pools.app, scope, (_tx, client) =>
        connectableRun(client, id, false),
      );
      const root = homeboxRoot(req.body.baseUrl);
      const { baseUrl: _url, ...credentials } = req.body;
      // No transaction is open while Homebox answers (like step 3's "Test connection").
      const connection = await readHomebox({
        root,
        credentials,
        collectionId: run.collection_id,
        fetch: guardedFetch({ allowPrivate: await allowPrivateAddresses(pools) }),
      });
      await withScope(pools.app, scope, async (tx, client) => {
        const locked = await connectableRun(client, id, true);
        await client.query('UPDATE public.import_runs SET source_version = $2 WHERE id = $1', [
          id,
          connection.version,
        ]);
        // A run with no target yet is its creator's: the event is their account's (§7.13).
        const owner = locked.location_id
          ? undefined
          : ((
              await client.query<{ id: string | null }>(
                'SELECT kept.current_owner_account_id() AS id',
              )
            ).rows[0]?.id ?? null);
        await audited(tx, {
          locationId: locked.location_id,
          ...(owner !== undefined ? { ownerAccountId: owner } : {}),
          actor: { type: 'user', id: scope.userId },
          action: 'import.homebox_connect',
          entity: { type: 'import_run', id },
          after: {
            host: root.host,
            version: connection.version,
            collections: connection.collections.length,
            members: connection.members?.length ?? 0,
          },
          requestId: req.id,
        });
      });
      return connection;
    },
  );
}
