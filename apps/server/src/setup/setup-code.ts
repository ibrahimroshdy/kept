import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { limiterKey } from '../auth/sign-in-limiter.js';
import { isCrockford, normaliseCrockford, randomCrockford } from '../crypto/crockford.js';
import { withSystem } from '../db/scope.js';

// The first-run setup code (D32, D190, D193; engineering spec §7.10, §7.14; screens §8).
//
// Until the instance has an instance admin, creating the first account needs a 6-character
// Crockford code that only someone with the server's logs can read. The web process makes it at
// boot, as kept_system, under an advisory lock; its hash goes into instance_settings behind the
// key's primary key, and only the process whose INSERT went in prints it, exactly
// `KEPT SETUP CODE: XXX-XXX`, so it appears once in `docker logs` however many replicas start.
// The migrate job never makes one. `KEPT_SETUP_CODE` presets it (app stores, D107). Using it
// (POST /api/v1/setup) deletes the hash; `kept admin setup-code` re-issues it while setup is
// still pending.
//
// The hash is salted SHA-256. It keeps the code out of a casual read of the table or a backup; it
// is not a defence against someone who can read instance_settings at will (30 bits is a small
// space), but such a reader is kept_system or an instance admin, who could write their own.

export const SETUP_CODE_LENGTH = 6;
/** The instance_settings key holding `{salt, hash}` while setup is pending. */
export const SETUP_CODE_KEY = 'setup_code_hash';
/** pg_advisory_xact_lock key for everything that makes, re-issues or redeems the code ('setu'). */
export const SETUP_LOCK = 0x73657475;

/** The instance-wide wrong-code counter's key (setup/routes.ts); `kept admin setup-code`
 * clears it when it re-issues the code. */
export const SETUP_ALL_KEY = limiterKey('setup-code-all');

export type StoredSetupCode = { salt: string; hash: string };

export class SetupCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupCodeError';
  }
}

/** A code as it is printed and shown: `XXX-XXX`. */
export function formatSetupCode(code: string): string {
  const n = normaliseCrockford(code);
  return `${n.slice(0, 3)}-${n.slice(3)}`;
}

/** The line the setup code is printed as. */
export function setupCodeLine(code: string): string {
  return `KEPT SETUP CODE: ${formatSetupCode(code)}`;
}

/** Whether `code` (as typed) is a well-formed setup code. */
export function isSetupCodeShape(code: string): boolean {
  return isCrockford(normaliseCrockford(code), SETUP_CODE_LENGTH);
}

export function generateSetupCode(): string {
  return randomCrockford(SETUP_CODE_LENGTH);
}

function digest(salt: string, code: string): Buffer {
  return createHash('sha256')
    .update(`${salt}\0${normaliseCrockford(code)}`)
    .digest();
}

export function hashSetupCode(code: string, salt = randomBytes(16).toString('base64url')) {
  return { salt, hash: digest(salt, code).toString('base64url') } satisfies StoredSetupCode;
}

/** Constant-time comparison of a typed code with the stored hash. */
export function setupCodeMatches(stored: unknown, given: string): boolean {
  const s = stored as Partial<StoredSetupCode> | null;
  if (!s || typeof s.salt !== 'string' || typeof s.hash !== 'string') return false;
  const expected = Buffer.from(s.hash, 'base64url');
  const actual = digest(s.salt, given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The stored hash, if setup is pending and a code was issued. */
export async function readStoredSetupCode(client: pg.ClientBase | pg.Pool): Promise<unknown> {
  const { rows } = await client.query<{ value: unknown }>(
    'SELECT value FROM public.instance_settings WHERE key = $1',
    [SETUP_CODE_KEY],
  );
  return rows[0]?.value ?? null;
}

/** Whether the instance still needs its first instance admin. kept_system only. */
export async function setupNeeded(client: pg.ClientBase | pg.Pool): Promise<boolean> {
  const { rows } = await client.query<{ done: boolean }>(
    'SELECT kept.instance_has_admin() AS done',
  );
  return rows[0]?.done !== true;
}

/**
 * At web boot: makes the setup code if the instance has no instance admin and no code yet.
 * Returns the code (formatted) when *this* call stored it, so the caller prints it; null
 * otherwise (set up already, or another process got there first, now or on an earlier boot).
 * `preset` is KEPT_SETUP_CODE.
 */
export async function ensureSetupCode(
  systemPool: pg.Pool,
  opts: { preset?: string | undefined } = {},
): Promise<string | null> {
  if (opts.preset !== undefined && !isSetupCodeShape(opts.preset)) {
    throw new SetupCodeError(
      `KEPT_SETUP_CODE must be ${SETUP_CODE_LENGTH} Crockford base32 characters (0-9, A-Z without I, L, O, U)`,
    );
  }
  return withSystem(systemPool, async (_tx, client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
    if (!(await setupNeeded(client))) return null;
    const code = opts.preset !== undefined ? normaliseCrockford(opts.preset) : generateSetupCode();
    const { rowCount } = await client.query(
      `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [SETUP_CODE_KEY, JSON.stringify(hashSetupCode(code))],
    );
    return rowCount ? formatSetupCode(code) : null;
  });
}
