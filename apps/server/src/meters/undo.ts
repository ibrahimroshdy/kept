import { notUndoable, registerUndo, type UndoArgs } from '../audit/undo.js';
import { conflict } from '../http/errors.js';
import { decimalOut } from './check.js';
import { placementOf } from './service.js';

// Undo for readings (step 5, T8; D112, D150; plan Q14):
// - reading.create: undo/registry.ts (step 6's, which a tool's reading shares): the reading goes,
//   unless anything was written about it since.
// - reading.delete (here): the reading comes back with its id, value, time, source, state and
//   note, and its proof photos (a file already purged, a day after it lost its last attachment,
//   stays gone), placed again among its neighbours (D112): one that no longer fits (a reading
//   put in since makes it run backwards) is refused with the reason, and nothing is written.
// A reading a fill or a service owned goes and comes back with its owner (their own undo), never
// alone: the readings routes refuse to delete one (409 `reading_owned`).

type Before = {
  meter_id?: string;
  value?: string;
  taken_at?: string;
  source?: string;
  state?: 'accepted' | 'needs_review';
  review_reason?: string | null;
  note?: string | null;
  proofs?: { id: string; file_id: string; sort: number }[];
};

async function undoReadingDelete(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'meter_reading' || !id) throw notUndoable();
  const b = Object.fromEntries(
    Object.entries(event.diff).map(([k, c]) => [k, c.before ?? null]),
  ) as Before;
  if (!b.meter_id || !b.value || !b.taken_at || !b.source) throw notUndoable();
  const { rowCount: back } = await client.query(
    'SELECT 1 FROM public.meter_readings WHERE id = $1',
    [id],
  );
  if (back) throw conflict("Can't undo: that reading is back already.");
  await client.query('SELECT 1 FROM public.meters WHERE id = $1 FOR UPDATE', [b.meter_id]);
  const takenAt = new Date(b.taken_at);
  const placed = await placementOf(client, b.meter_id, b.value, takenAt);
  if (!placed) throw conflict("Can't undo: that meter is gone.");
  const { meter, placement: p } = placed;
  if (p.reason === 'lower_than_previous' || p.reason === 'higher_than_next') {
    const other = p.reason === 'lower_than_previous' ? p.previous : p.next;
    throw conflict(
      `Can't undo: it no longer fits among the readings${
        other
          ? ` (${decimalOut(other.value)} ${meter.unit} on ${other.takenAt.toISOString().slice(0, 10)})`
          : ''
      }.`,
    );
  }
  await client.query(
    `INSERT INTO public.meter_readings
       (id, location_id, meter_id, value, taken_at, source, state, review_reason, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      meter.location_id,
      meter.id,
      b.value,
      takenAt,
      b.source,
      b.state ?? 'accepted',
      b.state === 'needs_review' ? (b.review_reason ?? null) : null,
      b.note ?? null,
    ],
  );
  for (const a of b.proofs ?? []) {
    await client.query(
      `INSERT INTO public.attachments (id, location_id, file_id, meter_reading_id, role, sort,
                                       created_by)
       SELECT $1, $2, $3, $4, 'proof', $5, kept.current_user_id()
        WHERE EXISTS (SELECT 1 FROM public.files f WHERE f.id = $3)
       ON CONFLICT DO NOTHING`,
      [a.id, meter.location_id, a.file_id, id, a.sort],
    );
  }
  await args.audit({
    action: 'reading.delete',
    entity: { type: 'meter_reading', id },
    before: null,
    after: {
      meter_id: meter.id,
      value: b.value,
      taken_at: takenAt,
      source: b.source,
      state: b.state ?? 'accepted',
      review_reason: b.state === 'needs_review' ? (b.review_reason ?? null) : null,
      note: b.note ?? null,
    },
    rootThingId: meter.thing_id,
  });
}

let registered = false;

/** Registers the readings' undo handlers (idempotent; meters/routes.ts). */
export function registerReadingUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('reading.delete', undoReadingDelete);
}
