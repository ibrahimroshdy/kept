import { MAX_FILTER_VALUES } from '@kept/shared';
import { z } from 'zod';

// Multi-value list filters (D205, the filter strip). A list endpoint's filter parameter may be
// repeated (`?typeId=a&typeId=b`: Fastify's querystring parser gives an array) or given once, as
// before; either way the route sees an array. `not` is repeated too, naming the filter parameters
// that are "is none of" rather than "is any of" (`?actorId=x&not=actorId`). A `not` naming a
// parameter with no values is ignored.
//
// In SQL, "any of" is `coalesce(<cond using = ANY ($n::uuid[])>, false)` and "none of" is the
// same wrapped in NOT, so a thing with no type, brand or owner counts as "none of" any of them:
// see anyOf()/noneOf() below.

/** One filter parameter: a single value or a repeated one, always an array (at most
 * MAX_FILTER_VALUES, duplicates dropped). */
export function manyOf<T extends z.ZodType<string>>(schema: T) {
  return z
    .union([schema, z.array(schema).max(MAX_FILTER_VALUES)])
    .transform((v): z.output<T>[] => [...new Set(Array.isArray(v) ? v : [v])] as z.output<T>[]);
}

/** The `not` parameter of an endpoint whose filter parameters are `names`. */
export function notOf<const N extends readonly [string, ...string[]]>(names: N) {
  return manyOf(z.enum(names));
}

/** Whether filter `name` is "is none of" in this request. */
export const isNot = (not: readonly string[] | undefined, name: string): boolean =>
  not?.includes(name) ?? false;

/** One multi-value filter as the SQL builders take it: "is any of" `values`, or "is none of"
 * them when `not`. */
export type Many<T extends string = string> = { values: T[]; not: boolean };

/** Filter `name` of a request, or undefined when it holds nothing (its `not` is then ignored). */
export function filterOf<T extends string>(
  values: readonly T[] | undefined,
  name: string,
  not: readonly string[] | undefined,
): Many<T> | undefined {
  return values?.length ? { values: [...values], not: isNot(not, name) } : undefined;
}

/** `cond` as an "any of" or "none of" condition: NULL (no type, no brand) is never "any of" and
 * always "none of". */
export const matchOf = (cond: string, negate: boolean): string =>
  negate ? `NOT coalesce(${cond}, false)` : `coalesce(${cond}, false)`;

/** A date bound of a list (`from` inclusive, `to` exclusive): a time, or a calendar date meaning
 * its midnight in UTC. */
export const When = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

/** Lower-cased uuids: the ids a client sent, as the database stores them. */
export const lowerIds = (ids: readonly string[] | undefined): string[] =>
  (ids ?? []).map((id) => id.toLowerCase());
