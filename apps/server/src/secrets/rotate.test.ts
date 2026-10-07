import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, type Person, peopleApp, person } from '../../test/people.js';
import { builtinType, createLocation, createThing, type Loc, ok, own } from '../../test/things.js';
import { CliError } from '../admin/cli.js';
import { providerKeyAad } from '../ai/db-keys.js';
import { rotateKey } from '../cli/rotate-key.js';
import { loadEnv, readKeyMaterial } from '../config/env.js';
import { open, type Sealed, seal } from '../crypto/envelope.js';
import { keyringOfMaterial, type SecretKeys, secretKeysOf } from '../crypto/keyring.js';
import { CIPHERTEXTS } from './rotate.js';
import { aadOf } from './service.js';

// `kept admin rotate-key` (plan T19, Q19; §7.3, D182): every stored value re-wrapped under a new
// key version, still readable afterwards; the old key kept as retired, so an old backup's
// ciphertexts still open; resumable; and nothing done when a key the rows need is missing.

let db: TestDb;
let t: TestApp;
let ann: Person;
let home: Loc;
let safeType: string;
let configDir: string;
let keys: SecretKeys;

const validEnv = {
  KEPT_DATABASE_URL: 'postgres://kept_app:kept_app@localhost:5452/kept',
  KEPT_AUTH_DATABASE_URL: 'postgres://kept_auth:kept_auth@localhost:5452/kept',
  KEPT_SYSTEM_DATABASE_URL: 'postgres://kept_system:kept_system@localhost:5452/kept',
  KEPT_PUBLIC_URL: 'http://localhost:5173',
};

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  configDir = await mkdtemp(path.join(tmpdir(), 'kept-rotate-test-'));
  // The server's keys, generated into the config volume on first boot (D193): version 1.
  keys = secretKeysOf(await loadEnv(validEnv, { configDir }));
  t = await peopleApp(db, { secretKeys: keys, publicUrl: 'https://kept.example' });
  ann = await person(t, db, 'ann');
  home = await createLocation(t, db, ann, 'complete');
  safeType = await builtinType(db, 'safe');
  await own(
    db,
    `INSERT INTO public.instance_settings (key, value)
     VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`,
  );
});
afterAll(async () => {
  await t.app.close();
  await rm(configDir, { recursive: true, force: true });
});

const source = () => ({ KEPT_OWNER_DATABASE_URL: db.urls.owner, KEPT_CONFIG_DIR: configDir });

async function safeWith(value: string): Promise<string> {
  const safe = await createThing(t, ann, home, { name: `Safe ${value}`, typeId: safeType });
  const res = await call(t, `/api/v1/things/${safe.id}/secrets/combination`, {
    as: ann,
    method: 'PUT',
    body: { value },
  });
  expect(res.statusCode, res.body).toBe(204);
  return safe.id;
}

const reveal = async (thingId: string) =>
  ok(
    await call(t, `/api/v1/things/${thingId}/secrets/combination/reveal`, {
      as: ann,
      method: 'POST',
    }),
  ).value;

type Row = { id: string; thing_id: string; ciphertext: Sealed; key_version: number };
const rows = () =>
  own<Row>(
    db,
    'SELECT id, thing_id, ciphertext, key_version FROM public.secret_values ORDER BY id',
  );

describe('kept admin rotate-key', () => {
  it('re-wraps every value to version 2, keeps them readable, and old backups open', async () => {
    const values = ['11-22-33', '44-55-66', '77-88-99', '00-11-22', '33-44-55'];
    const things = [];
    for (const v of values) things.push(await safeWith(v));
    const backup = await rows(); // what last night's backup holds
    expect(backup.every((r) => r.key_version === 1)).toBe(true);

    const lines: string[] = [];
    const code = await rotateKey(source(), { batchSize: 2 }, (l) => lines.push(l));
    expect(code, lines.join('\n')).toBe(0);
    expect(lines.join('\n')).toContain('secret field values: 5 re-wrapped to version 2');
    // Which versions the stored values use, before and after (review #17).
    expect(lines).toContain('Key versions in use before: 1 (5 values)');
    expect(lines).toContain('Key versions in use after: 2 (5 values)');

    // The config volume now holds version 2, with version 1 retired.
    const material = await readKeyMaterial({ KEPT_CONFIG_DIR: configDir });
    expect(material.KEPT_SECRET_KEY_VERSION).toBe(2);
    expect(material.KEPT_SECRET_KEYS_RETIRED).toMatch(/^1:/);
    const onDisk = JSON.parse(await readFile(path.join(configDir, 'secrets.json'), 'utf8'));
    expect(onDisk.KEPT_SECRET_KEY_VERSION).toBe(2);

    const after = await rows();
    expect(after.map((r) => [r.id, r.key_version, r.ciphertext.kv])).toEqual(
      backup.map((r) => [r.id, 2, 2]),
    );
    // Only the data key moved (§7.3): the value's own ciphertext is the same.
    expect(after.map((r) => r.ciphertext.ct)).toEqual(backup.map((r) => r.ciphertext.ct));

    // The running server meets version 2, re-reads the file, and reveals as before.
    for (const [i, id] of things.entries()) expect(await reveal(id)).toBe(values[i]);
    expect(keys.get().current.keyVersion).toBe(2);

    // An old backup's ciphertexts still open with the new keyring (version 1 is retired in it).
    const ring = keyringOfMaterial(material);
    for (const [i, r] of backup.entries()) {
      expect(open(ring.keyring, r.ciphertext, aadOf(r.id, 'combination')).toString()).toBe(
        values[i],
      );
    }

    const [event] = await own<{ actor_type: string; diff: object }>(
      db,
      `SELECT actor_type, diff FROM public.audit_events WHERE action = 'instance.rotate_key'`,
    );
    expect(event).toMatchObject({
      actor_type: 'system',
      diff: {
        key_versions: { before: [1], after: [2] },
        rewrapped: { before: 0, after: 5 },
      },
    });
  });

  it('resumes: a row restored from the old backup is re-wrapped by --resume', async () => {
    const id = await safeWith('restored-1');
    const [row] = (await rows()).filter((r) => r.thing_id === id);
    // As if restored from before the rotation: sealed by version 1.
    const ring = keyringOfMaterial(await readKeyMaterial({ KEPT_CONFIG_DIR: configDir }));
    const v1 = { key: ring.keyring.get(1) as Buffer, keyVersion: 1 };
    const { seal } = await import('../crypto/envelope.js');
    const old = seal(v1, 'restored-1', aadOf(row?.id as string, 'combination'));
    await own(
      db,
      'UPDATE public.secret_values SET ciphertext = $2, key_version = 1 WHERE id = $1',
      [row?.id, JSON.stringify(old)],
    );
    expect(await reveal(id)).toBe('restored-1');

    const lines: string[] = [];
    expect(await rotateKey(source(), { resume: true }, (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toContain('1 re-wrapped to version 2');
    expect((await rows()).every((r) => r.key_version === 2)).toBe(true);
    expect(await reveal(id)).toBe('restored-1');
    // Nothing left to do: a second resume re-wraps nothing.
    const again: string[] = [];
    expect(await rotateKey(source(), { resume: true }, (l) => again.push(l))).toBe(0);
    expect(again.join('\n')).toContain('0 re-wrapped');
  });

  it('reports a value it cannot re-wrap (tampered), leaves it, and exits 1', async () => {
    const id = await safeWith('tampered');
    const all0 = await rows();
    const row = all0.find((r) => r.thing_id === id);
    const other = all0.find((r) => r.thing_id !== id);
    // Another row's data key: well-formed, but bound to that row, so it can't be unwrapped here.
    const bad = { ...(row?.ciphertext as Sealed), dek: other?.ciphertext.dek };
    await own(db, 'UPDATE public.secret_values SET ciphertext = $2 WHERE id = $1', [
      row?.id,
      JSON.stringify(bad),
    ]);
    const lines: string[] = [];
    expect(await rotateKey(source(), {}, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain(`could not re-wrap ${row?.id} (crypto_aad_mismatch)`);
    const all = await rows();
    expect(all.filter((r) => r.id !== row?.id).every((r) => r.key_version === 3)).toBe(true);
    expect(all.find((r) => r.id === row?.id)?.key_version).toBe(2);
    await own(db, 'DELETE FROM public.secret_values WHERE id = $1', [row?.id]);
  });

  it("changes nothing when the rows use a key version the keyring doesn't hold", async () => {
    const id = await safeWith('orphan');
    const [row] = (await rows()).filter((r) => r.thing_id === id);
    await own(db, 'UPDATE public.secret_values SET key_version = 9 WHERE id = $1', [row?.id]);
    const before = await readFile(path.join(configDir, 'secrets.json'), 'utf8');
    const err = await rotateKey(source(), {}, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toContain('key version 9');
    expect(await readFile(path.join(configDir, 'secrets.json'), 'utf8')).toBe(before);
    await own(db, 'DELETE FROM public.secret_values WHERE id = $1', [row?.id]);
  });

  it('with keys in the environment, prints what to set and changes nothing', async () => {
    const material = await readKeyMaterial({ KEPT_CONFIG_DIR: configDir });
    const envSource = {
      KEPT_OWNER_DATABASE_URL: db.urls.owner,
      KEPT_SECRET_KEY: material.KEPT_SECRET_KEY,
      KEPT_AUTH_SECRET: material.KEPT_AUTH_SECRET,
      KEPT_SECRET_KEY_VERSION: String(material.KEPT_SECRET_KEY_VERSION),
      ...(material.KEPT_SECRET_KEYS_RETIRED
        ? { KEPT_SECRET_KEYS_RETIRED: material.KEPT_SECRET_KEYS_RETIRED }
        : {}),
    };
    const before = await rows();
    const lines: string[] = [];
    expect(await rotateKey(envSource, {}, (l) => lines.push(l))).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain(`KEPT_SECRET_KEY_VERSION=${material.KEPT_SECRET_KEY_VERSION + 1}`);
    expect(text).toContain(`KEPT_SECRET_KEYS_RETIRED=`);
    expect(text).toContain(`${material.KEPT_SECRET_KEY_VERSION}:${material.KEPT_SECRET_KEY}`);
    expect(text).toContain('--resume');
    expect(await rows()).toEqual(before);
  });
});

describe('kept admin rotate-key --drop <version> (review #17)', () => {
  it('refuses to drop a retired version a stored value still uses, and drops it once none does', async () => {
    const material = await readKeyMaterial({ KEPT_CONFIG_DIR: configDir });
    const current = material.KEPT_SECRET_KEY_VERSION;
    const [retired] = (material.KEPT_SECRET_KEYS_RETIRED ?? '')
      .split(',')
      .map((p) => Number(p.split(':')[0]));
    expect(retired).toBeDefined();
    const id = await safeWith('still-old');
    const [row] = (await rows()).filter((r) => r.thing_id === id);
    // As a row restored from an old backup would be: still under the retired version.
    await own(db, 'UPDATE public.secret_values SET key_version = $2 WHERE id = $1', [
      row?.id,
      retired,
    ]);

    const before = await readFile(path.join(configDir, 'secrets.json'), 'utf8');
    const refused = await rotateKey(source(), { drop: retired }, () => {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CliError);
    expect((refused as Error).message).toContain(
      `key version ${retired} still opens 1 stored value`,
    );
    expect(await readFile(path.join(configDir, 'secrets.json'), 'utf8')).toBe(before);

    // Never the current key, nor one the ring doesn't hold.
    const cur = await rotateKey(source(), { drop: current }, () => {}).catch((e: unknown) => e);
    expect((cur as Error).message).toContain('current');
    const none = await rotateKey(source(), { drop: 99 }, () => {}).catch((e: unknown) => e);
    expect((none as Error).message).toContain('no retired key version 99');

    await own(db, 'UPDATE public.secret_values SET key_version = $2 WHERE id = $1', [
      row?.id,
      current,
    ]);
    const lines: string[] = [];
    expect(await rotateKey(source(), { drop: retired }, (l) => lines.push(l))).toBe(0);
    const after = await readKeyMaterial({ KEPT_CONFIG_DIR: configDir });
    expect(after.KEPT_SECRET_KEY_VERSION).toBe(current);
    expect(after.KEPT_SECRET_KEYS_RETIRED ?? '').not.toMatch(new RegExp(`(^|,)${retired}:`));
    expect(lines.join('\n')).toContain('backup');
    const [event] = await own<{ diff: object }>(
      db,
      `SELECT diff FROM public.audit_events WHERE action = 'instance.drop_key'`,
    );
    expect(event?.diff).toMatchObject({ dropped: { before: null, after: retired } });
  });
});

describe('kept admin rotate-key: AI provider keys (T9)', () => {
  it('re-wraps an AI key too, which still opens under its own row and field', async () => {
    const id = newId();
    const apiKey = `gsk_rotate${randomBytes(8).toString('hex')}`;
    // The keys on disk now (earlier cases rotated them).
    const { current } = keyringOfMaterial(await readKeyMaterial({ KEPT_CONFIG_DIR: configDir }));
    await own(
      db,
      `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext,
                                        key_version, models, created_by)
       VALUES ($1, 'account', $2, 'groq', $3, $4, '{}', $5)`,
      [
        id,
        home.accountId,
        JSON.stringify(seal(current, apiKey, providerKeyAad(id))),
        current.keyVersion,
        ann.userId,
      ],
    );
    const lines: string[] = [];
    expect(await rotateKey(source(), { batchSize: 10 }, (l) => lines.push(l))).toBe(0);
    const [row] = await own<{ key_ciphertext: Sealed; key_version: number }>(
      db,
      'SELECT key_ciphertext, key_version FROM public.ai_providers WHERE id = $1',
      [id],
    );
    expect(row?.key_version).toBe(current.keyVersion + 1);
    expect(row?.key_ciphertext.kv).toBe(current.keyVersion + 1);
    const ring = keyringOfMaterial(await readKeyMaterial({ KEPT_CONFIG_DIR: configDir }));
    expect(open(ring.keyring, row?.key_ciphertext as Sealed, providerKeyAad(id)).toString()).toBe(
      apiKey,
    );
  });
});

describe('the registry of sealed columns', () => {
  it('lists every table that stores a ciphertext or a key version', async () => {
    const found = await own<{ t: string }>(
      db,
      `SELECT DISTINCT table_schema || '.' || table_name AS t FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('ciphertext', 'key_version')
        ORDER BY 1`,
    );
    expect(found.map((r) => r.t)).toEqual(CIPHERTEXTS.map((c) => c.table).sort());
  });
});
