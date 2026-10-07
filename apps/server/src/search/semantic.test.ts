// Semantic search end to end on the database (step-6 plan T14; D200, D206, D207; Q13, Q14): the
// backfill and the editor's job embed things with the mock embedder (KEPT_AI_MOCK's concept
// vectors, test/fixtures/semantic/concepts.json; never a real provider), GET /search fuses meaning
// with keywords, and the switch, the pauses and the leak hold. Ibrahim owns Home; Louis is a member
// there; Alfred owns بيت العائلة with a Groq-only key (no embeddings model); a stranger's location
// uses the same model.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { createLocation, createThing, type Json, type Loc, ok, own } from '../../test/things.js';
import { providerKeyAad } from '../ai/db-keys.js';
import { createAiDeps } from '../ai/routes.js';
import { type Keyring, seal } from '../crypto/envelope.js';
import { runBackfill } from '../embeddings/backfill.js';
import { embedThing } from '../embeddings/job.js';
import { EMBEDDINGS_SOURCE_KEY } from '../embeddings/provider.js';
import { wantsMeaning } from './semantic.js';

vi.setConfig({ testTimeout: 60_000 });

const MASTER = { key: Buffer.alloc(32, 7), keyVersion: 1 };
const keyring: Keyring = new Map([[1, MASTER.key]]);
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];
let ibrahim: Person;
let louis: Person;
let alfred: Person;
let stranger: Person;
let home: Loc;
let family: Loc;
let away: Loc;
let hdmi: Json;
let charger: Json;
let drill: Json;
let splitter: Json;

const ai = () =>
  createAiDeps({
    pools: db.pools,
    keyring: () => keyring,
    log: silent,
    mock: true,
    overrides: {
      fetch: (() => {
        throw new Error('no network');
      }) as unknown as typeof fetch,
    },
  });

async function provider(
  accountId: string,
  by: string,
  kind: 'openai' | 'groq',
  models: Record<string, string>,
) {
  const id = crypto.randomUUID();
  await own(
    db,
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext, key_version,
                                      models, created_by)
     VALUES ($1, 'account', $2, $3, $4, 1, $5, $6)`,
    [
      id,
      accountId,
      kind,
      JSON.stringify(seal(MASTER, 'sk-TESTKEY', providerKeyAad(id))),
      JSON.stringify(models),
      by,
    ],
  );
  return id;
}

const backfill = () =>
  runBackfill({ pools: db.pools, ai: ai(), keyring: () => keyring, log: silent });

type Row = { id: string; name: string; matchedBy?: string };
async function searchAs(p: Person, q: string, extra = '') {
  const res = await call(t, `/api/v1/search?kind=things&q=${encodeURIComponent(q)}${extra}`, {
    as: p,
    method: 'GET',
  });
  return ok(res) as unknown as {
    things: { items: Row[] };
    semantic?: { state: string; until?: string } | null;
  };
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent, ai: ai() });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  alfred = await person(t, db, 'alfred');
  stranger = await person(t, db, 'stranger');
  home = await createLocation(t, db, ibrahim, 'complete');
  family = await createLocation(t, db, alfred, 'complete', 'بيت العائلة');
  away = await createLocation(t, db, stranger, 'complete', 'Elsewhere');
  await join(db, home.id, louis.userId, 'member');
  const embeddings = { chat: 'gpt-chat', embeddings: 'text-embedding-3-small' };
  await provider(home.accountId, ibrahim.userId, 'openai', embeddings);
  await provider(away.accountId, stranger.userId, 'openai', embeddings);
  await provider(family.accountId, alfred.userId, 'groq', { chat: 'openai/gpt-oss-120b' });
  hdmi = await createThing(t, ibrahim, home, { name: 'HDMI cable, 2 m' });
  charger = await createThing(t, ibrahim, home, { name: 'Phone charger' });
  drill = await createThing(t, ibrahim, home, { name: 'Bosch drill, 18 V' });
  await createThing(t, ibrahim, home, { name: 'Sofa' });
  await createThing(t, alfred, family, { name: 'شاحن سامسونج' });
  splitter = await createThing(t, stranger, away, { name: 'HDMI splitter for the TV' });
});

beforeEach(async () => {
  await own(db, 'DELETE FROM public.instance_settings WHERE key = $1', [EMBEDDINGS_SOURCE_KEY]);
  await own(db, 'DELETE FROM public.ai_budgets');
});

describe('which queries are embedded', () => {
  it('never one short word, a short code or a serial', () => {
    expect(wantsMeaning('the thing for the TV')).toBe(true);
    expect(wantsMeaning('شاحن الموبايل')).toBe(true);
    expect(wantsMeaning('charger')).toBe(true);
    expect(wantsMeaning('TV')).toBe(false);
    expect(wantsMeaning('7KQ-4MZ')).toBe(false);
    expect(wantsMeaning('SN-99887766')).toBe(false);
    expect(wantsMeaning('')).toBe(false);
  });
});

describe('the backfill and the editor’s job', () => {
  it('embeds every location with a model, paid by its owner with no user (Kept, background)', async () => {
    await own(db, 'DELETE FROM public.llm_calls');
    const out = await backfill();
    const byLoc = new Map(out.map((o) => [o.locationId, o]));
    expect(byLoc.get(home.id)).toMatchObject({
      modelKey: 'provider:openai:text-embedding-3-small',
      stored: 4,
      pending: 0,
      stopped: null,
    });
    expect(byLoc.get(family.id)).toMatchObject({ stopped: 'keyword_only', stored: 0 });
    const rows = await own<{ task: string; user_id: string | null; paying_account_id: string }>(
      db,
      `SELECT task, user_id, paying_account_id FROM public.llm_calls WHERE location_id = $1`,
      [home.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toMatchObject({ task: 'embed_thing', user_id: null });
      expect(r.paying_account_id).toBe(home.accountId);
    }
    // A second run finds nothing left to embed.
    const again = await backfill();
    expect(again.find((o) => o.locationId === home.id)).toMatchObject({ stored: 0, pending: 0 });
  });

  it('an edit re-embeds the thing in the editor’s scope; a current vector is left alone', async () => {
    await backfill();
    const scope = { userId: ibrahim.userId, mfa: false };
    const deps = { pools: db.pools, ai: ai() };
    expect(await embedThing(deps, scope, String(drill.id))).toEqual({
      status: 'skipped',
      why: 'current',
    });
    sent.length = 0;
    const res = await call(t, `/api/v1/things/${drill.id}`, {
      as: ibrahim,
      method: 'PATCH',
      headers: { 'if-match': String(drill.rowVersion ?? 1) },
      body: { notes: 'For holes in the wall' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(sent).toContainEqual({ name: 'embed-thing', data: { thingId: drill.id } });
    expect(await embedThing(deps, scope, String(drill.id))).toMatchObject({
      status: 'stored',
      modelKey: 'provider:openai:text-embedding-3-small',
    });
  });
});

describe('GET /search with meaning', () => {
  beforeAll(async () => {
    await backfill();
  });

  it('“the thing for the TV” finds the HDMI cable by meaning alone', async () => {
    const res = await searchAs(louis, 'the thing for the TV');
    expect(res.semantic).toBeNull();
    const row = res.things.items.find((r) => r.id === hdmi.id);
    expect(row).toMatchObject({ matchedBy: 'meaning' });
    expect(res.things.items.map((r) => r.id)).not.toContain(drill.id);
  });

  it('Arabic “شاحن الموبايل” finds the phone charger', async () => {
    const res = await searchAs(louis, 'شاحن الموبايل');
    expect(res.things.items.map((r) => r.id)).toContain(charger.id);
  });

  it('a keyword match stays a keyword match, ranked first', async () => {
    const res = await searchAs(louis, 'HDMI cable');
    expect(res.things.items[0]).toMatchObject({ id: hdmi.id });
    expect(res.things.items[0]?.matchedBy).toBeUndefined();
  });

  it('never shows another tenant’s nearest vector (the leak case)', async () => {
    const res = await searchAs(louis, 'HDMI splitter for the TV');
    expect(res.things.items.map((r) => r.id)).not.toContain(splitter.id);
    const theirs = await searchAs(stranger, 'the thing for the TV');
    expect(theirs.things.items.map((r) => r.id)).toEqual([splitter.id]);
  });

  it('a location with only a Groq key is keyword-only, and says so', async () => {
    const res = await searchAs(alfred, 'the thing for my phone', `&locationId=${family.id}`);
    expect(res.semantic).toEqual({ state: 'keyword_only' });
  });

  it('a cap pause leaves search on keywords and says until when', async () => {
    await own(
      db,
      `INSERT INTO public.ai_budgets (scope, owner_account_id, location_id, tokens_per_month,
                                      paused_until, paused_reason, set_by)
       VALUES ('location', $1, $2, 10, now() + interval '3 days', 'cap_tokens', $3)`,
      [home.accountId, home.id, ibrahim.userId],
    );
    const res = await searchAs(louis, 'the thing for the TV');
    expect(res.semantic).toMatchObject({ state: 'paused', until: expect.any(String) });
    expect(res.things.items.some((r) => r.matchedBy === 'meaning')).toBe(false);
    const words = await searchAs(louis, 'HDMI cable');
    expect(words.things.items[0]).toMatchObject({ id: hdmi.id });
  });

  it('embeddings off: keyword results, “off”', async () => {
    await own(db, `INSERT INTO public.instance_settings (key, value) VALUES ($1, '"off"')`, [
      EMBEDDINGS_SOURCE_KEY,
    ]);
    const res = await searchAs(louis, 'the thing for the TV');
    expect(res.semantic).toEqual({ state: 'off' });
    expect(res.things.items.some((r) => r.matchedBy === 'meaning')).toBe(false);
  });
});

describe('the source switch', () => {
  // catalogue: PUT /api/v1/admin/embeddings
  it('an instance admin switches it, audited; local is refused without its runtime', async () => {
    await own(
      db,
      'INSERT INTO public.instance_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [ibrahim.userId],
    );
    const local = await call(t, '/api/v1/admin/embeddings', {
      as: ibrahim,
      method: 'PUT',
      body: { source: 'local' },
    });
    expect(local.statusCode).toBe(409);
    sent.length = 0;
    const off = ok(
      await call(t, '/api/v1/admin/embeddings', {
        as: ibrahim,
        method: 'PUT',
        body: { source: 'off' },
      }),
    );
    expect(off).toMatchObject({ source: 'off', local: { available: false } });
    const on = ok(
      await call(t, '/api/v1/admin/embeddings', {
        as: ibrahim,
        method: 'PUT',
        body: { source: 'provider' },
      }),
    );
    expect(on).toMatchObject({ source: 'provider' });
    expect(sent).toContainEqual({ name: 'embed-backfill', data: {} });
    const events = await own<{ diff: unknown }>(
      db,
      `SELECT diff FROM public.audit_events WHERE action = 'instance.embeddings_source' ORDER BY at`,
    );
    expect(events).toHaveLength(2);
    const status = ok(await call(t, '/api/v1/admin/status', { as: ibrahim, method: 'GET' }));
    expect(status.embeddings).toMatchObject({ source: 'provider', indexed: expect.any(Number) });
    const forbidden = await call(t, '/api/v1/admin/embeddings', {
      as: louis,
      method: 'PUT',
      body: { source: 'off' },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
