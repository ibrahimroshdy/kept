import {
  AMOUNT_STRING,
  CONDITIONS,
  customSchema,
  DERIVED_STATES,
  type FieldDef,
  LIFECYCLES,
  LINK_KINDS,
  parseAmount,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { PAGE_MAX } from '../http/conventions.js';
import { AppError, invalid } from '../http/errors.js';
import { manyOf, notOf } from '../http/list-filters.js';
import type { ResolvedFieldView } from './fields.js';

// Request shapes and the checks the database would otherwise answer less helpfully (plan T14
// validate.ts). The shapes are the web contract's (apps/web/src/api/inventory/types.ts).
//
// - `custom` is validated against the type's resolved fields with @kept/shared's customSchema():
//   unknown keys and secret keys are refused (secrets go through the secrets route, Q3). "Required"
//   applies to new edits only (D172): a request may leave a required field empty, but may not
//   clear one it touches.
// - Quantity (D10, §7.13, plan Q11) is checked against the resolved capabilities first, so the
//   caller gets a 400 with a hint rather than the trigger's 409.

const Text = (max: number) => z.string().trim().min(1).max(max);
const NullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s === '' ? null : s));
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((c) => c.toUpperCase());
/** Stored and audited in canonical form (`"1250.50"` → `"1250.5"`), as every amount is. */
const Amount = z
  .string()
  .regex(AMOUNT_STRING, 'a decimal amount, e.g. 1250.50')
  .transform((a) => parseAmount(a));
const IsoDate = z.iso.date();
const Quantity = z.number().min(0).max(999_999_999).multipleOf(0.001);
const Url = z.url({ protocol: /^https?$/ }).max(2000);
export const Aliases = z
  .record(z.string().regex(/^[a-z]{2,3}$/), z.array(z.string().trim().min(1).max(200)).max(20))
  .refine((a) => Object.keys(a).length <= 10, 'at most 10 languages');
const Custom = z.record(z.string().max(64), z.unknown());

export const Params = z.object({ id: z.uuid() });
export const LinkParams = z.object({ linkId: z.uuid() });
export const CodeParams = z.object({ code: z.string().min(1).max(20) });

export const MoveTarget = z.union([
  z.strictObject({ placeId: z.uuid() }),
  z.strictObject({ containerId: z.uuid() }),
]);
export type MoveTarget = z.infer<typeof MoveTarget>;

export const CreateBody = z
  .object({
    id: z.uuid().optional(),
    locationId: z.uuid(),
    placeId: z.uuid().optional(),
    containerId: z.uuid().optional(),
    name: Text(200),
    typeId: z.uuid().optional(),
    quantity: Quantity.optional(),
    brandId: z.uuid().optional(),
    model: Text(120).optional(),
    serial: Text(100).optional(),
    barcode: Text(64).optional(),
    colour: Text(60).optional(),
    condition: z.enum(CONDITIONS).optional(),
    notes: Text(5000).optional(),
    aliases: Aliases.optional(),
    tagIds: z.array(z.uuid()).max(50).optional(),
    belongsToPersonId: z.uuid().optional(),
    manualUrl: Url.optional(),
    expiresOn: IsoDate.optional(),
    expiryLeadDays: z.number().int().min(0).max(3650).optional(),
    custom: Custom.optional(),
    /** Quick add (T19): the template's payload is the base, and the fields sent here win. */
    templateId: z.uuid().optional(),
    purchase: z
      .object({
        purchasedOn: IsoDate,
        vendorId: z.uuid().optional(),
        currency: Currency,
        price: Amount,
      })
      .optional(),
  })
  .refine((b) => !b.placeId !== !b.containerId, {
    message: 'Put it in exactly one place or container.',
    path: ['placeId'],
  });
export type CreateBody = z.infer<typeof CreateBody>;

export const UpdateBody = z
  .object({
    name: Text(200),
    typeId: z.uuid().nullable(),
    quantity: Quantity,
    brandId: z.uuid().nullable(),
    model: NullableText(120),
    serial: NullableText(100),
    barcode: NullableText(64),
    colour: NullableText(60),
    condition: z.enum(CONDITIONS).nullable(),
    notes: NullableText(5000),
    aliases: Aliases,
    tagIds: z.array(z.uuid()).max(50),
    belongsToPersonId: z.uuid().nullable(),
    manualUrl: Url.nullable(),
    expiresOn: IsoDate.nullable(),
    expiryLeadDays: z.number().int().min(0).max(3650).nullable(),
    acquiredFrom: NullableText(200),
    provenanceNotes: NullableText(5000),
    custom: Custom,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' });
export type UpdateBody = z.infer<typeof UpdateBody>;

export const LifecycleBody = z.object({
  lifecycle: z.enum(LIFECYCLES),
  endedOn: IsoDate.optional(),
  endedPrice: Amount.optional(),
  endedCurrency: Currency.optional(),
  endedTo: Text(200).optional(),
  endedNotes: Text(5000).optional(),
});
export type LifecycleBody = z.infer<typeof LifecycleBody>;

export const RetypeBody = z.object({ typeId: z.uuid() });
export const DuplicateBody = z.object({ id: z.uuid().optional() }).default({});
export const SplitBody = z.object({
  quantity: Quantity.refine((q) => q > 0, 'more than 0'),
  id: z.uuid().optional(),
  to: MoveTarget.optional(),
});
export type SplitBody = z.infer<typeof SplitBody>;
export const LinkBody = z.object({ toThingId: z.uuid(), kind: z.enum(LINK_KINDS) });
export const ConvertBody = z
  .object({
    parentId: z.uuid().optional(),
    /** Convert even though the thing's own record (purchase link, serial, …) is lost (#23). */
    discard: z.boolean().optional(),
  })
  .default({});

/** The list's filters that take several values and "is none of" (D205, http/list-filters.ts);
 * the place, container and vendor stay one. */
export const THING_LIST_FILTERS = [
  'locationId',
  'typeId',
  'tagId',
  'state',
  'brandId',
  'belongsToId',
] as const;

export const ListQuery = z.object({
  locationId: manyOf(z.uuid()).optional(),
  placeId: z.uuid().optional(),
  containerId: z.uuid().optional(),
  typeId: manyOf(z.uuid()).optional(),
  tagId: manyOf(z.uuid()).optional(),
  belongsToId: manyOf(z.uuid()).optional(),
  brandId: manyOf(z.uuid()).optional(),
  vendorId: z.uuid().optional(),
  state: manyOf(z.enum(DERIVED_STATES)).optional(),
  not: notOf(THING_LIST_FILTERS).optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  /** The things an import run brought in (its import_source_ids): "See what was imported"
   * (step-7 T16). Owners and admins; for anyone else it matches nothing. */
  importRunId: z.uuid().optional(),
  /** `1`: only things that hold things (the container capability, or contents; T26). */
  container: z.enum(['0', '1']).optional(),
  q: z.string().trim().max(200).optional(),
  group: z.enum(['type', 'place', 'none']).default('none'),
  sort: z.enum(['name', 'updated', 'lastSeen']).default('name'),
  /** The order (D211): `asc` or `desc`. Absent, the sort's own: A to Z for the name, newest
   * first for the dates. */
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(20),
  cursor: z.string().max(2048).optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

// ---------------------------------------------------------------------------------------------
// custom
// ---------------------------------------------------------------------------------------------

const asDef = (f: ResolvedFieldView): FieldDef => ({
  key: f.key,
  kind: f.kind,
  names: { en: f.label ?? f.key, ar: f.label ?? f.key },
  ...(f.options ? { options: f.options } : {}),
  ...(f.secret ? { secret: true } : {}),
  ...(f.repeatable ? { repeatable: true } : {}),
});

/** The first issue's path, as `body.custom.<key>` (never the value). */
function issuePath(error: z.ZodError): string {
  const path = error.issues[0]?.path ?? [];
  return ['body', 'custom', ...path.map(String)].join('.');
}

/**
 * Checks the `custom` values a request writes against the type's live (not archived) fields.
 * `null` means "remove this key", allowed unless the field is required. Returns the keys the
 * request sets and removes; throws 400 naming the first bad key.
 */
export function checkCustom(
  fields: readonly ResolvedFieldView[],
  custom: Readonly<Record<string, unknown>>,
): { set: Record<string, unknown>; removed: string[] } {
  const live = fields.filter((f) => f.archivedAt === null);
  const byKey = new Map(live.map((f) => [f.key, f]));
  const set: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(custom)) {
    if (value !== null) {
      set[key] = value;
      continue;
    }
    const field = byKey.get(key);
    if (field?.required) throw invalid(`body.custom.${key} is required; it can't be cleared.`);
    removed.push(key);
  }
  const parsed = customSchema(live.map(asDef)).safeParse(set);
  if (!parsed.success) throw invalid(`Check ${issuePath(parsed.error)}.`);
  return { set: parsed.data as Record<string, unknown>, removed };
}

/** Whether `value` is a valid value of `field` (its kind, options, repeatable), for re-typing:
 * a money-shaped value fits a money field only, and a money field nothing else. */
export function fitsField(field: ResolvedFieldView, value: unknown): boolean {
  const money = field.kind === 'money';
  const shaped = Array.isArray(value) ? value.some(isMoney) : isMoney(value);
  if (shaped !== money) return false;
  return customSchema([asDef(field)]).safeParse({ [field.key]: value }).success;
}

const isMoney = (v: unknown) =>
  v !== null && typeof v === 'object' && 'amount' in v && 'currency' in v;

/** The money values among `set` (money-kind fields), for the currency and gate checks. */
export function moneyValues(
  fields: readonly ResolvedFieldView[],
  set: Readonly<Record<string, unknown>>,
): { key: string; currency: string }[] {
  const out: { key: string; currency: string }[] = [];
  for (const f of fields) {
    if (f.kind !== 'money' || !(f.key in set)) continue;
    const values = f.repeatable ? (set[f.key] as unknown[]) : [set[f.key]];
    for (const v of values)
      out.push({ key: f.key, currency: (v as { currency: string }).currency });
  }
  return out;
}

/** 400 unless every currency is enabled (D168). */
export async function requireCurrencies(
  client: pg.ClientBase,
  codes: readonly string[],
  where: string,
): Promise<void> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return;
  const { rows } = await client.query<{ code: string }>(
    'SELECT code FROM public.currencies WHERE code = ANY ($1::text[]) AND enabled',
    [unique],
  );
  if (rows.length !== unique.length) throw invalid(`Check ${where}: use an enabled currency.`);
}

/** Person and vendor values must be rows of the location's account (a 400, never a lookup
 * elsewhere). */
export async function checkCustomRefs(
  client: pg.ClientBase,
  fields: readonly ResolvedFieldView[],
  set: Readonly<Record<string, unknown>>,
  locationId: string,
): Promise<void> {
  for (const kind of ['person', 'vendor'] as const) {
    const ids: string[] = [];
    for (const f of fields) {
      if (f.kind !== kind || !(f.key in set)) continue;
      const v = set[f.key];
      ids.push(...(Array.isArray(v) ? (v as string[]) : [v as string]));
    }
    if (ids.length === 0) continue;
    const table = kind === 'person' ? 'people' : 'vendors';
    const unique = [...new Set(ids)];
    const { rows } = await client.query(
      `SELECT r.id FROM public.${table} r
        WHERE r.id = ANY ($1::uuid[])
          AND r.owner_account_id = (SELECT l.owner_account_id FROM public.locations l
                                     WHERE l.id = $2)`,
      [unique, locationId],
    );
    if (rows.length !== unique.length) throw invalid(`Check body.custom: an unknown ${kind}.`);
  }
}

// ---------------------------------------------------------------------------------------------
// quantity (D10)
// ---------------------------------------------------------------------------------------------

/**
 * D10 (plan Q11): quantity is 1 for anything serialized or metered (through inheritance) or with
 * a meter; 0 only for a consumable. Decimals are allowed (§7.13).
 */
export function checkQuantity(
  quantity: number,
  caps: readonly string[],
  hasMeters: boolean,
  where = 'body.quantity',
): void {
  if (quantity !== 1 && (caps.includes('serialized') || caps.includes('metered') || hasMeters)) {
    throw invalid(
      `${where} must be 1: a serialized or metered thing, or one with a meter, is counted one by one.`,
    );
  }
  if (quantity === 0 && !caps.includes('consumable')) {
    throw invalid(`${where} can be 0 only for a consumable.`);
  }
}

/** The body asks to write money the caller's gate hides: the money module is off here, or the
 * role can't see money. A viewer never gets this far (403); a member only when the module is
 * off. 409 module_off, like any write to a switched-off module. */
export const moneyOff = () =>
  new AppError('module_off', 409, 'Money is turned off for this location.');
