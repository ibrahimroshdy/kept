import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, PASSWORD, type Person, peopleApp, person } from '../../test/people.js';
import { asOwner, ownerTx } from '../../test/tenancy.js';
import { createLogger } from '../http/logger.js';
import { markRecoveryKitStale } from '../setup/recovery-kit.js';
import type { KitBackupHalf } from '../setup/recovery-kit-content.js';

// Step-8 T9: the recovery kit's download from the web (D182, D176, D181), through the front door.
// The backup half is T10's to fill in (backup/recovery-kit-source.ts); here it is mocked with
// what T10's settings will hand the kit, so these tests hold when the seam is filled in.

const kitBackup = vi.hoisted(() => ({ half: { state: 'none' } as KitBackupHalf }));
vi.mock('../backup/recovery-kit-source.js', () => ({
  readBackupForKit: async () => kitBackup.half,
}));

const HTTPS = 'https://kept.example';
const DOWNLOAD = '/api/v1/admin/recovery-kit/download';
const SECRET_KEY = randomBytes(32).toString('base64url');
const AUTH_SECRET = randomBytes(32).toString('base64url');
const RESTIC_PASSWORD = 'correct horse battery staple, the backup one';
const S3_SECRET = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';

const s3: KitBackupHalf = {
  state: 'configured',
  backup: {
    kind: 's3',
    description: 'S3 bucket kept-backups at s3.example.org',
    repository: 's3:https://s3.example.org/kept-backups/kept-backups/restic',
    password: RESTIC_PASSWORD,
    environment: [
      ['AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE'],
      ['AWS_SECRET_ACCESS_KEY', S3_SECRET],
    ],
    sftp: null,
    lockedByEnvironment: false,
  },
};

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let louis: Person;
const logLines: string[] = [];

beforeAll(async () => {
  vi.stubEnv('KEPT_SECRET_KEY', SECRET_KEY);
  vi.stubEnv('KEPT_AUTH_SECRET', AUTH_SECRET);
  vi.stubEnv('KEPT_SECRET_KEY_VERSION', '');
  vi.stubEnv('KEPT_SECRET_KEYS_RETIRED', '');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  logLines.length = 0;
  const sink = new Writable({
    write(chunk, _enc, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  t = await peopleApp(db, {
    publicUrl: HTTPS,
    logger: createLogger({ KEPT_LOG_LEVEL: 'trace', KEPT_LOG_FORMAT: 'json' }, sink),
  });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  await ownerTx(db, (c) =>
    c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [ibrahim.userId]),
  );
  kitBackup.half = s3;
});

const downloadAudit = () =>
  asOwner(db, async (c) => {
    const { rows } = await c.query<{ actor_id: string; diff: unknown }>(
      `SELECT actor_id, diff FROM public.audit_events
        WHERE action = 'instance.recovery_kit_download' ORDER BY at, id`,
    );
    return rows;
  });

const state = async (as: Person = ibrahim) =>
  (await call(t, '/api/v1/admin/recovery-kit', { as })).json() as {
    acknowledgedAt: string | null;
    downloadedAt: string | null;
    stale: boolean;
  };

describe('POST /api/v1/admin/recovery-kit/download', () => {
  // catalogue: POST /api/v1/admin/recovery-kit/download
  it('answers the full kit after the password, no-store, audited without its content', async () => {
    const res = await call(t, DOWNLOAD, { as: ibrahim, body: { password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="kept-recovery-kit-\d{4}-\d{2}-\d{2}\.txt"$/,
    );
    const kit = res.body;
    expect(kit).toContain(`KEPT_SECRET_KEY=${SECRET_KEY}`);
    expect(kit).toContain(`KEPT_AUTH_SECRET=${AUTH_SECRET}`);
    expect(kit).toContain(`Instance: ${HTTPS}`);
    expect(kit).toContain('RESTIC_REPOSITORY=s3:https://s3.example.org/kept-backups/kept-backups');
    expect(kit).toContain(`RESTIC_PASSWORD=${RESTIC_PASSWORD}`);
    expect(kit).toContain(`AWS_SECRET_ACCESS_KEY=${S3_SECRET}`);
    expect(kit).toContain('kept admin restore');
    expect(kit.split('\n').length).toBeLessThan(200);

    const audit = await downloadAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_id).toBe(ibrahim.userId);
    const recorded = JSON.stringify(audit);
    expect(recorded).toContain('text');
    for (const secret of [SECRET_KEY, AUTH_SECRET, RESTIC_PASSWORD, S3_SECRET, PASSWORD]) {
      expect(recorded).not.toContain(secret);
      expect(logLines.join('')).not.toContain(secret);
    }

    // A download is a kept kit: it counts as the acknowledgement (D193).
    const after = await state();
    expect(after.downloadedAt).toEqual(expect.any(String));
    expect(after.acknowledgedAt).toEqual(expect.any(String));
    expect(after.stale).toBe(false);
  });

  it('gives the printable page: the same content, no script, nothing remote', async () => {
    const res = await call(t, DOWNLOAD, {
      as: ibrahim,
      body: { password: PASSWORD, format: 'html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/\.html"$/);
    expect(res.body).toContain(`KEPT_SECRET_KEY=${SECRET_KEY}`);
    expect(res.body).toContain(`RESTIC_PASSWORD=${RESTIC_PASSWORD}`);
    expect(res.body).not.toMatch(/<script|<link|<img|src=|href=|@import|url\(/i);
  });

  it('says "No backup configured" when there is none', async () => {
    kitBackup.half = { state: 'none' };
    const res = await call(t, DOWNLOAD, { as: ibrahim, body: { password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('No backup configured.');
    expect(res.body).not.toContain('RESTIC_PASSWORD=');
  });

  it('refuses a wrong or missing password with 403 reauth_required, recording nothing', async () => {
    const wrong = await call(t, DOWNLOAD, { as: ibrahim, body: { password: 'not it at all' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ code: 'reauth_required', reauth: 'password' });
    expect(wrong.body).not.toContain(SECRET_KEY);
    const missing = await call(t, DOWNLOAD, { as: ibrahim, body: {} });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'reauth_required', reauth: 'password' });
    expect(await downloadAudit()).toEqual([]);
    expect(await state()).toEqual({ acknowledgedAt: null, downloadedAt: null, stale: false });
  });

  it('without a password on the account, takes a fresh sign-in, and asks for a new one later', async () => {
    await db.pools.auth.query(
      "UPDATE auth.account SET password = NULL WHERE user_id = $1 AND provider_id = 'credential'",
      [ibrahim.userId],
    );
    const fresh = await call(t, DOWNLOAD, { as: ibrahim, body: {} });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.body).toContain(`KEPT_SECRET_KEY=${SECRET_KEY}`);

    await db.pools.auth.query(
      "UPDATE auth.session SET created_at = now() - interval '11 minutes' WHERE user_id = $1",
      [ibrahim.userId],
    );
    const stale = await call(t, DOWNLOAD, { as: ibrahim, body: {} });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: 'reauth_required', reauth: 'sign_in' });
    expect(await downloadAudit()).toHaveLength(1);
  });

  it('is 404 for anyone but an instance admin, and 401 signed out', async () => {
    const res = await call(t, DOWNLOAD, { as: louis, body: { password: PASSWORD } });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(SECRET_KEY);
    expect((await call(t, DOWNLOAD, { body: { password: PASSWORD } })).statusCode).toBe(401);
    expect(await downloadAudit()).toEqual([]);
  });

  it('is refused over plain http (D181)', async () => {
    const plain = await peopleApp(db);
    const admin = await person(plain, db, 'bruce');
    await ownerTx(db, (c) =>
      c.query('INSERT INTO public.instance_admins (user_id) VALUES ($1)', [admin.userId]),
    );
    const res = await call(plain, DOWNLOAD, { as: admin, body: { password: PASSWORD } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'https_required' });
    expect(await downloadAudit()).toEqual([]);
    await plain.app.close();
  });

  it('turns stale when something it holds changes, and fresh again with a new download', async () => {
    await call(t, DOWNLOAD, { as: ibrahim, body: { password: PASSWORD } });
    expect((await state()).stale).toBe(false);
    // What T10's PUT /api/v1/admin/backup and `kept admin rotate-key` do.
    await asOwner(db, (c) => markRecoveryKitStale(c));
    expect((await state()).stale).toBe(true);
    await call(t, DOWNLOAD, { as: ibrahim, body: { password: PASSWORD } });
    expect((await state()).stale).toBe(false);
  });
});
