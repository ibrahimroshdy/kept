import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { newId } from '@kept/shared';
import pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { type TestDb, testDb } from '../../test/db.js';
import { ownerTx, seedUser } from '../../test/tenancy.js';
import { type Keyring, type MasterKey, open, type Sealed } from '../crypto/envelope.js';
import { withScope } from '../db/scope.js';
import { createLogger } from '../http/logger.js';
import { rotateCiphertexts, versionsInUse } from '../secrets/rotate.js';
import {
  createPushSource,
  ensureVapidKeys,
  pushReason,
  VAPID_AAD,
  type VapidEnv,
  type VapidKeyring,
} from './vapid.js';
import { openWebhookConfig, sealWebhookConfig } from './webhook.js';

// The VAPID keys (plan T15, Q11; D81): made once however many processes boot together, the
// environment's pair winning, the private key sealed at rest, re-wrapped by rotate-key, never in
// a log, and never readable by kept_app.

let db: TestDb;
const v1: MasterKey = { key: randomBytes(32), keyVersion: 1 };
const ring1: VapidKeyring = { current: v1, keyring: new Map([[1, v1.key]]) as Keyring };
const env: VapidEnv = { KEPT_PUBLIC_URL: 'https://kept.example.org' };

type Stored = { publicKey: string; privateKeySealed: Sealed };
const stored = () =>
  ownerTx(db, async (c) => {
    const { rows } = await c.query<{ value: Stored }>(
      `SELECT value FROM public.instance_settings WHERE key = 'vapid'`,
    );
    return rows[0]?.value ?? null;
  });

beforeAll(async () => {
  db = await testDb();
});

beforeEach(async () => {
  await db.reset();
  await ownerTx(db, (c) => c.query(`DELETE FROM public.instance_settings WHERE key = 'vapid'`));
});

describe('ensureVapidKeys', () => {
  it('makes one pair when two processes boot at once, and seals its private key', async () => {
    // A second process: its own pool on the same database.
    const other = new pg.Pool({ connectionString: db.urls.system, max: 2 });
    try {
      const [a, b] = await Promise.all([
        ensureVapidKeys(db.pools.system, env, () => ring1),
        ensureVapidKeys(other, env, () => ring1),
      ]);
      expect(a).toEqual(b);
      expect(Buffer.from(a.publicKey, 'base64url')).toHaveLength(65);
      const row = await stored();
      expect(row?.publicKey).toBe(a.publicKey);
      expect(JSON.stringify(row)).not.toContain(a.privateKey);
      expect(open(ring1.keyring, row?.privateKeySealed as Sealed, VAPID_AAD).toString()).toBe(
        a.privateKey,
      );
      // A later boot reads the same pair.
      expect(await ensureVapidKeys(db.pools.system, env, () => ring1)).toEqual(a);
    } finally {
      await other.end();
    }
  });

  it('uses the environment’s pair when it is set, and stores nothing', async () => {
    const pair = webpush.generateVAPIDKeys();
    const got = await ensureVapidKeys(
      db.pools.system,
      { ...env, KEPT_VAPID_PUBLIC_KEY: pair.publicKey, KEPT_VAPID_PRIVATE_KEY: pair.privateKey },
      () => ring1,
    );
    expect(got).toEqual(pair);
    expect(await stored()).toBeNull();
  });

  it('makes a new pair when the stored key can’t be opened, and drops the old subscriptions', async () => {
    const old = await ensureVapidKeys(db.pools.system, env, () => ring1);
    const bruce = await seedUser(db, 'bruce');
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1, 'https://push.example.org/x', 'k', 'a')`,
        [bruce],
      ),
    );
    const lost: MasterKey = { key: randomBytes(32), keyVersion: 1 };
    const warned: string[] = [];
    const fresh = await ensureVapidKeys(
      db.pools.system,
      env,
      () => ({ current: lost, keyring: new Map([[1, lost.key]]) as Keyring }),
      { warn: (_o, msg) => warned.push(msg) },
    );
    expect(fresh.publicKey).not.toBe(old.publicKey);
    expect(warned).toHaveLength(1);
    const left = await ownerTx(db, (c) => c.query('SELECT 1 FROM public.push_subscriptions'));
    expect(left.rowCount).toBe(0);
  });

  it('is never readable by kept_app, an instance admin included', async () => {
    await ensureVapidKeys(db.pools.system, env, () => ring1);
    const ibrahim = await seedUser(db, 'ibrahim');
    await ownerTx(db, (c) =>
      c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [ibrahim]),
    );
    const seen = await withScope(db.pools.app, { userId: ibrahim, mfa: true }, async (_tx, c) => {
      const admin = await c.query<{ a: boolean }>('SELECT kept.is_instance_admin() AS a');
      const { rows } = await c.query(
        `SELECT value FROM public.instance_settings WHERE key = 'vapid'`,
      );
      return { admin: admin.rows[0]?.a, rows: rows.length };
    });
    expect(seen).toEqual({ admin: true, rows: 0 });
  });
});

describe('the push setup', () => {
  it('says why push is unavailable: plain HTTP, or no subject', () => {
    expect(pushReason({ KEPT_PUBLIC_URL: 'http://kept.lan' })).toBe('no_https');
    expect(pushReason({ KEPT_PUBLIC_URL: 'https://kept.example.org' })).toBeNull();
    // localhost is a secure context; its subject comes from the mail sender.
    expect(pushReason({ KEPT_PUBLIC_URL: 'http://localhost:8080' })).toBe('no_subject');
    expect(
      pushReason({
        KEPT_PUBLIC_URL: 'http://localhost:8080',
        KEPT_SMTP_FROM: 'Kept <k@kept.test>',
      }),
    ).toBeNull();
  });

  it('never shows the private key to a logger or JSON', async () => {
    const lines: string[] = [];
    const logger = createLogger(
      { KEPT_LOG_LEVEL: 'info', KEPT_LOG_FORMAT: 'json' },
      new Writable({
        write(chunk, _enc, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    );
    const push = createPushSource(db.pools.system, env, () => ring1);
    const setup = await push();
    if (!setup.available) throw new Error('push should be available');
    logger.info({ setup }, 'push ready');
    const out = lines.join('') + JSON.stringify(setup);
    expect(out).toContain(setup.publicKey);
    expect(out).not.toContain(setup.details.privateKey);
    // The same process asks once.
    expect(await push()).toBe(setup);
  });
});

describe('rotate-key', () => {
  it('re-wraps the VAPID key and a webhook channel’s config under the new key', async () => {
    const pair = await ensureVapidKeys(db.pools.system, env, () => ring1);
    const bruce = await seedUser(db, 'bruce');
    const channel = newId();
    const config = { url: 'https://hooks.example.org/kept', secret: 'whsec_x' };
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.notification_channels
           (id, user_id, kind, display_host, config_ciphertext, key_version)
         VALUES ($1, $2, 'webhook', 'hooks.example.org', $3::jsonb, 1)`,
        [channel, bruce, JSON.stringify(sealWebhookConfig(v1, channel, config))],
      ),
    );
    const v2: MasterKey = { key: randomBytes(32), keyVersion: 2 };
    const both = new Map([
      [1, v1.key],
      [2, v2.key],
    ]) as Keyring;
    const client = new pg.Client({ connectionString: db.urls.owner });
    await client.connect();
    try {
      expect([...(await versionsInUse(client)).keys()]).toEqual([1]);
      const report = await rotateCiphertexts(client, both, v2);
      const vapid = report.columns.find((c) => c.name.includes('VAPID'));
      expect(vapid).toMatchObject({ rewrapped: 1, failed: [] });
      expect([...(await versionsInUse(client)).keys()]).toEqual([2]);
    } finally {
      await client.end();
    }
    const only2 = new Map([[2, v2.key]]) as Keyring;
    const row = await stored();
    expect(open(only2, row?.privateKeySealed as Sealed, VAPID_AAD).toString()).toBe(
      pair.privateKey,
    );
    const sealed = await ownerTx(db, async (c) => {
      const { rows } = await c.query<{ config_ciphertext: Sealed }>(
        'SELECT config_ciphertext FROM public.notification_channels WHERE id = $1',
        [channel],
      );
      return rows[0]?.config_ciphertext as Sealed;
    });
    expect(openWebhookConfig(only2, channel, sealed)).toEqual(config);
  });
});
