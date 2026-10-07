/**
 * Type fields, resolved and validated (D92, D154, D192; Q3, Q4). Shared by the server's routes and
 * the web forms, so both refuse the same values. Works for built-ins and for account types alike:
 * anything with a `key`, `fields` and optional `groups`.
 */

import { z } from 'zod';
import type { FieldDef } from './builtin-types.js';
import { parseAmount } from './money.js';

/** A decimal amount as the API accepts it: at most 12 integer digits and 4 decimals (§7.13). */
export const AMOUNT_STRING = /^\d{1,12}(?:\.\d{1,4})?$/;
export const CURRENCY_CODE = /^[A-Z]{3}$/;
const TEXT_MAX = 2000;
const REPEAT_MAX = 50;

export type FieldHolder = {
  readonly key: string;
  readonly fields: readonly FieldDef[];
  readonly groups?: readonly string[];
};

export type ResolvedField = FieldDef & {
  /** The key of the type or field group that defines the field. */
  readonly source: string;
  readonly fromGroup: boolean;
};

export class FieldRedefinedError extends Error {
  constructor(
    readonly key: string,
    readonly first: string,
    readonly second: string,
  ) {
    super(`field "${key}" is defined by both ${first} and ${second}`);
    this.name = 'FieldRedefinedError';
  }
}

/**
 * Every field a type carries, in display order: for each type from the root down, its own fields
 * and then those of its field groups. A group referenced more than once is included once. Throws
 * `FieldRedefinedError` when a key appears twice (a child or group may never redefine a field),
 * and a plain Error for an unknown group.
 */
export function resolveFields(
  typeChain: readonly FieldHolder[],
  groups: ReadonlyMap<string, FieldHolder> | Readonly<Record<string, FieldHolder>>,
): ResolvedField[] {
  const lookup = (k: string): FieldHolder | undefined =>
    groups instanceof Map ? groups.get(k) : (groups as Record<string, FieldHolder>)[k];
  const out: ResolvedField[] = [];
  const owner = new Map<string, string>();
  const included = new Set<string>();
  const add = (holder: FieldHolder, fromGroup: boolean) => {
    for (const field of holder.fields) {
      const prior = owner.get(field.key);
      if (prior !== undefined) throw new FieldRedefinedError(field.key, prior, holder.key);
      owner.set(field.key, holder.key);
      out.push({ ...field, source: holder.key, fromGroup });
    }
  };
  for (const type of typeChain) {
    add(type, false);
    for (const g of type.groups ?? []) {
      if (included.has(g)) continue;
      const group = lookup(g);
      if (!group) throw new Error(`unknown field group ${g} on ${type.key}`);
      included.add(g);
      add(group, true);
    }
  }
  return out;
}

type FieldShape = Pick<FieldDef, 'kind' | 'options' | 'repeatable'>;

function singleValue(field: FieldShape): z.ZodType {
  switch (field.kind) {
    case 'text':
      return z.string().max(TEXT_MAX);
    case 'number':
      return z.number();
    case 'date':
      return z.iso.date();
    case 'select':
      return field.options?.length ? z.enum(field.options as [string, ...string[]]) : z.string();
    case 'multi_select': {
      const option = field.options?.length
        ? z.enum(field.options as [string, ...string[]])
        : z.string();
      return z
        .array(option)
        .refine((xs) => new Set(xs).size === xs.length, 'Each option can be chosen once');
    }
    case 'boolean':
      return z.boolean();
    case 'url':
      return z.url({ protocol: /^https?$/ }).max(TEXT_MAX);
    case 'money':
      return z.strictObject({
        // Canonical once valid (`"12.00"` → `"12"`), so stored values and the wire agree.
        amount: z.string().regex(AMOUNT_STRING).transform(parseAmount),
        currency: z.string().regex(CURRENCY_CODE),
      });
    case 'person':
    case 'vendor':
    case 'file':
      return z.uuid();
  }
}

/**
 * The zod schema for one field's value. A `repeatable` field takes an array of values; for a
 * `multi_select` the value is already a list, so `repeatable` changes nothing.
 */
export function fieldValueSchema(field: FieldShape): z.ZodType {
  const one = singleValue(field);
  return field.repeatable && field.kind !== 'multi_select' ? z.array(one).max(REPEAT_MAX) : one;
}

const SECRET_MESSAGE = 'Secret fields are written through the secrets route, not in custom';

/**
 * The strict schema for a thing's `custom` object: every resolved field optional, unknown keys
 * refused, and a secret field refused with a pointer to the secrets route (secrets never reach
 * `custom`: §7.13, Q3).
 */
export function customSchema(fields: readonly FieldDef[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    shape[field.key] = field.secret
      ? z.never(SECRET_MESSAGE).optional()
      : fieldValueSchema(field).optional();
  }
  return z.strictObject(shape);
}
