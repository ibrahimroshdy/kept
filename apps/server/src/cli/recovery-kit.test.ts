import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { asOwner } from '../../test/tenancy.js';
import { CliError } from '../admin/cli.js';
import { loadEnv } from '../config/env.js';
import { recoveryKitStatus } from '../setup/recovery-kit.js';
import { recoveryKitCommand } from './recovery-kit.js';
import { rotateKey } from './rotate-key.js';

// `kept admin recovery-kit [--format text|html] [--out <file>]` (step-8 T9; D165, D182), run in
// process: the full kit with the backup half from the database, a 0600 file, the download
// recorded and audited, and `kept admin rotate-key` making it stale.

const BACKUP_PASSWORD = 'a long backup passphrase for the NAS';

let db: TestDb;
let dir: string;
let configDir: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  dir = await mkdtemp(path.join(tmpdir(), 'kept-kit-cli-'));
  configDir = path.join(dir, 'config');
  // The server's keys, generated into the config volume on first boot (D193).
  await loadEnv(
    {
      KEPT_DATABASE_URL: 'postgres://kept_app:kept_app@localhost:5452/kept',
      KEPT_AUTH_DATABASE_URL: 'postgres://kept_auth:kept_auth@localhost:5452/kept',
      KEPT_SYSTEM_DATABASE_URL: 'postgres://kept_system:kept_system@localhost:5452/kept',
      KEPT_PUBLIC_URL: 'https://kept.example',
    },
    { configDir },
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const source = () => ({
  KEPT_OWNER_DATABASE_URL: db.urls.owner,
  KEPT_CONFIG_DIR: configDir,
  KEPT_PUBLIC_URL: 'https://kept.example',
  KEPT_BACKUP_DIR: '/mnt/nas/kept',
  KEPT_BACKUP_PASSWORD: BACKUP_PASSWORD,
});

function capture() {
  const out = { stdout: '', stderr: [] as string[] };
  return {
    out,
    io: { write: (text: string) => (out.stdout += text), warn: (l: string) => out.stderr.push(l) },
  };
}

const kitState = () => asOwner(db, (c) => recoveryKitStatus(c));

describe('kept admin recovery-kit', () => {
  it('writes the full printable kit to a 0600 file, records and audits it; a rotation makes it stale', async () => {
    const file = path.join(dir, 'kit.html');
    await writeFile(file, 'old', { mode: 0o644 });
    const { out, io } = capture();
    expect(await recoveryKitCommand(source(), { format: 'html', out: file }, io)).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr.join('\n')).not.toContain(BACKUP_PASSWORD);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const html = await readFile(file, 'utf8');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('KEPT_SECRET_KEY=');
    // The backup half: the restic repository inside the directory target, and its password.
    expect(html).toContain('RESTIC_REPOSITORY=/mnt/nas/kept/restic');
    expect(html).toContain(`RESTIC_PASSWORD=${BACKUP_PASSWORD}`);
    expect(html).toContain('Instance: https://kept.example');

    const recorded = await kitState();
    expect(recorded).toMatchObject({ downloadedAt: expect.any(String), stale: false });
    expect(recorded.acknowledgedAt).toEqual(expect.any(String));
    const audit = await asOwner(db, async (c) => {
      const { rows } = await c.query(
        `SELECT actor_type, diff FROM public.audit_events
          WHERE action = 'instance.recovery_kit_download'`,
      );
      return rows;
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'system' });
    expect(JSON.stringify(audit)).not.toContain(BACKUP_PASSWORD);

    const lines: string[] = [];
    expect(await rotateKey(source(), {}, (l) => lines.push(l))).toBe(0);
    expect((await kitState()).stale).toBe(true);

    const again = capture();
    await recoveryKitCommand(source(), {}, again.io);
    expect(again.out.stdout).toContain('KEPT_SECRET_KEY_VERSION=2');
    expect(again.out.stdout).toContain('KEPT_SECRET_KEYS_RETIRED=1:');
    expect((await kitState()).stale).toBe(false);
  });

  it("without the owner's login, prints the keys and says the backup half is missing", async () => {
    const { KEPT_OWNER_DATABASE_URL: _owner, ...noDb } = source();
    const before = await kitState();
    const { out, io } = capture();
    expect(await recoveryKitCommand(noDb, {}, io)).toBe(0);
    expect(out.stdout).toContain('KEPT_SECRET_KEY=');
    expect(out.stdout).toContain('Not included:');
    expect(out.stdout).not.toContain(BACKUP_PASSWORD);
    expect(await kitState()).toEqual(before);
  });

  it('refuses an unknown format', async () => {
    await expect(recoveryKitCommand(source(), { format: 'pdf' }, capture().io)).rejects.toThrow(
      CliError,
    );
  });
});
