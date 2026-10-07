import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import { conflict } from '../http/errors.js';
import { requireCan } from '../locations/access.js';
import { type DOCUMENT_COLUMNS, findIncident, incidentImage } from './service.js';

// The undo handlers of incidents (D150, Q25; step-4 plan T18), registered with audit/undo.ts by
// incidentRoutes(). The route has already checked the event is visible, the caller's own or the
// caller an owner or admin, and still in its window; each handler also requires
// `incidents.manage`, as the write did.
//
// - `incident.update`: every changed field must still hold the event's `after` (D124), then each
//   `before` goes back.
// - `incident.things`: the incident's thing list must still be the event's `after`; it goes back
//   to `before` (a thing that has left the location since is a 409). Lifecycles ended by the same
//   request are their own `thing.lifecycle` events, undone on their own.
// - `incident.delete` (a hard delete, Q25): the row comes back with its id, its things, the claims
//   that were under it (still in the location and not under another incident since) and its
//   documents. The undo transaction names its event (`app.undo`, 0056), so the row and its
//   documents come back with who made them, and a document's file links again when the undoer
//   can read it or the event held it (kept.undo_holds_file); when a file is gone (purged), the
//   undo is refused whole rather than bringing the incident back without it.

const FIELDS = ['kind', 'occurred_on', 'police_reference', 'insurer_reference', 'notes'] as const;
type Field = (typeof FIELDS)[number];
const IS_FIELD = new Set<string>(FIELDS);

async function manage(args: UndoArgs): Promise<void> {
  requireCan(args.role, 'incidents.manage', 'Only owners and admins can change incidents.');
}

async function refuseIfChanged(args: UndoArgs, current: Record<string, unknown>) {
  const conflicts = changedSince(args.event.diff, current);
  if (conflicts.length > 0) {
    const who = await lastChangedBy(
      args.client,
      args.event.locationId,
      { type: 'incident', id: args.event.entityId as string },
      args.event.at,
    );
    throw undoConflict(conflicts, who);
  }
}

async function undoUpdate(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'incident' || !id) throw notUndoable();
  await manage(args);
  const found = await findIncident(client, id, true);
  if (!found || found.location_id !== event.locationId) {
    throw conflict("Can't undo: that incident no longer exists.");
  }
  const current = (await incidentImage(client, id)) as Record<string, unknown>;
  await refuseIfChanged(args, current);
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [field, change] of Object.entries(event.diff)) {
    if (!IS_FIELD.has(field) || !('before' in change)) throw notUndoable();
    values.push(change.before ?? null);
    sets.push(`${field as Field} = $${values.length}${field === 'occurred_on' ? '::date' : ''}`);
  }
  if (sets.length > 0) {
    await client.query(`UPDATE public.incidents SET ${sets.join(', ')} WHERE id = $1`, values);
  }
  await args.audit({
    action: event.action,
    entity: { type: 'incident', id },
    before: current,
    after: await incidentImage(client, id),
  });
}

async function undoThings(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  const change = event.diff.thing_ids;
  if (event.entityType !== 'incident' || !id || !change || !('before' in change)) {
    throw notUndoable();
  }
  await manage(args);
  const found = await findIncident(client, id, true);
  if (!found || found.location_id !== event.locationId) {
    throw conflict("Can't undo: that incident no longer exists.");
  }
  const current = (await incidentImage(client, id)) as Record<string, unknown>;
  await refuseIfChanged(args, { thing_ids: current.thing_ids });
  const back = (change.before as string[] | null) ?? [];
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM public.things WHERE id = ANY ($1::uuid[]) AND location_id = $2',
    [back, found.location_id],
  );
  if (rows.length !== back.length) {
    throw conflict("Can't undo: a thing it listed has left the location since.");
  }
  await client.query(
    'DELETE FROM public.incident_things WHERE incident_id = $1 AND NOT (thing_id = ANY ($2::uuid[]))',
    [id, back],
  );
  await client.query(
    `INSERT INTO public.incident_things (location_id, incident_id, thing_id)
     SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
    [found.location_id, id, back],
  );
  await client.query('UPDATE public.incidents SET updated_at = now() WHERE id = $1', [id]);
  const after = (await incidentImage(client, id)) as Record<string, unknown>;
  await args.audit({
    action: event.action,
    entity: { type: 'incident', id },
    before: { thing_ids: current.thing_ids },
    after: { thing_ids: after.thing_ids },
  });
}

type Document = Record<(typeof DOCUMENT_COLUMNS)[number], unknown>;

async function undoDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'incident' || !id) throw notUndoable();
  await manage(args);
  const was = (field: string) => {
    const c = event.diff[field];
    return c && 'before' in c ? c.before : undefined;
  };
  const kind = was('kind');
  const occurredOn = was('occurred_on');
  if (typeof kind !== 'string' || typeof occurredOn !== 'string') throw notUndoable();
  if (await findIncident(client, id)) throw conflict("Can't undo: that incident is back already.");
  const locationId = event.locationId;

  const documents = ((was('documents') as Document[] | undefined) ?? []).filter(
    (d) => typeof d.id === 'string',
  );
  const held = documents.flatMap((d) =>
    typeof d.file_id === 'string' ? [{ id: d.id, file: d.file_id }] : [],
  );
  const fileIds = held.map((h) => h.file);
  if (fileIds.length > 0) {
    // Visible to the person undoing, or held by the event being undone (0056).
    const { rows } = await client.query<{ id: string }>(
      `SELECT DISTINCT h.file AS id FROM unnest($1::uuid[], $2::uuid[]) AS h(att, file)
        WHERE EXISTS (SELECT 1 FROM public.files f WHERE f.id = h.file AND f.location_id = $3)
           OR kept.undo_holds_file(h.att, h.file)`,
      [held.map((h) => h.id), fileIds, locationId],
    );
    if (rows.length !== new Set(fileIds).size) {
      throw conflict(
        "Can't undo: a document it had is no longer readable to you. Ask whoever added it.",
      );
    }
  }

  await client.query(
    `INSERT INTO public.incidents (id, location_id, kind, occurred_on, police_reference,
                                   insurer_reference, notes, created_by)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7, kept.current_user_id())`,
    [
      id,
      locationId,
      kind,
      occurredOn,
      was('police_reference') ?? null,
      was('insurer_reference') ?? null,
      was('notes') ?? null,
    ],
  );
  const thingIds = ((was('thing_ids') as string[] | undefined) ?? []).filter(
    (t) => typeof t === 'string',
  );
  if (thingIds.length > 0) {
    await client.query(
      `INSERT INTO public.incident_things (location_id, incident_id, thing_id)
       SELECT $1, $2, t.id FROM public.things t
        WHERE t.id = ANY ($3::uuid[]) AND t.location_id = $1`,
      [locationId, id, thingIds],
    );
  }
  const claimIds = ((was('claim_ids') as string[] | undefined) ?? []).filter(
    (c) => typeof c === 'string',
  );
  if (claimIds.length > 0) {
    await client.query(
      `UPDATE public.claims SET incident_id = $2
        WHERE id = ANY ($3::uuid[]) AND location_id = $1 AND incident_id IS NULL`,
      [locationId, id, claimIds],
    );
  }
  for (const d of documents) {
    await client.query(
      `INSERT INTO public.attachments (id, location_id, file_id, url, incident_id, role, sort,
                                       created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, kept.current_user_id())
       ON CONFLICT (id) DO NOTHING`,
      [d.id, locationId, d.file_id ?? null, d.url ?? null, id, d.role, d.sort ?? 0],
    );
  }
  await args.audit({
    action: event.action,
    entity: { type: 'incident', id },
    before: null,
    after: await incidentImage(client, id),
    subjects: thingIds,
  });
}

export function registerIncidentUndo(): void {
  registerUndo('incident.update', undoUpdate);
  registerUndo('incident.things', undoThings);
  registerUndo('incident.delete', undoDelete);
}
