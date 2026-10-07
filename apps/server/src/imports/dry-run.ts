import {
  BUILTIN_TYPES,
  type BuiltinNameLocale,
  builtinTypeName,
  CONDITIONS,
  type Condition,
  type ImportIssue,
  type ImportIssueCode,
  type ImportIssueParams,
  type MappableField,
  mapCurrencyMark,
  normalize,
  splitPlacePath,
} from '@kept/shared';
import type pg from 'pg';
import { type CodeCheck, checkCodes, type FormatRule } from '../codes/format-rule.js';
import type { Scope, Tx } from '../db/scope.js';
import { invalid } from '../http/errors.js';
import { unplacedOf } from '../places/view.js';
import { gateFor } from '../serialize/gates.js';
import { type ResolvedFieldView, resolvedFields, typeCapabilities } from '../things/fields.js';
import { fitsField } from '../things/validate.js';
import {
  cell,
  foldDigits,
  type ImportChoices,
  legacyCodeOf,
  parseBoolean,
  parseDate,
  parsePrice,
  parseQuantity,
  parseUrl,
  rowHash,
  splitList,
} from './csv.js';

// The row mapper (plan T18; §5 "mapped, as text, skipped, why"). The dry run and the job run the
// same planRow() over the same Lookups: the dry run writes nothing and remembers what it would
// create under placeholder ids, so a later row sees the places, brands and codes an earlier row
// would make; the job remembers the real ids as it creates them (job.ts).
//
// A row is
// - `ok`: every mapped cell lands in its field;
// - `text`: something couldn't (a date that doesn't read in the chosen format, a type that
//   doesn't exist, money where the money module is off, …), and is kept in the notes as
//   "<column>: <value>", with an issue saying why;
// - `skipped`: no name, or already imported (its source id is taken, by an earlier run or an
//   earlier row of the same file).
//
// Lookups are read under the importer's own row-level security, and only with equality on
// indexed columns, or all of a location's (or an account's) rows at once, never with a
// non-leakproof operator over a large table (engineering spec §7.2).

/** A reason on a row: a stable code for the web to translate, with the English as a fallback. */
export type Issue = ImportIssue;

const issue = (
  column: string,
  code: ImportIssueCode,
  message: string,
  params?: ImportIssueParams,
): Issue => (params ? { column, code, params, message } : { column, code, message });
export type RowStatus = 'ok' | 'text' | 'skipped';

/** An existing row, or one to create by name. */
export type Ref = { id: string } | { create: string };

export type PlannedTarget =
  | { placeId: string }
  /** The deepest existing place of the path (null: the top level), and the names below it to
   * create, top down. */
  | { parentId: string | null; create: string[] };

export type PlannedThing = {
  name: string;
  quantity: number;
  typeId: string | null;
  brand: Ref | null;
  model: string | null;
  serial: string | null;
  barcode: string | null;
  colour: string | null;
  condition: Condition | null;
  notes: string | null;
  aliases: Record<string, string[]>;
  tags: Ref[];
  manualUrl: string | null;
  custom: Record<string, unknown>;
  target: PlannedTarget;
  purchase: { purchasedOn: string; currency: string; price: string; vendor: Ref | null } | null;
  legacyCodes: string[];
  /** Own codes (D208, T17a), each checked against the location's format rule. */
  ownCodes: string[];
};

export type PlannedRow = {
  /** 1-based, the data row's number (the header row not counted). */
  row: number;
  status: RowStatus;
  issues: Issue[];
  sourceId: string;
  thing: PlannedThing | null;
};

export type DryRunReport = {
  summary: {
    things: number;
    places: number;
    purchases: number;
    legacyCodes: number;
    skipped: number;
    asText: number;
  };
  rows: { row: number; status: RowStatus; issues: Issue[] }[];
};

/** What an import_runs row holds, as the mapper needs it. */
export type RunInput = {
  id: string;
  locationId: string;
  /** The header row, then the data rows (import_runs.rows). */
  columns: string[];
  rows: string[][];
  mapping: Record<string, MappableField>;
  choices: ImportChoices;
};

const NOTES_MAX = 5000;
const LIMITS = { name: 200, model: 120, serial: 100, barcode: 64, colour: 60 } as const;
const PLACE_NAME_MAX = 120;
const REGISTRY_NAME_MAX = { brand: 120, vendor: 120, tag: 60 } as const;
const TAGS_MAX = 50;
const ALIASES_MAX = 20;
const ALIAS_MAX = 200;
const CODE_MAX = 100;

const PLACEHOLDER = 'planned:';

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

type TypeInfo = { caps: string[]; fields: ResolvedFieldView[] };

/**
 * What the mapper checks cells against: the location's places, the account's brands, vendors,
 * tags and types, the enabled currencies, the money gate, and the source ids and legacy codes
 * already taken. Changes made while a row is applied go through `remember*()`, inside
 * begin()/commit(); rollback() forgets a row's changes when its savepoint is rolled back.
 */
export class Lookups {
  readonly places = new Map<string, Map<string, string>>();
  readonly brands = new Map<string, string>();
  readonly vendors = new Map<string, string>();
  readonly tags = new Map<string, string>();
  readonly types = new Map<string, string>();
  readonly typeInfo = new Map<string, TypeInfo>();
  /** Source ids taken, with the row of this file that took one (0: an earlier run). */
  readonly sourceIds = new Map<string, number>();
  /** Legacy codes taken in the location (any source: csv, homebox, own), and what they name. */
  readonly codes = new Map<string, string>();
  /** The location's format rule for own codes (T17a), and its verdict on each own code the
   * rows name, checked in one timed batch (codes/format-rule.ts). */
  rule: FormatRule | null = null;
  readonly ruleVerdicts = new Map<string, CodeCheck>();
  private journal: (() => void)[] | null = null;
  private planned = 0;

  constructor(
    readonly locationId: string,
    readonly accountId: string,
    readonly currency: string,
    readonly languages: readonly string[],
    readonly today: string,
    readonly showMoney: boolean,
    readonly defaultPlaceId: string,
    readonly currencies: ReadonlySet<string>,
  ) {}

  begin(): void {
    this.journal = [];
  }
  commit(): void {
    this.journal = null;
  }
  rollback(): void {
    for (const undo of (this.journal ?? []).reverse()) undo();
    this.journal = null;
  }

  private set<K, V>(map: Map<K, V>, key: K, value: V): void {
    const had = map.has(key);
    const was = map.get(key);
    map.set(key, value);
    this.journal?.push(() => {
      if (had) map.set(key, was as V);
      else map.delete(key);
    });
  }

  /** An id for something the dry run would create. */
  placeholder(): string {
    this.planned += 1;
    return `${PLACEHOLDER}${this.planned}`;
  }

  childPlace(parentId: string | null, name: string): string | undefined {
    return this.places.get(parentId ?? '')?.get(normalize(name));
  }
  rememberPlace(parentId: string | null, name: string, id: string): void {
    const key = parentId ?? '';
    let children = this.places.get(key);
    if (!children) {
      children = new Map();
      this.set(this.places, key, children);
    }
    this.set(children, normalize(name), id);
  }
  rememberBrand(name: string, id: string): void {
    this.set(this.brands, normalize(name), id);
  }
  rememberVendor(name: string, id: string): void {
    this.set(this.vendors, normalize(name), id);
  }
  rememberTag(name: string, id: string): void {
    this.set(this.tags, normalize(name), id);
  }
  rememberSourceId(sourceId: string, row: number): void {
    this.set(this.sourceIds, sourceId, row);
  }
  rememberCode(code: string, targetId: string): void {
    this.set(this.codes, code, targetId);
  }
}

/** Type names by normalised name: the account's own types first, then Kept's built-ins in each
 * of the five languages. */
export async function loadTypes(
  client: pg.ClientBase,
  accountId: string,
  into: Map<string, string>,
) {
  const { rows } = await client.query<{
    id: string;
    name: string | null;
    builtin_key: string | null;
    copied_key: string | null;
    owned: boolean;
  }>(
    `SELECT t.id, t.name, t.builtin_key, src.builtin_key AS copied_key,
            t.owner_account_id IS NOT NULL AS owned
       FROM public.types t LEFT JOIN public.types src ON src.id = t.copied_from_id
      WHERE (t.owner_account_id = $1 OR t.owner_account_id IS NULL)
        AND NOT t.is_field_group AND t.archived_at IS NULL`,
    [accountId],
  );
  const locales: BuiltinNameLocale[] = ['en', 'ar', 'fr', 'de', 'it'];
  const namesOf = (key: string) =>
    locales.map((l) => builtinTypeName(key, l)).filter((n): n is string => !!n);
  // Built-ins first, so the account's own (and its customised copies) win.
  const ordered = [...rows].sort((a, b) => Number(a.owned) - Number(b.owned));
  for (const r of ordered) {
    const key = r.builtin_key ?? r.copied_key;
    const names = r.name ? [r.name] : key ? namesOf(key) : [];
    for (const n of names) into.set(normalize(n), r.id);
  }
  // The keys themselves (`power_tool`, `power tool`) for built-ins, when no name took them.
  for (const t of BUILTIN_TYPES) {
    const id = rows.find((r) => r.builtin_key === t.key)?.id;
    if (!id) continue;
    for (const k of [t.key, t.key.replaceAll('_', ' ')]) {
      if (!into.has(normalize(k))) into.set(normalize(k), id);
    }
  }
}

/**
 * The lookups for one run, read as the importer. `sourceIds` and `codes` are read for the ones
 * `rows` can name (all of them for the dry run, a chunk's for the job). 400 when the default
 * target is no longer a live place of the location.
 */
export async function loadLookups(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  run: RunInput,
  rows: readonly { index: number; row: string[] }[],
): Promise<Lookups> {
  const gate = await gateFor(tx, run.locationId, scope);
  const { rows: locRows } = await client.query<{
    owner_account_id: string;
    currency: string;
    languages: string[];
    today: string;
  }>(
    `SELECT owner_account_id, currency, languages,
            (now() AT TIME ZONE timezone)::date::text AS today
       FROM public.locations WHERE id = $1`,
    [run.locationId],
  );
  const loc = locRows[0];
  if (!loc) throw invalid('The location is gone.');

  let defaultPlaceId: string;
  if ('placeId' in run.choices.defaultTarget) {
    const id = run.choices.defaultTarget.placeId.toLowerCase();
    const { rowCount } = await client.query(
      `SELECT 1 FROM public.places WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL`,
      [id, run.locationId],
    );
    if (!rowCount) throw invalid('Check body.choices.defaultTarget: that place is gone.');
    defaultPlaceId = id;
  } else {
    defaultPlaceId = await unplacedOf(client, run.locationId);
  }

  const { rows: currencyRows } = await client.query<{ code: string }>(
    'SELECT code FROM public.currencies WHERE enabled',
  );
  const lookups = new Lookups(
    run.locationId,
    loc.owner_account_id,
    loc.currency.trim(),
    loc.languages,
    loc.today,
    gate.showMoney,
    defaultPlaceId,
    new Set(currencyRows.map((r) => r.code.trim())),
  );

  const { rows: placeRows } = await client.query<{
    id: string;
    parent_id: string | null;
    name: string;
  }>(
    `SELECT id, parent_id, name FROM public.places
      WHERE location_id = $1 AND deleted_at IS NULL AND NOT is_unplaced
      ORDER BY sort, id`,
    [run.locationId],
  );
  for (const p of placeRows) {
    if (!lookups.childPlace(p.parent_id, p.name)) lookups.rememberPlace(p.parent_id, p.name, p.id);
  }

  for (const [table, into] of [
    ['brands', lookups.brands],
    ['vendors', lookups.vendors],
    ['tags', lookups.tags],
  ] as const) {
    const { rows: reg } = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM public.${table} WHERE owner_account_id = $1 ORDER BY created_at, id`,
      [loc.owner_account_id],
    );
    for (const r of reg) if (!into.has(normalize(r.name))) into.set(normalize(r.name), r.id);
  }
  await loadTypes(client, loc.owner_account_id, lookups.types);

  // Source ids and codes the rows could name.
  const ids = rows.map((r) => sourceIdOf(run, r.row).id);
  const { rows: taken } = await client.query<{ source_id: string }>(
    `SELECT source_id FROM public.import_source_ids
      WHERE location_id = $1 AND source = 'csv' AND source_id = ANY ($2::text[])`,
    [run.locationId, ids],
  );
  for (const r of taken) lookups.sourceIds.set(r.source_id, 0);
  const own = rows.flatMap((r) => codesOf(run, r.row, 'own_code'));
  const codes = [...rows.flatMap((r) => codesOf(run, r.row)), ...own];
  if (own.length > 0) {
    const { rows: ruleRows } = await client.query<{
      rule_pattern: string | null;
      rule_message: string | null;
      rule_example: string | null;
    }>(
      `SELECT rule_pattern, rule_message, rule_example FROM public.own_code_settings
        WHERE location_id = $1`,
      [run.locationId],
    );
    const r = ruleRows[0];
    if (r?.rule_pattern && r.rule_message && r.rule_example) {
      lookups.rule = { pattern: r.rule_pattern, message: r.rule_message, example: r.rule_example };
      const unique = [...new Set(own)];
      checkCodes(lookups.rule, unique).forEach((v, i) => {
        lookups.ruleVerdicts.set(unique[i] as string, v);
      });
    }
  }
  if (codes.length > 0) {
    const { rows: codeRows } = await client.query<{ code: string; target: string }>(
      `SELECT code, coalesce(thing_id, place_id) AS target FROM public.legacy_codes
        WHERE location_id = $1 AND code = ANY ($2::text[])`,
      [run.locationId, codes],
    );
    for (const r of codeRows) lookups.codes.set(r.code, r.target);
  }
  return lookups;
}

/** A type's capabilities and fields, read once per run. */
export async function typeInfoOf(
  client: pg.ClientBase,
  lookups: Lookups,
  typeId: string,
): Promise<TypeInfo> {
  const known = lookups.typeInfo.get(typeId);
  if (known) return known;
  const info = {
    caps: await typeCapabilities(client, typeId),
    fields: await resolvedFields(client, typeId),
  };
  lookups.typeInfo.set(typeId, info);
  return info;
}

// ---------------------------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------------------------

/** The cells of `row` mapped to `field`, with their column names, non-empty only. */
function cellsOf(
  run: RunInput,
  row: readonly string[],
  field: string,
): { column: string; value: string }[] {
  const out: { column: string; value: string }[] = [];
  run.columns.forEach((column, i) => {
    if (run.mapping[column] !== field) return;
    const value = cell(row[i]);
    if (value) out.push({ column, value });
  });
  return out;
}

/** The row's source id: its `source_id` cell, or the hash of the row. */
export function sourceIdOf(run: RunInput, row: readonly string[]): { id: string; column: string } {
  const own = cellsOf(run, row, 'source_id')[0];
  if (own && own.value.length <= 200) return { id: own.value, column: own.column };
  return { id: rowHash(run.columns, row), column: own?.column ?? '' };
}

function codesOf(
  run: RunInput,
  row: readonly string[],
  field: 'legacy_code' | 'own_code' = 'legacy_code',
): string[] {
  return cellsOf(run, row, field)
    .map((c) => legacyCodeOf(c.value))
    .filter((c) => c.length > 0 && c.length <= CODE_MAX);
}

/** The language an alias is filed under: Arabic script → `ar`, otherwise the location's first
 * other language, or `en`. */
function aliasLanguage(lookups: Lookups, alias: string): string {
  if (/\p{Script=Arabic}/u.test(alias)) return 'ar';
  const other = lookups.languages
    .map((l) => l.toLowerCase().split('-')[0] ?? '')
    .find((l) => l !== 'ar' && /^[a-z]{2,3}$/.test(l));
  return other ?? 'en';
}

type Ctx = {
  run: RunInput;
  lookups: Lookups;
  issues: Issue[];
  /** Cells kept as text, written to the notes in column order. */
  text: { column: string; line: string }[];
};

/** Keeps a cell as text in the notes, with why. */
function asText(
  ctx: Ctx,
  column: string,
  value: string,
  code: ImportIssueCode,
  message: string,
  params?: ImportIssueParams,
): void {
  ctx.text.push({ column, line: `${column}: ${value}` });
  ctx.issues.push(issue(column, code, message, params));
}

function refOf(map: Map<string, string>, name: string): Ref {
  const id = map.get(normalize(name));
  return id ? { id } : { create: name };
}

/** A custom field's value from a cell, or a reason it can't be one. */
function customValue(
  ctx: Ctx,
  field: ResolvedFieldView,
  raw: string,
  currency: string | null,
): { value: unknown } | { code: ImportIssueCode; reason: string; params?: ImportIssueParams } {
  const choices = ctx.run.choices;
  const one = (s: string): unknown => {
    switch (field.kind) {
      case 'text':
        return s;
      case 'number': {
        const t = foldDigits(s)
          .replace(/٫/g, '.')
          .replace(/[\s,٬]/g, '');
        return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : undefined;
      }
      case 'date':
        return parseDate(s, choices.dateFormat) ?? undefined;
      case 'boolean':
        return parseBoolean(s) ?? undefined;
      case 'url':
        return parseUrl(s) ?? undefined;
      case 'select':
        return field.options?.length ? field.options.find((o) => normalize(o) === normalize(s)) : s;
      case 'multi_select': {
        const items = splitList(s).map((item) =>
          field.options?.length
            ? field.options.find((o) => normalize(o) === normalize(item))
            : item,
        );
        return items.every((i) => i !== undefined) ? items : undefined;
      }
      case 'money': {
        const amount = parsePrice(s);
        return amount && currency ? { amount, currency } : undefined;
      }
      default:
        // person, vendor, file: an id the CSV can't name.
        return undefined;
    }
  };
  if (field.kind === 'money' && !ctx.lookups.showMoney) {
    return { code: 'money_off', reason: 'Money is turned off for this location.' };
  }
  const value =
    field.repeatable && field.kind !== 'multi_select' ? splitList(raw).map(one) : one(raw);
  const bad =
    Array.isArray(value) && field.kind !== 'multi_select'
      ? value.some((v) => v === undefined)
      : value === undefined;
  if (bad || !fitsField(field, value)) {
    return {
      code: 'not_field_value',
      reason: `Not a ${field.kind.replace('_', ' ')} value for this field.`,
      params: { kind: field.kind },
    };
  }
  return { value };
}

/** The currency of a row's prices: its `currency` cell (a code or a mark: `E£`, `ج.م`), else the
 * run's choice, else the location's. */
function currencyOf(ctx: Ctx, row: readonly string[]): string | null {
  const c = cellsOf(ctx.run, row, 'currency')[0];
  if (!c) return ctx.run.choices.currency ?? ctx.lookups.currency;
  let code: string | null = null;
  if (/^[A-Za-z]{3}$/.test(c.value)) code = c.value.toUpperCase();
  else {
    const match = mapCurrencyMark(c.value, { languages: ctx.lookups.languages });
    if (match && 'code' in match) code = match.code;
  }
  if (!code || !ctx.lookups.currencies.has(code)) {
    asText(
      ctx,
      c.column,
      c.value,
      'not_currency',
      'Not an enabled currency; the price is kept as text.',
    );
    return null;
  }
  return code;
}

/**
 * Maps one data row. `client` reads a type's fields the first time a row uses the type.
 * Remembers the row's source id, and in the dry run (`plan`) what the row would create.
 */
export async function planRow(
  client: pg.ClientBase,
  run: RunInput,
  lookups: Lookups,
  index: number,
  row: readonly string[],
  mode: 'plan' | 'apply',
): Promise<PlannedRow> {
  const ctx: Ctx = { run, lookups, issues: [], text: [] };
  const rowNo = index + 1;
  const source = sourceIdOf(run, row);
  const skip = (
    column: string,
    code: ImportIssueCode,
    message: string,
    params?: ImportIssueParams,
  ): PlannedRow => ({
    row: rowNo,
    status: 'skipped',
    issues: [issue(column, code, message, params)],
    sourceId: source.id,
    thing: null,
  });

  const nameCell = cellsOf(run, row, 'name')[0];
  const nameColumn = run.columns.find((c) => run.mapping[c] === 'name') ?? '';
  if (!nameCell) return skip(nameColumn, 'no_name', 'No name.');
  if (nameCell.value.length > LIMITS.name) {
    return skip(
      nameCell.column,
      'name_too_long',
      `The name is longer than ${LIMITS.name} characters.`,
      { max: LIMITS.name },
    );
  }
  const takenBy = lookups.sourceIds.get(source.id);
  if (takenBy !== undefined) {
    return takenBy === 0
      ? skip(source.column, 'already_imported', 'Already imported.')
      : skip(source.column, 'same_as_row', `The same as row ${takenBy}.`, { row: takenBy });
  }

  const first = (field: string) => cellsOf(run, row, field)[0];
  const text = (field: keyof typeof LIMITS): string | null => {
    const c = first(field);
    if (!c) return null;
    if (c.value.length > LIMITS[field]) {
      asText(ctx, c.column, c.value, 'too_long', `Longer than ${LIMITS[field]} characters.`, {
        max: LIMITS[field],
      });
      return null;
    }
    return c.value;
  };

  // Type, then what depends on it (quantity, custom fields).
  let typeId: string | null = null;
  const typeCell = first('type');
  if (typeCell) {
    const found = run.choices.typeByName ? lookups.types.get(normalize(typeCell.value)) : undefined;
    if (found) typeId = found;
    else {
      if (run.choices.typeByName) {
        asText(ctx, typeCell.column, typeCell.value, 'type_not_found', 'No type has this name.');
      } else {
        asText(
          ctx,
          typeCell.column,
          typeCell.value,
          'types_not_matched',
          'Types are not matched by name.',
        );
      }
    }
  }
  const info = typeId ? await typeInfoOf(client, lookups, typeId) : { caps: [], fields: [] };

  const model = text('model');
  const serial = text('serial');
  const barcode = text('barcode');
  const colour = text('colour');

  // The row's currency, read once (a bad currency cell is kept as text once).
  let rowCurrency: string | null | undefined;
  const currency = () => {
    if (rowCurrency === undefined) rowCurrency = currencyOf(ctx, row);
    return rowCurrency;
  };

  let quantity = 1;
  const qtyCell = first('quantity');
  if (qtyCell) {
    const q = parseQuantity(qtyCell.value);
    const counted = info.caps.includes('serialized') || info.caps.includes('metered');
    if (q === null) asText(ctx, qtyCell.column, qtyCell.value, 'not_quantity', 'Not a quantity.');
    else if (q !== 1 && counted) {
      asText(
        ctx,
        qtyCell.column,
        qtyCell.value,
        'counted_one_by_one',
        'This type is counted one by one.',
      );
    } else if (q === 0 && !info.caps.includes('consumable')) {
      asText(
        ctx,
        qtyCell.column,
        qtyCell.value,
        'zero_needs_consumable',
        'Only a consumable can have quantity 0.',
      );
    } else quantity = q;
  }

  let brand: Ref | null = null;
  const brandCell = first('brand');
  if (brandCell) {
    if (brandCell.value.length > REGISTRY_NAME_MAX.brand) {
      asText(
        ctx,
        brandCell.column,
        brandCell.value,
        'brand_too_long',
        'Too long for a brand name.',
        {
          max: REGISTRY_NAME_MAX.brand,
        },
      );
    } else brand = refOf(lookups.brands, brandCell.value);
  }

  let condition: Condition | null = null;
  const condCell = first('condition');
  if (condCell) {
    const c = CONDITIONS.find((k) => k === condCell.value.toLowerCase());
    if (c) condition = c;
    else {
      asText(
        ctx,
        condCell.column,
        condCell.value,
        'not_condition',
        `Not a condition (${CONDITIONS.join(', ')}).`,
      );
    }
  }

  let manualUrl: string | null = null;
  const urlCell = first('manual_url');
  if (urlCell) {
    manualUrl = parseUrl(urlCell.value);
    if (!manualUrl) {
      asText(ctx, urlCell.column, urlCell.value, 'not_link', 'Not an http(s) link.');
    }
  }

  const tags: Ref[] = [];
  for (const c of cellsOf(run, row, 'tags')) {
    for (const t of splitList(c.value)) {
      if (t.length > REGISTRY_NAME_MAX.tag || tags.length >= TAGS_MAX) {
        asText(
          ctx,
          c.column,
          t,
          'tag_not_added',
          'Not added as a tag (too long, or too many tags).',
        );
        continue;
      }
      const ref = refOf(lookups.tags, t);
      const key = 'id' in ref ? ref.id : normalize(ref.create);
      if (!tags.some((x) => ('id' in x ? x.id : normalize(x.create)) === key)) tags.push(ref);
    }
  }

  const aliases: Record<string, string[]> = {};
  for (const c of cellsOf(run, row, 'aliases')) {
    for (const a of splitList(c.value)) {
      const lang = aliasLanguage(lookups, a);
      const list = aliases[lang] ?? [];
      if (a.length > ALIAS_MAX || list.length >= ALIASES_MAX) {
        asText(
          ctx,
          c.column,
          a,
          'alias_not_added',
          'Not added as a name it is also called (too long, or too many).',
        );
        continue;
      }
      list.push(a);
      aliases[lang] = list;
    }
  }

  // Money: one purchase line per row (D115), when the money module shows.
  let purchase: PlannedThing['purchase'] = null;
  const priceCell = first('price');
  const dateCell = first('purchased_on');
  const vendorCell = first('vendor');
  const currencyCell = first('currency');
  if (!lookups.showMoney) {
    for (const c of [priceCell, dateCell, vendorCell, currencyCell]) {
      if (c) {
        asText(
          ctx,
          c.column,
          c.value,
          'money_off',
          'Money is turned off for this location; kept as text.',
        );
      }
    }
  } else if (priceCell || dateCell || vendorCell) {
    const price = priceCell ? parsePrice(priceCell.value) : null;
    const date = dateCell ? parseDate(dateCell.value, run.choices.dateFormat) : null;
    const cur = priceCell ? currency() : null;
    if (priceCell && !price) {
      asText(ctx, priceCell.column, priceCell.value, 'not_price', 'Not a price.');
    }
    if (dateCell && !date) {
      asText(
        ctx,
        dateCell.column,
        dateCell.value,
        'not_date',
        `Not a date as ${run.choices.dateFormat}.`,
        { format: run.choices.dateFormat },
      );
    } else if (date && date > lookups.today) {
      asText(
        ctx,
        dateCell?.column ?? '',
        dateCell?.value ?? '',
        'future_date',
        'The date is in the future.',
      );
    }
    const dateOk = !!date && date <= lookups.today;
    if (price && cur && dateOk) {
      let vendor: Ref | null = null;
      if (vendorCell) {
        if (vendorCell.value.length > REGISTRY_NAME_MAX.vendor) {
          asText(
            ctx,
            vendorCell.column,
            vendorCell.value,
            'vendor_too_long',
            'Too long for a vendor name.',
            { max: REGISTRY_NAME_MAX.vendor },
          );
        } else vendor = refOf(lookups.vendors, vendorCell.value);
      }
      purchase = { purchasedOn: date, currency: cur, price, vendor };
    } else {
      // A purchase needs a price, a currency and a date: whatever is here stays as text.
      const [code, why]: [ImportIssueCode, string] = !priceCell
        ? ['needs_price', 'A purchase needs a price.']
        : !dateCell
          ? ['needs_date', 'A price needs a purchase date.']
          : ['purchase_incomplete', 'The purchase is incomplete; kept as text.'];
      for (const c of [priceCell, dateCell, vendorCell]) {
        if (c && !ctx.text.some((x) => x.column === c.column)) {
          asText(ctx, c.column, c.value, code, why);
        }
      }
    }
  }

  // Custom fields of the row's type.
  const custom: Record<string, unknown> = {};
  run.columns.forEach((column, i) => {
    const field = run.mapping[column];
    if (!field?.startsWith('custom.')) return;
    const value = cell(row[i]);
    if (!value) return;
    const key = field.slice('custom.'.length);
    const def = info.fields.find((f) => f.key === key && f.archivedAt === null);
    if (!def) {
      if (typeId) asText(ctx, column, value, 'not_type_field', 'Not a field of this type.');
      else asText(ctx, column, value, 'no_type', 'The row has no type.');
      return;
    }
    if (def.secret) {
      // Never into the notes: a secret stays out of plain text (D116).
      ctx.issues.push(
        issue(column, 'secret_skipped', 'Secret fields are not imported; add it on the thing.'),
      );
      return;
    }
    const got = customValue(
      ctx,
      def,
      value,
      def.kind === 'money' && lookups.showMoney ? currency() : null,
    );
    if ('value' in got) custom[key] = got.value;
    else asText(ctx, column, value, got.code, got.reason, got.params);
  });

  // Where it goes.
  let target: PlannedTarget = { placeId: lookups.defaultPlaceId };
  const pathCell = first('place_path');
  if (pathCell) {
    const names = splitPlacePath(pathCell.value, run.choices.placeSeparator);
    let parentId: string | null = null;
    let at = 0;
    for (; at < names.length; at++) {
      const found = lookups.childPlace(parentId, names[at] as string);
      if (!found) break;
      parentId = found;
    }
    const rest = names.slice(at);
    if (names.length === 0) {
      // A separator alone: the default target.
    } else if (rest.some((n) => n.length > PLACE_NAME_MAX)) {
      asText(
        ctx,
        pathCell.column,
        pathCell.value,
        'place_name_too_long',
        `A place name is longer than ${PLACE_NAME_MAX} characters.`,
        { max: PLACE_NAME_MAX },
      );
    } else if (rest.length === 0) {
      target = { placeId: parentId as string };
    } else if (run.choices.createPlaces) {
      target = { parentId, create: rest };
      if (mode === 'plan') {
        // Later rows find these places; the job creates them for real.
        let parent = parentId;
        for (const n of rest) {
          const id = lookups.placeholder();
          lookups.rememberPlace(parent, n, id);
          parent = id;
        }
      }
    } else {
      asText(
        ctx,
        pathCell.column,
        pathCell.value,
        'no_such_place',
        'No such place; it goes to the default place.',
      );
    }
  }

  // Legacy codes (D146, D208): unique per location whatever their source.
  const legacyCodes: string[] = [];
  for (const c of cellsOf(run, row, 'legacy_code')) {
    const code = legacyCodeOf(c.value);
    if (code.length > CODE_MAX) {
      asText(ctx, c.column, c.value, 'too_long', `Longer than ${CODE_MAX} characters.`, {
        max: CODE_MAX,
      });
    } else if (lookups.codes.has(code) || legacyCodes.includes(code)) {
      ctx.issues.push(issue(c.column, 'code_taken', 'This code is already on something else.'));
    } else legacyCodes.push(code);
  }
  // Own codes (D208, T17a): the same, and the location's format rule; a code it refuses is kept
  // as text, with the owner's message.
  const ownCodes: string[] = [];
  for (const c of cellsOf(run, row, 'own_code')) {
    const code = legacyCodeOf(c.value);
    const verdict = lookups.rule ? (lookups.ruleVerdicts.get(code) ?? 'mismatch') : 'ok';
    if (code.length > CODE_MAX) {
      asText(ctx, c.column, c.value, 'too_long', `Longer than ${CODE_MAX} characters.`, {
        max: CODE_MAX,
      });
    } else if (verdict !== 'ok' && lookups.rule) {
      asText(ctx, c.column, c.value, 'code_format', lookups.rule.message, {
        rule: lookups.rule.message,
      });
    } else if (lookups.codes.has(code) || legacyCodes.includes(code) || ownCodes.includes(code)) {
      ctx.issues.push(issue(c.column, 'code_taken', 'This code is already on something else.'));
    } else ownCodes.push(code);
  }

  // Notes last: the mapped notes, then what was kept as text.
  const notesParts = cellsOf(run, row, 'notes').map((c) => c.value);
  const order = (column: string) => run.columns.indexOf(column);
  notesParts.push(
    ...ctx.text
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => order(a.column) - order(b.column) || a.i - b.i)
      .map((x) => x.line),
  );
  let notes: string | null = notesParts.length ? notesParts.join('\n') : null;
  if (notes && notes.length > NOTES_MAX) {
    notes = notes.slice(0, NOTES_MAX);
    ctx.issues.push(
      issue(
        cellsOf(run, row, 'notes')[0]?.column ?? '',
        'notes_cut',
        `The notes are cut to ${NOTES_MAX.toLocaleString('en')} characters.`,
        { max: NOTES_MAX },
      ),
    );
  }

  lookups.rememberSourceId(source.id, rowNo);
  if (mode === 'plan') {
    for (const code of [...legacyCodes, ...ownCodes]) lookups.rememberCode(code, PLACEHOLDER);
    if (brand && 'create' in brand) lookups.rememberBrand(brand.create, lookups.placeholder());
    for (const t of tags) if ('create' in t) lookups.rememberTag(t.create, lookups.placeholder());
    const v = purchase?.vendor;
    if (v && 'create' in v) lookups.rememberVendor(v.create, lookups.placeholder());
  }

  return {
    row: rowNo,
    status: ctx.text.length > 0 ? 'text' : 'ok',
    issues: ctx.issues,
    sourceId: source.id,
    thing: {
      name: nameCell.value,
      quantity,
      typeId,
      brand,
      model,
      serial,
      barcode,
      colour,
      condition,
      notes,
      aliases,
      tags,
      manualUrl,
      custom,
      target,
      purchase,
      legacyCodes,
      ownCodes,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------------------------

/** Maps every row without writing, and reports "mapped, as text, skipped, why" (§5). */
export async function dryRun(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  run: RunInput,
): Promise<DryRunReport> {
  const indexed = run.rows.map((row, index) => ({ index, row }));
  const lookups = await loadLookups(tx, client, scope, run, indexed);
  const report: DryRunReport = {
    summary: { things: 0, places: 0, purchases: 0, legacyCodes: 0, skipped: 0, asText: 0 },
    rows: [],
  };
  for (const { index, row } of indexed) {
    const planned = await planRow(client, run, lookups, index, row, 'plan');
    report.rows.push({ row: planned.row, status: planned.status, issues: planned.issues });
    if (planned.status === 'skipped' || !planned.thing) {
      report.summary.skipped += 1;
      continue;
    }
    if (planned.status === 'text') report.summary.asText += 1;
    report.summary.things += 1;
    if (planned.thing.purchase) report.summary.purchases += 1;
    report.summary.legacyCodes += planned.thing.legacyCodes.length + planned.thing.ownCodes.length;
    if ('create' in planned.thing.target)
      report.summary.places += planned.thing.target.create.length;
  }
  return report;
}
