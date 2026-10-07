import type pg from 'pg';
import webpush from 'web-push';
import { vapidSubject } from '../config/env.js';
import {
  type Aad,
  CryptoError,
  type Keyring,
  type MasterKey,
  open,
  type Sealed,
  seal,
} from '../crypto/envelope.js';
import { withSystem } from '../db/scope.js';

// The VAPID keys web push signs with (D81, D139; step-4 plan T15, Q11).
//
// - `KEPT_VAPID_PUBLIC_KEY` + `KEPT_VAPID_PRIVATE_KEY` win when set (both or neither: loadEnv).
// - Otherwise the pair lives in instance_settings under `vapid`: `{publicKey, privateKeySealed}`,
//   the private key sealed with the envelope key (§7.3, AAD `instance_settings|vapid|private_key`),
//   so a database dump alone doesn't hold it and `kept admin rotate-key` re-wraps it
//   (secrets/rotate.ts SEALED_SETTINGS). kept_app never reads that key (0055's policy).
// - The web process makes the pair at boot as kept_system, under an advisory lock, so two
//   replicas starting together agree on one pair (the setup code's pattern, §7.14). A worker
//   reads it the same way the first time it sends a push.
// - If the stored private key can't be opened (the key it was sealed with is gone), a new pair
//   replaces it and every push subscription is dropped: they were made for the old public key,
//   and phones subscribe again (Q11: losing the keys only means that).
//
// The private key never reaches a log: it lives in the returned object only, and loggers see
// the keys' holder (PushSetup) through toJSON(), which leaves it out.

/** The instance_settings key the pair lives under. */
export const VAPID_KEY = 'vapid';
/** pg_advisory_xact_lock key for making the pair ('vapi'). */
export const VAPID_LOCK = 0x76617069;
/** The AAD the private key is sealed under. */
export const VAPID_AAD: Aad = Object.freeze({
  table: 'instance_settings',
  rowId: VAPID_KEY,
  fieldKey: 'private_key',
});

export type VapidKeys = { publicKey: string; privateKey: string };
export type VapidDetails = VapidKeys & { subject: string };

/** What the instance can do for push (GET /api/v1/me/notification-settings `push`). */
export type PushSetup =
  | { available: true; publicKey: string; details: VapidDetails }
  | { available: false; reason: 'no_https' | 'no_subject' };

/** Where routes and jobs get the push setup; made once per process (createPushSource). */
export type PushSource = () => Promise<PushSetup>;

type StoredVapid = { publicKey: string; privateKeySealed: Sealed };

export type VapidEnv = {
  KEPT_PUBLIC_URL: string;
  KEPT_VAPID_PUBLIC_KEY?: string | undefined;
  KEPT_VAPID_PRIVATE_KEY?: string | undefined;
  KEPT_VAPID_SUBJECT?: string | undefined;
  KEPT_SMTP_FROM?: string | undefined;
};

export type VapidKeyring = { current: MasterKey; keyring: Keyring };

type Log = { warn: (obj: object, msg: string) => void };

function isStored(value: unknown): value is StoredVapid {
  const v = value as Partial<StoredVapid> | null;
  return !!v && typeof v.publicKey === 'string' && !!v.privateKeySealed;
}

/**
 * The instance's VAPID pair: the environment's, else the stored one, else a new one stored now.
 * Idempotent and safe to race: the advisory lock makes one process the maker.
 */
export async function ensureVapidKeys(
  systemPool: pg.Pool,
  env: VapidEnv,
  keys: () => VapidKeyring,
  log?: Log,
): Promise<VapidKeys> {
  if (env.KEPT_VAPID_PUBLIC_KEY && env.KEPT_VAPID_PRIVATE_KEY) {
    return { publicKey: env.KEPT_VAPID_PUBLIC_KEY, privateKey: env.KEPT_VAPID_PRIVATE_KEY };
  }
  return withSystem(systemPool, async (_tx, client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [VAPID_LOCK]);
    const { rows } = await client.query<{ value: unknown }>(
      'SELECT value FROM public.instance_settings WHERE key = $1',
      [VAPID_KEY],
    );
    const stored = rows[0]?.value;
    const ring = keys();
    if (isStored(stored)) {
      try {
        const privateKey = open(ring.keyring, stored.privateKeySealed, VAPID_AAD).toString('utf8');
        return { publicKey: stored.publicKey, privateKey };
      } catch (err) {
        if (!(err instanceof CryptoError)) throw err;
        log?.warn(
          { code: err.code },
          'the stored VAPID key could not be opened; making a new pair (phones subscribe again)',
        );
      }
    }
    const fresh = webpush.generateVAPIDKeys();
    const value: StoredVapid = {
      publicKey: fresh.publicKey,
      privateKeySealed: seal(ring.current, fresh.privateKey, VAPID_AAD),
    };
    await client.query(
      `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [VAPID_KEY, JSON.stringify(value)],
    );
    // Subscriptions made for a replaced public key can never be sent to again.
    if (stored !== undefined) await client.query('DELETE FROM public.push_subscriptions');
    return fresh;
  });
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether push can work here, and why not (D139, D193): a browser subscribes only in a secure
 * context (HTTPS, or localhost), and push services need a VAPID subject (vapidSubject()).
 */
export function pushReason(env: VapidEnv): 'no_https' | 'no_subject' | null {
  const url = new URL(env.KEPT_PUBLIC_URL);
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) return 'no_https';
  const subject = vapidSubject({
    KEPT_PUBLIC_URL: env.KEPT_PUBLIC_URL,
    KEPT_VAPID_SUBJECT: env.KEPT_VAPID_SUBJECT,
    KEPT_SMTP_FROM: env.KEPT_SMTP_FROM,
  } as Parameters<typeof vapidSubject>[0]);
  return subject ? null : 'no_subject';
}

/** A PushSetup that never shows its private key to a logger or JSON.stringify. */
function hidden(setup: PushSetup): PushSetup {
  return Object.defineProperty(setup, 'toJSON', {
    enumerable: false,
    value: () => (setup.available ? { available: true, publicKey: setup.publicKey } : { ...setup }),
  });
}

/**
 * The process's push setup, made on first use and kept: the web calls it at boot (so the pair
 * exists before anyone subscribes), a worker when it first sends. A failure isn't kept, so the
 * next call tries again.
 */
export function createPushSource(
  systemPool: pg.Pool,
  env: VapidEnv,
  keys: () => VapidKeyring,
  log?: Log,
): PushSource {
  let pending: Promise<PushSetup> | null = null;
  return () => {
    pending ??= (async (): Promise<PushSetup> => {
      const reason = pushReason(env);
      if (reason) return hidden({ available: false, reason });
      const pair = await ensureVapidKeys(systemPool, env, keys, log);
      const subject = vapidSubject({
        KEPT_PUBLIC_URL: env.KEPT_PUBLIC_URL,
        KEPT_VAPID_SUBJECT: env.KEPT_VAPID_SUBJECT,
        KEPT_SMTP_FROM: env.KEPT_SMTP_FROM,
      } as Parameters<typeof vapidSubject>[0]) as string;
      return hidden({
        available: true,
        publicKey: pair.publicKey,
        details: { ...pair, subject },
      });
    })().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

/** A fixed setup (tests). */
export function fixedPushSource(setup: PushSetup): PushSource {
  const kept = hidden(setup);
  return async () => kept;
}
