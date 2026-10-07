import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jar, type TestApp, testApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, freshIp, PASSWORD } from '../../test/people.js';
import { asOwner } from '../../test/tenancy.js';
import { loadEnv } from '../config/env.js';
import { withSystem } from '../db/scope.js';
import { toErrorReply } from '../http/errors.js';
import { createLogger } from '../http/logger.js';
import { startKept } from '../main.js';
import { recoveryKitAcknowledgedAt, requireRecoveryKitAck } from './recovery-kit.js';
import { SETUP_ATTEMPTS_PER_IP } from './routes.js';
import {
  ensureSetupCode,
  formatSetupCode,
  hashSetupCode,
  isSetupCodeShape,
  SETUP_CODE_KEY,
  setupCodeLine,
  setupCodeMatches,
} from './setup-code.js';

// Task 22: the one-time setup code and the first instance admin (D32, D190, D193, §7.10).

let db: TestDb;
let t: TestApp;

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await testApp(db);
});

const CODE_LINE = /^KEPT SETUP CODE: [0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/;

const storedCode = () =>
  asOwner(db, async (c) => {
    const { rows } = await c.query('SELECT value FROM public.instance_settings WHERE key = $1', [
      SETUP_CODE_KEY,
    ]);
    return rows[0]?.value ?? null;
  });

const firstAccount = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  email: 'first@example.com',
  password: PASSWORD,
  displayName: 'First',
  ...overrides,
});

describe('the setup code', () => {
  it('is 6 Crockford characters, printed as XXX-XXX, typed in any case with look-alikes', () => {
    expect(isSetupCodeShape('ABC-123')).toBe(true);
    expect(isSetupCodeShape('abc 123')).toBe(true);
    expect(isSetupCodeShape('ABCD-123')).toBe(false);
    expect(isSetupCodeShape('ABU123')).toBe(false); // U is not in the alphabet
    expect(formatSetupCode('abc123')).toBe('ABC-123');
    expect(setupCodeLine('abc123')).toBe('KEPT SETUP CODE: ABC-123');
    const stored = hashSetupCode('10A-B2C');
    expect(setupCodeMatches(stored, 'loa b2c')).toBe(true); // l → 1, o → 0
    expect(setupCodeMatches(stored, '10A-B2D')).toBe(false);
    expect(setupCodeMatches(null, '10A-B2C')).toBe(false);
    expect(JSON.stringify(stored)).not.toContain('10AB2C');
  });

  it('is stored (hashed) and returned by exactly one of two concurrent boots, never again', async () => {
    const codes = await Promise.all([
      ensureSetupCode(db.pools.system),
      ensureSetupCode(db.pools.system),
    ]);
    const printed = codes.filter((c) => c !== null);
    expect(printed).toHaveLength(1);
    expect(setupCodeLine(printed[0] as string)).toMatch(CODE_LINE);
    expect(setupCodeMatches(await storedCode(), printed[0] as string)).toBe(true);
    // A later boot (same database) makes no new code.
    expect(await ensureSetupCode(db.pools.system)).toBeNull();
  });

  it('takes KEPT_SETUP_CODE as given, and refuses a malformed one', async () => {
    expect(await ensureSetupCode(db.pools.system, { preset: 'kpt-2x9' })).toBe('KPT-2X9');
    await expect(ensureSetupCode(db.pools.system, { preset: 'nope' })).rejects.toThrow(
      /KEPT_SETUP_CODE/,
    );
    await expect(
      loadEnv(
        {
          KEPT_DATABASE_URL: db.urls.app,
          KEPT_AUTH_DATABASE_URL: db.urls.auth,
          KEPT_SYSTEM_DATABASE_URL: db.urls.system,
          KEPT_PUBLIC_URL: 'http://kept.test',
          KEPT_SETUP_CODE: 'too-long-code',
        },
        { configDir: path.join(tmpdir(), 'kept-never-written') },
      ),
    ).rejects.toThrow(/KEPT_SETUP_CODE/);
  });

  it('is not made once the instance has an instance admin', async () => {
    const code = (await ensureSetupCode(db.pools.system)) as string;
    const res = await call(t, '/api/v1/setup', { body: firstAccount(code) });
    expect(res.statusCode).toBe(201);
    await asOwner(db, (c) =>
      c.query('DELETE FROM public.instance_settings WHERE key = $1', [SETUP_CODE_KEY]),
    );
    expect(await ensureSetupCode(db.pools.system)).toBeNull();
  });
});

describe('startKept() at boot (the web role)', () => {
  let configDir: string;
  beforeAll(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'kept-setup-'));
  });
  afterAll(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('prints the line once across two concurrent boots, and not on the next', async () => {
    const env = await loadEnv(
      {
        KEPT_DATABASE_URL: db.urls.app,
        KEPT_AUTH_DATABASE_URL: db.urls.auth,
        KEPT_SYSTEM_DATABASE_URL: db.urls.system,
        KEPT_PUBLIC_URL: 'http://kept.test',
        KEPT_ROLE: 'web',
        KEPT_LOG_LEVEL: 'silent',
      },
      { configDir },
    );
    const lines: string[] = [];
    const boot = () =>
      startKept(env, {
        port: 0,
        host: '127.0.0.1',
        webRoot: null,
        logger: createLogger({ KEPT_LOG_LEVEL: 'silent', KEPT_LOG_FORMAT: 'json' }),
        print: (line) => lines.push(line),
      });
    const running = await Promise.all([boot(), boot()]);
    await Promise.all(running.map((r) => r.stop()));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(CODE_LINE);
    const again = await boot();
    await again.stop();
    expect(lines).toHaveLength(1);
  });
});

describe('GET/POST /api/v1/setup', () => {
  // catalogue: POST /api/v1/setup
  it('creates the first account once: signed in, an instance admin, the code gone, audited', async () => {
    expect((await call(t, '/api/v1/setup')).json()).toEqual({ needed: true });
    const code = (await ensureSetupCode(db.pools.system)) as string;

    const done = await call(t, '/api/v1/setup', { body: firstAccount(code.toLowerCase()) });
    expect(done.statusCode).toBe(201);
    const { userId } = done.json() as { userId: string };

    // Signed in as the new admin, with a Personal location (ensureAccount).
    const me = await call(t, '/api/v1/me', { as: { cookie: jar(done) } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { id: userId, displayName: 'First', instanceAdmin: true },
      personalLocationId: expect.any(String),
      instance: { recoveryKitAcknowledged: false },
    });
    expect(await storedCode()).toBeNull();
    const audit = await asOwner(db, (c) =>
      c.query(`SELECT actor_type, actor_id, action FROM public.audit_events
                WHERE action = 'instance.setup'`),
    );
    expect(audit.rows).toEqual([
      { actor_type: 'user', actor_id: userId, action: 'instance.setup' },
    ]);

    expect((await call(t, '/api/v1/setup')).json()).toEqual({ needed: false });
    const again = await call(t, '/api/v1/setup', {
      body: firstAccount(code, { email: 'second@example.com' }),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'conflict' });
  });

  it('refuses a wrong code and creates nothing', async () => {
    const code = (await ensureSetupCode(db.pools.system)) as string;
    const wrong = code.startsWith('0') ? `1${code.slice(1)}` : `0${code.slice(1)}`;
    const res = await call(t, '/api/v1/setup', { body: firstAccount(wrong) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'setup_code_invalid' });
    const users = await asOwner(db, (c) => c.query('SELECT count(*)::int AS n FROM auth."user"'));
    expect(users.rows[0].n).toBe(0);
    expect((await call(t, '/api/v1/setup')).json()).toEqual({ needed: true });
  });

  it('locks an IP out for 15 minutes after 10 wrong codes; other IPs still get in', async () => {
    const code = (await ensureSetupCode(db.pools.system)) as string;
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < SETUP_ATTEMPTS_PER_IP; i++) {
      statuses.push(
        (await call(t, '/api/v1/setup', { ip, body: firstAccount('000-000') })).statusCode,
      );
    }
    expect(new Set(statuses)).toEqual(new Set([400]));
    const locked = await call(t, '/api/v1/setup', { ip, body: firstAccount(code) });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(14 * 60);
    const elsewhere = await call(t, '/api/v1/setup', { body: firstAccount(code) });
    expect(elsewhere.statusCode).toBe(201);
  });

  it('lets exactly one of two concurrent correct requests through', async () => {
    const code = (await ensureSetupCode(db.pools.system)) as string;
    const results = await Promise.all([
      call(t, '/api/v1/setup', { body: firstAccount(code, { email: 'a@example.com' }) }),
      call(t, '/api/v1/setup', { body: firstAccount(code, { email: 'b@example.com' }) }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const admins = await asOwner(db, (c) => c.query('SELECT user_id FROM public.instance_admins'));
    expect(admins.rows).toHaveLength(1);
    // The loser's user was not left behind.
    const users = await asOwner(db, (c) => c.query('SELECT email FROM auth."user"'));
    expect(users.rows).toHaveLength(1);
  });

  it('checks the password before spending an attempt', async () => {
    const code = (await ensureSetupCode(db.pools.system)) as string;
    const res = await call(t, '/api/v1/setup', { body: firstAccount(code, { password: 'short' }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation' });
  });
});

describe('requireRecoveryKitAck() (D193)', () => {
  it('refuses until an instance admin acknowledged the kit, then lets everything through', async () => {
    const refused = await requireRecoveryKitAck(db.pools.system).catch((err: unknown) => err);
    expect(toErrorReply(refused)).toMatchObject({
      status: 409,
      body: { code: 'recovery_kit_required' },
    });
    await withSystem(db.pools.system, (_tx, c) =>
      c.query(
        `INSERT INTO public.instance_settings (key, value) VALUES ('recovery_kit_acknowledged_at', to_jsonb(now()))`,
      ),
    );
    await expect(requireRecoveryKitAck(db.pools.system)).resolves.toBeUndefined();
    expect(await recoveryKitAcknowledgedAt(db.pools.system)).toBeInstanceOf(Date);
  });
});
