import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { buildCli } from './index.js';

const run = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(serverRoot, 'src', 'cli', 'index.ts');
const SUPERUSER_URL = 'postgres://postgres:postgres@localhost:5452/postgres';

/** Runs the CLI in a child process through tsx, with exactly `env` (plus PATH). */
function kept(file: string, args: string[], env: Record<string, string> = {}) {
  return run(process.execPath, ['--import', 'tsx', file, ...args], {
    cwd: serverRoot,
    env: { PATH: process.env.PATH ?? '', ...env },
  });
}

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-cli-test-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('kept CLI', () => {
  it('registers migrate and admin config commands', () => {
    const program = buildCli();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('migrate');
    expect(names).toContain('admin');

    const admin = program.commands.find((c) => c.name() === 'admin');
    const adminNames = admin?.commands.map((c) => c.name()) ?? [];
    expect(adminNames).toEqual(
      expect.arrayContaining([
        'config',
        'gen-key',
        'reset-password',
        'setup-code',
        'disable-user',
        'enable-user',
        'transfer-ownership',
        'recovery-kit',
        'rotate-key',
        'backup',
        'export',
        'restore',
        'readable',
        'backfill-pdf-text',
      ]),
    );
  });

  // T31c: the commands' own behaviour is tested in backup/backup.test.ts; here, that they run as
  // commands with only the owner login and the target, and say plainly what is missing.
  describe('backup', () => {
    const owner = 'postgres://kept_owner:kept_owner@localhost:5452/kept';

    it('refuses without a target, naming the variables', async () => {
      await expect(
        kept(entry, ['admin', 'backup'], {
          KEPT_OWNER_DATABASE_URL: owner,
          KEPT_DATA_DIR: scratch,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('KEPT_BACKUP_DIR'),
      });
    });

    // The final check's question (step 8 T5/T7): with `verify`, `drill` and `unlock` beside it,
    // a bare `kept admin backup` still makes a backup, not the help. Here it gets as far as
    // restic (a binary that isn't there, so nothing is written but the run's failed row).
    it('bare, makes a backup: it says where to, then runs restic', async () => {
      const db = await testDb();
      await db.reset();
      const res = await kept(entry, ['admin', 'backup'], {
        KEPT_OWNER_DATABASE_URL: db.urls.owner,
        KEPT_DATA_DIR: path.join(scratch, 'bare-data'),
        KEPT_BACKUP_DIR: path.join(scratch, 'bare-backups'),
        KEPT_BACKUP_PASSWORD: 'correct horse battery staple',
        KEPT_RESTIC_BIN: path.join(scratch, 'no-restic-here'),
      }).catch((err: { code?: number; stdout?: string; stderr?: string }) => err);
      expect(res.stdout).toContain('Backing up to directory');
      expect(res.stdout).not.toMatch(/Usage:/);
      expect((res as { code?: number }).code).not.toBe(0);
    });

    it('refuses to list a target without a backup password (no password, no backup)', async () => {
      await expect(
        kept(entry, ['admin', 'backup', '--list'], {
          KEPT_OWNER_DATABASE_URL: owner,
          KEPT_DATA_DIR: path.join(scratch, 'data'),
          KEPT_BACKUP_DIR: path.join(scratch, 'backups'),
        }),
      ).rejects.toThrow(/backups have no password/);
    });

    it('refuses a backup directory inside the data directory', async () => {
      await expect(
        kept(entry, ['admin', 'backup', '--list'], {
          KEPT_OWNER_DATABASE_URL: owner,
          KEPT_DATA_DIR: scratch,
          KEPT_BACKUP_DIR: path.join(scratch, 'backups'),
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('inside KEPT_DATA_DIR'),
      });
    });
  });

  describe('backfill-pdf-text', () => {
    it('names the logins it needs when they are missing', async () => {
      await expect(kept(entry, ['admin', 'backfill-pdf-text'])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('KEPT_SYSTEM_DATABASE_URL'),
      });
    });

    it('refuses a batch outside 1 to 1000', async () => {
      await expect(
        kept(entry, ['admin', 'backfill-pdf-text', '--batch', '0']),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--batch') });
    });
  });

  it('runs when started through a symlink, as an installed bin is', async () => {
    const link = path.join(scratch, 'kept');
    await symlink(entry, link);
    const { stdout } = await kept(link, ['admin', 'config']);
    expect(stdout).toContain('| `KEPT_DATABASE_URL` |');
  });

  it('does nothing when imported rather than run', async () => {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(entry)})`],
      { cwd: serverRoot },
    );
    expect(stdout).toBe('');
  });

  describe('migrate', () => {
    const dbName = `kept_cli_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = () => new pg.Client({ connectionString: SUPERUSER_URL });

    beforeAll(async () => {
      const client = admin();
      await client.connect();
      await client.query(`CREATE DATABASE ${dbName} OWNER kept_owner`);
      await client.end();
    });
    afterAll(async () => {
      const client = admin();
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await client.end();
    });

    it('needs only KEPT_OWNER_DATABASE_URL: no keys, and nothing written to the config dir', async () => {
      const configDir = path.join(scratch, 'config');
      const ownerUrl = `postgres://kept_owner:kept_owner@localhost:5452/${dbName}`;
      await kept(entry, ['migrate'], {
        KEPT_OWNER_DATABASE_URL: ownerUrl,
        KEPT_CONFIG_DIR: configDir,
      });

      expect(existsSync(configDir)).toBe(false);
      const client = new pg.Client({ connectionString: ownerUrl });
      await client.connect();
      try {
        const { rows } = await client.query('SELECT count(*)::int AS n FROM kept_meta.migrations');
        expect(rows[0].n).toBeGreaterThan(0);
      } finally {
        await client.end();
      }
    });

    it('exits non-zero naming KEPT_OWNER_DATABASE_URL when it is missing', async () => {
      await expect(kept(entry, ['migrate'])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('KEPT_OWNER_DATABASE_URL'),
      });
    });
  });
});
