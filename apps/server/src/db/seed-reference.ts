import {
  BUILTIN_PLACE_KINDS,
  BUILTIN_TYPES,
  type BuiltinPlaceKind,
  type BuiltinType,
  ISO_CURRENCIES,
  SUPPORTED_DEFAULT,
} from '@kept/shared';
import type pg from 'pg';

// Reference data that `kept migrate` upserts after the migrations, as kept_owner inside the
// migrate lock (engineering spec §7.9, §7.12; D136, D168). Idempotent: a second run changes
// nothing. Never touches what an instance admin decides (`currencies.enabled`).

const displayNames = new Intl.DisplayNames('en', { type: 'currency' });

/** The English name of `code`, or the code itself when ICU has none. */
function currencyName(code: string): string {
  return displayNames.of(code) ?? code;
}

/** The narrow symbol of `code` in English (e.g. `$`, `€`), or the code itself. */
function currencySymbol(code: string): string {
  const parts = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'narrowSymbol',
  }).formatToParts(0);
  return parts.find((p) => p.type === 'currency')?.value ?? code;
}

/**
 * Every ISO 4217 currency (D168). A new row starts enabled only when it is one of the five
 * defaults (D136); an existing row keeps its `enabled` and its `symbol` (0004 chose the five's
 * symbols by hand, e.g. `E£`, never a bare `£` for EGP), and gets the current name and minor
 * units. `IS DISTINCT FROM` keeps a re-run from rewriting unchanged rows.
 */
export async function seedCurrencies(client: pg.ClientBase): Promise<void> {
  const rows = ISO_CURRENCIES.map((c) => ({
    code: c.code,
    name: currencyName(c.code),
    minor_units: c.minorUnits,
    symbol: currencySymbol(c.code),
    enabled: (SUPPORTED_DEFAULT as readonly string[]).includes(c.code),
  }));
  await client.query(
    `INSERT INTO public.currencies (code, name, minor_units, symbol, enabled)
     SELECT code, name, minor_units, symbol, enabled
       FROM jsonb_to_recordset($1::jsonb)
         AS x(code text, name text, minor_units int, symbol text, enabled boolean)
     ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name, minor_units = EXCLUDED.minor_units
     WHERE (public.currencies.name, public.currencies.minor_units)
           IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.minor_units)`,
    [JSON.stringify(rows)],
  );
}

/** The built-in place kinds' icons (D33, D98): names the web's STATIC_ICONS map draws. */
export const BUILTIN_PLACE_KIND_ICONS: Readonly<Record<BuiltinPlaceKind, string>> = Object.freeze({
  floor: 'lucide:layers',
  room: 'lucide:door-open',
  zone: 'lucide:square-dashed',
  closet: 'tabler:hanger',
});

/** Parents and field groups before the types that name them. */
function libraryOrder(library: readonly BuiltinType[]): BuiltinType[] {
  const byKey = new Map(library.map((t) => [t.key, t]));
  const done = new Set<string>();
  const out: BuiltinType[] = [];
  const visit = (t: BuiltinType, path: Set<string>) => {
    if (done.has(t.key)) return;
    if (path.has(t.key)) throw new Error(`built-in type cycle at ${t.key}`);
    path.add(t.key);
    for (const dep of [t.parent, ...(t.groups ?? [])]) {
      if (dep === undefined) continue;
      const d = byKey.get(dep);
      if (!d) throw new Error(`built-in type ${t.key} names unknown ${dep}`);
      visit(d, path);
    }
    path.delete(t.key);
    done.add(t.key);
    out.push(t);
  };
  for (const t of library) visit(t, new Set());
  return out;
}

/**
 * The built-in type library (D154, D192, §7.9), upserted by `builtin_key`; then each type's own
 * fields by (type, key); then the built-in place kinds. Names stay NULL (translated from the
 * keys); `search_names` holds the English and Arabic names for search. A built-in field that
 * left the library is archived, never deleted (values may still refer to it). Every write is
 * guarded by `IS DISTINCT FROM`, so a re-run touches no row (same row_version).
 *
 * Note for later library changes: kept.guard_type_keys() refuses a key defined twice along a
 * chain, including an account's customised or child types, so a new built-in field whose key an
 * account already uses below it fails the migrate. Give new library fields distinct keys.
 */
export async function seedTypes(client: pg.ClientBase): Promise<void> {
  const ordered = libraryOrder(BUILTIN_TYPES);
  const types = ordered.map((t) => ({
    key: t.key,
    parent: t.parent ?? null,
    groups: [...(t.groups ?? [])],
    search_names: `${t.names.en} ${t.names.ar}`,
    icon: t.icon,
    capabilities: [...t.capabilities],
    // undefined: inherit (SQL NULL); null: cancel an inherited meter (JSON null).
    default_meter: t.defaultMeter === undefined ? null : t.defaultMeter,
    meter_set: t.defaultMeter !== undefined,
    is_field_group: t.isFieldGroup ?? false,
  }));
  // 1. The rows, without their links (a parent or group must exist first).
  await client.query(
    `INSERT INTO public.types (builtin_key, search_names, icon, capabilities, default_meter,
                               is_field_group)
     SELECT x.key, x.search_names, x.icon, x.capabilities,
            CASE WHEN x.meter_set THEN coalesce(x.default_meter, 'null'::jsonb) END,
            x.is_field_group
       FROM jsonb_to_recordset($1::jsonb) AS x(key text, search_names text, icon text,
              capabilities text[], default_meter jsonb, meter_set boolean, is_field_group boolean)
     ON CONFLICT (builtin_key) WHERE owner_account_id IS NULL DO UPDATE
       SET search_names = EXCLUDED.search_names, icon = EXCLUDED.icon,
           capabilities = EXCLUDED.capabilities, default_meter = EXCLUDED.default_meter,
           is_field_group = EXCLUDED.is_field_group, archived_at = NULL
     WHERE (types.search_names, types.icon, types.capabilities, types.default_meter,
            types.is_field_group, types.archived_at)
           IS DISTINCT FROM (EXCLUDED.search_names, EXCLUDED.icon, EXCLUDED.capabilities,
                             EXCLUDED.default_meter, EXCLUDED.is_field_group, NULL::timestamptz)`,
    [JSON.stringify(types)],
  );
  // 2. Parents and field groups, by key.
  await client.query(
    `WITH x AS (
       SELECT x.key, x.parent, x.groups
         FROM jsonb_to_recordset($1::jsonb) AS x(key text, parent text, groups text[])
     ), want AS (
       SELECT t.id,
              (SELECT p.id FROM public.types p
                WHERE p.owner_account_id IS NULL AND p.builtin_key = x.parent) AS parent_id,
              ARRAY(SELECT g.id FROM unnest(x.groups) WITH ORDINALITY AS k(key, n)
                      JOIN public.types g ON g.owner_account_id IS NULL AND g.builtin_key = k.key
                     ORDER BY k.n) AS field_groups
         FROM x JOIN public.types t ON t.owner_account_id IS NULL AND t.builtin_key = x.key
     )
     UPDATE public.types t SET parent_id = w.parent_id, field_groups = w.field_groups
       FROM want w
      WHERE t.id = w.id
        AND (t.parent_id, t.field_groups) IS DISTINCT FROM (w.parent_id, w.field_groups)`,
    [JSON.stringify(types)],
  );
  // 3. Each type's own fields, in library order.
  const fields = ordered.flatMap((t) =>
    t.fields.map((f, i) => ({
      type_key: t.key,
      key: f.key,
      kind: f.kind,
      unit: f.unit ?? null,
      options: f.options ? [...f.options] : null,
      repeatable: f.repeatable ?? false,
      secret: f.secret ?? false,
      sort: i,
    })),
  );
  // A field never changes to or from secret in place (D177; 0024's type_fields_secret_fixed
  // refuses it too): a library change that would must fail the migrate, naming the field.
  const flipped = await client.query<{ name: string }>(
    `SELECT t.builtin_key || '.' || f.key AS name
       FROM jsonb_to_recordset($1::jsonb) AS x(type_key text, key text, secret boolean)
       JOIN public.types t ON t.owner_account_id IS NULL AND t.builtin_key = x.type_key
       JOIN public.type_fields f ON f.type_id = t.id AND f.key = x.key
      WHERE f.secret IS DISTINCT FROM x.secret
      ORDER BY 1`,
    [JSON.stringify(fields)],
  );
  if (flipped.rows.length > 0) {
    throw new Error(
      `the type library would turn built-in fields to or from secret: ${flipped.rows
        .map((r) => r.name)
        .join(', ')}. A field's secret flag is fixed (D177); give the library a new key instead.`,
    );
  }
  await client.query(
    `INSERT INTO public.type_fields (owner_account_id, type_id, key, kind, unit, options,
                                     repeatable, secret, sort)
     SELECT NULL, t.id, x.key, x.kind, x.unit, x.options, x.repeatable, x.secret, x.sort
       FROM jsonb_to_recordset($1::jsonb) AS x(type_key text, key text, kind text, unit text,
              options jsonb, repeatable boolean, secret boolean, sort int)
       JOIN public.types t ON t.owner_account_id IS NULL AND t.builtin_key = x.type_key
     ON CONFLICT (type_id, key) WHERE type_id IS NOT NULL DO UPDATE
       SET kind = EXCLUDED.kind, unit = EXCLUDED.unit, options = EXCLUDED.options,
           repeatable = EXCLUDED.repeatable, secret = EXCLUDED.secret, sort = EXCLUDED.sort,
           archived_at = NULL
     WHERE (type_fields.kind, type_fields.unit, type_fields.options, type_fields.repeatable,
            type_fields.secret, type_fields.sort, type_fields.archived_at)
           IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.unit, EXCLUDED.options,
                             EXCLUDED.repeatable, EXCLUDED.secret, EXCLUDED.sort,
                             NULL::timestamptz)`,
    [JSON.stringify(fields)],
  );
  // 4. Built-in fields no longer in the library: archived, never deleted.
  await client.query(
    `UPDATE public.type_fields f SET archived_at = now()
       FROM public.types t
      WHERE t.id = f.type_id AND t.owner_account_id IS NULL AND f.owner_account_id IS NULL
        AND f.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS x(type_key text, key text)
                         WHERE x.type_key = t.builtin_key AND x.key = f.key)`,
    [JSON.stringify(fields)],
  );
  // 5. The built-in place kinds (D33).
  const kinds = BUILTIN_PLACE_KINDS.map((key) => ({ key, icon: BUILTIN_PLACE_KIND_ICONS[key] }));
  await client.query(
    `INSERT INTO public.place_kinds (owner_account_id, key, icon)
     SELECT NULL, x.key, x.icon FROM jsonb_to_recordset($1::jsonb) AS x(key text, icon text)
     ON CONFLICT ON CONSTRAINT place_kinds_owner_key_uq DO UPDATE
       SET icon = EXCLUDED.icon, archived_at = NULL
     WHERE (place_kinds.icon, place_kinds.archived_at)
           IS DISTINCT FROM (EXCLUDED.icon, NULL::timestamptz)`,
    [JSON.stringify(kinds)],
  );
}

/** Everything `kept migrate` seeds, in dependency order. */
export async function seedReference(client: pg.ClientBase): Promise<void> {
  await client.query('BEGIN');
  try {
    await seedCurrencies(client);
    await seedTypes(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
