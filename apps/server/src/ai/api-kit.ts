/**
 * Small pieces the AI settings routes share (plan T9): who the caller is to AI, amounts and times
 * as the web contract spells them (apps/web/src/api/capture/types.ts "AI"), and the audit
 * placement of events that belong to an account or the instance rather than a location.
 */
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { FOREVER } from './breaker.js';

export type Who = {
  userId: string;
  /** The caller's own owner account (every person has one, §7.14). */
  accountId: string | null;
  instanceAdmin: boolean;
};

export async function whoAmI(client: pg.ClientBase): Promise<Who> {
  const { rows } = await client.query<{ uid: string; acct: string | null; admin: boolean }>(
    `SELECT kept.current_user_id() AS uid, kept.current_owner_account_id() AS acct,
            kept.is_instance_admin() AS admin`,
  );
  const r = rows[0];
  if (!r?.uid) throw new Error('whoAmI outside a scoped transaction');
  return { userId: r.uid, accountId: r.acct, instanceAdmin: r.admin === true };
}

/** A numeric the database reads back (`0.003900`, `5.0000`) as the contract's decimal string. */
export function amount(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'number' ? v.toFixed(6) : v;
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** A timestamptz as ISO; `infinity` (a manual pause) stays the word, as the mock sends it. */
export function isoTime(v: Date | number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v > 0 ? 'infinity' : null;
  if (typeof v === 'string') return v;
  return v.getTime() >= FOREVER.getTime() ? 'infinity' : v.toISOString();
}

/** Where an account- or instance-level AI event goes in the audit (the insert policy of 0006):
 * the instance's own events have no account; everyone else's go under their own account. */
export function auditHome(
  who: Who,
  instanceLevel: boolean,
): { locationId: null; ownerAccountId: string | null } {
  return { locationId: null, ownerAccountId: instanceLevel ? null : who.accountId };
}

export const MoneySchema = z.object({ amount: z.string(), currency: z.string() });

/** A decimal a person typed for a cap or a price: up to 12 digits and 6 decimals, not negative. */
export const Decimal = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'a decimal number, like 5 or 0.15');

export const Currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((c) => c.toUpperCase());

/** 400 `currency_not_enabled` unless the instance has the currency turned on. */
export async function requireCurrency(client: pg.ClientBase, code: string): Promise<void> {
  const { rows } = await client.query<{ ok: boolean }>(
    'SELECT enabled AS ok FROM public.currencies WHERE code = $1',
    [code],
  );
  if (rows[0]?.ok !== true) {
    throw new AppError('currency_not_enabled', 400, `Turn on ${code} in Settings first.`);
  }
}
