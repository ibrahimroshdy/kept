import { AmountError, parseAmount } from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Pools } from '../db/pools.js';
import { withScope } from '../db/scope.js';
import { AppError, invalid, notFound } from '../http/errors.js';

// Input rules the step-4 money and warranty routes share (T8, T9): amounts, currencies and dates
// as purchases read them (purchases/service.ts; D136, D168, D172, D189), today in a location's
// zone, and the module gate's location for a route addressed by a record's id.

/** An amount as typed, in canonical form; 400 naming the field when it isn't one. */
export function amountIn(raw: string, where: string): string {
  try {
    return parseAmount(raw);
  } catch (err) {
    if (err instanceof AmountError) {
      throw invalid(`Check ${where}: a decimal amount of at most 4 decimals, e.g. 1250.50.`);
    }
    throw err;
  }
}

/** An ISO 4217 code, upper-cased. "$" gets its own hint: it is USD or CAD, never a default. */
export function currencyIn(raw: string, where: string): string {
  const code = raw.trim();
  if (code.includes('$')) throw invalid(`Check ${where}: “$” can be USD or CAD. Pick one.`);
  if (!/^[A-Za-z]{3}$/.test(code)) {
    throw invalid(`Check ${where}: a three-letter currency code, e.g. EGP.`);
  }
  return code.toUpperCase();
}

/** 400 unless the currency is enabled on this server (D168). */
export async function requireEnabled(
  client: pg.ClientBase,
  code: string,
  where: string,
): Promise<void> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.currencies WHERE code = $1 AND enabled',
    [code],
  );
  if (!rowCount) throw invalid(`Check ${where}: use a currency that is turned on.`);
}

/** Today in the location's time zone, `YYYY-MM-DD` (reminder rules: the location's zone). */
export async function todayIn(client: pg.ClientBase, locationId: string): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `SELECT (now() AT TIME ZONE l.timezone)::date::text AS today
       FROM public.locations l WHERE l.id = $1`,
    [locationId],
  );
  const today = rows[0]?.today;
  if (!today) throw notFound();
  return today;
}

/** A calendar date, `YYYY-MM-DD`, that exists (2026-02-30 doesn't). */
export const Day = z.iso.date();

/** Writing money where the caller's gate hides it (the money module is off there): 409. */
export const moneyOff = () =>
  new AppError('module_off', 409, 'Money is turned off for this location.');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Step-4 record tables addressed by id whose rows name their location. */
export type LocatedTable = 'valuations' | 'warranties' | 'claims';

/**
 * A `moduleLocation` resolver (http/modules.ts) for `/api/v1/<records>/:id`: the row's location
 * as the request's user sees it, in its own short scoped transaction, so a row they can't see
 * resolves to null (a plain 404, never `module_off`).
 */
export function locationOfRow(
  pools: Pick<Pools, 'app'>,
  table: LocatedTable,
): (req: FastifyRequest) => Promise<string | null> {
  return async (req) => {
    const id = (req.params as { id?: unknown } | undefined)?.id;
    if (!req.scope || typeof id !== 'string' || !UUID.test(id)) return null;
    return withScope(pools.app, req.scope, async (_tx, client) => {
      const { rows } = await client.query<{ location_id: string }>(
        `SELECT location_id FROM public.${table} WHERE id = $1`,
        [id.toLowerCase()],
      );
      return rows[0]?.location_id ?? null;
    });
  };
}
