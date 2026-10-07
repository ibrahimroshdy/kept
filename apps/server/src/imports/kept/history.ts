import type { ExportHistoryEvent } from '@kept/shared';
import type pg from 'pg';
import { type IdMap, isUuid } from './ids.js';

// Carried history on a Kept import (engineering spec §3.3; step-7 plan T14, Q10). The export's
// `data/history.ndjson` holds the location's audit events as its exporter saw them (D110: a
// secret only `{changed: true}`, money per their gate). After every row is in, the job sends them
// in batches through kept.import_history() (0083), which writes them as `actor_type = 'import'`
// events (actor = the run) with the original actor's name kept for "Alfred (before the import)".
//
// Here each event is brought into the door's shape, or left out:
// - ids are remapped (IdMap); an event about something the import doesn't hold (a thing that
//   wasn't exported, an export or import run, another location's row) is left out, as is one
//   whose thing (`rootThingId`) isn't here; subjects not here are dropped from the event;
// - a diff keeps the stored shape only: `{before, after, class}` for plain and money, and
//   `{changed: true, class: 'secret'}`; money the exporter couldn't see (`hidden`) has no value to
//   carry and is left out of the diff; labels are dropped (they are rendered, not stored); ids in
//   before and after are remapped where they name something imported;
// - an event older than the two-year retention, in the future (another server's clock), or with
//   an action or entity type Kept doesn't write is left out and counted.

/** Events per call: the door's limit. */
export const HISTORY_BATCH = 5000;
const RETENTION_MS = 2 * 365.25 * 24 * 3600 * 1000;
const ACTION = /^[a-z][a-z0-9_.]{0,63}$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_SUBJECTS = 1000;
const MAX_ACTOR_NAME = 200;

/** One event in kept.import_history()'s shape. */
export type DoorEvent = {
  at: string;
  action: string;
  entityType: string;
  entityId: string | null;
  rootThingId: string | null;
  subjects: string[];
  diff: Record<string, StoredChange> | null;
  actorName: string | null;
};

type StoredChange =
  | { before: unknown; after: unknown; class: 'plain' | 'money' }
  | { changed: true; class: 'secret' };

/** What the import holds: the old ids of every row it wrote (the location's included). */
export type Known = { has(oldId: string): boolean };

function remapValue(value: unknown, ids: IdMap, known: Known): unknown {
  if (typeof value === 'string') {
    return isUuid(value) && known.has(value.toLowerCase()) ? ids.of(value) : value;
  }
  if (Array.isArray(value)) return value.map((v) => remapValue(v, ids, known));
  return value;
}

function diffOf(
  diff: ExportHistoryEvent['diff'],
  ids: IdMap,
  known: Known,
): Record<string, StoredChange> | null {
  if (!diff || typeof diff !== 'object') return null;
  const out: Record<string, StoredChange> = {};
  for (const [field, change] of Object.entries(diff)) {
    if (field === '_importedActor' || !change || typeof change !== 'object') continue;
    if (change.class === 'secret') out[field] = { changed: true, class: 'secret' };
    else if ((change.class === 'plain' || change.class === 'money') && !('hidden' in change)) {
      const c = change as { before: unknown; after: unknown };
      out[field] = {
        before: remapValue(c.before ?? null, ids, known),
        after: remapValue(c.after ?? null, ids, known),
        class: change.class,
      };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The event in the door's shape, or null when it is left out. `now` is this server's clock.
 */
export function doorEventOf(
  e: ExportHistoryEvent,
  ids: IdMap,
  known: Known,
  now: number,
): DoorEvent | null {
  const at = Date.parse(e.at);
  if (!Number.isFinite(at) || at > now || at < now - RETENTION_MS) return null;
  if (!ACTION.test(e.action) || !ENTITY_TYPE.test(e.entity.type)) return null;
  const here = (id: string | null) => !id || known.has(id.toLowerCase());
  if (!here(e.entity.id) || !here(e.rootThingId)) return null;
  const subjects = [
    ...new Set(
      (e.subjects ?? []).filter((s) => isUuid(s) && known.has(s.toLowerCase())).map(ids.of, ids),
    ),
  ].slice(0, MAX_SUBJECTS);
  const name = e.actor?.name?.trim() || null;
  return {
    at: new Date(at).toISOString(),
    action: e.action,
    entityType: e.entity.type,
    entityId: ids.ref(e.entity.id),
    rootThingId: ids.ref(e.rootThingId),
    subjects,
    diff: diffOf(e.diff, ids, known),
    actorName: name ? name.slice(0, MAX_ACTOR_NAME) : null,
  };
}

/** Writes one batch (at most HISTORY_BATCH) for run `runId`; returns how many the door wrote. */
export async function writeHistory(
  client: pg.ClientBase,
  runId: string,
  events: readonly DoorEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  const { rows } = await client.query<{ n: number }>(
    'SELECT kept.import_history($1, $2::jsonb) AS n',
    [runId, JSON.stringify(events)],
  );
  return rows[0]?.n ?? 0;
}
