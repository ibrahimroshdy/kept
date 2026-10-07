import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, PASSWORD, type Person, peopleApp, person } from '../../test/people.js';
import { asOwner } from '../../test/tenancy.js';
import { ensureSetupCode, SETUP_CODE_KEY, setupCodeMatches } from '../setup/setup-code.js';

// Task 23: `kept admin` (D164, D165, D180, D190, D193), each command run the way an operator
// would, in a child process with only the environment it needs.

const run = promisify(execFile);
/** Each command starts a Node process through tsx: seconds, under a parallel run. */
const CLI_TIMEOUT = 30_000;
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(serverRoot, 'src', 'cli', 'index.ts');

let db: TestDb;
let t: TestApp;
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-admin-cli-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
});

function kept(args: string[], env: Record<string, string> = {}) {
  return run(process.execPath, ['--import', 'tsx', entry, 'admin', ...args], {
    cwd: serverRoot,
    env: { PATH: process.env.PATH ?? '', KEPT_OWNER_DATABASE_URL: db.urls.owner, ...env },
  });
}

/** The exit code and stderr of a command that must fail. */
async function refused(args: string[], env: Record<string, string> = {}) {
  const err = (await kept(args, env).then(
    () => {
      throw new Error('expected the command to fail');
    },
    (e: unknown) => e,
  )) as { code: number; stderr: string };
  return { code: err.code, stderr: err.stderr };
}

const audit = (action: string) =>
  asOwner(db, async (c) => {
    const { rows } = await c.query(
      'SELECT actor_type, entity_id, location_id FROM public.audit_events WHERE action = $1',
      [action],
    );
    return rows;
  });

describe('kept admin reset-password', { timeout: CLI_TIMEOUT }, () => {
  it('prints a one-time code that sets a new password, signs the account out, audits and mails', async () => {
    const ann: Person = await person(t, db, 'ann');
    const { stdout, stderr } = await kept(['reset-password', ann.email.toUpperCase()], {
      KEPT_PUBLIC_URL: t.publicUrl,
    });
    const code = /KEPT RESET CODE: (\S+)/.exec(stdout)?.[1] ?? '';
    expect(code).not.toBe('');
    expect(stdout).toContain(`${t.publicUrl}/auth/reset#token=${code}`);
    // Signed out at once; the mail is due (logged by kind, never the address).
    expect((await call(t, '/api/v1/me', { as: ann })).statusCode).toBe(401);
    expect(stderr).toContain('"mail":"admin-action"');
    expect(stderr).not.toContain(ann.email);

    const reset = await call(t, '/api/v1/auth/reset-password', {
      body: { token: code, newPassword: 'chosen by ann herself' },
    });
    expect(reset.statusCode).toBe(200);
    const signedIn = await call(t, '/api/v1/auth/sign-in/email', {
      body: { email: ann.email, password: 'chosen by ann herself' },
    });
    expect(signedIn.statusCode).toBe(200);
    // Single use.
    const again = await call(t, '/api/v1/auth/reset-password', {
      body: { token: code, newPassword: 'someone else entirely' },
    });
    expect(again.statusCode).toBe(400);
    expect(await audit('admin.cli_reset_password')).toEqual([
      { actor_type: 'system', entity_id: ann.userId, location_id: null },
    ]);
  });

  it("works for a managed account by username, and says so when there's no such account", async () => {
    const owner = await person(t, db, 'owner');
    const home = await call(t, '/api/v1/locations', {
      as: owner,
      body: { name: 'Home', kind: 'home', timezone: 'UTC', currency: 'USD' },
    });
    const username = `kid_${randomUUID().slice(0, 8)}`;
    await call(t, `/api/v1/locations/${home.json().id}/managed-accounts`, {
      as: owner,
      body: { displayName: 'Kid', username, role: 'member' },
    });
    const { stdout } = await kept(['reset-password', username]);
    const code = /KEPT RESET CODE: (\S+)/.exec(stdout)?.[1] ?? '';
    expect(stdout).toContain(`/auth/reset#token=${code}`);
    const reset = await call(t, '/api/v1/auth/reset-password', {
      body: { token: code, newPassword: 'the kid picked this' },
    });
    expect(reset.statusCode).toBe(200);
    expect(
      (
        await call(t, '/api/v1/auth/sign-in/username', {
          body: { username, password: 'the kid picked this' },
        })
      ).statusCode,
    ).toBe(200);

    const missing = await refused(['reset-password', 'nobody@example.com']);
    expect(missing).toMatchObject({ code: 1, stderr: expect.stringContaining('kept: no account') });
  });

  it('needs KEPT_OWNER_DATABASE_URL', async () => {
    const err = (await run(process.execPath, ['--import', 'tsx', entry, 'admin', 'setup-code'], {
      cwd: serverRoot,
      env: { PATH: process.env.PATH ?? '' },
    }).catch((e: unknown) => e)) as { code: number; stderr: string };
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('KEPT_OWNER_DATABASE_URL');
  });
});

describe('kept admin setup-code', { timeout: CLI_TIMEOUT }, () => {
  it('replaces a pending code (the old one stops working), and refuses once set up', async () => {
    const old = (await ensureSetupCode(db.pools.system)) as string;
    const { stdout } = await kept(['setup-code']);
    const line = stdout.trim();
    expect(line).toMatch(/^KEPT SETUP CODE: [0-9A-Z]{3}-[0-9A-Z]{3}$/);
    const code = line.slice('KEPT SETUP CODE: '.length);
    const stored = await asOwner(db, async (c) => {
      const { rows } = await c.query('SELECT value FROM public.instance_settings WHERE key = $1', [
        SETUP_CODE_KEY,
      ]);
      return rows[0]?.value;
    });
    expect(setupCodeMatches(stored, code)).toBe(true);
    if (old !== code) expect(setupCodeMatches(stored, old)).toBe(false);

    const done = await call(t, '/api/v1/setup', {
      body: { code, email: 'first@example.com', password: PASSWORD, displayName: 'First' },
    });
    expect(done.statusCode).toBe(201);
    expect(await refused(['setup-code'])).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('already set up'),
    });
    expect(await audit('instance.setup_code_reissue')).toHaveLength(1);
  });
});

describe('kept admin disable-user and enable-user', { timeout: CLI_TIMEOUT }, () => {
  it('ends every session and refuses sign-in, until enabled again', async () => {
    const dan = await person(t, db, 'dan');
    const { stdout } = await kept(['disable-user', dan.email]);
    expect(stdout).toContain(dan.userId);
    expect((await call(t, '/api/v1/me', { as: dan })).statusCode).toBe(401);
    const signIn = await call(t, '/api/v1/auth/sign-in/email', {
      body: { email: dan.email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(403);
    expect(await audit('admin.cli_user_disable')).toEqual([
      { actor_type: 'system', entity_id: dan.userId, location_id: null },
    ]);

    // enable-user undoes it.
    await kept(['enable-user', dan.email]);
    const back = await call(t, '/api/v1/auth/sign-in/email', {
      body: { email: dan.email, password: PASSWORD },
    });
    expect(back.statusCode).toBe(200);
    expect(await audit('admin.cli_user_enable')).toHaveLength(1);
  });
});

describe('kept admin transfer-ownership', { timeout: CLI_TIMEOUT }, () => {
  it('moves a location to another person; the old owner stays as an admin', async () => {
    const olga = await person(t, db, 'olga');
    const nick = await person(t, db, 'nick');
    const home = (
      await call(t, '/api/v1/locations', {
        as: olga,
        body: { name: 'Cabin', kind: 'home', timezone: 'UTC', currency: 'USD' },
      })
    ).json().id as string;
    await join(db, home, nick.userId, 'member');

    const { stdout } = await kept(['transfer-ownership', home, nick.userId]);
    expect(stdout).toContain('"Cabin"');
    const members = await call(t, `/api/v1/locations/${home}/members`, { as: nick });
    const roles = Object.fromEntries(
      (members.json().members as { userId: string; role: string }[]).map((m) => [m.userId, m.role]),
    );
    expect(roles).toEqual({ [nick.userId]: 'owner', [olga.userId]: 'admin' });
    const owner = await asOwner(db, async (c) => {
      const { rows } = await c.query(
        `SELECT oa.user_id FROM public.locations l JOIN public.owner_accounts oa
            ON oa.id = l.owner_account_id WHERE l.id = $1`,
        [home],
      );
      return rows[0]?.user_id;
    });
    expect(owner).toBe(nick.userId);
    expect(await audit('location.transfer_ownership')).toEqual([
      { actor_type: 'system', entity_id: home, location_id: home },
    ]);
  });

  it('refuses a Personal location and an unknown user, changing nothing', async () => {
    const pat = await person(t, db, 'pat');
    const other = await person(t, db, 'other');
    expect(
      await refused(['transfer-ownership', pat.personalLocationId, other.userId]),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining('Personal') });
    const home = (
      await call(t, '/api/v1/locations', {
        as: pat,
        body: { name: 'Flat', kind: 'apartment', timezone: 'UTC', currency: 'USD' },
      })
    ).json().id as string;
    expect(await refused(['transfer-ownership', home, randomUUID()])).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no user'),
    });
    expect((await call(t, `/api/v1/locations/${home}`, { as: pat })).json().role).toBe('owner');
  });
});

describe('kept admin recovery-kit', { timeout: CLI_TIMEOUT }, () => {
  it('prints the keys from the environment, or from the config volume, never generating any', async () => {
    const secret = randomBytes(32).toString('base64url');
    const authSecret = randomBytes(32).toString('base64url');
    const fromEnv = await kept(['recovery-kit'], {
      KEPT_SECRET_KEY: secret,
      KEPT_AUTH_SECRET: authSecret,
    });
    expect(fromEnv.stdout).toContain(`KEPT_SECRET_KEY=${secret}`);
    expect(fromEnv.stdout).toContain(`KEPT_AUTH_SECRET=${authSecret}`);

    const configDir = path.join(scratch, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, 'secrets.json'),
      JSON.stringify({ KEPT_SECRET_KEY: secret, KEPT_AUTH_SECRET: authSecret }),
    );
    const fromVolume = await kept(['recovery-kit'], { KEPT_CONFIG_DIR: configDir });
    expect(fromVolume.stdout).toContain(`KEPT_SECRET_KEY=${secret}`);
    expect(fromVolume.stdout).toContain(path.join(configDir, 'secrets.json'));

    const empty = path.join(scratch, 'empty');
    expect(await refused(['recovery-kit'], { KEPT_CONFIG_DIR: empty })).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no keys'),
    });
    expect(existsSync(empty)).toBe(false);
  });
});
