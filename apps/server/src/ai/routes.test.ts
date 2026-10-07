import { randomBytes } from 'node:crypto';
import { CSV_BOM, newId, RECOMMENDED, RECOMMENDED_PRICE, safeCsvCell } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { createLocation, type Json, type Loc, ok, own, setDisplayName } from '../../test/things.js';
import { fixedSecretKeys, keyringOf } from '../crypto/keyring.js';
import type { Mail } from '../mail/mailer.js';
import { aiNoticeHooks, runAiNotice } from './notices.js';
import type { AiDeps } from './routes.js';
import { aiRuntime } from './runtime.js';

// T9: AI settings, keys, "Test connection", caps, prices, usage and the call ledger, through the
// front door in the web contract's shapes (apps/web/src/api/capture/types.ts "AI", mock/ai.ts).
// The sample cast: Ibrahim owns Home and is the instance admin; Bruce is Home's admin, Louis a
// member, Talia a viewer; Alfred owns بيت العائلة, another household.

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];
const mails: Mail[] = [];
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let talia: Person;
let alfred: Person;
let home: Loc;
let family: Loc;

const master = { key: randomBytes(32), keyVersion: 1 };
const keys = fixedSecretKeys(keyringOf({ version: 1, key: master.key, retired: new Map() }));

/** A marker in every key, searched for in every table afterwards: it must be nowhere. */
const KEY_MARKER = 'KEYMARKER7f3a';
const groqKey = (tail = 'Ab12') => `gsk_${KEY_MARKER}${randomBytes(6).toString('hex')}${tail}`;

/** The provider's list-models endpoint, as recorded shapes (models.ts's Groq and compatible
 * branches); a key containing `bad` is refused. Fixture values, not provider prices. */
const listing = {
  object: 'list',
  data: [
    {
      id: RECOMMENDED.model,
      active: true,
      context_window: 131072,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      pricing: { prompt: '0.0000001', completion: '0.0000003' },
    },
    {
      id: 'openai/gpt-oss-120b',
      active: true,
      context_window: 131072,
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
  ],
};
const fetched: string[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  if (auth.includes('bad')) return new Response('{}', { status: 401 });
  return new Response(JSON.stringify(listing), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const silent = { warn: () => {}, info: () => {} };

function aiDeps(): AiDeps {
  return {
    mock: false,
    runtime: (scope) =>
      aiRuntime(
        {
          pools: db.pools,
          keyring: () => keys.get().keyring,
          log: silent,
          mock: {},
          ...aiNoticeHooks(db.pools, {
            send: async (_c, name, data) => {
              sent.push({ name, data });
            },
            sendTenant: async () => {},
          }),
          overrides: { fetch: fakeFetch },
        },
        scope,
      ),
  };
}

const acknowledgeKit = () =>
  own(
    db,
    `INSERT INTO public.instance_settings (key, value)
     VALUES ('recovery_kit_acknowledged_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING`,
  );

const put = (as: Person, scope: string, body: object, rowVersion?: number) =>
  call(t, `/api/v1/ai/providers/${scope}`, {
    as,
    method: 'PUT',
    body,
    headers: rowVersion === undefined ? {} : { 'if-match': String(rowVersion) },
  });

/**
 * A photo captured while AI capture was on but no provider resolved: its thing, file,
 * attachment and the extraction waiting for a provider, as the capture writes them.
 */
async function waitingPhoto(locationId: string, by: Person): Promise<string> {
  const [thing, file, attachment, extraction] = [newId(), newId(), newId(), newId()];
  await own(
    db,
    `INSERT INTO public.things (id, location_id, place_id, name, review_state, created_by)
     SELECT $1, $2, p.id, NULL, 'draft', $3 FROM public.places p
      WHERE p.location_id = $2 AND p.is_unplaced`,
    [thing, locationId, by.userId],
  );
  await own(
    db,
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by)
     VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
    [file, locationId, `f/${locationId}/${file}`, randomBytes(32).toString('hex'), by.userId],
  );
  await own(
    db,
    `INSERT INTO public.attachments (id, location_id, file_id, thing_id, role, created_by)
     VALUES ($1, $2, $3, $4, 'photo', $5)`,
    [attachment, locationId, file, thing, by.userId],
  );
  await own(
    db,
    `INSERT INTO public.extractions (id, location_id, attachment_id, thing_id, mode, status,
                                     status_reason, requested_by)
     VALUES ($1, $2, $3, $4, 'thing', 'waiting_provider', 'no_provider', $5)`,
    [extraction, locationId, attachment, thing, by.userId],
  );
  return extraction;
}

const extractionState = async (id: string) =>
  (
    await own<{ status: string; status_reason: string | null }>(
      db,
      'SELECT status, status_reason FROM public.extractions WHERE id = $1',
      [id],
    )
  )[0];

/** A 204, which has no body to parse. */
function gone(res: LightMyRequestResponse): void {
  expect(res.statusCode, res.body).toBe(204);
}

const auditRows = (action: string) =>
  own<{ actor_id: string; diff: Record<string, unknown>; location_id: string | null }>(
    db,
    `SELECT actor_id, diff, location_id FROM public.audit_events WHERE action = $1 ORDER BY at`,
    [action],
  );

/** A ledger row, written by the door that writes them (kept.ai_insert_call, as kept_owner). */
async function ledgerRow(over: {
  task?: string;
  location?: Loc | null;
  userId?: string | null;
  paying?: 'account' | 'instance' | 'user';
  payingAccountId?: string | null;
  payingUserId?: string | null;
  model?: string;
  tokens?: [number, number];
  cost?: string | null;
  images?: number;
  outcome?: string;
  requestId?: string;
  attempt?: number;
  thingId?: string;
  threadId?: string;
  at?: Date;
}): Promise<string> {
  const loc = over.location === undefined ? home : over.location;
  const paying = over.paying ?? 'account';
  const sent = over.outcome !== 'over_budget';
  const rows = await own<{ id: string }>(db, 'SELECT kept.ai_insert_call($1, $2, $3, $4) AS id', [
    JSON.stringify({
      at: (over.at ?? new Date()).toISOString(),
      request_id: over.requestId ?? newId(),
      attempt: over.attempt ?? 1,
      task: over.task ?? 'extract_thing',
      location_id: loc?.id ?? null,
      owner_account_id: loc?.accountId ?? null,
      user_id: over.userId === undefined ? louis.userId : over.userId,
      paying_scope: paying,
      paying_account_id:
        paying === 'account' ? (over.payingAccountId ?? loc?.accountId ?? null) : null,
      paying_user_id: paying === 'user' ? over.payingUserId : null,
      provider_kind: 'groq',
      model: over.model ?? RECOMMENDED.model,
      estimate_tokens: 3000,
      image_count: over.images ?? 1,
      image_bytes: over.images === 0 ? null : 180_000,
      thing_id: over.thingId ?? null,
      thread_id: over.threadId ?? null,
    }),
    JSON.stringify({
      sent,
      input_tokens: sent ? (over.tokens?.[0] ?? 2000) : null,
      output_tokens: sent ? (over.tokens?.[1] ?? 500) : null,
      latency_ms: 900,
    }),
    over.outcome ?? 'ok',
    sent && over.cost !== null
      ? JSON.stringify({ amount: over.cost ?? '0.0039', currency: 'USD', source: 'provider' })
      : sent
        ? JSON.stringify({ source: 'unknown' })
        : null,
  ]);
  return rows[0]?.id as string;
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent, secretKeys: keys, ai: aiDeps() });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  await setDisplayName(db, ibrahim, 'Ibrahim');
  await setDisplayName(db, louis, 'Louis');
  await setDisplayName(db, talia, 'Talia');
  await setDisplayName(db, bruce, 'Bruce');
  await setDisplayName(db, alfred, 'Alfred');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  family = await createLocation(t, db, alfred, 'household', 'بيت العائلة');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await own(db, 'INSERT INTO public.instance_admins (user_id) VALUES ($1)', [ibrahim.userId]);
});

beforeEach(() => {
  sent.length = 0;
  mails.length = 0;
});

afterAll(async () => {
  await t.app.close();
});

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

describe('keys: PUT /api/v1/ai/providers/:scope', () => {
  it('needs the recovery kit before the first AI key (D193)', async () => {
    const res = await put(ibrahim, 'account', { apiKey: groqKey() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'recovery_kit_required' });
    await acknowledgeKit();
  });

  // catalogue: PUT /api/v1/ai/providers/:ref
  it('saves a pasted Groq key write-only, with the recommended model, and audits it as a secret', async () => {
    const key = groqKey('Wx9z');
    const out = ok(await put(ibrahim, 'account', { apiKey: key }));
    expect(out).toMatchObject({
      scope: 'account',
      kind: 'groq',
      keyHint: 'Wx9z',
      baseUrl: null,
      models: { vision: RECOMMENDED.model, chat: 'openai/gpt-oss-120b' },
      disabled: false,
    });
    expect(JSON.stringify(out)).not.toContain(KEY_MARKER);
    // The list came from the provider's own endpoint, through the fetch the runtime guards.
    expect(fetched.some((u) => u === 'https://api.groq.com/openai/v1/models')).toBe(true);
    const listed = ok(await call(t, '/api/v1/ai/providers', { as: ibrahim }));
    expect(JSON.stringify(listed)).not.toContain(KEY_MARKER);
    expect((listed.providers as Json[]).map((p) => p.id)).toContain(out.id);
    const [row] = await own<{ key_ciphertext: unknown; key_version: number }>(
      db,
      'SELECT key_ciphertext, key_version FROM public.ai_providers WHERE id = $1',
      [out.id],
    );
    expect(row?.key_version).toBe(1);
    expect(JSON.stringify(row?.key_ciphertext)).not.toContain(KEY_MARKER);
    const [event] = (await auditRows('ai.provider_set')).slice(-1);
    expect(event?.actor_id).toBe(ibrahim.userId);
    expect(event?.diff.api_key).toEqual({ changed: true, class: 'secret' });
    // The recommended model has a price from its first call: the listing's, saved with its date
    // because an instance admin connected it and none was set.
    const prices = ok(await call(t, '/api/v1/ai/prices', { as: louis })).prices as Json[];
    expect(prices).toEqual([
      expect.objectContaining({
        providerKind: 'groq',
        model: RECOMMENDED.model,
        version: 1,
        rates: expect.objectContaining({ inputPerMtok: '0.1', outputPerMtok: '0.3' }),
        currency: 'USD',
        source: 'provider_listing',
        listingFetchedAt: expect.any(String),
      }),
    ]);
    expect((await auditRows('ai.price_set')).at(-1)?.actor_id).toBe(ibrahim.userId);
  });

  it('sends what waited for a provider when a key is saved: the saver’s own, once', async () => {
    // Peter captured a photo in his Personal location before any provider existed: the capture
    // wrote the extraction as waiting_provider / no_provider (capture/service.ts).
    const peter = await person(t, db, 'peter');
    const waiting = await waitingPhoto(peter.personalLocationId, peter);
    const other = await waitingPhoto(family.id, alfred);
    ok(await put(peter, 'me', { apiKey: groqKey('Pe77') }));
    expect(await extractionState(waiting)).toEqual({ status: 'queued', status_reason: null });
    expect(sent.filter((j) => j.name === 'extract')).toEqual([
      { name: 'extract', data: { extractionId: waiting } },
    ]);
    // Another household's is not his to send (their own capture or inbox sends it).
    expect(await extractionState(other)).toEqual({
      status: 'waiting_provider',
      status_reason: 'no_provider',
    });
    // Saved again: nothing waits any more, nothing is sent twice.
    sent.length = 0;
    const mine = (
      ok(await call(t, '/api/v1/ai/providers', { as: peter })).providers as Json[]
    ).find((p) => p.scope === 'user') as Json;
    ok(await put(peter, 'me', { reasoning: 'low' }, mine.rowVersion as number));
    expect(sent.filter((j) => j.name === 'extract')).toEqual([]);
  });

  it('answers 400 "choose a provider" for a key it cannot place, and 404 for the instance to a non-admin', async () => {
    const unknown = await put(louis, 'me', { apiKey: `xx-${randomBytes(12).toString('hex')}` });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: 'validation' });
    expect(unknown.json().hint).toMatch(/Choose a provider/);
    expect((await put(louis, 'instance', { apiKey: groqKey() })).statusCode).toBe(404);
    expect((await put(louis, 'garage', { apiKey: groqKey() })).statusCode).toBe(404);
  });

  it('keeps a member off the account key: their own "account" is their own, never Home’s', async () => {
    const mine = ok(await put(louis, 'account', { apiKey: groqKey('Lo11') }));
    const [row] = await own<{ owner_account_id: string }>(
      db,
      'SELECT owner_account_id FROM public.ai_providers WHERE id = $1',
      [mine.id],
    );
    expect(row?.owner_account_id).not.toBe(home.accountId);
    const homeKey = (
      await own<{ id: string }>(
        db,
        `SELECT id FROM public.ai_providers WHERE scope = 'account' AND owner_account_id = $1
         AND disabled_at IS NULL`,
        [home.accountId],
      )
    )[0]?.id as string;
    for (const res of [
      await call(t, `/api/v1/ai/providers/${homeKey}`, { as: louis, method: 'DELETE' }),
      await call(t, `/api/v1/ai/providers/${homeKey}/test`, { as: louis, method: 'POST' }),
      await call(t, `/api/v1/ai/providers/${homeKey}/models`, { as: louis }),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    // Louis's own goes again.
    gone(await call(t, `/api/v1/ai/providers/${mine.id}`, { as: louis, method: 'DELETE' }));
  });

  it('needs If-Match to replace a key, and refuses a stale one', async () => {
    const current = (
      ok(await call(t, '/api/v1/ai/providers', { as: ibrahim })).providers as Json[]
    ).find((p) => p.scope === 'account') as Json;
    expect((await put(ibrahim, 'account', { apiKey: groqKey() })).statusCode).toBe(428);
    const stale = await put(
      ibrahim,
      'account',
      { apiKey: groqKey() },
      (current.rowVersion as number) - 1,
    );
    expect(stale.statusCode).toBe(412);
    const next = ok(
      await put(ibrahim, 'account', { apiKey: groqKey('Nw22') }, current.rowVersion as number),
    );
    expect(next).toMatchObject({ id: current.id, keyHint: 'Nw22' });
  });

  it('refuses a model the provider does not list, except a custom id on a compatible server', async () => {
    const current = (
      ok(await call(t, '/api/v1/ai/providers', { as: ibrahim })).providers as Json[]
    ).find((p) => p.scope === 'account') as Json;
    const res = await put(
      ibrahim,
      'account',
      { models: { vision: 'made-up-model' } },
      current.rowVersion as number,
    );
    expect(res.statusCode).toBe(400);
  });

  it('checks a typed base URL against private addresses, unless the instance allows them (Q9)', async () => {
    const body = {
      kind: 'openai_compatible',
      baseUrl: 'http://10.0.0.5:11434/v1',
      apiKey: 'ollama-local-key',
    };
    const refused = await put(bruce, 'me', body);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'private_address' });
    expect(refused.json().hint).toMatch(/Allow private addresses/);
    await own(
      db,
      `INSERT INTO public.instance_settings (key, value) VALUES ('ssrf_allow_private', 'true')`,
    );
    try {
      const saved = ok(
        await put(bruce, 'me', { ...body, models: { vision: 'my-own-vision-model' } }),
      );
      expect(saved).toMatchObject({
        kind: 'openai_compatible',
        baseUrl: 'http://10.0.0.5:11434/v1',
        models: { vision: 'my-own-vision-model' },
      });
    } finally {
      await own(db, `DELETE FROM public.instance_settings WHERE key = 'ssrf_allow_private'`);
    }
  });

  // catalogue: DELETE /api/v1/ai/providers/:ref
  it('removes a key: disabled, the key and its hint gone, audited', async () => {
    const mine = ok(await put(talia, 'me', { apiKey: groqKey('Ta33') }));
    gone(await call(t, `/api/v1/ai/providers/${mine.id}`, { as: talia, method: 'DELETE' }));
    const [row] = await own<{
      disabled_at: Date | null;
      key_ciphertext: unknown;
      key_hint: unknown;
    }>(db, 'SELECT disabled_at, key_ciphertext, key_hint FROM public.ai_providers WHERE id = $1', [
      mine.id,
    ]);
    expect(row?.disabled_at).not.toBeNull();
    expect(row?.key_ciphertext).toBeNull();
    expect(row?.key_hint).toBeNull();
    const events = await auditRows('ai.provider_remove');
    expect(events.some((e) => e.actor_id === talia.userId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Test connection and the model list
// ---------------------------------------------------------------------------------------------

const accountKey = async () =>
  (ok(await call(t, '/api/v1/ai/providers', { as: ibrahim })).providers as Json[]).find(
    (p) => p.scope === 'account',
  ) as Json;

describe('"Test connection" and the model list (D188, D202, L50)', () => {
  // catalogue: POST /api/v1/ai/providers/:id/test
  it('makes the two ledgered calls, records the capabilities, and is audited', async () => {
    const key = await accountKey();
    // Louis's photo in Home waited for a provider: a passing test sends it too.
    const waiting = await waitingPhoto(home.id, louis);
    const before = await own<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM public.llm_calls WHERE provider_id = $1`,
      [key.id],
    );
    const out = ok(
      await call(t, `/api/v1/ai/providers/${key.id}/test`, { as: ibrahim, method: 'POST' }),
    );
    expect(out).toMatchObject({
      vision: { ok: true },
      structured: { ok: true },
      model: RECOMMENDED.model,
    });
    expect(out.tokens).toBeGreaterThan(0);
    const rows = await own<{ task: string; paying_account_id: string; image_count: number }>(
      db,
      `SELECT task, paying_account_id, image_count FROM public.llm_calls
        WHERE provider_id = $1 ORDER BY attempt`,
      [key.id],
    );
    expect(rows.length - (before[0]?.n ?? 0)).toBe(2);
    expect(rows.slice(-2).map((r) => [r.task, r.paying_account_id, r.image_count])).toEqual([
      ['connection_test', home.accountId, 1],
      ['connection_test', home.accountId, 0],
    ]);
    const after = await accountKey();
    expect(after.capabilities).toEqual({ vision: true, structured: true });
    const events = await auditRows('ai.provider_test');
    expect(events.at(-1)?.actor_id).toBe(ibrahim.userId);
    expect(await extractionState(waiting)).toEqual({ status: 'queued', status_reason: null });
    expect(sent).toContainEqual({ name: 'extract', data: { extractionId: waiting } });
  });

  it('lists the models from the cache, and a refresh is audited but never a model call', async () => {
    const key = await accountKey();
    const calls = async () =>
      (await own<{ n: number }>(db, 'SELECT count(*)::int AS n FROM public.llm_calls'))[0]?.n;
    const n = await calls();
    const cached = ok(await call(t, `/api/v1/ai/providers/${key.id}/models`, { as: ibrahim }));
    expect(cached.models).toEqual([
      {
        id: RECOMMENDED.model,
        vision: true,
        text: true,
        embeddings: false,
        visionSource: 'listing',
      },
      {
        id: 'openai/gpt-oss-120b',
        vision: false,
        text: true,
        embeddings: false,
        visionSource: 'listing',
      },
    ]);
    expect(cached.chosenMissing).toEqual([]);
    const fresh = ok(
      await call(t, `/api/v1/ai/providers/${key.id}/models?refresh=1`, { as: ibrahim }),
    );
    expect(fresh.fetchedAt).not.toBe(cached.fetchedAt);
    expect(await calls()).toBe(n);
    expect((await auditRows('ai.provider_models')).length).toBeGreaterThan(0);
  });

  it('flags a chosen model the provider no longer lists, in the list and the status line', async () => {
    const key = await accountKey();
    await own(
      db,
      `UPDATE public.ai_providers SET models = models || '{"chat": "retired-chat"}' WHERE id = $1`,
      [key.id],
    );
    const listed = ok(await call(t, `/api/v1/ai/providers/${key.id}/models`, { as: ibrahim }));
    expect(listed.chosenMissing).toEqual(['chat']);
    await own(
      db,
      `UPDATE public.ai_providers SET models = models || '{"vision": "gone-vision"}' WHERE id = $1`,
      [key.id],
    );
    const status = ok(await call(t, `/api/v1/ai/status?locationId=${home.id}`, { as: ibrahim }));
    expect(status.modelMissing).toBe(true);
    await own(
      db,
      `UPDATE public.ai_providers SET models = jsonb_build_object('vision', $2::text, 'chat', 'openai/gpt-oss-120b') WHERE id = $1`,
      [key.id, RECOMMENDED.model],
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Status, caps, pause and resume
// ---------------------------------------------------------------------------------------------

const putCap = (as: Person, body: object, rowVersion?: number) =>
  call(t, '/api/v1/ai/caps', {
    as,
    method: 'PUT',
    body,
    headers: rowVersion === undefined ? {} : { 'if-match': String(rowVersion) },
  });

describe('status and caps (D206)', () => {
  it('gives every role the status line; only the owner may manage, the rest are told whom to ask', async () => {
    const mine = ok(await call(t, `/api/v1/ai/status?locationId=${home.id}`, { as: ibrahim }));
    expect(mine).toMatchObject({
      resolved: true,
      source: 'account',
      providerKind: 'groq',
      model: RECOMMENDED.model,
      canManage: true,
      manager: null,
    });
    const viewer = ok(await call(t, `/api/v1/ai/status?locationId=${home.id}`, { as: talia }));
    expect(viewer).toMatchObject({
      resolved: true,
      canManage: false,
      canResume: false,
      manager: { displayName: 'Ibrahim' },
    });
    expect(JSON.stringify(viewer)).not.toContain(KEY_MARKER);
    expect(
      (await call(t, `/api/v1/ai/status?locationId=${home.id}`, { as: alfred })).statusCode,
    ).toBe(404);
    expect(ok(await call(t, '/api/v1/ai/status', { as: alfred })).resolved).toBe(false);
  });

  // catalogue: PUT /api/v1/ai/caps
  it('lets the owner set account, location and member caps; a location cap above the account’s is refused', async () => {
    const account = ok(
      await putCap(ibrahim, { scope: 'account', monthlyCap: { amount: '5', currency: 'USD' } }),
    );
    expect(account).toMatchObject({
      scope: 'account',
      monthlyCap: { amount: '5', currency: 'USD' },
      state: 'active',
      canEdit: true,
    });
    const above = await putCap(ibrahim, {
      scope: 'location',
      locationId: home.id,
      monthlyCap: { amount: '9', currency: 'USD' },
    });
    expect(above.statusCode).toBe(400);
    expect(above.json()).toMatchObject({ code: 'cap_above_account' });
    const location = ok(
      await putCap(ibrahim, {
        scope: 'location',
        locationId: home.id,
        monthlyCap: { amount: '3', currency: 'USD' },
      }),
    );
    expect(location).toMatchObject({ scope: 'location', target: { id: home.id, label: 'Home' } });
    const member = ok(
      await putCap(ibrahim, { scope: 'member', userId: louis.userId, tokensPerMonth: 1_000_000 }),
    );
    expect(member).toMatchObject({
      scope: 'member',
      target: { id: louis.userId, label: 'Louis' },
      tokensPerMonth: 1_000_000,
    });
    const events = await auditRows('ai.cap_set');
    expect(events.some((e) => e.location_id === home.id && e.actor_id === ibrahim.userId)).toBe(
      true,
    );
    const nope = await putCap(ibrahim, {
      scope: 'account',
      monthlyCap: { amount: '5', currency: 'XYZ' },
    });
    expect(nope.json()).toMatchObject({ code: 'currency_not_enabled' });
  });

  it('lets an admin read the location cap but not write it; a member sees only their own cap', async () => {
    const admin = ok(
      await call(t, `/api/v1/ai/caps?scope=location&locationId=${home.id}`, { as: bruce }),
    );
    expect((admin.caps as Json[]).map((c) => [c.scope, c.canEdit])).toEqual([['location', false]]);
    expect(
      (
        await putCap(bruce, {
          scope: 'location',
          locationId: home.id,
          monthlyCap: { amount: '1', currency: 'USD' },
        })
      ).statusCode,
    ).toBe(404);
    const member = ok(await call(t, `/api/v1/ai/caps?scope=me`, { as: louis }));
    expect((member.caps as Json[]).map((c) => c.scope)).toEqual(['member']);
    const other = ok(
      await call(t, `/api/v1/ai/caps?scope=location&locationId=${home.id}`, { as: talia }),
    );
    expect(other.caps).toEqual([]);
    expect(
      (await call(t, `/api/v1/ai/caps?scope=location&locationId=${home.id}`, { as: alfred }))
        .statusCode,
    ).toBe(404);
  });

  // catalogue: POST /api/v1/ai/pause
  it('pauses by hand: the status line says so, and the owner may resume', async () => {
    const paused = ok(
      await call(t, '/api/v1/ai/pause', {
        as: ibrahim,
        body: { scope: 'location', locationId: home.id },
      }),
    );
    expect(paused).toMatchObject({ state: 'paused', reason: 'manual', pausedUntil: 'infinity' });
    expect((await auditRows('ai.pause')).at(-1)?.location_id).toBe(home.id);
    const status = ok(await call(t, `/api/v1/ai/status?locationId=${home.id}`, { as: louis }));
    expect(status).toMatchObject({
      pausedUntil: 'infinity',
      reason: 'manual',
      pausedBy: { scope: 'location', label: 'Home' },
      canResume: false,
    });
    const owner = ok(await call(t, `/api/v1/ai/status?locationId=${home.id}`, { as: ibrahim }));
    expect(owner.canResume).toBe(true);
    expect(
      (
        await call(t, '/api/v1/ai/pause', {
          as: louis,
          body: { scope: 'location', locationId: home.id },
        })
      ).statusCode,
    ).toBe(404);
  });

  // catalogue: POST /api/v1/ai/caps/:id/resume
  it('resumes: a non-writer gets 404; the owner resumes and the paused extractions go again, oldest first', async () => {
    const [cap] = await own<{ id: string }>(
      db,
      `SELECT id FROM public.ai_budgets WHERE scope = 'location' AND location_id = $1`,
      [home.id],
    );
    const capId = cap?.id as string;
    // Two paused extractions of a photo in Home.
    const thing = newId();
    const ids: string[] = [];
    await own(
      db,
      `INSERT INTO public.things (id, location_id, place_id, name)
       SELECT $1, $2, p.id, 'Drill' FROM public.places p WHERE p.location_id = $2 AND p.is_unplaced`,
      [thing, home.id],
    );
    for (const attempt of [1, 2]) {
      const file = newId();
      await own(
        db,
        `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                   derivative_state, created_by)
         VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
        [file, home.id, `f/${home.id}/${file}`, randomBytes(32).toString('hex'), louis.userId],
      );
      const [att] = await own<{ id: string }>(
        db,
        `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
         VALUES ($1, $2, $3, 'photo', $4) RETURNING id`,
        [home.id, file, thing, louis.userId],
      );
      const id = newId();
      ids.push(id);
      await own(
        db,
        `INSERT INTO public.extractions (id, location_id, attachment_id, thing_id, mode, attempt,
                                         status, status_reason, paused_until, requested_by)
         VALUES ($1, $2, $3, $4, 'thing', $5, 'paused_budget', 'manual', 'infinity', $6)`,
        [id, home.id, att?.id, thing, attempt, louis.userId],
      );
    }
    expect(
      (await call(t, `/api/v1/ai/caps/${capId}/resume`, { as: bruce, body: {} })).statusCode,
    ).toBe(404);
    const out = ok(await call(t, `/api/v1/ai/caps/${capId}/resume`, { as: ibrahim, body: {} }));
    expect(out).toMatchObject({ cap: { state: 'active' }, resumed: 2 });
    expect(sent.filter((j) => j.name === 'extract').map((j) => j.data)).toEqual(
      ids.map((extractionId) => ({ extractionId })),
    );
    expect((await auditRows('ai.resume')).at(-1)?.actor_id).toBe(ibrahim.userId);
    const status = ok(await call(t, `/api/v1/ai/status?locationId=${home.id}`, { as: louis }));
    expect(status.pausedUntil).toBeNull();
  });

  // catalogue: DELETE /api/v1/ai/caps/:id
  it('clears a cap (the owner only), audited', async () => {
    const member = (
      ok(await call(t, '/api/v1/ai/caps?scope=account', { as: ibrahim })).caps as Json[]
    ).find((c) => c.scope === 'member') as Json;
    expect(
      (await call(t, `/api/v1/ai/caps/${member.id}`, { as: louis, method: 'DELETE' })).statusCode,
    ).toBe(404);
    gone(await call(t, `/api/v1/ai/caps/${member.id}`, { as: ibrahim, method: 'DELETE' }));
    expect((await auditRows('ai.cap_clear')).at(-1)?.actor_id).toBe(ibrahim.userId);
  });
});

// ---------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------

const priceBody = {
  providerKind: 'groq',
  model: RECOMMENDED.model,
  inputPerMtok: '0.1',
  outputPerMtok: '0.3',
  currency: 'USD',
};

describe('the price table (D167, D206)', () => {
  // catalogue: POST /api/v1/admin/ai/prices
  it('is the instance admin’s: versioned, the old one superseded, read by everyone', async () => {
    expect(
      (await call(t, '/api/v1/admin/ai/prices', { as: louis, body: priceBody })).statusCode,
    ).toBe(403);
    // Version 1 is the listing's, saved with the recommended model's key (priceRecommended).
    const sets = (await auditRows('ai.price_set')).length;
    const v2 = ok(await call(t, '/api/v1/admin/ai/prices', { as: ibrahim, body: priceBody }), 201);
    const v3 = ok(
      await call(t, '/api/v1/admin/ai/prices', {
        as: ibrahim,
        body: { ...priceBody, outputPerMtok: '0.35' },
      }),
      201,
    );
    expect([v2.version, v3.version]).toEqual([2, 3]);
    expect(v3.source).toBe('admin');
    const current = ok(await call(t, '/api/v1/ai/prices', { as: talia }));
    expect((current.prices as Json[]).map((p) => p.version)).toEqual([3]);
    const all = ok(await call(t, '/api/v1/ai/prices?history=1', { as: talia }));
    expect((all.prices as Json[]).map((p) => [p.version, p.supersededAt === null])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
    expect((await auditRows('ai.price_set')).length).toBe(sets + 2);
  });

  // catalogue: POST /api/v1/admin/ai/prices/prefill
  it('prefills from the cached listing without saving anything', async () => {
    const key = await accountKey();
    const before = ok(await call(t, '/api/v1/ai/prices?history=1', { as: ibrahim }));
    const out = ok(
      await call(t, '/api/v1/admin/ai/prices/prefill', {
        as: ibrahim,
        body: { providerId: key.id },
      }),
    );
    expect(out.prices).toEqual([
      expect.objectContaining({
        providerKind: 'groq',
        model: RECOMMENDED.model,
        inputPerMtok: '0.1',
        outputPerMtok: '0.3',
        currency: 'USD',
      }),
    ]);
    expect(ok(await call(t, '/api/v1/ai/prices?history=1', { as: ibrahim }))).toEqual(before);
    expect((await auditRows('ai.price_prefill')).at(-1)?.actor_id).toBe(ibrahim.userId);
    expect(
      (
        await call(t, '/api/v1/admin/ai/prices/prefill', {
          as: louis,
          body: { providerId: key.id },
        })
      ).statusCode,
    ).toBe(403);
  });

  // catalogue: POST /api/v1/admin/ai/prices/recost
  it('costs this month’s unknown calls late, audited', async () => {
    await ledgerRow({ cost: null, model: 'priced-later' });
    ok(
      await call(t, '/api/v1/admin/ai/prices', {
        as: ibrahim,
        body: { ...priceBody, model: 'priced-later' },
      }),
      201,
    );
    const out = ok(
      await call(t, '/api/v1/admin/ai/prices/recost', {
        as: ibrahim,
        body: { providerKind: 'groq', model: 'priced-later', since: '2020-01-01' },
      }),
    );
    expect(out.recosted).toBe(1);
    expect((await auditRows('ai.price_recost')).at(-1)?.diff).toMatchObject({
      recosted: { after: 1 },
    });
  });

  // catalogue: DELETE /api/v1/admin/ai/prices/:providerKind/:model
  it('removes a price: no price from now, audited; a model with a slash in its id works', async () => {
    gone(
      await call(t, `/api/v1/admin/ai/prices/groq/${encodeURIComponent('priced-later')}`, {
        as: ibrahim,
        method: 'DELETE',
      }),
    );
    expect(
      (
        await call(t, `/api/v1/admin/ai/prices/groq/priced-later`, {
          as: ibrahim,
          method: 'DELETE',
        })
      ).statusCode,
    ).toBe(404);
    expect((await auditRows('ai.price_remove')).length).toBe(1);
    const slash = encodeURIComponent(RECOMMENDED.model);
    expect(
      (await call(t, `/api/v1/admin/ai/prices/groq/${slash}`, { as: louis, method: 'DELETE' }))
        .statusCode,
    ).toBe(403);
  });

  it('prices the recommended model at Groq’s recorded listing when a key is saved with no price and no listing price', async () => {
    const slash = encodeURIComponent(RECOMMENDED.model);
    await call(t, `/api/v1/admin/ai/prices/groq/${slash}`, { as: ibrahim, method: 'DELETE' });
    const key = await accountKey();
    // The cached listing has lost its prices: nothing to take from it.
    await own(
      db,
      `UPDATE public.ai_providers
          SET model_list = (SELECT jsonb_agg(m - 'pricing') FROM jsonb_array_elements(model_list) m)
        WHERE id = $1`,
      [key.id],
    );
    const unpriced = await ledgerRow({ cost: null, model: RECOMMENDED.model });
    // Louis's own key is no instance admin's: it sets no price.
    const his = ok(await put(louis, 'me', { apiKey: groqKey('Lu88') }));
    expect(ok(await call(t, '/api/v1/ai/prices', { as: louis })).prices).toEqual([]);
    gone(await call(t, `/api/v1/ai/providers/${his.id}`, { as: louis, method: 'DELETE' }));
    const now = await accountKey();
    ok(await put(ibrahim, 'account', { reasoning: 'low' }, now.rowVersion as number));
    const [price] = ok(await call(t, '/api/v1/ai/prices', { as: louis })).prices as Json[];
    expect(price).toMatchObject({
      providerKind: RECOMMENDED_PRICE.kind,
      model: RECOMMENDED_PRICE.model,
      rates: {
        inputPerMtok: RECOMMENDED_PRICE.inputPerMtok,
        outputPerMtok: RECOMMENDED_PRICE.outputPerMtok,
        cachedInputPerMtok: RECOMMENDED_PRICE.cachedInputPerMtok,
      },
      currency: 'USD',
      source: 'provider_listing',
      listingFetchedAt: RECOMMENDED_PRICE.listingFetchedAt,
    });
    // This month's unpriced call of it is costed now (D206's price_table_later).
    const [costed] = await own<{ cost_source: string; cost_amount: string | null }>(
      db,
      'SELECT cost_source, cost_amount::text FROM public.llm_calls WHERE id = $1',
      [unpriced],
    );
    expect(costed?.cost_source).toBe('price_table_later');
    expect(costed?.cost_amount).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Usage, the call list and the CSV
// ---------------------------------------------------------------------------------------------

type Call = Json & {
  person?: unknown;
  cost?: Json;
  moneyHidden?: true;
  links: Json;
  location?: Json;
};
const list = async (as: Person, qs: string) =>
  ok(await call(t, `/api/v1/ai/calls?${qs}`, { as })) as Json & {
    items: Call[];
    next_cursor: string | null;
  };

describe('usage and the call list (L47, D205, D206)', () => {
  const marks: Record<string, string> = {};

  beforeAll(async () => {
    await own(db, 'DELETE FROM public.llm_calls');
    const thread = newId();
    marks.louis = await ledgerRow({ userId: louis.userId, requestId: 'req-louis' });
    marks.retry = await ledgerRow({
      userId: louis.userId,
      requestId: 'req-louis',
      attempt: 2,
      outcome: 'timeout',
      cost: null,
    });
    marks.talia = await ledgerRow({
      userId: talia.userId,
      task: 'assistant_turn',
      images: 0,
      threadId: thread,
      tokens: [300, 100],
      cost: '0.0002',
    });
    marks.background = await ledgerRow({
      userId: null,
      task: 'embed_thing',
      images: 0,
      tokens: [20, 0],
      cost: '0.00001',
    });
    marks.held = await ledgerRow({ userId: louis.userId, outcome: 'over_budget' });
    marks.instance = await ledgerRow({
      userId: louis.userId,
      paying: 'instance',
      model: '=cmd|evil',
    });
    marks.family = await ledgerRow({ location: family, userId: alfred.userId });
  });

  it('shows each person their own calls; a viewer’s cost stays hidden where Home hides money', async () => {
    const mine = await list(talia, 'scope=me');
    expect(mine.items.map((c) => c.id)).toEqual([marks.talia]);
    const [row] = mine.items;
    expect(row?.cost).toBeUndefined();
    expect(row?.moneyHidden).toBe(true);
    expect(row?.tokens).toMatchObject({ input: 300, output: 100 });
    // Her own thread's link is hers.
    expect(row?.links.threadId).toBeDefined();
    const louisOwn = await list(louis, 'scope=me');
    expect(louisOwn.items.map((c) => c.id).sort()).toEqual(
      [marks.louis, marks.retry, marks.held, marks.instance].sort(),
    );
  });

  it('shows an admin every call in the location, without another person’s thread link', async () => {
    const all = await list(bruce, `scope=location&locationId=${home.id}`);
    expect(all.items.map((c) => c.id).sort()).toEqual(
      [marks.louis, marks.retry, marks.talia, marks.background, marks.held, marks.instance].sort(),
    );
    const talias = all.items.find((c) => c.id === marks.talia) as Call;
    expect(talias.links.threadId).toBeUndefined();
    expect(all.items.find((c) => c.id === marks.background)?.person).toBe('background');
    expect(
      (await call(t, `/api/v1/ai/calls?scope=location&locationId=${home.id}`, { as: louis }))
        .statusCode,
    ).toBe(404);
  });

  it('shows the owner the account’s calls with their cost; the instance admin sees instance-paid calls with no location', async () => {
    const acct = await list(ibrahim, 'scope=account');
    expect(acct.items.some((c) => c.id === marks.family)).toBe(false);
    const louisCall = acct.items.find((c) => c.id === marks.louis) as Call;
    expect(louisCall.cost).toMatchObject({ amount: '0.0039', currency: 'USD', source: 'provider' });
    expect(louisCall.paidBy).toMatchObject({ scope: 'account', label: 'Ibrahim' });
    expect(louisCall.location).toEqual({ id: home.id, name: 'Home' });
    const inst = await list(ibrahim, 'scope=instance');
    expect(inst.items.map((c) => c.id)).toEqual([marks.instance]);
    expect(inst.items[0]?.location).toBeUndefined();
    expect(inst.items[0]?.links).toEqual({});
    expect((await call(t, '/api/v1/ai/calls?scope=instance', { as: louis })).statusCode).toBe(404);
  });

  it('filters in the D205 URL form: repeated values, not, dir, ranges and background', async () => {
    const q = `scope=location&locationId=${home.id}`;
    const tasks = await list(bruce, `${q}&task=extract_thing&not=task`);
    expect(tasks.items.map((c) => c.task).sort()).toEqual(['assistant_turn', 'embed_thing']);
    const bg = await list(bruce, `${q}&person=background`);
    expect(bg.items.map((c) => c.id)).toEqual([marks.background]);
    const many = await list(bruce, `${q}&outcome=timeout&outcome=over_budget`);
    expect(many.items.map((c) => c.id).sort()).toEqual([marks.retry, marks.held].sort());
    const small = await list(bruce, `${q}&tokens=..500`);
    expect(small.items.map((c) => c.id).sort()).toEqual(
      [marks.talia, marks.background, marks.held].sort(),
    );
    const images = await list(bruce, `${q}&hasImage=true&outcome=ok`);
    expect(images.items.every((c) => ((c.images as Json).count as number) > 0)).toBe(true);
    const asc = await list(bruce, `${q}&dir=asc&limit=2`);
    expect(asc.items.map((c) => c.id)).toEqual([marks.louis, marks.retry]);
    const next = await list(bruce, `${q}&dir=asc&limit=2&cursor=${asc.next_cursor}`);
    expect(next.items[0]?.id).toBe(marks.talia);
    const today = await list(bruce, `${q}&at=today`);
    expect(today.items.length).toBe(6);
    const byRequest = await list(bruce, `${q}&q=req-louis`);
    expect(byRequest.items.length).toBe(2);
  });

  it('gives a call’s detail with its other attempts', async () => {
    const d = ok(await call(t, `/api/v1/ai/calls/${marks.louis}`, { as: louis }));
    expect((d.attempts as Json[]).map((a) => a.id)).toEqual([marks.retry]);
    expect((await call(t, `/api/v1/ai/calls/${marks.family}`, { as: louis })).statusCode).toBe(404);
    const inst = ok(await call(t, `/api/v1/ai/calls/${marks.instance}`, { as: ibrahim }));
    expect(inst.id).toBe(marks.instance);
  });

  it('exports the list as CSV: the same rows, formulas defused, money dropped where hidden, audited, 5 an hour', async () => {
    const q = `scope=location&locationId=${home.id}`;
    const res = await call(t, `/api/v1/ai/calls.csv?${q}`, { as: bruce });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    const lines = res.body.trim().split('\r\n');
    const shown = await list(bruce, q);
    expect(lines.length - 1).toBe(shown.items.length);
    expect(lines[0]).toContain('cost,currency,cost_source');
    expect(res.body).toContain(`'=cmd|evil`);
    expect(res.body).not.toContain(KEY_MARKER);
    const events = await auditRows('ai.usage_export');
    expect(events.at(-1)).toMatchObject({ actor_id: bruce.userId, location_id: home.id });
    const viewer = await call(t, '/api/v1/ai/calls.csv?scope=me', { as: talia });
    expect(viewer.body.split('\r\n')[0]).not.toContain('cost');
    for (let i = 0; i < 4; i++) await call(t, '/api/v1/ai/calls.csv?scope=me', { as: talia });
    expect((await call(t, '/api/v1/ai/calls.csv?scope=me', { as: talia })).statusCode).toBe(429);
    // The shared writer (D169): a BOM first, and a leading tab or carriage return defused too.
    expect(res.body.startsWith(CSV_BOM)).toBe(true);
    expect(safeCsvCell('+1')).toBe(`'+1`);
    expect(safeCsvCell('\tcmd')).toBe(`'\tcmd`);
    expect(safeCsvCell('a,"b"')).toBe('"a,""b"""');
  });

  it('totals usage per scope and group, with tasks per day, and 404 for a scope you cannot read', async () => {
    const u = ok(
      await call(t, `/api/v1/ai/usage?scope=location&locationId=${home.id}&groupBy=task`, {
        as: bruce,
      }),
    );
    expect(u.soFar).toBe(true);
    const totals = u.totals as Json;
    expect(totals.calls).toBe(6);
    expect(totals.unknownCostCalls).toBe(1);
    expect((u.groups as Json[]).map((g) => g.key).sort()).toEqual([
      'assistant_turn',
      'embed_thing',
      'extract_thing',
    ]);
    const days = ok(await call(t, `/api/v1/ai/usage?scope=me&groupBy=day`, { as: louis }));
    const [day] = days.groups as Json[];
    expect(((day as Json).tasks as Json).extraction).toMatchObject({ calls: 4 });
    expect(
      (await call(t, `/api/v1/ai/usage?scope=location&locationId=${home.id}`, { as: talia }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(t, '/api/v1/ai/usage?scope=me&groupBy=account', { as: louis })).statusCode,
    ).toBe(400);
  });

  it('explains what uses AI: reference figures under five calls of a task, the scope’s own from five', async () => {
    const before = ok(await call(t, '/api/v1/ai/explain?scope=account', { as: ibrahim }));
    const thing = (before.actions as Json[]).find((a) => a.task === 'extract_thing') as Json;
    expect(thing).toMatchObject({ basis: 'reference', referenceDate: '2026-09-26' });
    for (let i = 0; i < 3; i++)
      await ledgerRow({ userId: louis.userId, tokens: [1000, 200], cost: '0.002' });
    const after = ok(await call(t, '/api/v1/ai/explain?scope=account', { as: ibrahim }));
    const mine = (after.actions as Json[]).find((a) => a.task === 'extract_thing') as Json;
    expect(mine).toMatchObject({ basis: 'history', callsPerAction: 1 });
    expect((after.projection as Json).calls).toBeGreaterThan(0);
    // A member reads the panel for Home from their own history.
    ok(await call(t, `/api/v1/ai/explain?scope=location&locationId=${home.id}`, { as: louis }));
  });
});

// ---------------------------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------------------------

describe('cap notices and the rejected-key alert (D166, D206)', () => {
  const deps = () => ({
    pools: db.pools,
    mailer: {
      send: async (m: Mail) => {
        mails.push(m);
      },
    },
    log: { info: () => {}, error: () => {} },
  });

  it('mails whoever set a location cap and its owner and admins, once per crossing', async () => {
    const [cap] = await own<{ id: string }>(
      db,
      `SELECT id FROM public.ai_budgets WHERE scope = 'location' AND location_id = $1`,
      [home.id],
    );
    const told = await runAiNotice(deps(), {
      kind: 'cap',
      budgetId: cap?.id,
      level: 80,
      month: '2026-09-01',
    });
    expect(told).toBe(2);
    expect(mails.map((m) => m.to).sort()).toEqual([ibrahim.email, bruce.email].sort());
    expect(mails[0]).toMatchObject({
      kind: 'ai-cap',
      level: 80,
      cap: { scope: 'location', target: 'Home', unit: 'money', limit: '3', currency: 'USD' },
    });
    // A payload naming nothing real does nothing.
    expect(
      await runAiNotice(deps(), { kind: 'cap', budgetId: newId(), level: 80, month: '2026-09-01' }),
    ).toBe(0);
    expect(await runAiNotice(deps(), { kind: 'nonsense' })).toBe(0);
  });

  it('leaves each person it mails one ai_cap notification in the centre, however often it runs (T16)', async () => {
    const [cap] = await own<{ id: string }>(
      db,
      `SELECT id FROM public.ai_budgets WHERE scope = 'location' AND location_id = $1`,
      [home.id],
    );
    const data = { kind: 'cap', budgetId: cap?.id, level: 80, month: '2026-09-01' };
    await runAiNotice(deps(), data);
    await runAiNotice(deps(), data);
    const notices = await own<{ user_id: string; location_id: string | null; payload: object }>(
      db,
      `SELECT user_id, location_id, payload FROM public.notifications WHERE kind = 'ai_cap'
        ORDER BY user_id`,
    );
    expect(notices.map((n) => n.user_id)).toEqual([ibrahim.userId, bruce.userId].sort());
    expect(notices[0]).toMatchObject({
      location_id: null,
      payload: { budgetId: cap?.id, level: 80, month: '2026-09-01', scope: 'location' },
    });
    // The 100% crossing is its own notice.
    await runAiNotice(deps(), { ...data, level: 100 });
    expect(await own(db, `SELECT 1 FROM public.notifications WHERE kind = 'ai_cap'`)).toHaveLength(
      4,
    );
  });

  it('raises the admin alert for an instance cap, and for a rejected instance key only when it is one', async () => {
    ok(await putCap(ibrahim, { scope: 'instance', tokensPerMonth: 5_000_000 }));
    const [cap] = await own<{ id: string }>(
      db,
      `SELECT id FROM public.ai_budgets WHERE scope = 'instance' AND task IS NULL`,
    );
    await runAiNotice(deps(), { kind: 'cap', budgetId: cap?.id, level: 100, month: '2026-09-01' });
    const alerts = async () =>
      await own<{ kind: string; resolved_at: Date | null }>(
        db,
        `SELECT kind, resolved_at FROM public.admin_alerts WHERE kind LIKE 'ai_%'`,
      );
    expect((await alerts()).map((a) => a.kind)).toContain('ai_instance_cap_reached');
    // Home's account key is not the instance's: no alert.
    const acct = await accountKey();
    await own(
      db,
      `INSERT INTO public.ai_breakers (provider_id, reason, until) VALUES ($1, 'auth', 'infinity')
     ON CONFLICT (provider_id) DO UPDATE SET reason = 'auth', until = 'infinity'`,
      [acct.id],
    );
    expect(await runAiNotice(deps(), { kind: 'key_rejected', providerId: acct.id })).toBe(0);
    await own(
      db,
      'UPDATE public.ai_breakers SET reason = NULL, until = NULL WHERE provider_id = $1',
      [acct.id],
    );
    // The instance's key, rejected: the alert; a new key resolves it.
    const inst = ok(await put(ibrahim, 'instance', { apiKey: groqKey('In44') }));
    await own(
      db,
      `INSERT INTO public.ai_breakers (provider_id, reason, until) VALUES ($1, 'auth', 'infinity')
     ON CONFLICT (provider_id) DO UPDATE SET reason = 'auth', until = 'infinity'`,
      [inst.id],
    );
    expect(await runAiNotice(deps(), { kind: 'key_rejected', providerId: inst.id })).toBe(1);
    expect(
      (await alerts()).find((a) => a.kind === 'ai_instance_key_rejected')?.resolved_at,
    ).toBeNull();
    ok(await put(ibrahim, 'instance', { apiKey: groqKey('In55') }, inst.rowVersion as number));
    expect(
      (await alerts()).find((a) => a.kind === 'ai_instance_key_rejected')?.resolved_at,
    ).not.toBeNull();
    gone(await call(t, `/api/v1/ai/providers/${inst.id}`, { as: ibrahim, method: 'DELETE' }));
  });

  it('queues the notice job from the runtime hook', async () => {
    const hooks = aiNoticeHooks(db.pools, {
      send: async (_c, name, data) => {
        sent.push({ name, data });
      },
      sendTenant: async () => {},
    });
    await hooks.onCrossed({
      budgetId: newId(),
      bucket: 'location:x',
      level: 80,
      month: '2026-09-01',
    });
    expect(sent.map((j) => j.name)).toEqual(['ai-notice']);
  });
});

// ---------------------------------------------------------------------------------------------
// Keys never leak; another household is nothing
// ---------------------------------------------------------------------------------------------

/** The status and body a request answered with, for the equal-answers checks. */
const answer = (res: LightMyRequestResponse) => ({ status: res.statusCode, body: res.body });

describe('leak: the AI routes answer another household exactly as nothing', () => {
  it('no key, in any column of any table', async () => {
    const tables = await own<{ table_name: string }>(
      db,
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    for (const { table_name } of tables) {
      const [hit] = await own<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM public."${table_name}" x WHERE row_to_json(x)::text LIKE $1`,
        [`%${KEY_MARKER}%`],
      );
      expect(hit?.n, table_name).toBe(0);
    }
  });

  it("treats Home's ids like random ids on every AI route, for Alfred", async () => {
    const key = await accountKey();
    const [cap] = await own<{ id: string }>(
      db,
      `SELECT id FROM public.ai_budgets WHERE scope = 'location' AND location_id = $1`,
      [home.id],
    );
    const [row] = await own<{ id: string }>(
      db,
      `SELECT id FROM public.llm_calls WHERE location_id = $1 LIMIT 1`,
      [home.id],
    );
    const pairs: [string, string, 'GET' | 'POST' | 'DELETE', object?][] = [
      [`/api/v1/ai/status?locationId=${home.id}`, `/api/v1/ai/status?locationId=${newId()}`, 'GET'],
      [`/api/v1/ai/providers/${key.id}/models`, `/api/v1/ai/providers/${newId()}/models`, 'GET'],
      [`/api/v1/ai/providers/${key.id}/test`, `/api/v1/ai/providers/${newId()}/test`, 'POST', {}],
      [`/api/v1/ai/providers/${key.id}`, `/api/v1/ai/providers/${newId()}`, 'DELETE'],
      [`/api/v1/ai/caps/${cap?.id}`, `/api/v1/ai/caps/${newId()}`, 'DELETE'],
      [`/api/v1/ai/caps/${cap?.id}/resume`, `/api/v1/ai/caps/${newId()}/resume`, 'POST', {}],
      [`/api/v1/ai/calls/${row?.id}`, `/api/v1/ai/calls/${newId()}`, 'GET'],
      [
        `/api/v1/ai/caps?scope=location&locationId=${home.id}`,
        `/api/v1/ai/caps?scope=location&locationId=${newId()}`,
        'GET',
      ],
      [
        `/api/v1/ai/usage?scope=location&locationId=${home.id}`,
        `/api/v1/ai/usage?scope=location&locationId=${newId()}`,
        'GET',
      ],
      [
        `/api/v1/ai/calls?scope=location&locationId=${home.id}`,
        `/api/v1/ai/calls?scope=location&locationId=${newId()}`,
        'GET',
      ],
      [
        `/api/v1/ai/calls.csv?scope=location&locationId=${home.id}`,
        `/api/v1/ai/calls.csv?scope=location&locationId=${newId()}`,
        'GET',
      ],
      [
        `/api/v1/ai/explain?scope=location&locationId=${home.id}`,
        `/api/v1/ai/explain?scope=location&locationId=${newId()}`,
        'GET',
      ],
    ];
    for (const [theirs, random, method, body] of pairs) {
      const opts = { as: alfred, method, ...(body ? { body } : {}) };
      const a = await call(t, theirs, opts);
      const b = await call(t, random, opts);
      expect(answer(a), theirs).toEqual(answer(b));
      expect(a.statusCode, theirs).toBe(404);
    }
    // Nothing of Home's in his own lists.
    for (const url of [
      '/api/v1/ai/calls?scope=me',
      '/api/v1/ai/calls?scope=account',
      '/api/v1/ai/providers',
      '/api/v1/ai/caps?scope=account',
      '/api/v1/ai/usage?scope=account',
    ]) {
      const res = await call(t, url, { as: alfred });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain(home.id);
      expect(res.body, url).not.toContain(home.accountId);
    }
    // His pause of Home, and a cap on Home.
    expect(
      (
        await call(t, '/api/v1/ai/pause', {
          as: alfred,
          body: { scope: 'location', locationId: home.id },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await putCap(alfred, { scope: 'location', locationId: home.id, tokensPerMonth: 5 }))
        .statusCode,
    ).toBe(404);
  });
});

describe('the module wiring (D191)', () => {
  it('turns AI capture on in a location once a provider resolves, and off with its toggle', async () => {
    await acknowledgeKit();
    const view = async () => ok(await call(t, `/api/v1/locations/${family.id}`, { as: alfred }));
    const before = await view();
    expect(before.providerResolved).toBe(false);
    expect(before.effectiveModules).not.toContain('ai_capture');
    ok(await put(alfred, 'account', { apiKey: groqKey('Af66') }));
    const on = await view();
    expect(on.providerResolved).toBe(true);
    expect(on.effectiveModules).toContain('ai_capture');
    await own(
      db,
      `INSERT INTO public.location_modules (location_id, module, enabled)
       VALUES ($1, 'ai_capture', false)
       ON CONFLICT (location_id, module) DO UPDATE SET enabled = false`,
      [family.id],
    );
    expect((await view()).effectiveModules).not.toContain('ai_capture');
  });
});
