import { createHash, randomBytes } from 'node:crypto';
import {
  newId,
  SHARE_LINK_MAX_DAYS,
  SHARE_VIEW_FILTERS,
  type ShareLinkScope,
  type ShareLinkState,
  type ShareView,
  type ShareViewFilter,
  tsQuery,
} from '@kept/shared';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import type { Scope, Tx } from '../db/scope.js';
import { invalid, notFound } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import type { FileStorage } from '../storage/blob-store.js';
import { type DoorPage, type SharedPage, sharedPageOf } from './page.js';

// Read-only share links: the rows behind /api/v1/locations/:id/share-links and
// /api/v1/share-links/:id (1.5, D233; D39 item 7, D72, D116, D180). The web's contract is
// apps/web/src/api/sharelinks/types.ts.
//
// - Owners and admins only (`share-links.create`): a location the caller can't see is a 404, one
//   they see but don't administer a 403. Row-level security says the same (0127), and refuses a
//   token, a Personal location and a box or place of another location.
// - The token is 32 random bytes, shown once in the create answer as the link; only its SHA-256
//   is stored, and kept_app can't read even that back. The audit holds what was shared and until
//   when, never the token.
// - A filtered list keeps the words and the place, type and tag filters (@kept/shared ShareView),
//   with `tsq`, the words as the search's own tsquery (@kept/shared tsQuery), so the page matches
//   them as the phone's offline search does. Its places must be this location's.

/** A new link token: 32 random bytes, base64url (43 characters). */
export function newShareToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored: the token's SHA-256, hex. */
export function shareTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type ShareLinkRow = {
  id: string;
  locationId: string;
  scope: ShareLinkScope;
  /** The box or place shared, by id and name (null when it is gone, and for a list). */
  subject: { id: string; name: string | null; isUnplaced: boolean } | null;
  title: string | null;
  view: ShareView | null;
  state: ShareLinkState;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string };
  views: number;
  lastViewedAt: string | null;
};

type DbRow = {
  id: string;
  location_id: string;
  scope_type: ShareLinkScope;
  thing_id: string | null;
  place_id: string | null;
  filter: (ShareView & { tsq?: string | null }) | null;
  title: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  created_by: string;
  created_at: Date;
  views: number;
  last_viewed_at: Date | null;
  creator_name: string | null;
  subject_name: string | null;
  subject_unplaced: boolean | null;
  backed: boolean;
  expired: boolean;
};

// Never token_hash: kept_app has no SELECT on it (0127). `backed`: the creator still administers
// the location (D180), as far as the caller's policies show memberships; the door also checks
// the location and that the creator isn't banned.
const SELECT_ROWS = `
  SELECT s.id, s.location_id, s.scope_type, s.thing_id, s.place_id, s.filter, s.title,
         s.expires_at, s.revoked_at, s.created_by, s.created_at, s.views, s.last_viewed_at,
         pr.display_name AS creator_name,
         coalesce(t.name, p.name) AS subject_name, p.is_unplaced AS subject_unplaced,
         EXISTS (SELECT 1 FROM public.memberships m
                  WHERE m.location_id = s.location_id AND m.user_id = s.created_by
                    AND m.role IN ('owner', 'admin')
                    AND (m.expires_at IS NULL OR m.expires_at > now())) AS backed,
         s.expires_at <= now() AS expired
    FROM public.share_links s
    LEFT JOIN public.user_profiles pr ON pr.user_id = s.created_by
    LEFT JOIN public.things t
      ON t.id = s.thing_id AND t.location_id = s.location_id AND t.deleted_at IS NULL
    LEFT JOIN public.places p
      ON p.id = s.place_id AND p.location_id = s.location_id AND p.deleted_at IS NULL`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function stateOf(r: DbRow): ShareLinkState {
  if (r.revoked_at) return 'revoked';
  if (r.expired) return 'expired';
  if (!r.backed) return 'stopped';
  return 'active';
}

/** The stored filter as the contract's ShareView (never `tsq`). */
function viewOf(filter: DbRow['filter']): ShareView | null {
  if (!filter) return null;
  return {
    ...(filter.q ? { q: filter.q } : {}),
    ...(filter.filters ? { filters: filter.filters } : {}),
    ...(filter.not?.length ? { not: filter.not } : {}),
  };
}

function rowOf(r: DbRow): ShareLinkRow {
  const subjectId = r.thing_id ?? r.place_id;
  return {
    id: r.id,
    locationId: r.location_id,
    scope: r.scope_type,
    subject:
      subjectId && (r.subject_name !== null || r.subject_unplaced !== null)
        ? { id: subjectId, name: r.subject_name, isUnplaced: r.subject_unplaced === true }
        : null,
    title: r.title,
    view: viewOf(r.filter),
    state: stateOf(r),
    expiresAt: r.expires_at.toISOString(),
    revokedAt: iso(r.revoked_at),
    createdAt: r.created_at.toISOString(),
    createdBy: { id: r.created_by, displayName: r.creator_name ?? '' },
    views: r.views,
    lastViewedAt: iso(r.last_viewed_at),
  };
}

/** What the audit keeps of a link: what was shared and until when; never the token. */
function auditImage(
  r: Pick<DbRow, 'scope_type' | 'thing_id' | 'place_id' | 'title'> & {
    filter: unknown;
    expires_at: Date;
    revoked_at: Date | null;
  },
) {
  return {
    scope_type: r.scope_type,
    thing_id: r.thing_id,
    place_id: r.place_id,
    filter: viewOf(r.filter as DbRow['filter']),
    title: r.title,
    expires_at: r.expires_at.toISOString(),
    revoked_at: iso(r.revoked_at),
  };
}

/** The caller's membership, refused unless they may make share links there (404 when unseen). */
async function requireSharer(client: pg.ClientBase, locationId: string): Promise<void> {
  const { role } = await requireMembership(client, locationId);
  requireCan(role, 'share-links.create', "Only the location's owner and admins share links.");
}

async function linkOf(client: pg.ClientBase, id: string): Promise<DbRow> {
  const { rows } = await client.query<DbRow>(`${SELECT_ROWS} WHERE s.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw notFound();
  await requireSharer(client, row.location_id);
  return row;
}

export type WriteCtx = { tx: Tx; client: pg.ClientBase; scope: Scope; requestId: string };

const actorOf = (scope: Scope) => ({ type: 'user' as const, id: scope.userId });

/** GET /api/v1/locations/:id/share-links: every link, live first, newest first. */
export async function listShareLinks(
  client: pg.ClientBase,
  locationId: string,
): Promise<{ items: ShareLinkRow[] }> {
  await requireSharer(client, locationId);
  const { rows } = await client.query<DbRow>(
    `${SELECT_ROWS} WHERE s.location_id = $1
      ORDER BY (s.revoked_at IS NULL AND s.expires_at > now()) DESC, s.created_at DESC, s.id`,
    [locationId],
  );
  return { items: rows.map(rowOf) };
}

export type CreateBody = {
  thingId?: string | undefined;
  placeId?: string | undefined;
  view?: ShareView | undefined;
  title?: string | undefined;
  expiresInDays: number;
};

/** The view as stored: its filters de-duplicated, its places this location's, `tsq` added. */
async function storedView(
  client: pg.ClientBase,
  locationId: string,
  view: ShareView,
): Promise<ShareView & { tsq: string | null }> {
  const filters: Partial<Record<ShareViewFilter, string[]>> = {};
  for (const key of SHARE_VIEW_FILTERS) {
    const values = [...new Set(view.filters?.[key] ?? [])];
    if (values.length) filters[key] = values;
  }
  const places = filters.place ?? [];
  if (places.length) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM public.places p
                WHERE p.id = ANY ($1::uuid[]) AND p.location_id = $2 AND p.deleted_at IS NULL)
            + (SELECT count(*) FROM public.things t
                WHERE t.id = ANY ($1::uuid[]) AND t.location_id = $2 AND t.deleted_at IS NULL))::int
              AS n`,
      [places, locationId],
    );
    if ((rows[0]?.n ?? 0) !== places.length) {
      throw invalid('view.filters.place: places and boxes of this location only.');
    }
  }
  for (const [key, table] of [
    ['type', 'types'],
    ['tag', 'tags'],
  ] as const) {
    const ids = filters[key] ?? [];
    if (!ids.length) continue;
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.${table} WHERE id = ANY ($1::uuid[])`,
      [ids],
    );
    if ((rows[0]?.n ?? 0) !== ids.length) throw invalid(`view.filters.${key}: unknown ${key}.`);
  }
  const not = [...new Set(view.not ?? [])].filter((k) => filters[k]);
  const q = view.q?.trim() ?? '';
  return {
    ...(q ? { q } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(not.length ? { not } : {}),
    tsq: q ? tsQuery(q) : null,
  };
}

/** POST /api/v1/locations/:id/share-links: the link, and its URL once. */
export async function createShareLink(
  ctx: WriteCtx,
  locationId: string,
  body: CreateBody,
  publicUrl: string,
): Promise<{ link: ShareLinkRow; url: string }> {
  await requireSharer(ctx.client, locationId);
  const { rows: loc } = await ctx.client.query<{ kind: string }>(
    'SELECT kind FROM public.locations WHERE id = $1',
    [locationId],
  );
  if (loc[0]?.kind === 'personal') throw invalid('A Personal location has no share links.');
  const scopes = [body.thingId, body.placeId, body.view].filter((x) => x !== undefined);
  if (scopes.length !== 1) throw invalid('Share one of: thingId, placeId or view.');
  if (body.expiresInDays < 1 || body.expiresInDays > SHARE_LINK_MAX_DAYS) {
    throw invalid(`expiresInDays: 1 to ${SHARE_LINK_MAX_DAYS}.`);
  }
  let scope: ShareLinkScope;
  let filter: (ShareView & { tsq: string | null }) | null = null;
  const title = body.title?.trim() || null;
  if (body.thingId) {
    scope = 'thing';
    const { rows } = await ctx.client.query(
      `SELECT 1 FROM public.things
        WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL`,
      [body.thingId, locationId],
    );
    if (!rows[0]) throw notFound();
  } else if (body.placeId) {
    scope = 'place';
    const { rows } = await ctx.client.query(
      `SELECT 1 FROM public.places WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL`,
      [body.placeId, locationId],
    );
    if (!rows[0]) throw notFound();
  } else {
    scope = 'view';
    if (!title) throw invalid('title: a shared list needs a name.');
    filter = await storedView(ctx.client, locationId, body.view as ShareView);
  }

  const id = newId();
  const token = newShareToken();
  await ctx.client.query(
    `INSERT INTO public.share_links (id, location_id, scope_type, thing_id, place_id, filter,
                                     title, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now() + make_interval(days => $9),
             kept.current_user_id())`,
    [
      id,
      locationId,
      scope,
      body.thingId ?? null,
      body.placeId ?? null,
      filter ? JSON.stringify(filter) : null,
      scope === 'view' ? title : null,
      shareTokenHash(token),
      body.expiresInDays,
    ],
  );
  const row = (await ctx.client.query<DbRow>(`${SELECT_ROWS} WHERE s.id = $1`, [id]))
    .rows[0] as DbRow;
  await audited(ctx.tx, {
    locationId,
    actor: actorOf(ctx.scope),
    action: 'share_link.create',
    entity: { type: 'share_link', id },
    after: auditImage(row),
    requestId: ctx.requestId,
  });
  const url = new URL(`/s/${token}`, publicUrl).toString();
  return { link: rowOf(row), url };
}

/** DELETE /api/v1/share-links/:id: revoked at once and for good; the row stays for the list. */
export async function revokeShareLink(ctx: WriteCtx, id: string): Promise<void> {
  const before = await linkOf(ctx.client, id);
  if (before.revoked_at) throw notFound();
  const { rows } = await ctx.client.query<{ revoked_at: Date }>(
    `UPDATE public.share_links SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL RETURNING revoked_at`,
    [id],
  );
  const revokedAt = rows[0]?.revoked_at;
  if (!revokedAt) throw notFound();
  await audited(ctx.tx, {
    locationId: before.location_id,
    actor: actorOf(ctx.scope),
    action: 'share_link.revoke',
    entity: { type: 'share_link', id },
    before: auditImage(before),
    after: auditImage({ ...before, revoked_at: revokedAt }),
    requestId: ctx.requestId,
  });
}

/** GET /api/v1/share-links/:id/preview: the page as a recipient sees it, for the location's
 * admins, whatever the link's state. */
export async function previewShareLink(
  client: pg.ClientBase,
  files: FileStorage | null,
  id: string,
  page: number,
): Promise<SharedPage> {
  await linkOf(client, id);
  const { rows } = await client.query<{ page: DoorPage | null }>(
    'SELECT kept.share_link_preview($1, $2) AS page',
    [id, page],
  );
  const door = rows[0]?.page;
  // The box or place is gone, or left the location: nothing to show.
  if (!door) throw notFound('What this link shared is no longer in this location.');
  return sharedPageOf(files, door);
}

/** The public page's door (kept_system): the page, or null for any link that doesn't open. */
export async function openSharedPage(
  client: pg.ClientBase,
  tokenHash: string,
  page: number,
): Promise<DoorPage | null> {
  const { rows } = await client.query<{ page: DoorPage | null }>(
    'SELECT kept.share_link_open($1, $2) AS page',
    [tokenHash, page],
  );
  return rows[0]?.page ?? null;
}
