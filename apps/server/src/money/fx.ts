import type pg from 'pg';
import { audited } from '../audit/audited.js';
import { undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { checkVersion } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { accountAccess } from '../registries/account.js';
import { currencyIn, requireEnabled } from './input.js';
import type { FxRateView, PutFxRateBody } from './view.js';

// Exchange rates (step-4 plan T8; D76, D136; Q21, Q22): one per account, pair and date, entered
// by hand (no provider, Q22). A conversion uses the pair's newest rate valid on the day, else the
// inverse pair's; never chained, never estimated (@kept/shared money.ts `convert`, convert.ts; in
// SQL kept.fx_rate(), which the AI money caps count through).
//
// - Read by anyone who sees a location of the account (0049's policy).
// - Written by the account's owner and admins (0049's policy), audited at the account level
//   (`fx_rate.set`, `fx_rate.delete`), both undoable for 7 days (undo.ts). The audit policy
//   admits an account's admins' account-level `fx_rate` events (0056).
// - Replacing a rate (the same pair and date) needs If-Match; it is stored as a new row with the
//   next row_version, so `updatedBy` (the row's `created_by`) names who set the current rate.
//
// Every audit image is `{fx_rate: {from_ccy, to_ccy, valid_from, rate}}` (null where there was
// none, or is none after), so an event always carries the key its undo needs, even when only the
// rate changed.

const RATE_DIGITS = /[٠-٩۰-۹]/g;
const RATE = /^(\d+)(?:\.(\d+))?$/;

function westernDigit(d: string): string {
  const c = d.charCodeAt(0);
  return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
}

/**
 * A rate as typed, canonical ("48.25", "0.0205"): above 0, at most 10 integer digits and 8
 * decimals (numeric(18,8)); Eastern Arabic and Persian digits and `٫` read as the amounts' are
 * (D172). 400 naming the field otherwise.
 */
export function rateIn(raw: string, where: string): string {
  const s = raw.trim().replace(RATE_DIGITS, westernDigit).replace(/٫/g, '.');
  const m = RATE.exec(s);
  const hint = () => invalid(`Check ${where}: a rate above 0, e.g. 48.25.`);
  if (!m) throw hint();
  const int = (m[1] ?? '').replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (int.length > 10 || frac.length > 8) throw hint();
  if (/^0*$/.test(int) && frac === '') throw hint();
  return frac ? `${int}.${frac}` : int;
}

/** A stored numeric(18,8) as the wire has it: "48.25000000" → "48.25". */
export function rateOut(stored: string): string {
  if (!stored.includes('.')) return stored;
  return stored.replace(/0+$/, '').replace(/\.$/, '');
}

type RateRow = {
  from_ccy: string;
  to_ccy: string;
  rate: string;
  valid_from: string;
  row_version: number;
  updated_at: Date;
  display_name: string | null;
};

const RATE_SELECT = `SELECT f.from_ccy::text AS from_ccy, f.to_ccy::text AS to_ccy,
       f.rate::text AS rate, f.valid_from::text AS valid_from, f.row_version, f.updated_at,
       up.display_name
  FROM public.fx_rates f
  LEFT JOIN public.user_profiles up ON up.user_id = f.created_by`;

function rateView(r: RateRow): FxRateView {
  return {
    fromCcy: r.from_ccy,
    toCcy: r.to_ccy,
    rate: rateOut(r.rate),
    validFrom: r.valid_from,
    rowVersion: r.row_version,
    updatedBy: { displayName: r.display_name ?? '' },
    updatedAt: r.updated_at.toISOString(),
  };
}

export type RateKey = { accountId: string; from: string; to: string; validFrom: string };

/** The audit image of a rate (see the header). */
export type RateImage = { from_ccy: string; to_ccy: string; valid_from: string; rate: string };

const imageOf = (k: RateKey, rate: string): RateImage => ({
  from_ccy: k.from,
  to_ccy: k.to,
  valid_from: k.validFrom,
  rate,
});

/** The rate at `key`, locked when `lock`; null when there is none the caller sees. */
export async function rateAt(
  client: pg.ClientBase,
  key: RateKey,
  lock = false,
): Promise<RateRow | null> {
  const { rows } = await client.query<RateRow>(
    `${RATE_SELECT}
      WHERE f.owner_account_id = $1 AND f.from_ccy = $2 AND f.to_ccy = $3 AND f.valid_from = $4
      ${lock ? 'FOR UPDATE OF f' : ''}`,
    [key.accountId, key.from, key.to, key.validFrom],
  );
  return rows[0] ?? null;
}

/**
 * Sets the rate at `key`: a new row, or the existing one replaced by a new row with the next
 * row_version (so `created_by` is who set it). The caller has checked access.
 */
export async function writeRate(
  client: pg.ClientBase,
  key: RateKey,
  rate: string,
  existing: { row_version: number } | null,
): Promise<void> {
  if (existing) {
    await client.query(
      `DELETE FROM public.fx_rates
        WHERE owner_account_id = $1 AND from_ccy = $2 AND to_ccy = $3 AND valid_from = $4`,
      [key.accountId, key.from, key.to, key.validFrom],
    );
  }
  await client.query(
    `INSERT INTO public.fx_rates (owner_account_id, from_ccy, to_ccy, rate, valid_from, created_by,
                                  row_version)
     VALUES ($1, $2, $3, $4, $5, kept.current_user_id(), $6)`,
    [key.accountId, key.from, key.to, rate, key.validFrom, (existing?.row_version ?? 0) + 1],
  );
}

/** Removes the rate at `key`. */
export async function removeRate(client: pg.ClientBase, key: RateKey): Promise<void> {
  await client.query(
    `DELETE FROM public.fx_rates
      WHERE owner_account_id = $1 AND from_ccy = $2 AND to_ccy = $3 AND valid_from = $4`,
    [key.accountId, key.from, key.to, key.validFrom],
  );
}

// ---------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------

const WRITE_HINT = 'Only owners and admins set exchange rates.';

/** 404 unless the caller sees a location of the account. */
async function readAccess(client: pg.ClientBase, accountId: string): Promise<void> {
  if (!(await accountAccess(client, accountId))) throw notFound();
}

/** 404 unless visible; 403 unless an owner or admin of it. */
async function writeAccess(client: pg.ClientBase, accountId: string): Promise<void> {
  const access = await accountAccess(client, accountId);
  if (!access) throw notFound();
  if (access.role !== 'owner' && access.role !== 'admin') throw forbidden(WRITE_HINT);
}

// ---------------------------------------------------------------------------------------------
// Routes' services
// ---------------------------------------------------------------------------------------------

export type FxCtx = { tx: Tx; client: pg.ClientBase; scope: Scope; requestId: string };

/** GET /api/v1/accounts/:accountId/fx-rates?from&to: by pair, the newest date first. */
export async function listRates(
  client: pg.ClientBase,
  accountId: string,
  filter: { from?: string | undefined; to?: string | undefined },
): Promise<{ items: FxRateView[] }> {
  await readAccess(client, accountId);
  const { rows } = await client.query<RateRow>(
    `${RATE_SELECT}
      WHERE f.owner_account_id = $1
        AND ($2::text IS NULL OR f.from_ccy = $2) AND ($3::text IS NULL OR f.to_ccy = $3)
      ORDER BY f.from_ccy, f.to_ccy, f.valid_from DESC`,
    [accountId, filter.from?.toUpperCase() ?? null, filter.to?.toUpperCase() ?? null],
  );
  return { items: rows.map(rateView) };
}

/** PUT /api/v1/accounts/:accountId/fx-rates: an upsert on the key; a replace needs If-Match. */
export async function putRate(
  ctx: FxCtx,
  accountId: string,
  body: PutFxRateBody,
  expected: number | null,
): Promise<FxRateView> {
  const { client } = ctx;
  await writeAccess(client, accountId);
  const from = currencyIn(body.fromCcy, 'body.fromCcy');
  const to = currencyIn(body.toCcy, 'body.toCcy');
  if (from === to) throw invalid('Check body.toCcy: a rate is between two different currencies.');
  await requireEnabled(client, from, 'body.fromCcy');
  await requireEnabled(client, to, 'body.toCcy');
  const rate = rateIn(body.rate, 'body.rate');
  const key: RateKey = { accountId, from, to, validFrom: body.validFrom };

  const existing = await rateAt(client, key, true);
  if (existing) {
    if (expected === null) {
      throw new AppError(
        'precondition_failed',
        428,
        'A rate for this pair and date exists; send If-Match to replace it.',
        { conflicts: ['rate'], row_version: existing.row_version },
      );
    }
    checkVersion(
      { rowVersion: existing.row_version },
      expected,
      ['rate'],
      existing.display_name ? { displayName: existing.display_name } : null,
    );
    if (rateOut(existing.rate) === rate) return rateView(existing);
  }
  await writeRate(client, key, rate, existing);
  await audited(ctx.tx, {
    locationId: null,
    ownerAccountId: accountId,
    actor: { type: 'user', id: ctx.scope.userId },
    action: 'fx_rate.set',
    entity: { type: 'fx_rate' },
    before: { fx_rate: existing ? imageOf(key, rateOut(existing.rate)) : null },
    after: { fx_rate: imageOf(key, rate) },
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
  return rateView((await rateAt(client, key)) as RateRow);
}

/** DELETE /api/v1/accounts/:accountId/fx-rates/:from/:to/:validFrom (If-Match). */
export async function deleteRate(ctx: FxCtx, key: RateKey, expected: number): Promise<void> {
  const { client } = ctx;
  await writeAccess(client, key.accountId);
  const k = { ...key, from: key.from.toUpperCase(), to: key.to.toUpperCase() };
  const existing = await rateAt(client, k, true);
  if (!existing) throw notFound();
  checkVersion(
    { rowVersion: existing.row_version },
    expected,
    ['rate'],
    existing.display_name ? { displayName: existing.display_name } : null,
  );
  await removeRate(client, k);
  await audited(ctx.tx, {
    locationId: null,
    ownerAccountId: k.accountId,
    actor: { type: 'user', id: ctx.scope.userId },
    action: 'fx_rate.delete',
    entity: { type: 'fx_rate' },
    before: { fx_rate: imageOf(k, rateOut(existing.rate)) },
    after: { fx_rate: null },
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
}
