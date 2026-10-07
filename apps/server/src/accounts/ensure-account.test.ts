import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { jar, testApp } from '../../test/app.js';
import { signUp, testAuth } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { asOwner, insertUser, ownerTx, pgError } from '../../test/tenancy.js';
import { withScope } from '../db/scope.js';
import { runJob } from '../jobs/boss.js';
import { systemJobs } from '../jobs/system.js';
import {
  accountEnsurer,
  currencyForLocale,
  defaultsFromHeaders,
  EnsuredUsers,
  ensureAccount,
  localeFromAcceptLanguage,
  repairOrphanAccounts,
  TIMEZONE_HEADER,
} from './ensure-account.js';

// Task 18: ensureAccount() (D114, D190, D191, §7.14) and the repair-orphans job.

let db: TestDb;

beforeEach(async () => {
  db = await testDb();
  await db.reset();
});

/** A committed auth user with no Kept rows at all, `ageMinutes` old. */
function bareUser(label: string, ageMinutes = 0): Promise<string> {
  return ownerTx(db, async (c) => {
    const id = await insertUser(c, label);
    await c.query(
      'UPDATE auth."user" SET created_at = now() - make_interval(mins => $2) WHERE id = $1',
      [id, ageMinutes],
    );
    return id;
  });
}

type Snapshot = {
  accounts: { id: string }[];
  locations: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  places: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  audit: Record<string, unknown>[];
};

/** Everything Kept holds for `userId`, read as kept_owner. */
function snapshot(userId: string): Promise<Snapshot> {
  return asOwner(db, async (c) => {
    const q = async (sql: string) => (await c.query(sql, [userId])).rows;
    return {
      accounts: await q('SELECT id FROM public.owner_accounts WHERE user_id = $1'),
      locations: await q(
        `SELECT l.id, l.kind, l.name, l.preset, l.timezone, l.currency
           FROM public.locations l JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
          WHERE oa.user_id = $1`,
      ),
      memberships: await q('SELECT location_id, role FROM public.memberships WHERE user_id = $1'),
      places: await q(
        `SELECT p.name, p.is_unplaced, p.parent_id FROM public.places p
           JOIN public.memberships m ON m.location_id = p.location_id
          WHERE m.user_id = $1`,
      ),
      profiles: await q(
        'SELECT display_name, timezone, locale, managed FROM public.user_profiles WHERE user_id = $1',
      ),
      audit: await q(
        `SELECT e.action, e.actor_type, e.actor_id, e.entity_type, e.entity_id, e.location_id, e.diff
           FROM public.audit_events e JOIN public.owner_accounts oa ON oa.id = e.owner_account_id
          WHERE oa.user_id = $1`,
      ),
    };
  });
}

describe('ensureAccount()', () => {
  it('creates the owner account, Personal location, owner membership, Unplaced area and profile', async () => {
    const userId = await bareUser('fresh');
    const headers = new Headers({
      'accept-language': 'ar-EG,ar;q=0.9,en;q=0.8',
      [TIMEZONE_HEADER]: 'Africa/Cairo',
    });
    const result = await ensureAccount(db.pools, userId, { headers, requestId: 'req-1' });
    expect(result.created).toBe(true);

    const s = await snapshot(userId);
    expect(s.accounts).toEqual([{ id: result.ownerAccountId }]);
    expect(s.locations).toEqual([
      {
        id: result.personalLocationId,
        kind: 'personal',
        name: 'Personal',
        preset: 'household',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
      },
    ]);
    expect(s.memberships).toEqual([{ location_id: result.personalLocationId, role: 'owner' }]);
    expect(s.places).toEqual([{ name: 'Unplaced', is_unplaced: true, parent_id: null }]);
    expect(s.profiles).toEqual([
      { display_name: 'fresh', timezone: 'Africa/Cairo', locale: 'ar-EG', managed: false },
    ]);
    // Audited as the user, on the location, once the membership made it visible.
    expect(s.audit).toEqual([
      expect.objectContaining({
        action: 'location.create',
        actor_type: 'user',
        actor_id: userId,
        entity_type: 'location',
        entity_id: result.personalLocationId,
        location_id: result.personalLocationId,
      }),
    ]);
    // The user sees their Personal location through kept_app's own policies.
    const seen = await withScope(
      db.pools.app,
      { userId, mfa: false },
      async (_tx, c) => (await c.query('SELECT id FROM public.locations')).rows,
    );
    expect(seen).toEqual([{ id: result.personalLocationId }]);
  });

  it('falls back to UTC, en and USD, and ignores a time zone it does not know', async () => {
    const userId = await bareUser('plain');
    await ensureAccount(db.pools, userId, {
      headers: new Headers({ [TIMEZONE_HEADER]: 'Mars/Olympus_Mons' }),
    });
    const s = await snapshot(userId);
    expect(s.locations[0]).toMatchObject({ timezone: 'UTC', currency: 'USD' });
    expect(s.profiles[0]).toMatchObject({ timezone: 'UTC', locale: 'en' });
  });

  it('is idempotent: a second call makes nothing new', async () => {
    const userId = await bareUser('twice');
    const first = await ensureAccount(db.pools, userId);
    const before = await snapshot(userId);
    const second = await ensureAccount(db.pools, userId);
    expect(second).toEqual({ ...first, created: false });
    expect(await snapshot(userId)).toEqual(before);
  });

  it('two calls at the same time make exactly one of each', async () => {
    const userId = await bareUser('race');
    const results = await Promise.all([
      ensureAccount(db.pools, userId),
      ensureAccount(db.pools, userId),
      ensureAccount(db.pools, userId),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.personalLocationId)).size).toBe(1);
    const s = await snapshot(userId);
    expect(s.accounts).toHaveLength(1);
    expect(s.locations).toHaveLength(1);
    expect(s.memberships).toHaveLength(1);
    expect(s.places).toHaveLength(1);
    expect(s.profiles).toHaveLength(1);
    expect(s.audit).toHaveLength(1);
  });

  it('keeps a profile made earlier (a managed one, task 21) and uses its time zone', async () => {
    const userId = await bareUser('managed');
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.user_profiles (user_id, display_name, timezone, managed)
         VALUES ($1, 'Grandma', 'Europe/London', true)`,
        [userId],
      ),
    );
    await ensureAccount(db.pools, userId);
    const s = await snapshot(userId);
    expect(s.profiles).toEqual([
      { display_name: 'Grandma', timezone: 'Europe/London', locale: 'en', managed: true },
    ]);
    expect(s.locations[0]).toMatchObject({ timezone: 'Europe/London' });
  });

  it('fills in a missing Unplaced area on a second pass', async () => {
    const userId = await bareUser('repair');
    const { personalLocationId } = await ensureAccount(db.pools, userId);
    await ownerTx(db, (c) =>
      c.query('DELETE FROM public.places WHERE location_id = $1', [personalLocationId]),
    );
    await ensureAccount(db.pools, userId);
    expect((await snapshot(userId)).places).toHaveLength(1);
  });

  it('kept.ensure_account() refuses a call with no user scope', async () => {
    for (const pool of [db.pools.app, db.pools.system]) {
      const err = await pgError(
        pool.query("SELECT * FROM kept.ensure_account('UTC', 'en', 'USD')"),
      );
      expect(err.code).toBe('42501');
    }
  });
});

describe('defaults from the request', () => {
  it.each([
    ['ar-EG', 'EGP'],
    ['en-GB', 'GBP'],
    ['en-CA', 'CAD'],
    ['fr-CA', 'CAD'],
    ['de-DE', 'EUR'],
    ['fr-FR', 'EUR'],
    ['bg-BG', 'EUR'],
    ['en-US', 'USD'],
    ['ar', 'USD'],
    ['nonsense!!', 'USD'],
  ])('%s → %s', (locale, currency) => {
    expect(currencyForLocale(locale)).toBe(currency);
  });

  it('reads the first Accept-Language tag, canonicalised', () => {
    expect(localeFromAcceptLanguage('en-gb,en;q=0.9')).toBe('en-GB');
    expect(localeFromAcceptLanguage('*')).toBeNull();
    expect(localeFromAcceptLanguage('')).toBeNull();
    expect(localeFromAcceptLanguage('not a tag')).toBeNull();
    expect(defaultsFromHeaders(undefined)).toEqual({
      timezone: 'UTC',
      locale: 'en',
      currency: 'USD',
    });
  });
});

describe('wiring', () => {
  it('Better Auth runs it when a user is created (after the auth transaction commits)', async () => {
    const accounts = accountEnsurer(db.pools);
    const auth = testAuth(db, { onUserCreated: accounts.onUserCreated });
    const { userId } = await signUp(auth, `hook-${randomUUID()}@example.com`);
    const s = await snapshot(userId);
    expect(s.accounts).toHaveLength(1);
    expect(s.locations).toHaveLength(1);
    expect(accounts.cache.has(userId)).toBe(true);
  });

  it('the hook leaves managed (.invalid) accounts to task 21', async () => {
    const accounts = accountEnsurer(db.pools);
    await accounts.onUserCreated({ id: randomUUID(), email: 'x@managed.invalid' }, undefined);
    expect(accounts.cache.size).toBe(0);
  });

  it('a signed-in request ensures a user the hook missed, once per process', async () => {
    const accounts = accountEnsurer(db.pools);
    let calls = 0;
    const t = await testApp(db, {
      onScope: async (req, scope, headers) => {
        if (!accounts.cache.has(scope.userId)) calls++;
        await accounts.onScope(req, scope, headers);
      },
    });
    // Sign-up without the hook: an orphan.
    const email = `late-${randomUUID()}@example.com`;
    const { userId } = await signUp(t.auth, email);
    expect((await snapshot(userId)).accounts).toEqual([]);
    const signIn = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { origin: t.publicUrl },
      payload: { email, password: 'correct horse battery' },
    });
    const cookie = jar(signIn);
    for (let i = 0; i < 3; i++) {
      const res = await t.app.inject({
        url: '/api/v1/me/sessions',
        headers: { cookie, 'accept-language': 'en-GB', [TIMEZONE_HEADER]: 'Europe/London' },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(calls).toBe(1);
    const s = await snapshot(userId);
    expect(s.locations).toEqual([
      expect.objectContaining({ currency: 'GBP', timezone: 'Europe/London' }),
    ]);
    await t.app.close();
  });

  it('EnsuredUsers keeps the most recently used ids', () => {
    const cache = new EnsuredUsers(2);
    cache.add('a');
    cache.add('b');
    expect(cache.has('a')).toBe(true); // a is now the most recent
    cache.add('c');
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });
});

describe('repair-orphans (kept_system)', () => {
  it('ensures auth users past the grace period with no account, audited as system', async () => {
    const orphan = await bareUser('orphan', 30);
    const young = await bareUser('young', 1);
    const whole = await bareUser('whole', 30);
    await ensureAccount(db.pools, whole);

    const { repaired, failed } = await repairOrphanAccounts(db.pools);
    expect(failed).toEqual([]);
    expect(repaired).toEqual([orphan]);

    const s = await snapshot(orphan);
    expect(s.locations).toEqual([
      expect.objectContaining({ kind: 'personal', timezone: 'UTC', currency: 'USD' }),
    ]);
    expect(s.audit).toEqual([
      expect.objectContaining({ action: 'location.create', actor_type: 'system', actor_id: null }),
    ]);
    expect((await snapshot(young)).accounts).toEqual([]);
    // A second run finds nothing.
    expect((await repairOrphanAccounts(db.pools)).repaired).toEqual([]);
  });

  it('also repairs a user with an account but no profile', async () => {
    const userId = await bareUser('noprofile', 30);
    await ensureAccount(db.pools, userId);
    await ownerTx(db, (c) =>
      c.query('DELETE FROM public.user_profiles WHERE user_id = $1', [userId]),
    );
    expect((await repairOrphanAccounts(db.pools)).repaired).toEqual([userId]);
    expect((await snapshot(userId)).profiles).toHaveLength(1);
  });

  it('deletes a half-made managed account instead of making it an ordinary one (review M5)', async () => {
    const halfMade = await bareUser('half', 30);
    await ownerTx(db, (c) =>
      c.query(`UPDATE auth."user" SET email = $2 WHERE id = $1`, [
        halfMade,
        `${halfMade}@managed.invalid`,
      ]),
    );
    // A managed account whose profile was made, but not yet its owner account: ensured (D114).
    const whole = await bareUser('kid', 30);
    await ownerTx(db, async (c) => {
      await c.query(`UPDATE auth."user" SET email = $2 WHERE id = $1`, [
        whole,
        `${whole}@managed.invalid`,
      ]);
      await c.query(
        `INSERT INTO public.user_profiles (user_id, display_name, managed) VALUES ($1, 'Kid', true)`,
        [whole],
      );
    });
    const result = await repairOrphanAccounts(db.pools);
    expect(result.removed).toEqual([halfMade]);
    expect(result.repaired).toEqual([whole]);
    const { rows } = await db.pools.auth.query('SELECT id FROM auth."user" WHERE id = $1', [
      halfMade,
    ]);
    expect(rows).toEqual([]);
    expect((await snapshot(whole)).profiles).toEqual([expect.objectContaining({ managed: true })]);
  });

  it('is registered as an hourly job whose handler repairs orphans', async () => {
    const orphan = await bareUser('scheduled', 30);
    const job = systemJobs({
      pools: db.pools,
      log: { info: () => {}, error: () => {} },
      mailer: { send: async () => {} },
      publicUrl: 'http://kept.test',
    }).find((j) => j.name === 'repair-orphans');
    expect(job?.kind).toBe('system');
    expect(job?.kind === 'system' ? job.schedule : null).toMatch(/^\d+ \* \* \* \*$/);
    if (job) await runJob(job, null, db.pools);
    expect((await snapshot(orphan)).accounts).toHaveLength(1);
  });
});
