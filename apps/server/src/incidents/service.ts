import type { ClaimStatus, IncidentKind } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import {
  ATTACHMENT_SELECT,
  type AttachmentRow,
  type AttachmentView,
  attachmentViews,
  MONEY_ROLES,
} from '../files/views.js';
import { assertClientId, checkVersion, pageOf } from '../http/conventions.js';
import { invalid, notFound } from '../http/errors.js';
import { locationModuleSet } from '../http/modules.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { readImage } from '../things/audit-image.js';
import { rowsOf, type ThingRow } from '../things/view.js';

// Incidents (D158, D169; engineering spec §1.4; step-4 plan T18): a burglary, fire, flood or loss
// grouping the things it touched, with its date, police and insurer references, notes and
// documents; claims (D54) may belong to one. They belong to the Warranties & claims module
// (product design §5: "incidents and claim packs"); the routes gate on it.
//
// Who: anyone who sees the location reads its incidents; owners and admins create, change and
// delete them (`incidents.manage`, §7.1; the policies of 0049 say the same). Every write runs as
// the request's user under row-level security.
//
// - Creating one may end the listed things with a lifecycle (stolen, destroyed, lost: D158): each
//   thing still in use gets its own `thing.lifecycle` event (undoable one by one, things/undo.ts)
//   besides the incident's `incident.create` (a create: not undoable, §7.7).
// - PATCH writes `incident.update`, POST …/things `incident.things` (the thing list before and
//   after), DELETE `incident.delete` with the full before-image (the row, its things, its
//   documents and the claims under it): all three undoable for 7 days (D150, Q25; undo.ts).
// - A hard delete (Q25): the incident's documents go with it (the attachments' foreign key), its
//   claims and claim packs lose the link (SET NULL).

export const MAX_INCIDENT_THINGS = 200;

const Day = z.iso.date();
const Ref = z.string().trim().min(1).max(100);
const Notes = z.string().max(5000);
const Lifecycle = z.enum(['stolen', 'destroyed', 'lost']);
const Kind = z.enum(['burglary', 'fire', 'flood', 'loss', 'other']);
const Ids = (max: number) => z.array(z.uuid()).max(max);

export const CreateIncidentBody = z
  .object({
    id: z.uuid().optional(),
    kind: Kind,
    occurredOn: Day,
    policeReference: Ref.optional(),
    insurerReference: Ref.optional(),
    notes: Notes.optional(),
    thingIds: Ids(MAX_INCIDENT_THINGS).optional(),
    lifecycle: Lifecycle.optional(),
  })
  .strict();
export type CreateIncidentBody = z.infer<typeof CreateIncidentBody>;

export const UpdateIncidentBody = z
  .object({
    kind: Kind.optional(),
    occurredOn: Day.optional(),
    policeReference: Ref.nullable().optional(),
    insurerReference: Ref.nullable().optional(),
    notes: Notes.nullable().optional(),
  })
  .strict();
export type UpdateIncidentBody = z.infer<typeof UpdateIncidentBody>;

export const IncidentThingsBody = z
  .object({
    add: Ids(MAX_INCIDENT_THINGS).optional(),
    remove: Ids(MAX_INCIDENT_THINGS).optional(),
    lifecycle: Lifecycle.optional(),
  })
  .strict();
export type IncidentThingsBody = z.infer<typeof IncidentThingsBody>;

export const IncidentsQuery = z.object({
  locationId: z.uuid().optional(),
  kind: Kind.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().max(2048).optional(),
});
export type IncidentsQuery = z.infer<typeof IncidentsQuery>;

export type IncidentRowView = {
  id: string;
  locationId: string;
  kind: IncidentKind;
  occurredOn: string;
  policeReference: string | null;
  insurerReference: string | null;
  thingCount: number;
  claimCount: number;
  rowVersion: number;
};

export type IncidentView = IncidentRowView & {
  notes: string | null;
  things: ThingRow[];
  claims: { id: string; thingId: string; status: ClaimStatus; reference: string | null }[];
  documents: AttachmentView[];
  createdBy: { displayName: string };
};

type IncidentRecord = {
  id: string;
  location_id: string;
  kind: IncidentKind;
  occurred_on: string;
  police_reference: string | null;
  insurer_reference: string | null;
  notes: string | null;
  created_by: string;
  created_at: Date;
  row_version: number;
  thing_count: number;
  claim_count: number;
};

const RECORD_COLUMNS = `i.id, i.location_id, i.kind, i.occurred_on::text AS occurred_on,
  i.police_reference, i.insurer_reference, i.notes, i.created_by, i.created_at, i.row_version,
  (SELECT count(*) FROM public.incident_things it WHERE it.incident_id = i.id)::int AS thing_count,
  (SELECT count(*) FROM public.claims k WHERE k.incident_id = i.id)::int AS claim_count`;

const rowView = (r: IncidentRecord): IncidentRowView => ({
  id: r.id,
  locationId: r.location_id,
  kind: r.kind,
  occurredOn: r.occurred_on,
  policeReference: r.police_reference,
  insurerReference: r.insurer_reference,
  thingCount: r.thing_count,
  claimCount: r.claim_count,
  rowVersion: r.row_version,
});

/** The incident as the caller sees it; null when invisible. */
export async function findIncident(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<IncidentRecord | null> {
  const { rows } = await client.query<IncidentRecord>(
    `SELECT ${RECORD_COLUMNS} FROM public.incidents i WHERE i.id = $1${lock ? ' FOR UPDATE OF i' : ''}`,
    [id.toLowerCase()],
  );
  return rows[0] ?? null;
}

/** The audited image of an incident: its columns and its things (sorted). */
export async function incidentImage(
  client: pg.ClientBase,
  id: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT i.kind, i.occurred_on::text AS occurred_on, i.police_reference, i.insurer_reference,
            i.notes,
            coalesce((SELECT array_agg(it.thing_id::text ORDER BY it.thing_id)
                        FROM public.incident_things it WHERE it.incident_id = i.id),
                     '{}'::text[]) AS thing_ids
       FROM public.incidents i WHERE i.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function incidentThingIds(client: pg.ClientBase, id: string): Promise<string[]> {
  const { rows } = await client.query<{ thing_id: string }>(
    'SELECT thing_id FROM public.incident_things WHERE incident_id = $1 ORDER BY thing_id',
    [id],
  );
  return rows.map((r) => r.thing_id);
}

/** The documents attached to an incident, money roles left out where money is hidden. */
async function documentsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  id: string,
  showMoney: boolean,
): Promise<AttachmentView[]> {
  const hidden = showMoney ? [] : [...MONEY_ROLES];
  const { rows } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT}
      WHERE a.incident_id = $1 AND NOT (a.role = ANY ($2::text[]))
      ORDER BY a.sort, a.id`,
    [id, hidden],
  );
  return attachmentViews(client, files, rows);
}

export async function incidentView(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage | null,
  id: string,
): Promise<IncidentView> {
  const r = await findIncident(client, id);
  if (!r) throw notFound();
  const gate = await gateFor(tx, r.location_id, scope);
  // In turn: all three read on the one client, which runs one query at a time.
  const thingIds = await incidentThingIds(client, r.id);
  const claims = await client.query<{
    id: string;
    thing_id: string;
    status: ClaimStatus;
    reference: string | null;
  }>(
    `SELECT id, thing_id, status, reference FROM public.claims
      WHERE incident_id = $1 ORDER BY opened_on, id`,
    [r.id],
  );
  const who = await client.query<{ display_name: string }>(
    'SELECT display_name FROM public.user_profiles WHERE user_id = $1',
    [r.created_by],
  );
  // Every thing the incident touched, ended ones included; rowsOf() leaves the trash out.
  const things = await rowsOf(client, files, thingIds);
  return {
    ...rowView(r),
    notes: r.notes,
    things,
    claims: claims.rows.map((c) => ({
      id: c.id,
      thingId: c.thing_id,
      status: c.status,
      reference: c.reference,
    })),
    documents: await documentsOf(client, files, r.id, gate.showMoney),
    createdBy: { displayName: who.rows[0]?.display_name ?? '' },
  };
}

// ---------------------------------------------------------------------------------------------
// GET /api/v1/incidents
// ---------------------------------------------------------------------------------------------

const Cursor = z.tuple([Day, z.uuid()]);

/** The incidents the caller can see, newest first, in locations where the module is on. */
export async function listIncidents(
  tx: Tx,
  client: pg.ClientBase,
  q: IncidentsQuery,
  after: unknown,
): Promise<{ items: IncidentRowView[]; next_cursor: string | null }> {
  let cursor: [string, string] | null = null;
  if (after !== null && after !== undefined) {
    const parsed = Cursor.safeParse(after);
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    cursor = parsed.data;
  }
  // The module is per location (§7.6): an incident in a location with Warranties & claims off
  // is paused, not listed.
  const { rows: locs } = await client.query<{ id: string }>(
    `SELECT id FROM public.locations
      WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id = $1)`,
    [q.locationId?.toLowerCase() ?? null],
  );
  const on: string[] = [];
  for (const l of locs) {
    const modules = await locationModuleSet(tx, l.id);
    if (modules?.has('warranties')) on.push(l.id);
  }
  const { rows } = await client.query<IncidentRecord>(
    `SELECT ${RECORD_COLUMNS} FROM public.incidents i
      WHERE i.location_id = ANY ($1::uuid[])
        AND ($2::text IS NULL OR i.kind = $2)
        AND ($3::date IS NULL OR (i.occurred_on, i.id) < ($3::date, $4::uuid))
      ORDER BY i.occurred_on DESC, i.id DESC
      LIMIT $5`,
    [on, q.kind ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, q.limit + 1],
  );
  const page = pageOf(rows, q.limit, (r) => [r.occurred_on, r.id]);
  return { items: page.items.map(rowView), next_cursor: page.next_cursor };
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export type WriteCtx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  files: FileStorage | null;
  requestId: string;
};

const actor = (scope: Scope) => actorOf(scope);

/** 404 unless the caller sees the location, 403 unless they manage its incidents. */
async function requireManager(client: pg.ClientBase, locationId: string): Promise<void> {
  const me = await requireMembership(client, locationId);
  requireCan(me.role, 'incidents.manage', 'Only owners and admins can record incidents.');
}

/** The things of `ids` in `locationId` the caller can see (drafts and the trash included: an
 * incident lists what it touched). 400 naming none of them when any is missing. */
async function requireThings(
  client: pg.ClientBase,
  locationId: string,
  ids: readonly string[],
  where: string,
): Promise<string[]> {
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
  if (unique.length === 0) return [];
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM public.things WHERE id = ANY ($1::uuid[]) AND location_id = $2',
    [unique, locationId],
  );
  if (rows.length !== unique.length) {
    throw invalid(`Check ${where}: every thing must be in the incident's location.`);
  }
  return unique;
}

/**
 * Ends each of `ids` still in use with `lifecycle` on `on` (D158): one `thing.lifecycle` event
 * each, undoable (things/undo.ts). Things already ended keep their end.
 */
async function endThings(
  ctx: WriteCtx,
  locationId: string,
  ids: readonly string[],
  lifecycle: 'stolen' | 'destroyed' | 'lost',
  on: string,
): Promise<string[]> {
  const ended: string[] = [];
  for (const id of ids) {
    const before = await readImage(ctx.client, id, { lock: true });
    if (before?.lifecycle !== 'in_use' || before.deleted_at !== null) continue;
    await ctx.client.query(
      `UPDATE public.things SET lifecycle = $2, ended_on = $3::date WHERE id = $1`,
      [id, lifecycle, on],
    );
    const after = await readImage(ctx.client, id);
    await audited(ctx.tx, {
      locationId,
      actor: actor(ctx.scope),
      action: 'thing.lifecycle',
      entity: { type: 'thing', id },
      before,
      after,
      rootThingId: id,
      subjects: [id],
      requestId: ctx.requestId,
      undoableUntil: undoableUntil(),
    });
    ended.push(id);
  }
  return ended;
}

export async function createIncident(
  ctx: WriteCtx,
  locationId: string,
  body: CreateIncidentBody,
): Promise<IncidentView> {
  const loc = locationId.toLowerCase();
  await requireManager(ctx.client, loc);
  const id = body.id ? assertClientId(body.id.toLowerCase()) : null;
  const thingIds = await requireThings(ctx.client, loc, body.thingIds ?? [], 'body.thingIds');
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO public.incidents (id, location_id, kind, occurred_on, police_reference,
                                   insurer_reference, notes, created_by)
     VALUES (coalesce($1::uuid, uuidv7()), $2, $3, $4::date, $5, $6, $7, kept.current_user_id())
     RETURNING id`,
    [
      id,
      loc,
      body.kind,
      body.occurredOn,
      body.policeReference ?? null,
      body.insurerReference ?? null,
      body.notes ?? null,
    ],
  );
  const incidentId = (rows[0] as { id: string }).id;
  if (thingIds.length > 0) {
    await ctx.client.query(
      `INSERT INTO public.incident_things (location_id, incident_id, thing_id)
       SELECT $1, $2, unnest($3::uuid[])`,
      [loc, incidentId, thingIds],
    );
  }
  await audited(ctx.tx, {
    locationId: loc,
    actor: actor(ctx.scope),
    action: 'incident.create',
    entity: { type: 'incident', id: incidentId },
    before: null,
    after: await incidentImage(ctx.client, incidentId),
    subjects: thingIds,
    requestId: ctx.requestId,
  });
  if (body.lifecycle) await endThings(ctx, loc, thingIds, body.lifecycle, body.occurredOn);
  return incidentView(ctx.tx, ctx.client, ctx.scope, ctx.files, incidentId);
}

/** The incident for a write: 404 invisible, 403 not a manager, 412 stale. */
async function writableIncident(
  ctx: WriteCtx,
  id: string,
  expected: number,
  fields: readonly string[],
): Promise<IncidentRecord> {
  const r = await findIncident(ctx.client, id, true);
  if (!r) throw notFound();
  await requireManager(ctx.client, r.location_id);
  if (r.row_version !== expected) {
    const who = await lastChangedBy(ctx.client, r.location_id, { type: 'incident', id: r.id });
    checkVersion(
      { rowVersion: r.row_version },
      expected,
      fields,
      who ? { displayName: who } : null,
    );
  }
  return r;
}

const COLUMN_OF = {
  kind: 'kind',
  occurredOn: 'occurred_on',
  policeReference: 'police_reference',
  insurerReference: 'insurer_reference',
  notes: 'notes',
} as const;

export async function updateIncident(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: UpdateIncidentBody,
): Promise<IncidentView> {
  const fields = Object.keys(body) as (keyof UpdateIncidentBody)[];
  const r = await writableIncident(ctx, id, expected, fields);
  const before = await incidentImage(ctx.client, r.id);
  const sets: string[] = [];
  const values: unknown[] = [r.id];
  for (const f of fields) {
    values.push(body[f] ?? null);
    sets.push(`${COLUMN_OF[f]} = $${values.length}${f === 'occurredOn' ? '::date' : ''}`);
  }
  if (sets.length === 0) throw invalid('Send at least one field to change.');
  await ctx.client.query(`UPDATE public.incidents SET ${sets.join(', ')} WHERE id = $1`, values);
  const after = await incidentImage(ctx.client, r.id);
  await audited(ctx.tx, {
    locationId: r.location_id,
    actor: actor(ctx.scope),
    action: 'incident.update',
    entity: { type: 'incident', id: r.id },
    before,
    after,
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
  return incidentView(ctx.tx, ctx.client, ctx.scope, ctx.files, r.id);
}

export async function changeIncidentThings(
  ctx: WriteCtx,
  id: string,
  expected: number,
  body: IncidentThingsBody,
): Promise<IncidentView> {
  const r = await writableIncident(ctx, id, expected, ['thingIds']);
  const add = await requireThings(ctx.client, r.location_id, body.add ?? [], 'body.add');
  const remove = [...new Set((body.remove ?? []).map((x) => x.toLowerCase()))];
  if (add.some((x) => remove.includes(x))) {
    throw invalid('A thing is either added or removed, not both.');
  }
  const before = await incidentImage(ctx.client, r.id);
  const was = new Set(before?.thing_ids as string[]);
  const added = add.filter((x) => !was.has(x));
  if (added.length > 0) {
    await ctx.client.query(
      `INSERT INTO public.incident_things (location_id, incident_id, thing_id)
       SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
      [r.location_id, r.id, added],
    );
  }
  if (remove.length > 0) {
    await ctx.client.query(
      'DELETE FROM public.incident_things WHERE incident_id = $1 AND thing_id = ANY ($2::uuid[])',
      [r.id, remove],
    );
  }
  // The thing list is the incident's: its version moves with it (If-Match on the next change).
  await ctx.client.query('UPDATE public.incidents SET updated_at = now() WHERE id = $1', [r.id]);
  const after = await incidentImage(ctx.client, r.id);
  await audited(ctx.tx, {
    locationId: r.location_id,
    actor: actor(ctx.scope),
    action: 'incident.things',
    entity: { type: 'incident', id: r.id },
    before: { thing_ids: before?.thing_ids ?? [] },
    after: { thing_ids: after?.thing_ids ?? [] },
    subjects: [...new Set([...added, ...remove])],
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
  if (body.lifecycle) await endThings(ctx, r.location_id, added, body.lifecycle, r.occurred_on);
  return incidentView(ctx.tx, ctx.client, ctx.scope, ctx.files, r.id);
}

/** The attachment columns a deleted incident's before-image keeps, for its undo. */
export const DOCUMENT_COLUMNS = ['id', 'file_id', 'url', 'role', 'sort', 'created_by'] as const;

export async function deleteIncident(ctx: WriteCtx, id: string, expected: number): Promise<void> {
  const r = await writableIncident(ctx, id, expected, []);
  const before = await incidentImage(ctx.client, r.id);
  const { rows: documents } = await ctx.client.query<Record<string, unknown>>(
    `SELECT ${DOCUMENT_COLUMNS.map((c) => `a.${c}`).join(', ')} FROM public.attachments a
      WHERE a.incident_id = $1 ORDER BY a.sort, a.id`,
    [r.id],
  );
  const { rows: claims } = await ctx.client.query<{ id: string }>(
    'SELECT id FROM public.claims WHERE incident_id = $1 ORDER BY id',
    [r.id],
  );
  await ctx.client.query('DELETE FROM public.incidents WHERE id = $1', [r.id]);
  await audited(ctx.tx, {
    locationId: r.location_id,
    actor: actor(ctx.scope),
    action: 'incident.delete',
    entity: { type: 'incident', id: r.id },
    before: {
      ...before,
      created_by: r.created_by,
      // `created_at` is bookkeeping, which audited() leaves out of a diff.
      recorded_at: r.created_at.toISOString(),
      documents,
      claim_ids: claims.map((c) => c.id),
    },
    after: null,
    subjects: (before?.thing_ids as string[] | undefined) ?? [],
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
}
