import { createHash } from 'node:crypto';
import {
  effectiveModules,
  type LoanDirection,
  MIN_PAYLOAD_VERSION,
  PAYLOAD_VERSION,
  type Preset,
  type Role,
  type SnapCode,
  type SnapLegacyCode,
  type SnapLocation,
  type SnapMeter,
  type SnapPlace,
  type SnapRemoved,
  type SnapshotPage,
  type SnapThing,
  type SnapType,
  SYNC_LIMITS,
} from '@kept/shared';
import type pg from 'pg';
import { switchedOn } from '../locations/views.js';
import { decimalOut } from '../meters/check.js';
import {
  type After,
  type CursorState,
  FROM_START,
  type Pass,
  SNAPSHOT_TABLES,
  type SnapshotTable,
  type Watermarks,
} from './cursor.js';

// The offline snapshot (plan T12; engineering spec §2.2, §7.4; D17, D36, D156, D159; plan Q1,
// Q21, Q30). One page of `GET /api/v1/sync/snapshot`, read as the signed-in person on kept_app,
// so row-level security decides what is visible: nothing here filters by membership itself.
//
// A pass reads, per table in the order places → things → codes → legacy codes → tombstones, the
// rows whose change_xid is at or after their location's watermark, in (location, key) order:
// things and places by id, codes by code, legacy codes and tombstones by their primary key. The
// locations that share a watermark are read in one query per table. A row that changes
// after the pass has read it carries a change_xid at or after the pass's horizon, so the next
// pass reads it again; a duplicate is harmless (the phone upserts). The first pass of a location
// reads it in full and leaves out the trash and the tombstones, which a phone starting empty has
// no use for.
//
// Never here (D36, D159, Q21): money, secrets, documents, notes, custom fields, contact details.
// The rows below carry no such column; the snapshot's tests search the whole response for them.
//
// A thing carries its meters (id, kind, unit, label, and from step 5 the latest reading's value
// and time), for READING and "Log a reading" offline. A meter added or renamed bumps its thing's
// `meter_version` (0047), and so does a reading (0061), so a delta resends the thing.

export type SnapshotOptions = {
  /** Rows per page, across the change tables and the tombstones. */
  limit: number;
  /** The types hash the phone holds; the items come only when it differs. */
  typesHash?: string | undefined;
  /** Live things per person (Q30); a test lowers it. */
  thingCap?: number;
};

export type SnapshotResult = {
  page: Omit<SnapshotPage, 'nextCursor'>;
  /** The state `nextCursor` signs. */
  next: CursorState;
};

/** Tombstones of these kinds reach the phone; `thing_link` and the rest are the server's own. */
const REMOVED_KINDS = ['thing', 'place', 'code', 'legacy_code'] as const;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

type LocationRow = {
  id: string;
  name: string;
  kind: string;
  timezone: string;
  languages: string[];
  preset: Preset;
  latitude: number | null;
  longitude: number | null;
  suggest_radius_m: number;
  role: Role;
  unplaced_id: string | null;
  provider_resolved: boolean | null;
};

/** Every location the person can see now, with their role there. */
async function visibleLocations(client: pg.ClientBase): Promise<SnapLocation[]> {
  const { rows } = await client.query<LocationRow>(
    `SELECT l.id, l.name, l.kind, l.timezone, l.languages, l.preset, l.latitude, l.longitude,
            l.suggest_radius_m, m.role,
            (SELECT p.id FROM public.places p
              WHERE p.location_id = l.id AND p.is_unplaced) AS unplaced_id,
            kept.ai_provider_resolved(l.id) AS provider_resolved
       FROM public.locations l
       JOIN public.memberships m ON m.location_id = l.id AND m.user_id = kept.current_user_id()
      ORDER BY l.id`,
  );
  if (rows.length === 0) return [];
  const switches = await client.query<{ location_id: string; module: string; enabled: boolean }>(
    'SELECT location_id, module, enabled FROM public.location_modules WHERE location_id = ANY($1)',
    [rows.map((r) => r.id)],
  );
  const byLocation = new Map<string, { module: string; enabled: boolean }[]>();
  for (const s of switches.rows) {
    const list = byLocation.get(s.location_id) ?? [];
    list.push(s);
    byLocation.set(s.location_id, list);
  }
  return rows.map((r) => {
    const enabled = switchedOn(r.preset, byLocation.get(r.id) ?? []);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      timezone: r.timezone,
      languages: r.languages,
      role: r.role,
      // As the location API computes it (locations/views.ts): step 3 (T9, D191), the AI
      // modules follow a provider that resolves for the caller in the location.
      effectiveModules: [
        ...effectiveModules(enabled, { providerResolved: r.provider_resolved === true }),
      ],
      unplacedPlaceId: r.unplaced_id ?? '',
      ...(r.latitude !== null ? { latitude: r.latitude } : {}),
      ...(r.longitude !== null ? { longitude: r.longitude } : {}),
      suggestRadiusM: r.suggest_radius_m,
    };
  });
}

/** The types the person's things can have (built-ins and their accounts'), field groups left
 * out, with the hash the phone compares. */
async function visibleTypes(client: pg.ClientBase): Promise<{ hash: string; items: SnapType[] }> {
  const { rows } = await client.query<{
    id: string;
    builtin_key: string | null;
    name: string | null;
    icon: string;
    is_container: boolean;
  }>(
    `SELECT t.id, t.builtin_key, t.name, t.icon,
            coalesce('container' = ANY (kept.type_capabilities(t.id)), false) AS is_container
       FROM public.types t
      WHERE NOT t.is_field_group
      ORDER BY t.id`,
  );
  const items = rows.map((r) => ({
    id: r.id,
    builtinKey: r.builtin_key,
    // A built-in's name is its key; the phone shows the translated name for it.
    name: r.name ?? r.builtin_key ?? '',
    icon: r.icon,
    isContainer: r.is_container,
  }));
  const hash = createHash('sha256').update(JSON.stringify(items)).digest('base64url').slice(0, 22);
  return { hash, items };
}

/** A new pass: its horizon, the watermark of each location it reads, and the truncation cut. */
async function startPass(
  client: pg.ClientBase,
  w: Watermarks,
  visible: readonly string[],
  cap: number,
): Promise<Pass> {
  const { rows } = await client.query<{ x: string }>(
    'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS x',
  );
  const l: Watermarks = {};
  for (const id of visible) l[id] = w[id] ?? FROM_START;
  const pass: Pass = { x: rows[0]?.x as string, l, a: null };
  // Past the cap, the most recently seen are kept (Q30). Counted under the person's policies.
  const count = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.things WHERE deleted_at IS NULL',
  );
  if ((count.rows[0]?.n ?? 0) > cap) {
    const cut = await client.query<{ seen: string; id: string }>(
      `SELECT last_seen_at::text AS seen, id FROM public.things WHERE deleted_at IS NULL
        ORDER BY last_seen_at DESC, id DESC OFFSET $1 LIMIT 1`,
      [cap - 1],
    );
    const row = cut.rows[0];
    if (row) pass.c = [row.seen, row.id];
  }
  return pass;
}

/** Where a read stopped: the location and the last row's key in its table's order. */
type Mark = { l: string; k: string[] };

/** What one read gave: how many rows, and where it stopped. */
type Read = { count: number; last: Mark | null };

const readOf = <R extends { location_id: string }>(rows: R[], key: (row: R) => string[]): Read => {
  const last = rows.at(-1);
  return {
    count: rows.length,
    last: last === undefined ? null : { l: last.location_id, k: key(last) },
  };
};

type Collected = {
  places: SnapPlace[];
  things: SnapThing[];
  codes: SnapCode[];
  legacyCodes: SnapLegacyCode[];
  removed: SnapRemoved[];
};

/** What every read of a page shares. */
type PageContext = {
  client: pg.ClientBase;
  /** The pass's truncation cut, if any. */
  cut: [string, string] | undefined;
  /** Types that make a thing a container (their capabilities, inherited, include it). */
  containerTypes: ReadonlySet<string>;
  out: Collected;
};

/**
 * One read: up to `limit` rows of a table in `locations` (which share one watermark, `since`;
 * null reads them in full), in (location, key) order, after `after`.
 */
type Slice = {
  locations: string[];
  since: string | null;
  after: Mark | null;
  limit: number;
};

type Key = { col: string; cast: string; min: string };

/**
 * The WHERE and ORDER BY of one read, with its parameters: the locations, the keyset after
 * `q.after`, and the watermark (or, for a full read, the trash left out). One location reads by
 * `location_id = $` and its own key, which the (location_id, key) indexes answer in order and stop
 * at the limit; several (a delta, whose rows are few) by `= ANY` and (location_id, key).
 */
function sliceSql(alias: string, keys: readonly Key[], q: Slice, trash: boolean) {
  const values: unknown[] = [];
  const param = (v: unknown, cast: string) => {
    values.push(v);
    return `$${values.length}::${cast}`;
  };
  const cols = keys.map((k) => `${alias}.${k.col}`);
  let where: string;
  let order: string;
  if (q.locations.length === 1) {
    const location = q.locations[0] as string;
    const from = q.after?.l === location ? q.after.k : keys.map((k) => k.min);
    where = `${alias}.location_id = ${param(location, 'uuid')}
         AND (${cols.join(', ')}) > (${from.map((v, i) => param(v, (keys[i] as Key).cast)).join(', ')})`;
    order = cols.join(', ');
  } else {
    const from = q.after ? [q.after.l, ...q.after.k] : [ZERO_UUID, ...keys.map((k) => k.min)];
    const casts = ['uuid', ...keys.map((k) => k.cast)];
    where = `${alias}.location_id = ANY (${param(q.locations, 'uuid[]')})
         AND (${alias}.location_id, ${cols.join(', ')})
             > (${from.map((v, i) => param(v, casts[i] as string)).join(', ')})`;
    order = `${alias}.location_id, ${cols.join(', ')}`;
  }
  if (q.since !== null) where += ` AND ${alias}.change_xid >= ${param(q.since, 'xid8')}`;
  else if (trash) where += ` AND ${alias}.deleted_at IS NULL`;
  return { where, order, values, param };
}

const ID_KEY: readonly Key[] = [{ col: 'id', cast: 'uuid', min: ZERO_UUID }];

async function readPlaces({ client, out }: PageContext, q: Slice): Promise<Read> {
  const w = sliceSql('p', ID_KEY, q, true);
  const limit = w.param(q.limit, 'int');
  const { rows } = await client.query<{
    id: string;
    location_id: string;
    parent_id: string | null;
    name: string;
    kind_key: string;
    icon: string | null;
    is_unplaced: boolean;
    sort: number;
    deleted: boolean;
  }>(
    `SELECT p.id, p.location_id, p.parent_id, p.name, p.kind_key, p.icon, p.is_unplaced, p.sort,
            p.deleted_at IS NOT NULL AS deleted
       FROM public.places p
      WHERE ${w.where}
      ORDER BY ${w.order}
      LIMIT ${limit}`,
    w.values,
  );
  for (const r of rows) {
    out.places.push({
      id: r.id,
      locationId: r.location_id,
      parentId: r.parent_id,
      name: r.name,
      kindKey: r.kind_key,
      icon: r.icon,
      isUnplaced: r.is_unplaced,
      sort: r.sort,
      deleted: r.deleted,
    });
  }
  return readOf(rows, (r) => [r.id]);
}

type ThingRow = {
  id: string;
  location_id: string;
  short_code: string | null;
  name: string | null;
  type_id: string | null;
  place_id: string | null;
  container_id: string | null;
  quantity: string;
  aliases: Record<string, string[]>;
  lifecycle: SnapThing['lifecycle'];
  review_state: SnapThing['reviewState'];
  location_uncertain: boolean;
  last_seen_at: Date;
  cover_file_id: string | null;
  deleted: boolean;
  loan_direction: LoanDirection | null;
  loan_person: string | null;
  loan_due_on: string | null;
  in_repair: boolean;
};

async function readThings(ctx: PageContext, q: Slice): Promise<Read> {
  const { client, cut, out } = ctx;
  const w = sliceSql('t', ID_KEY, q, true);
  const cutSql = cut
    ? `AND (t.deleted_at IS NOT NULL
            OR (t.last_seen_at, t.id) >= (${w.param(cut[0], 'timestamptz')}, ${w.param(cut[1], 'uuid')}))`
    : '';
  const limit = w.param(q.limit, 'int');
  const { rows } = await client.query<ThingRow>(
    `SELECT t.id, t.location_id, s.code AS short_code, t.name, t.type_id, t.place_id,
            t.container_id, t.quantity::text AS quantity, t.aliases, t.lifecycle, t.review_state,
            t.location_uncertain, t.last_seen_at, t.cover_file_id,
            t.deleted_at IS NOT NULL AS deleted,
            ln.direction AS loan_direction, ln.person AS loan_person, ln.due_on AS loan_due_on,
            EXISTS (SELECT 1 FROM public.claims k
                     WHERE k.thing_id = t.id AND k.status = 'in_repair') AS in_repair
       FROM public.things t
       LEFT JOIN public.short_ids s
              ON s.thing_id = t.id AND s.is_primary AND s.state = 'assigned'
       -- Step 4 (Q34): the open loan, a name and a due date only; never a contact detail (D36).
       LEFT JOIN LATERAL (
         SELECT o.direction, coalesce(pe.display_name, '') AS person, o.due_on::text AS due_on
           FROM public.loans o LEFT JOIN public.people pe ON pe.id = o.person_id
          WHERE o.thing_id = t.id AND o.returned_at IS NULL LIMIT 1) ln ON true
      WHERE ${w.where} ${cutSql}
      ORDER BY ${w.order}
      LIMIT ${limit}`,
    w.values,
  );
  // A thing holding something is a container whatever its type. Asked for this page's rows by
  // the container index: as a subquery the planner hashes every visible thing, on every page.
  const holders = new Set<string>();
  if (rows.length > 0) {
    const held = await client.query<{ id: string }>(
      `SELECT DISTINCT c.container_id AS id FROM public.things c
        WHERE c.container_id = ANY ($1::uuid[]) AND c.deleted_at IS NULL`,
      [rows.map((r) => r.id)],
    );
    for (const h of held.rows) holders.add(h.id);
  }
  // Their meters, under the policies, oldest first (as the thing page lists them).
  const meters = new Map<string, SnapMeter[]>();
  if (rows.length > 0) {
    // Step 5 (Q18): each meter's latest accepted reading, offset-corrected by the replacement in
    // force when it was taken (as kept.meter_estimate() reads it), for offline "Log a reading".
    // A reading bumps its thing's meter_version (0061), so a delta resends it.
    const found = await client.query<
      Omit<SnapMeter, 'latest'> & { thing_id: string; value: string | null; taken_at: Date | null }
    >(
      `SELECT m.thing_id, m.id, m.kind, m.unit, m.label,
              trim_scale(l.value + coalesce(
                (SELECT e."offset" FROM public.meter_events e
                  WHERE e.meter_id = m.id AND e.kind = 'replaced' AND e.at <= l.taken_at
                  ORDER BY e.at DESC, e.id DESC LIMIT 1), 0))::text AS value,
              l.taken_at
         FROM public.meters m
         LEFT JOIN LATERAL (
           SELECT r.value, r.taken_at FROM public.meter_readings r
            WHERE r.meter_id = m.id AND r.state = 'accepted'
            ORDER BY r.taken_at DESC, r.received_at DESC, r.id DESC LIMIT 1) l ON true
        WHERE m.thing_id = ANY ($1::uuid[])
        ORDER BY m.thing_id, m.created_at, m.id`,
      [rows.filter((r) => !r.deleted).map((r) => r.id)],
    );
    for (const { thing_id, value, taken_at, ...m } of found.rows) {
      const list = meters.get(thing_id) ?? [];
      list.push({
        ...m,
        ...(value !== null && taken_at
          ? { latest: { value, takenAt: taken_at.toISOString() } }
          : {}),
      });
      meters.set(thing_id, list);
    }
  }
  for (const r of rows) {
    // Step 4 (D119, Q34): lent, borrowed and in repair, and the open loan, for the offline path.
    const derived: NonNullable<SnapThing['derived']> = [];
    if (r.loan_direction === 'out') derived.push('lent');
    if (r.loan_direction === 'in') derived.push('borrowed');
    if (r.in_repair) derived.push('in_repair');
    out.things.push({
      id: r.id,
      locationId: r.location_id,
      shortCode: r.short_code,
      name: r.name,
      typeId: r.type_id,
      placeId: r.place_id,
      containerId: r.container_id,
      quantity: decimalOut(r.quantity),
      aliases: r.aliases,
      lifecycle: r.lifecycle,
      reviewState: r.review_state,
      locationUncertain: r.location_uncertain,
      lastSeenAt: r.last_seen_at.toISOString(),
      coverFileId: r.cover_file_id,
      isContainer: holders.has(r.id) || (r.type_id !== null && ctx.containerTypes.has(r.type_id)),
      meters: meters.get(r.id) ?? [],
      ...(derived.length > 0 ? { derived } : {}),
      ...(r.loan_direction
        ? {
            loan: {
              direction: r.loan_direction,
              personName: r.loan_person ?? '',
              dueOn: r.loan_due_on,
            },
          }
        : {}),
      deleted: r.deleted,
    });
  }
  return readOf(rows, (r) => [r.id]);
}

async function readCodes({ client, out }: PageContext, q: Slice): Promise<Read> {
  const w = sliceSql('c', [{ col: 'code', cast: 'bpchar', min: '' }], q, false);
  const limit = w.param(q.limit, 'int');
  const { rows } = await client.query<{
    code: string;
    location_id: string;
    thing_id: string | null;
    place_id: string | null;
    state: SnapCode['state'];
    is_primary: boolean;
  }>(
    `SELECT c.code, c.location_id, c.thing_id, c.place_id, c.state, c.is_primary
       FROM public.short_ids c
      WHERE ${w.where}
      ORDER BY ${w.order}
      LIMIT ${limit}`,
    w.values,
  );
  for (const r of rows) {
    out.codes.push({
      code: r.code,
      locationId: r.location_id,
      thingId: r.thing_id,
      placeId: r.place_id,
      state: r.state,
      isPrimary: r.is_primary,
    });
  }
  return readOf(rows, (r) => [r.code]);
}

const LEGACY_KEY: readonly Key[] = [
  { col: 'source', cast: 'text', min: '' },
  { col: 'source_collection', cast: 'text', min: '' },
  { col: 'code', cast: 'text', min: '' },
];

async function readLegacyCodes({ client, out }: PageContext, q: Slice): Promise<Read> {
  const w = sliceSql('g', LEGACY_KEY, q, false);
  const limit = w.param(q.limit, 'int');
  const { rows } = await client.query<{
    location_id: string;
    source: string;
    source_collection: string;
    code: string;
    thing_id: string | null;
    place_id: string | null;
  }>(
    `SELECT g.location_id, g.source, g.source_collection, g.code, g.thing_id, g.place_id
       FROM public.legacy_codes g
      WHERE ${w.where}
      ORDER BY ${w.order}
      LIMIT ${limit}`,
    w.values,
  );
  for (const r of rows) {
    out.legacyCodes.push({
      locationId: r.location_id,
      source: r.source,
      sourceCollection: r.source_collection,
      code: r.code,
      thingId: r.thing_id,
      placeId: r.place_id,
    });
  }
  return readOf(rows, (r) => [r.source, r.source_collection, r.code]);
}

const TOMBSTONE_KEY: readonly Key[] = [
  { col: 'entity_type', cast: 'text', min: '' },
  { col: 'entity_id', cast: 'uuid', min: ZERO_UUID },
];

async function readTombstones({ client, out }: PageContext, q: Slice): Promise<Read> {
  // A location's first pass starts the phone from nothing: there is nothing to remove.
  if (q.since === null) return { count: 0, last: null };
  const w = sliceSql('z', TOMBSTONE_KEY, q, false);
  const kinds = w.param(REMOVED_KINDS, 'text[]');
  const limit = w.param(q.limit, 'int');
  const { rows } = await client.query<{
    location_id: string;
    entity_type: SnapRemoved['entityType'];
    entity_id: string;
    entity_key: string | null;
  }>(
    `SELECT z.location_id, z.entity_type, z.entity_id, z.entity_key
       FROM public.sync_tombstones z
      WHERE ${w.where} AND z.entity_type = ANY (${kinds})
      ORDER BY ${w.order}
      LIMIT ${limit}`,
    w.values,
  );
  for (const r of rows) {
    // A code's or legacy code's tombstone carries its text key (0046, T17a): the short ID, or
    // legacyCodeKey(); its entity_id is only that key's hash.
    out.removed.push({
      locationId: r.location_id,
      entityType: r.entity_type,
      entityId: r.entity_key ?? r.entity_id,
    });
  }
  return readOf(rows, (r) => [r.entity_type, r.entity_id]);
}

const READERS: Record<SnapshotTable, (ctx: PageContext, q: Slice) => Promise<Read>> = {
  places: readPlaces,
  things: readThings,
  codes: readCodes,
  legacyCodes: readLegacyCodes,
  tombstones: readTombstones,
};

/**
 * Where a pass resumes: per table, the groups its reads go by, in (watermark, location) order.
 * The locations that share a watermark (usually all of them: those of the last complete pass)
 * are one group, read in one query; a location read in full is a group of its own.
 */
function* remaining(pass: Pass, visible: ReadonlySet<string>) {
  const groups: [since: string, locations: string[]][] = [];
  const bySince = new Map<string, string[]>();
  for (const id of Object.keys(pass.l).sort()) {
    if (!visible.has(id)) continue;
    const since = pass.l[id] as string;
    // A full read goes one location at a time, down its index; deltas share one query.
    if (since === FROM_START) groups.push([since, [id]]);
    else bySince.set(since, [...(bySince.get(since) ?? []), id]);
  }
  groups.push(...bySince.entries());
  const order = (g: [string, string[]]) => `${g[0].padStart(20, '0')}:${g[1][0]}`;
  groups.sort((x, y) => (order(x) < order(y) ? -1 : order(x) > order(y) ? 1 : 0));
  const a = pass.a;
  const aSince = a ? pass.l[a.l] : undefined;
  const first = a ? SNAPSHOT_TABLES.indexOf(a.t) : 0;
  for (let i = first; i < SNAPSHOT_TABLES.length; i++) {
    const table = SNAPSHOT_TABLES[i] as SnapshotTable;
    for (const [since, locations] of groups) {
      let after: Mark | null = null;
      if (a && aSince !== undefined && i === first) {
        const pad = (x: string) => x.padStart(20, '0');
        if (pad(since) < pad(aSince)) continue;
        if (since === aSince) {
          // Wholly before where the last page stopped: done. Otherwise resume after it (a group
          // of one location that comes after it starts from its beginning).
          if ((locations.at(-1) as string) < a.l) continue;
          after = { l: a.l, k: a.k };
        }
      }
      yield { table, since, locations, after };
    }
  }
}

/**
 * One page. `state` is the verified cursor (FIRST_SYNC without one); the result's `next` is what
 * the next cursor signs. A page is complete when the pass has read everything and it read every
 * location the person can see; a location they joined during the pass starts another pass
 * straight away (`complete: false`), which reads it in full.
 */
export async function snapshotPage(
  client: pg.ClientBase,
  state: CursorState,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  const asOf = new Date().toISOString();
  const locations = await visibleLocations(client);
  const visibleIds = locations.map((l) => l.id);
  const visible = new Set(visibleIds);
  const types = await visibleTypes(client);
  const pass =
    state.p ??
    (await startPass(client, state.w, visibleIds, opts.thingCap ?? SYNC_LIMITS.snapshotThings));

  const known = new Set([...Object.keys(state.w), ...Object.keys(pass.l)]);
  const revokedLocationIds = [...known].filter((id) => !visible.has(id)).sort();

  const out: Collected = { places: [], things: [], codes: [], legacyCodes: [], removed: [] };
  const ctx: PageContext = {
    client,
    cut: pass.c,
    containerTypes: new Set(types.items.filter((t) => t.isContainer).map((t) => t.id)),
    out,
  };
  let budget = opts.limit;
  let stoppedAt: After | null = null;
  for (const step of remaining(pass, visible)) {
    const read = await READERS[step.table](ctx, {
      locations: step.locations,
      since: step.since === FROM_START ? null : step.since,
      after: step.after,
      limit: budget,
    });
    budget -= read.count;
    if (budget <= 0 && read.last) {
      // Full: resume after the last row read (an exhausted table just reads nothing next time).
      stoppedAt = { t: step.table, l: read.last.l, k: read.last.k };
      break;
    }
  }

  const page: Omit<SnapshotPage, 'nextCursor'> = {
    asOf,
    payloadVersion: PAYLOAD_VERSION,
    minPayloadVersion: MIN_PAYLOAD_VERSION,
    locations,
    types: types.hash === opts.typesHash ? { hash: types.hash } : types,
    changes: {
      places: out.places,
      things: out.things,
      codes: out.codes,
      legacyCodes: out.legacyCodes,
    },
    removed: out.removed,
    revokedLocationIds,
    complete: false,
    ...(pass.c ? { truncated: true } : {}),
  };

  if (stoppedAt) {
    return { page, next: { v: 1, w: state.w, p: { ...pass, a: stoppedAt } } };
  }
  // The pass is done: every location it read now starts from its horizon.
  const w: Watermarks = {};
  for (const id of Object.keys(pass.l)) if (visible.has(id)) w[id] = pass.x;
  page.complete = visibleIds.every((id) => id in pass.l);
  return { page, next: { v: 1, w, p: null } };
}
