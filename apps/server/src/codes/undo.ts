import { isDeepStrictEqual } from 'node:util';
import { lastChangedBy, registerUndo, type UndoArgs, undoConflict } from '../audit/undo.js';
import { conflict, notFound } from '../http/errors.js';
import { ownCodesOf, type Target } from './service.js';

// Undo of an own-code change (T17a, D208, D150): `thing.codes` and `place.codes` store the whole
// list of own codes before and after (`own_codes`). The undo puts the list back when the thing or
// place still has exactly the list the event left, and refuses otherwise (D124). A code the undo
// would bring back that the location has since given to something else refuses too: codes are
// unique per location.

const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').sort() : [];

async function undoCodes(args: UndoArgs): Promise<void> {
  const { client, event } = args;
  const kind = event.entityType === 'place' ? 'place' : 'thing';
  if (!event.entityId) throw notFound();
  const target: Target = { kind, id: event.entityId };
  const table = kind === 'thing' ? 'things' : 'places';
  const { rows } = await client.query<{ location_id: string }>(
    `SELECT location_id FROM public.${table} WHERE id = $1 AND deleted_at IS NULL`,
    [target.id],
  );
  const locationId = rows[0]?.location_id;
  if (!locationId) throw conflict(`Can't undo: the ${kind} is in the trash now.`);

  const change = event.diff.own_codes;
  const before = listOf(change?.before);
  const after = listOf(change?.after);
  const now = await ownCodesOf(client, target);
  if (!isDeepStrictEqual(now, after)) {
    throw undoConflict(
      ['own_codes'],
      await lastChangedBy(client, event.locationId, { type: kind, id: target.id }, event.at),
    );
  }
  const col = kind === 'thing' ? 'thing_id' : 'place_id';
  const drop = after.filter((c) => !before.includes(c));
  const add = before.filter((c) => !after.includes(c));
  if (drop.length > 0) {
    await client.query(
      `DELETE FROM public.legacy_codes
        WHERE ${col} = $1 AND source = 'own' AND source_collection = '' AND code = ANY ($2::text[])`,
      [target.id, drop],
    );
  }
  if (add.length > 0) {
    const { rows: taken } = await client.query<{ code: string }>(
      'SELECT code FROM public.legacy_codes WHERE location_id = $1 AND code = ANY ($2::text[])',
      [locationId, add],
    );
    if (taken.length > 0) {
      throw conflict(
        `Can't undo: ${taken.map((r) => r.code).join(', ')} is on something else now.`,
      );
    }
    await client.query(
      `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, ${col})
       SELECT $1, 'own', '', c, $2 FROM unnest($3::text[]) c`,
      [locationId, target.id, add],
    );
  }
  await args.audit({
    action: event.action,
    entity: { type: kind, id: target.id },
    before: { own_codes: after },
    after: { own_codes: before },
    ...(kind === 'thing' ? { rootThingId: target.id, subjects: [target.id] } : {}),
  });
}

/** Registers the handlers (called from codes/routes.ts). */
export function registerCodeUndo(): void {
  registerUndo('thing.codes', undoCodes);
  registerUndo('place.codes', undoCodes);
}
