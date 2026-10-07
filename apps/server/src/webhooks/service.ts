import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import {
  newId,
  type Role,
  WEBHOOK_EVENTS,
  type WebhookDeliveryStatus,
  type WebhookDisabledReason,
  type WebhookEvent,
} from '@kept/shared';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import { type Aad, type MasterKey, seal } from '../crypto/envelope.js';
import type { Scope, Tx } from '../db/scope.js';
import { checkVersion, pageOf } from '../http/conventions.js';
import { invalid, notFound } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { isPrivateAddress, PrivateAddressError, type Resolve } from '../net/ssrf.js';
import { newWebhookSecret } from '../notify/webhook.js';

// Location webhooks: the rows behind /api/v1/locations/:id/webhooks and /api/v1/webhooks/:id
// (step-6 plan T15; engineering spec §2.6; D63, D110, D180). The web's contract is
// apps/web/src/api/connections/types.ts (WebhookRow, CreatedWebhook, WebhookDelivery).
//
// - Owners and admins only (`webhooks.manage`): a location the caller can't see is a 404, one
//   they see but don't administer a 403. Row-level security says the same (0078): kept_app sees
//   and writes a location's hooks only as its admin.
// - The signing secret is made here, sealed with AAD `webhooks|<id>|secret` (§7.3) and shown
//   once, in the create or rotate answer. kept_app can't SELECT it back; the delivery job opens
//   it through kept.webhook_secret() as kept_system (deliver.ts).
// - Audit images hold the URL, the events and the switch; never the secret or its ciphertext. A
//   rotation is `{secret: {changed: true}}` (the field's `secret` class, audit/classes.ts).
// - The URL is checked for private addresses when it is saved (D83, D128): an IP literal or a
//   name resolving to one is 400 `private_address` unless the instance allows private
//   addresses. Delivery checks again at connect time (net/ssrf.ts), so a name that re-resolves
//   later still can't reach the LAN.

export const webhookAad = (webhookId: string): Aad => ({
  table: 'webhooks',
  rowId: webhookId,
  fieldKey: 'secret',
});

/** How many hooks a location may have. */
export const MAX_WEBHOOKS_PER_LOCATION = 10;

/** The URL column's limit (0077's webhooks_url_chk). */
const URL_MAX = 500;

export type WebhookRow = {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  failingSince: string | null;
  disabledReason: WebhookDisabledReason | null;
  createdBy: { id: string; displayName: string };
  lastDelivery?: { status: WebhookDeliveryStatus; at: string; httpStatus: number | null };
  rowVersion: number;
};

export type WebhookDelivery = {
  id: string;
  event: WebhookEvent | 'ping';
  status: WebhookDeliveryStatus;
  attempts: number;
  httpStatus: number | null;
  createdAt: string;
  nextAttemptAt: string | null;
};

type DbRow = {
  id: string;
  location_id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  failing_since: Date | null;
  disabled_reason: WebhookDisabledReason | null;
  created_by: string;
  creator_name: string | null;
  row_version: number;
  last_status: WebhookDeliveryStatus | null;
  last_at: Date | null;
  last_http_status: number | null;
};

// Never secret_ciphertext: kept_app has no SELECT on it (0078).
const SELECT_ROWS = `
  SELECT w.id, w.location_id, w.url, w.events, w.active, w.failing_since, w.disabled_reason,
         w.created_by, p.display_name AS creator_name, w.row_version,
         d.status AS last_status, d.updated_at AS last_at, d.http_status AS last_http_status
    FROM public.webhooks w
    LEFT JOIN public.user_profiles p ON p.user_id = w.created_by
    LEFT JOIN LATERAL (
      SELECT x.status, x.updated_at, x.http_status FROM public.webhook_deliveries x
       WHERE x.webhook_id = w.id ORDER BY x.id DESC LIMIT 1) d ON true`;

function rowOf(r: DbRow): WebhookRow {
  return {
    id: r.id,
    url: r.url,
    events: r.events,
    active: r.active,
    failingSince: r.failing_since?.toISOString() ?? null,
    disabledReason: r.disabled_reason,
    createdBy: { id: r.created_by, displayName: r.creator_name ?? '' },
    ...(r.last_status && r.last_at
      ? {
          lastDelivery: {
            status: r.last_status,
            at: r.last_at.toISOString(),
            httpStatus: r.last_http_status,
          },
        }
      : {}),
    rowVersion: r.row_version,
  };
}

/** What an audit image of a hook holds: never the secret. */
function auditImage(r: Pick<DbRow, 'url' | 'events' | 'active' | 'disabled_reason'>) {
  return { url: r.url, events: r.events, active: r.active, disabled_reason: r.disabled_reason };
}

/** The caller's role in `locationId`, refused unless it manages webhooks (404 when unseen). */
async function requireManager(client: pg.ClientBase, locationId: string): Promise<Role> {
  const { role } = await requireMembership(client, locationId);
  requireCan(role, 'webhooks.manage', "Only the location's owner and admins manage webhooks.");
  return role;
}

/** A hook the caller may manage, by id: 404 for one they can't see, 403 for one they see only as
 * a member. kept_app's policy hides other people's hooks, so the location comes from the row. */
async function hookOf(client: pg.ClientBase, id: string): Promise<DbRow> {
  const { rows } = await client.query<DbRow>(`${SELECT_ROWS} WHERE w.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw notFound();
  await requireManager(client, row.location_id);
  return row;
}

// ---------------------------------------------------------------------------------------------
// The URL (D83, D128)
// ---------------------------------------------------------------------------------------------

const systemResolve: Resolve = (host, cb) =>
  dnsLookup(host, { all: true }, (err, addrs) => cb(err, addrs ?? []));

/** Parses a webhook URL: http or https, no credentials in it, at most 500 characters. */
export function parseWebhookUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length > URL_MAX) throw invalid(`url: at most ${URL_MAX} characters.`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalid('url: an http or https address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid('url: an http or https address.');
  }
  if (url.username || url.password) throw invalid('url: no user name or password in it.');
  if (url.hash) throw invalid('url: no #fragment.');
  return url;
}

/**
 * The URL a hook may be saved with: refused with 400 `private_address` when it is, or resolves
 * to, a private address and the instance doesn't allow those. A name that doesn't resolve is a
 * 400 too: a hook that can't be reached would only fail every delivery.
 */
export async function checkWebhookUrl(
  raw: string,
  allowPrivate: boolean,
  resolve: Resolve = systemResolve,
): Promise<string> {
  const url = parseWebhookUrl(raw);
  if (allowPrivate) return url.toString();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new PrivateAddressError(host);
    return url.toString();
  }
  const addresses = await new Promise<{ address: string }[]>((done) =>
    resolve(host, (err, found) => done(err ? [] : found)),
  );
  if (addresses.length === 0) throw invalid(`url: ${host} doesn't resolve to an address.`);
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) throw new PrivateAddressError(bad.address);
  return url.toString();
}

function eventsOf(events: readonly string[]): WebhookEvent[] {
  const set = [...new Set(events)];
  if (set.length === 0) throw invalid('events: at least one.');
  const unknown = set.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (unknown.length > 0) throw invalid(`events: unknown ${unknown.join(', ')}.`);
  // Stored in the contract's order, so an edit that only reorders changes nothing.
  return WEBHOOK_EVENTS.filter((e) => set.includes(e));
}

// ---------------------------------------------------------------------------------------------
// The routes' operations
// ---------------------------------------------------------------------------------------------

export type WriteCtx = { tx: Tx; client: pg.ClientBase; scope: Scope; requestId: string };

const actorOf = (scope: Scope) => ({ type: 'user' as const, id: scope.userId });

/** GET /api/v1/locations/:id/webhooks. */
export async function listWebhooks(
  client: pg.ClientBase,
  locationId: string,
): Promise<{ items: WebhookRow[] }> {
  await requireManager(client, locationId);
  const { rows } = await client.query<DbRow>(
    `${SELECT_ROWS} WHERE w.location_id = $1 ORDER BY w.id`,
    [locationId],
  );
  return { items: rows.map(rowOf) };
}

/** POST /api/v1/locations/:id/webhooks: the hook, and its secret once. */
export async function createWebhook(
  ctx: WriteCtx,
  master: MasterKey,
  locationId: string,
  body: { url: string; events: readonly string[] },
  allowPrivate: boolean,
): Promise<{ webhook: WebhookRow; secret: string }> {
  await requireManager(ctx.client, locationId);
  const url = await checkWebhookUrl(body.url, allowPrivate);
  const events = eventsOf(body.events);
  const { rows: count } = await ctx.client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.webhooks WHERE location_id = $1',
    [locationId],
  );
  if ((count[0]?.n ?? 0) >= MAX_WEBHOOKS_PER_LOCATION) {
    throw invalid(
      `A location has at most ${MAX_WEBHOOKS_PER_LOCATION} webhooks; remove one first.`,
    );
  }
  const id = newId();
  const secret = newWebhookSecret();
  const sealed = seal(master, secret, webhookAad(id));
  await ctx.client.query(
    `INSERT INTO public.webhooks (id, location_id, url, secret_ciphertext, key_version, events,
                                  created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, kept.current_user_id())`,
    [id, locationId, url, JSON.stringify(sealed), master.keyVersion, events],
  );
  const row = (await ctx.client.query<DbRow>(`${SELECT_ROWS} WHERE w.id = $1`, [id]))
    .rows[0] as DbRow;
  await audited(ctx.tx, {
    locationId,
    actor: actorOf(ctx.scope),
    action: 'webhook.create',
    entity: { type: 'webhook', id },
    after: auditImage(row),
    requestId: ctx.requestId,
  });
  return { webhook: rowOf(row), secret };
}

/** PATCH /api/v1/webhooks/:id (If-Match). Turning a hook back on clears why it was off and its
 * failing mark: the admin has looked at it. */
export async function updateWebhook(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: { url?: string | undefined; events?: readonly string[] | undefined; active?: boolean },
  allowPrivate: boolean,
): Promise<WebhookRow> {
  const before = await hookOf(ctx.client, id);
  checkVersion({ rowVersion: before.row_version }, expected, Object.keys(body));
  const url = body.url === undefined ? before.url : await checkWebhookUrl(body.url, allowPrivate);
  const events = body.events === undefined ? before.events : eventsOf(body.events);
  const active = body.active ?? before.active;
  const reopened = active && !before.active;
  // D180 (security review T25, M3): a hook stopped because its creator stopped administering the
  // location stays stopped; another admin adds their own, which then belongs to them.
  if (reopened && before.disabled_reason === 'creator_lost_role') {
    throw invalid(
      'This webhook stopped because the admin who added it no longer manages this location; add a new one.',
    );
  }
  const disabledReason = active ? null : body.active === false ? 'admin' : before.disabled_reason;
  await ctx.client.query(
    `UPDATE public.webhooks
        SET url = $2, events = $3, active = $4, disabled_reason = $5,
            failing_since = CASE WHEN $6 THEN NULL ELSE failing_since END
      WHERE id = $1`,
    [id, url, events, active, disabledReason, reopened],
  );
  const after = (await ctx.client.query<DbRow>(`${SELECT_ROWS} WHERE w.id = $1`, [id]))
    .rows[0] as DbRow;
  await audited(ctx.tx, {
    locationId: before.location_id,
    actor: actorOf(ctx.scope),
    action: 'webhook.update',
    entity: { type: 'webhook', id },
    before: auditImage(before),
    after: auditImage(after),
    requestId: ctx.requestId,
  });
  return rowOf(after);
}

/** POST /api/v1/webhooks/:id/rotate-secret: a new secret, shown once; the old one stops at once. */
export async function rotateWebhookSecret(
  ctx: WriteCtx,
  master: MasterKey,
  id: string,
): Promise<{ secret: string }> {
  const row = await hookOf(ctx.client, id);
  const secret = newWebhookSecret();
  const sealed = seal(master, secret, webhookAad(id));
  await ctx.client.query(
    'UPDATE public.webhooks SET secret_ciphertext = $2::jsonb, key_version = $3 WHERE id = $1',
    [id, JSON.stringify(sealed), master.keyVersion],
  );
  // The diff is `{secret: {changed: true}}`: the field's class is secret (audit/classes.ts), so
  // neither value is stored, and the event is never undoable.
  await audited(ctx.tx, {
    locationId: row.location_id,
    actor: actorOf(ctx.scope),
    action: 'webhook.rotate_secret',
    entity: { type: 'webhook', id },
    before: { secret: 'old' },
    after: { secret: 'new' },
    requestId: ctx.requestId,
  });
  return { secret };
}

/** DELETE /api/v1/webhooks/:id. Its deliveries go with it (the foreign key cascades). */
export async function deleteWebhook(ctx: WriteCtx, id: string): Promise<void> {
  const row = await hookOf(ctx.client, id);
  await ctx.client.query('DELETE FROM public.webhooks WHERE id = $1', [id]);
  await audited(ctx.tx, {
    locationId: row.location_id,
    actor: actorOf(ctx.scope),
    action: 'webhook.delete',
    entity: { type: 'webhook', id },
    before: auditImage(row),
    after: null,
    requestId: ctx.requestId,
  });
}

/** GET /api/v1/webhooks/:id/deliveries: newest first, the last 30 days (older ones are pruned,
 * kept.prune_stale_rows()). */
export async function listDeliveries(
  client: pg.ClientBase,
  id: string,
  page: { limit: number; after: string | null },
): Promise<{ items: WebhookDelivery[]; next_cursor: string | null }> {
  await hookOf(client, id);
  const { rows } = await client.query<{
    id: string;
    event: WebhookEvent | 'ping';
    status: WebhookDeliveryStatus;
    attempts: number;
    http_status: number | null;
    created_at: Date;
    next_attempt_at: Date | null;
  }>(
    `SELECT id, event, status, attempts, http_status, created_at, next_attempt_at
       FROM public.webhook_deliveries
      WHERE webhook_id = $1 AND created_at > now() - interval '30 days'
        AND ($2::uuid IS NULL OR id < $2::uuid)
      ORDER BY id DESC LIMIT $3`,
    [id, page.after, page.limit + 1],
  );
  const items = rows.map((r) => ({
    id: r.id,
    event: r.event,
    status: r.status,
    attempts: r.attempts,
    httpStatus: r.http_status,
    createdAt: r.created_at.toISOString(),
    nextAttemptAt: r.next_attempt_at?.toISOString() ?? null,
  }));
  return pageOf(items, page.limit, (d) => d.id);
}

/** The hook a test ping may go to: the caller manages it. Its location, for the delivery row. */
export async function testableWebhook(
  client: pg.ClientBase,
  id: string,
): Promise<{ id: string; locationId: string }> {
  const row = await hookOf(client, id);
  return { id: row.id, locationId: row.location_id };
}
