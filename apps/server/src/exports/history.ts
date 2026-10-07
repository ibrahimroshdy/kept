import type { ExportHistoryEvent } from '@kept/shared';
import type pg from 'pg';
import { type AuditEventRow, type AuditViewer, renderAudit } from '../audit/render.js';
import type { Scope, Tx } from '../db/scope.js';
import { gateFor } from '../serialize/gates.js';

// The location's history in an export (§3.3: audit events "included in exports"; plan T12, Q10):
// every event of the location the requester can read, rendered through renderAudit() for them,
// so a secret is only `{changed: true}` and money follows their gate (D110). No custom-field
// labels are added (a label isn't part of a stored change, and the importer writes the changes
// back as stored, kept.import_history()). The actor travels by display name (`actor.name`), shown
// on import as "Alfred (before the import)".

const PAGE = 1000;

type EventRecord = {
  id: string;
  at: Date;
  at_key: string;
  location_id: string | null;
  owner_account_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  root_thing_id: string | null;
  diff: unknown;
  request_id: string | null;
  undo_of: string | null;
  undoable_until: Date | null;
  actor_name: string | null;
  subjects: string[];
};

const rowOf = (e: EventRecord): AuditEventRow =>
  ({
    id: e.id,
    at: e.at,
    locationId: e.location_id,
    ownerAccountId: e.owner_account_id,
    actorType: e.actor_type,
    actorId: e.actor_id,
    action: e.action,
    entityType: e.entity_type,
    entityId: e.entity_id,
    rootThingId: e.root_thing_id,
    diff: e.diff,
    requestId: e.request_id,
    undoOf: e.undo_of,
    undoableUntil: e.undoable_until,
  }) as AuditEventRow;

/** The requester as a reader of the location's events. */
export async function historyViewer(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  locationId: string,
): Promise<AuditViewer> {
  const gate = await gateFor(tx, locationId, scope);
  const { rows } = await client.query<{ id: string }>(
    'SELECT v AS id FROM kept.visible_location_ids() v',
  );
  return {
    role: gate.role,
    moneyVisibleToViewers: gate.moneyVisibleToViewers,
    moneyModule: gate.modules.has('money'),
    visibleLocationIds: new Set(rows.map((r) => r.id)),
  };
}

/** Every event of the location the requester reads, oldest first, rendered for `viewer`. */
export async function* readHistory(
  client: pg.ClientBase,
  locationId: string,
  viewer: AuditViewer,
): AsyncGenerator<ExportHistoryEvent> {
  let after: [string, string] | null = null;
  for (;;) {
    const params: unknown[] = [locationId];
    let keyset = '';
    if (after) {
      params.push(after[0], after[1]);
      keyset = 'AND (e.at, e.id) > ($2::timestamptz, $3::uuid)';
    }
    const { rows } = await client.query<EventRecord>(
      `SELECT e.id, e.at, e.at::text AS at_key, e.location_id, e.owner_account_id, e.actor_type,
              e.actor_id, e.action, e.entity_type, e.entity_id, e.root_thing_id, e.diff,
              e.request_id, e.undo_of, e.undoable_until, up.display_name AS actor_name,
              ARRAY(SELECT s.thing_id FROM public.audit_event_subjects s
                     WHERE s.event_id = e.id AND s.event_at = e.at ORDER BY s.thing_id)::text[]
                AS subjects
         FROM public.audit_events e
         LEFT JOIN public.user_profiles up ON e.actor_type = 'user' AND up.user_id = e.actor_id
        WHERE e.location_id = $1 ${keyset}
        ORDER BY e.at, e.id
        LIMIT ${PAGE}`,
      params,
    );
    for (const e of rows) {
      const r = renderAudit(rowOf(e), viewer);
      // D183: a move from a location the requester can't see carries no diff, and no name.
      const hidden = r.movedInFromElsewhere === true;
      yield {
        id: r.id,
        at: r.at,
        action: r.action,
        actor: { type: r.actor.type, id: r.actor.id, name: hidden ? null : e.actor_name },
        entity: r.entity,
        rootThingId: r.root_thing_id,
        subjects: e.subjects ?? [],
        diff: r.diff,
        undoOf: r.undo_of,
      };
    }
    if (rows.length < PAGE) return;
    const last = rows.at(-1) as EventRecord;
    after = [last.at_key, last.id];
  }
}
