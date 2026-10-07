import {
  isDateFilterValue,
  LIST_SURFACES,
  type ListSurface,
  MAX_FILTER_VALUES,
  MAX_PINNED_VIEWS,
  MONEY_FILTER_KEYS,
  newId,
  type SavedListQuery,
  SURFACE_FILTER_KEYS,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import type { FieldClass } from '../audit/classes.js';
import type { Tx } from '../db/scope.js';
import { assertClientId, checkVersion, decodeCursor, encodeCursor } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { callerMembership, requireCan, requireMembership } from '../locations/access.js';
import type { Gate } from '../serialize/gates.js';

// Saved views (D42, D183, D205; screens spec §5 Search and "The filter strip"): a list's state
// saved by its maker, personal or shared with one location. Each view belongs to one list, its
// `surface` (@kept/shared LIST_SURFACES), fixed when it is made; its query is that list's URL
// state (SavedListQuery), checked against the filters the list offers (SURFACE_FILTER_KEYS).
// Row-level security (0020) lets everyone read their own and the shared views of locations they
// can see, and lets only the maker change or delete a view. Sharing needs `saved-views.share`
// (owner, admin, member) in the location.
//
// `location_id` can't be updated (0020 grants name, query and shared only), so moving a view to
// another location, or making a shared view personal again, deletes it and inserts it again
// with the same id, its first created_at and the next row_version, in one transaction. A
// personal view never keeps a location_id: one the maker has since left would fail the write
// policy on the next edit.
//
// Every write is audited as `saved_view.<verb>`: in the shared location when shared before or
// after, else account-level on the maker's own account. A query holding a money filter is
// audited as money, so a viewer's history never shows the amount.
//
// Read back, a view's money filters (MONEY_FILTER_KEYS) follow the gate of its location (security
// review #29): a shared view's location, or a personal view's location filter when it holds one
// location as "is any of". Where the caller's gate hides money there (a viewer where viewers
// don't see money, anyone where the Money module is off) they are left out of the query and the
// view carries `moneyHidden: true`, as any withheld money field does (serialize/gates.ts). A
// personal view with no one location keeps what its maker typed.

/** One filter value as a saved view keeps it. */
const FilterValue = z.string().min(1).max(200);

/** A saved view's query as it is sent (@kept/shared SavedListQuery); checkQuery() then holds it
 * to its list's filters. */
export const SavedListQuerySchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  filters: z.record(z.string().max(40), z.array(FilterValue).max(MAX_FILTER_VALUES)).optional(),
  not: z.array(z.string().max(40)).max(40).optional(),
  group: z.string().trim().max(40).optional(),
  sort: z.string().trim().max(40).optional(),
  /** The sort turned around, or not (D211). */
  dir: z.enum(['asc', 'desc']).optional(),
  /** The list's layout where it offers one (D211: a container's `photos`). */
  layout: z.string().trim().max(40).optional(),
});

const MONEY_KEYS: readonly string[] = MONEY_FILTER_KEYS;

/**
 * `query` held to `surface`'s filters, compacted as it is stored: every filter key one the list
 * offers, empty filters and empty strings dropped, dates well formed, and `not` naming only
 * filters that are present (never a money one). 400 naming the first problem.
 */
export function checkQuery(
  surface: ListSurface,
  query: z.infer<typeof SavedListQuerySchema>,
): SavedListQuery {
  const allowed = SURFACE_FILTER_KEYS[surface];
  const out: SavedListQuery = {};
  if (query.q) out.q = query.q;
  const filters: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(query.filters ?? {})) {
    if (!allowed.includes(key)) {
      throw invalid(`query.filters.${key}: not a filter of the ${surface} list.`);
    }
    // `when`, and the AI call list's `at` (D206, T19): a preset or a date range.
    if ((key === 'when' || key === 'at') && values.some((v) => !isDateFilterValue(v))) {
      throw invalid(`query.filters.${key}: a preset or a range YYYY-MM-DD..YYYY-MM-DD.`);
    }
    const unique = [...new Set(values)];
    if (unique.length > 0) filters[key] = unique;
  }
  if (Object.keys(filters).length > 0) out.filters = filters;
  const not: string[] = [];
  for (const key of query.not ?? []) {
    if (!allowed.includes(key)) throw invalid(`query.not: ${key} is not a filter of this list.`);
    if (MONEY_KEYS.includes(key)) throw invalid(`query.not: ${key} can't be "is none of".`);
    // A "none of" whose filter holds nothing says nothing, as on the list endpoints.
    if (filters[key] && !not.includes(key)) not.push(key);
  }
  if (not.length > 0) out.not = not;
  if (query.group) out.group = query.group;
  if (query.sort) out.sort = query.sort;
  if (query.dir) out.dir = query.dir;
  if (query.layout) out.layout = query.layout;
  return out;
}

export const SavedViewBody = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  surface: z.enum(LIST_SURFACES).default('search'),
  query: SavedListQuerySchema,
  sharedLocationId: z.uuid().nullable().optional(),
});

/** A view's list is fixed when it is made: `surface` isn't a field here. */
export const SavedViewPatch = z
  .object({
    name: z.string().trim().min(1).max(80),
    query: SavedListQuerySchema,
    sharedLocationId: z.uuid().nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' });

export const SavedViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  surface: z.enum(LIST_SURFACES),
  query: z.object({
    q: z.string().optional(),
    filters: z.record(z.string(), z.array(z.string())).optional(),
    not: z.array(z.string()).optional(),
    group: z.string().optional(),
    sort: z.string().optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    layout: z.string().optional(),
  }),
  sharedLocationId: z.uuid().nullable(),
  createdBy: z.object({ displayName: z.string() }),
  /** The caller made it (and so may change it). */
  mine: z.boolean(),
  rowVersion: z.number().int(),
  moneyHidden: z.literal(true).optional(),
});
export type SavedView = z.infer<typeof SavedViewSchema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The location a view's money follows: its shared location, else its location filter when that
 * holds exactly one location as "is any of". */
function locationOfView(view: SavedView): string | null {
  if (view.sharedLocationId) return view.sharedLocationId;
  const filter = view.query.filters?.location;
  if (filter?.length !== 1 || view.query.not?.includes('location')) return null;
  return filter[0] ?? null;
}

/** `view` with its money filters withheld where the gate of its location hides money (review
 * #29). A location the caller can no longer see (a personal view's stale filter) hides them. */
export async function gateView(
  view: SavedView,
  gateOf: (locationId: string) => Promise<Gate>,
): Promise<SavedView> {
  const locationId = locationOfView(view);
  if (!locationId || !hasMoney(view.query)) return view;
  const shown = UUID.test(locationId)
    ? await gateOf(locationId.toLowerCase()).then(
        (g) => g.showMoney,
        (err: unknown) => {
          if (err instanceof AppError && err.status === 404) return false;
          throw err;
        },
      )
    : false;
  if (shown) return view;
  const filters = Object.fromEntries(
    Object.entries(view.query.filters ?? {}).filter(([k]) => !MONEY_KEYS.includes(k)),
  );
  const query: SavedListQuery = { ...view.query };
  if (Object.keys(filters).length > 0) query.filters = filters;
  else delete query.filters;
  return { ...view, query, moneyHidden: true };
}

type Row = {
  id: string;
  user_id: string;
  location_id: string | null;
  name: string;
  surface: ListSurface;
  query: SavedListQuery;
  shared: boolean;
  row_version: number;
  created_at: Date;
  display_name: string | null;
};

const SELECT = `SELECT v.id, v.user_id, v.location_id, v.name, v.surface, v.query, v.shared,
                       v.row_version, v.created_at, up.display_name
                  FROM public.saved_views v
                  LEFT JOIN public.user_profiles up ON up.user_id = v.user_id`;

const viewOf = (r: Row, userId: string): SavedView => ({
  id: r.id,
  name: r.name,
  surface: r.surface,
  query: r.query,
  sharedLocationId: r.shared ? r.location_id : null,
  createdBy: { displayName: r.display_name ?? '' },
  mine: r.user_id === userId,
  rowVersion: r.row_version,
});

/** The audit image of a view. */
const imageOf = (r: Pick<Row, 'name' | 'surface' | 'query' | 'shared' | 'location_id'>) => ({
  name: r.name,
  surface: r.surface,
  query: r.query,
  shared: r.shared,
  location_id: r.location_id,
});

const hasMoney = (...queries: (SavedListQuery | undefined)[]) =>
  queries.some((q) => q?.filters && MONEY_KEYS.some((k) => q.filters?.[k] !== undefined));

async function one(client: pg.ClientBase, id: string): Promise<Row | null> {
  const { rows } = await client.query<Row>(`${SELECT} WHERE v.id = $1`, [id]);
  return rows[0] ?? null;
}

/** 404 unless the caller can see `locationId`; 403 unless their role may share views there. */
async function requireShare(client: pg.ClientBase, locationId: string): Promise<void> {
  const m = await requireMembership(client, locationId);
  requireCan(m.role, 'saved-views.share', 'Viewers keep their saved searches to themselves.');
}

async function auditView(
  tx: Tx,
  client: pg.ClientBase,
  opts: {
    action: 'create' | 'update' | 'delete';
    id: string;
    userId: string;
    before: Row | null;
    after: Pick<Row, 'name' | 'surface' | 'query' | 'shared' | 'location_id'> | null;
    requestId: string;
  },
): Promise<void> {
  const shared = [opts.after, opts.before].find((r) => r?.shared && r.location_id);
  const locationId = shared?.location_id ?? null;
  let ownerAccountId: string | null | undefined;
  if (!locationId) {
    const { rows } = await client.query<{ id: string | null }>(
      'SELECT kept.current_owner_account_id() AS id',
    );
    ownerAccountId = rows[0]?.id ?? null;
  }
  const fieldClasses: Record<string, FieldClass> = hasMoney(
    opts.before?.query,
    opts.after?.query ?? undefined,
  )
    ? { query: 'money' }
    : {};
  await audited(tx, {
    locationId,
    ...(ownerAccountId !== undefined ? { ownerAccountId } : {}),
    actor: { type: 'user', id: opts.userId },
    action: `saved_view.${opts.action}`,
    entity: { type: 'saved_view', id: opts.id },
    before: opts.before ? imageOf(opts.before) : null,
    after: opts.after ? imageOf(opts.after) : null,
    fieldClasses,
    requestId: opts.requestId,
  });
}

/** How many views of their own a person may keep (security review #34). */
export const MAX_OWN_VIEWS = 100;

export const ViewsQuery = z.object({
  /** One list's views; without it, every list's (the search screen before D205 asked so). */
  surface: z.enum(LIST_SURFACES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_OWN_VIEWS).default(MAX_OWN_VIEWS),
  cursor: z.string().max(2048).optional(),
});

const ViewsCursor = z.tuple([z.string().max(400), z.uuid()]);

/** The caller's views and the shared views of their locations, by name, a page at a time
 * (security review #34: shared views of busy locations aren't cut off at a fixed limit). */
export async function listViews(
  client: pg.ClientBase,
  userId: string,
  query: z.infer<typeof ViewsQuery> = { limit: MAX_OWN_VIEWS },
): Promise<{ items: SavedView[]; next_cursor: string | null }> {
  const values: unknown[] = [query.limit + 1];
  const v = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const where: string[] = [];
  if (query.surface) where.push(`v.surface = ${v(query.surface)}`);
  if (query.cursor) {
    const key = ViewsCursor.safeParse(decodeCursor(query.cursor));
    if (!key.success) throw invalid('The cursor is not valid; start again from the first page.');
    where.push(`(lower(v.name), v.id) > (${v(key.data[0])}::text, ${v(key.data[1])}::uuid)`);
  }
  const { rows } = await client.query<Row & { sort_key: string }>(
    `SELECT * FROM (${SELECT.replace('SELECT ', 'SELECT lower(v.name) AS sort_key, ')}
                    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                    ORDER BY lower(v.name), v.id LIMIT $1) page`,
    values,
  );
  const shown = rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: shown.map((r) => viewOf(r, userId)),
    next_cursor: rows.length > query.limit && last ? encodeCursor([last.sort_key, last.id]) : null,
  };
}

/** 409 once the caller keeps MAX_OWN_VIEWS views (serialised per person). */
async function requireRoomForView(client: pg.ClientBase): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('kept.saved_views'),
                                  hashtext(kept.current_user_id()::text))`,
  );
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.saved_views WHERE user_id = kept.current_user_id()',
  );
  if ((rows[0]?.n ?? 0) >= MAX_OWN_VIEWS) {
    throw new AppError(
      'conflict',
      409,
      `You can keep ${MAX_OWN_VIEWS} saved views; delete one to save another.`,
      { reason: 'limit' },
    );
  }
}

export async function createView(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  body: z.infer<typeof SavedViewBody>,
  requestId: string,
): Promise<SavedView> {
  const id = body.id ? assertClientId(body.id) : newId();
  const locationId = body.sharedLocationId ?? null;
  const query = checkQuery(body.surface, body.query);
  if (locationId) await requireShare(client, locationId);
  await requireRoomForView(client);
  await client.query(
    `INSERT INTO public.saved_views (id, user_id, location_id, name, surface, query, shared)
     VALUES ($1, kept.current_user_id(), $2, $3, $4, $5::jsonb, $6)`,
    [id, locationId, body.name, body.surface, JSON.stringify(query), locationId !== null],
  );
  const row = await one(client, id);
  if (!row) throw notFound();
  await auditView(tx, client, {
    action: 'create',
    id,
    userId,
    before: null,
    after: row,
    requestId,
  });
  return viewOf(row, userId);
}

export async function updateView(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  id: string,
  expected: number,
  body: z.infer<typeof SavedViewPatch>,
  requestId: string,
): Promise<SavedView> {
  const { rows: locked } = await client.query<{ id: string }>(
    'SELECT id FROM public.saved_views WHERE id = $1 AND user_id = kept.current_user_id() FOR UPDATE',
    [id],
  );
  const before = await one(client, id);
  if (!before) throw notFound();
  if (locked.length === 0) throw forbidden('Only the person who saved this search can change it.');
  checkVersion({ rowVersion: before.row_version }, expected, Object.keys(body));

  const name = body.name ?? before.name;
  const query = body.query ? checkQuery(before.surface, body.query) : before.query;
  const target =
    body.sharedLocationId === undefined
      ? before.shared
        ? before.location_id
        : null
      : body.sharedLocationId;
  if (target) await requireShare(client, target);

  if (target === before.location_id) {
    await client.query(
      'UPDATE public.saved_views SET name = $2, query = $3::jsonb, shared = $4 WHERE id = $1',
      [id, name, JSON.stringify(query), target !== null],
    );
  } else {
    // The delete sets every saved_view_prefs.default_view_id naming the view to null (its
    // foreign key). The maker's own default is put back once the view is in again; anyone
    // else's is theirs to set again (their policy keeps it from us), and a pin, not a foreign
    // key, survives as it is.
    const { rows: mine } = await client.query<{ surface: string }>(
      `SELECT surface FROM public.saved_view_prefs
        WHERE user_id = kept.current_user_id() AND default_view_id = $1`,
      [id],
    );
    await client.query('DELETE FROM public.saved_views WHERE id = $1', [id]);
    await client.query(
      `INSERT INTO public.saved_views
         (id, user_id, location_id, name, surface, query, shared, created_at, row_version)
       VALUES ($1, kept.current_user_id(), $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        id,
        target,
        name,
        before.surface,
        JSON.stringify(query),
        target !== null,
        before.created_at,
        before.row_version + 1,
      ],
    );
    if (mine.length > 0) {
      await client.query(
        `UPDATE public.saved_view_prefs SET default_view_id = $1
          WHERE user_id = kept.current_user_id() AND surface = ANY ($2::text[])`,
        [id, mine.map((r) => r.surface)],
      );
    }
  }
  const after = await one(client, id);
  if (!after) throw notFound();
  await auditView(tx, client, { action: 'update', id, userId, before, after, requestId });
  return viewOf(after, userId);
}

export async function deleteView(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  id: string,
  requestId: string,
): Promise<void> {
  const before = await one(client, id);
  if (!before) throw notFound();
  if (before.user_id !== userId) {
    // A location's owners and admins may tidy its shared views (the web's rule, and the delete
    // policy since 0024), but not edit them. Anyone else is 403; the policy would refuse them
    // too (a delete of no row, below).
    const m =
      before.shared && before.location_id
        ? await callerMembership(client, before.location_id)
        : null;
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
      throw forbidden('Only the person who saved this search can delete it.');
    }
  }
  const { rowCount } = await client.query('DELETE FROM public.saved_views WHERE id = $1', [id]);
  if (!rowCount) throw forbidden('Only the person who saved this search can delete it.');
  await auditView(tx, client, {
    action: 'delete',
    id,
    userId,
    before,
    after: null,
    requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// A person's pinned and default views, per list (D205)
// ---------------------------------------------------------------------------------------------
//
// One saved_view_prefs row per person and list (0034): the view the list opens with and the views
// pinned as tabs above the strip, in order. Read back, a view the caller can no longer see on
// that list (deleted, unshared, a location left) is left out, so the answer only ever names
// views the list page has. Written whole (PUT), every id checked to be a view of that list the
// caller can see; audited `saved_view_prefs.update` on the caller's own account, as hints are
// (home/service.ts), and only when something changed.

export const SavedViewPrefsSchema = z.object({
  defaultViewId: z.uuid().nullable(),
  pinned: z.array(z.uuid()),
});
export type SavedViewPrefs = z.infer<typeof SavedViewPrefsSchema>;

export const SavedViewPrefsBody = z.strictObject({
  defaultViewId: z.uuid().nullable(),
  pinned: z
    .array(z.uuid())
    .max(MAX_PINNED_VIEWS)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: 'Pin a view once.',
    }),
});

export const PrefsParams = z.object({ surface: z.enum(LIST_SURFACES) });

/** The caller's prefs on `surface`, naming only views they can still see there. */
export async function prefsOf(
  client: pg.ClientBase,
  surface: ListSurface,
): Promise<SavedViewPrefs> {
  const { rows } = await client.query<{ default_view_id: string | null; pinned: string[] }>(
    `SELECT (SELECT v.id FROM public.saved_views v
              WHERE v.id = p.default_view_id AND v.surface = p.surface) AS default_view_id,
            ARRAY(SELECT x.id FROM unnest(p.pinned) WITH ORDINALITY AS x(id, n)
                   WHERE EXISTS (SELECT 1 FROM public.saved_views v
                                  WHERE v.id = x.id AND v.surface = p.surface)
                   ORDER BY x.n)::text[] AS pinned
       FROM public.saved_view_prefs p
      WHERE p.user_id = kept.current_user_id() AND p.surface = $1`,
    [surface],
  );
  const row = rows[0];
  return { defaultViewId: row?.default_view_id ?? null, pinned: row?.pinned ?? [] };
}

export async function putPrefs(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  surface: ListSurface,
  body: z.infer<typeof SavedViewPrefsBody>,
  requestId: string,
): Promise<SavedViewPrefs> {
  const defaultViewId = body.defaultViewId?.toLowerCase() ?? null;
  const pinned = body.pinned.map((id) => id.toLowerCase());
  const wanted = [...new Set([...(defaultViewId ? [defaultViewId] : []), ...pinned])];
  if (wanted.length > 0) {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM public.saved_views WHERE id = ANY ($1::uuid[]) AND surface = $2',
      [wanted, surface],
    );
    const seen = new Set(rows.map((r) => r.id));
    const missing = wanted.find((id) => !seen.has(id));
    if (missing) {
      const field = missing === defaultViewId ? 'defaultViewId' : 'pinned';
      throw invalid(`body.${field}: ${missing} is not a saved view of the ${surface} list.`);
    }
  }
  const { rows: current } = await client.query<{
    default_view_id: string | null;
    pinned: string[];
  }>(
    `SELECT default_view_id, pinned::text[] AS pinned FROM public.saved_view_prefs
      WHERE user_id = kept.current_user_id() AND surface = $1 FOR UPDATE`,
    [surface],
  );
  const before = current[0]
    ? { default_view_id: current[0].default_view_id, pinned: current[0].pinned }
    : { default_view_id: null, pinned: [] as string[] };
  const after = { default_view_id: defaultViewId, pinned };
  const changed =
    before.default_view_id !== after.default_view_id ||
    before.pinned.join() !== after.pinned.join();
  if (changed) {
    await client.query(
      `INSERT INTO public.saved_view_prefs (user_id, surface, default_view_id, pinned)
       VALUES (kept.current_user_id(), $1, $2, $3::uuid[])
       ON CONFLICT (user_id, surface)
       DO UPDATE SET default_view_id = EXCLUDED.default_view_id, pinned = EXCLUDED.pinned`,
      [surface, defaultViewId, pinned],
    );
    const { rows: account } = await client.query<{ id: string | null }>(
      'SELECT kept.current_owner_account_id() AS id',
    );
    await audited(tx, {
      locationId: null,
      ownerAccountId: account[0]?.id ?? null,
      actor: { type: 'user', id: userId },
      action: 'saved_view_prefs.update',
      entity: { type: 'saved_view_prefs' },
      before: { [surface]: before },
      after: { [surface]: after },
      requestId,
    });
  }
  return { defaultViewId, pinned };
}
