import { isDeepStrictEqual } from 'node:util';
import { registerUndo, type UndoArgs, undoConflict } from '../audit/undo.js';
import { requireCan } from '../locations/access.js';
import { imageOf, type LayoutImage, lockLayout, writeImage } from './service.js';
import { nodeRows } from './view.js';

// Undo of an arrange session (1.x, D237): `place.arrange` stores the location's whole layout
// before and after (service.ts). Undo, within its ten minutes, checks the layout is still the
// session's (D124: someone who arranged since, or a place or thing removed since, refuses with
// `changed_since`), then writes the layout from before back and audits that under the same
// action. Only someone who may still arrange there undoes it.

async function undoArrange(args: UndoArgs): Promise<void> {
  requireCan(args.role, 'things.edit');
  const locationId = args.event.locationId;
  await lockLayout(args.client, locationId);
  const change = args.event.diff.layout;
  const before = (change?.before ?? []) as LayoutImage[];
  const after = (change?.after ?? []) as LayoutImage[];
  const now = imageOf(await nodeRows(args.client, locationId));
  if (!isDeepStrictEqual(now, after)) throw undoConflict(['layout']);
  // A room or node that left the location since can't come back: write back what still exists.
  const { rows } = await args.client.query<{ id: string }>(
    `SELECT p.id FROM public.places p WHERE p.location_id = $1 AND p.id = ANY ($2::uuid[])
     UNION ALL
     SELECT t.id FROM public.things t WHERE t.location_id = $1 AND t.id = ANY ($2::uuid[])`,
    [locationId, before.map((r) => r.id)],
  );
  const here = new Set(rows.map((r) => r.id));
  const back = before
    .filter((r) => here.has(r.id))
    .map((r) => (r.host && !here.has(r.host) ? { ...r, host: null } : r));
  await writeImage(args.client, locationId, back);
  await args.audit({
    action: 'place.arrange',
    entity: { type: 'location', id: locationId },
    before: { layout: now },
    after: { layout: back },
  });
}

export function registerMapUndo(): void {
  registerUndo('place.arrange', undoArrange);
}
