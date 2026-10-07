import type pg from 'pg';
import type { FieldClass } from '../audit/classes.js';

// A thing as its audit diff sees it (engineering spec §7.5; D110, D183; plan "custom-field
// audit"). audited() diffs two images field by field, so `custom` and `archived_custom` are
// flattened into one entry per key (`custom.<key>`, `archived_custom.<key>`): a single nested
// `custom` entry would carry a money value under a plain class, past renderAudit(). The field
// classes come from the type's resolved fields: a money-kind key is `money`. Secret fields never
// reach `custom` (kept.guard_thing_custom()), so they never reach the image either; a stray one
// would still be classed `secret` here.
//
// Tags are one entry, `tag_ids`, sorted. Cache columns and bookkeeping are left out (audited()
// drops them anyway). The image is also what undo reads back (things/undo.ts): each entry names
// something that can be read and written again.

export type ThingImage = Record<string, unknown>;

/** The columns of `things` an image carries, as selected (snake_case). */
export const IMAGE_COLUMNS = [
  'place_id',
  'container_id',
  'type_id',
  'name',
  'brand_id',
  'model',
  'serial',
  'barcode',
  'colour',
  'quantity',
  'condition',
  'notes',
  'aliases',
  'belongs_to_person_id',
  'purchase_line_id',
  'manual_url',
  'expires_on',
  'expiry_lead_days',
  'lifecycle',
  'ended_on',
  'ended_price',
  'ended_currency',
  'ended_to',
  'ended_notes',
  'acquired_from',
  'provenance_notes',
  'location_uncertain',
  'review_state',
  'deleted_at',
  'trash_batch_id',
] as const;

export type ImageColumn = (typeof IMAGE_COLUMNS)[number];

/** Columns whose value an image holds as text (numerics, dates) so it compares exactly. */
const TEXT_COLUMNS = new Set<ImageColumn>([
  'quantity',
  'ended_price',
  'expires_on',
  'ended_on',
  'deleted_at',
]);

const selectList = IMAGE_COLUMNS.map((c) =>
  TEXT_COLUMNS.has(c) ? `t.${c}::text AS ${c}` : `t.${c}`,
).join(', ');

type ImageRow = Record<ImageColumn, unknown> & {
  custom: Record<string, unknown> | null;
  archived_custom: Record<string, unknown> | null;
  tag_ids: string[] | null;
};

/** The image of one thing, read in the caller's transaction (null when it isn't visible). */
export async function readImage(
  client: pg.ClientBase,
  thingId: string,
  opts: { lock?: boolean } = {},
): Promise<ThingImage | null> {
  const { rows } = await client.query<ImageRow>(
    `SELECT ${selectList}, t.custom, t.archived_custom,
            coalesce((SELECT array_agg(g.tag_id::text ORDER BY g.tag_id) FROM public.thing_tags g
                       WHERE g.thing_id = t.id), '{}'::text[]) AS tag_ids
       FROM public.things t WHERE t.id = $1${opts.lock ? ' FOR UPDATE OF t' : ''}`,
    [thingId],
  );
  const row = rows[0];
  return row ? imageOf(row) : null;
}

export function imageOf(row: ImageRow): ThingImage {
  const out: ThingImage = {};
  for (const c of IMAGE_COLUMNS) out[c] = row[c] ?? null;
  for (const [k, v] of Object.entries(row.custom ?? {})) out[`custom.${k}`] = v;
  for (const [k, v] of Object.entries(row.archived_custom ?? {})) out[`archived_custom.${k}`] = v;
  out.tag_ids = [...(row.tag_ids ?? [])].sort();
  return out;
}

/** The per-call classes of an image's custom entries: money-kind keys are money, secret ones
 * secret. Pass every field the before and after images' types resolve. */
export function customClasses(
  fields: readonly { key: string; kind: string; secret?: boolean | null }[],
): Record<string, FieldClass> {
  const out: Record<string, FieldClass> = {};
  for (const f of fields) {
    const cls: FieldClass | null = f.secret ? 'secret' : f.kind === 'money' ? 'money' : null;
    if (!cls) continue;
    out[`custom.${f.key}`] = cls;
    out[`archived_custom.${f.key}`] = cls;
  }
  return out;
}

/** A custom value shaped like money (`{amount, currency}`), or a list holding one (a repeatable
 * money field's value): classed money even when no field says so (an archived value whose field
 * is gone), so an amount never shows as plain. */
export function moneyShaped(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(moneyShaped);
  return value !== null && typeof value === 'object' && 'amount' in value && 'currency' in value;
}

/** Classes for every custom entry of the images that holds a money-shaped value. */
export function moneyShapedClasses(...images: (ThingImage | null)[]): Record<string, FieldClass> {
  const out: Record<string, FieldClass> = {};
  for (const image of images) {
    for (const [k, v] of Object.entries(image ?? {})) {
      if ((k.startsWith('custom.') || k.startsWith('archived_custom.')) && moneyShaped(v)) {
        out[k] = 'money';
      }
    }
  }
  return out;
}
