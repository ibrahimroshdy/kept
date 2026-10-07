import type { FieldKind } from '@kept/shared';
import type pg from 'pg';

// A thing's type fields, resolved from the database (D92, D154, D192; plan Q3, Q4): the type's
// own fields, its ancestors' (root first) and those of every field group along the chain, each
// group once. Read as the caller on kept_app: type_chain() and the types/type_fields policies
// show built-ins and the caller's visible accounts' types, which is everything a thing's chain
// can hold. The shape is the web contract's ResolvedField (apps/web/src/api/inventory/types.ts).

export type ResolvedFieldView = {
  id: string;
  key: string;
  /** Null for a built-in's field: the web translates `labelKey`. */
  label: string | null;
  labelKey: string | null;
  kind: FieldKind;
  unit: string | null;
  options: string[] | null;
  repeatable: boolean;
  required: boolean;
  secret: boolean;
  sort: number;
  archivedAt: string | null;
  source: { typeId: string; via: 'own' | 'inherited' | 'group' };
  rowVersion: number;
};

type Row = {
  id: string;
  key: string;
  label: string | null;
  kind: FieldKind;
  unit: string | null;
  options: unknown;
  repeatable: boolean;
  required: boolean;
  secret: boolean;
  sort: number;
  archived_at: Date | null;
  row_version: number;
  type_id: string;
  depth: number;
  own: boolean;
};

/** Every field `typeId` resolves, archived ones included (their values stay readable). */
export async function resolvedFields(
  client: pg.ClientBase,
  typeId: string | null,
): Promise<ResolvedFieldView[]> {
  if (!typeId) return [];
  const { rows } = await client.query<Row>(
    `SELECT f.id, f.key, f.label, f.kind, f.unit, f.options, f.repeatable, f.required, f.secret,
            f.sort, f.archived_at, f.row_version, f.type_id, ch.depth, (f.type_id = t.id) AS own
       FROM kept.type_chain($1) ch
       JOIN public.types t ON t.id = ch.id
       JOIN public.type_fields f ON f.type_id = t.id OR f.type_id = ANY (t.field_groups)
      ORDER BY ch.depth DESC, (f.type_id = t.id) DESC,
               array_position(t.field_groups, f.type_id), f.sort, f.key`,
    [typeId],
  );
  const seen = new Set<string>();
  const out: ResolvedFieldView[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      key: r.key,
      label: r.label,
      labelKey: r.label === null ? r.key : null,
      kind: r.kind,
      unit: r.unit,
      options: Array.isArray(r.options) ? (r.options as string[]) : null,
      repeatable: r.repeatable,
      required: r.required,
      secret: r.secret,
      sort: r.sort,
      archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
      source: { typeId: r.type_id, via: !r.own ? 'group' : r.depth === 0 ? 'own' : 'inherited' },
      rowVersion: r.row_version,
    });
  }
  return out;
}

/** The capabilities `typeId` resolves (own and inherited), `[]` for none. */
export async function typeCapabilities(
  client: pg.ClientBase,
  typeId: string | null,
): Promise<string[]> {
  if (!typeId) return [];
  const { rows } = await client.query<{ caps: string[] }>(
    'SELECT kept.type_capabilities($1) AS caps',
    [typeId],
  );
  return rows[0]?.caps ?? [];
}

/** The meter a new thing of `typeId` starts with: the nearest `default_meter` along its chain
 * (JSON null cancels an inherited one), or null. */
export async function defaultMeterOf(
  client: pg.ClientBase,
  typeId: string | null,
): Promise<{ kind: string; unit: string } | null> {
  if (!typeId) return null;
  const { rows } = await client.query<{ m: { kind?: unknown; unit?: unknown } | null }>(
    `SELECT t.default_meter AS m
       FROM kept.type_chain($1) ch JOIN public.types t ON t.id = ch.id
      WHERE t.default_meter IS NOT NULL
      ORDER BY ch.depth LIMIT 1`,
    [typeId],
  );
  const m = rows[0]?.m;
  if (!m || typeof m.kind !== 'string' || typeof m.unit !== 'string') return null;
  return { kind: m.kind, unit: m.unit };
}
