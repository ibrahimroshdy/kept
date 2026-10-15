import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { TOOL_DEFS } from '@kept/mcp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { FIXTURES, type TestFiles, testFiles } from '../../test/files.js';
import { FakePaperless } from '../../test/paperless-fake.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  createLocation,
  createThing,
  type Json,
  type Loc,
  ok,
  own,
  place,
} from '../../test/things.js';
import { limiterKey } from '../auth/sign-in-limiter.js';
import type { Keyring, MasterKey } from '../crypto/envelope.js';
import { fixedSecretKeys } from '../crypto/keyring.js';
import { runTool } from '../tools/context.js';
import { PaperlessClient, PaperlessError } from './client.js';
import { paperlessRoot, paperlessToken } from './config.js';
import { kindOf } from './kinds.js';

// Paperless-ngx (1.x, D248) through the front door: a location's admins connect it (the token
// sealed, never answered, logged or audited); members search it through Kept, link documents to a
// thing or a place (Kept caches what Paperless says, not what the browser sent), see thumbnails
// re-encoded and access-checked, download, copy a document into Kept, and unlink; viewers see the
// links but no money; tokens read links only. Paperless is a stand-in on 127.0.0.1
// (test/paperless-fake.ts) answering as Paperless-ngx 3.3.1 did when recorded.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let fake: FakePaperless;
const master: MasterKey = { key: randomBytes(32), keyVersion: 1 };
const keyring = new Map([[1, master.key]]) as Keyring;
let ibrahim: Person; // owns Home
let bruce: Person; // admin of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let alfred: Person; // owns Lake house; nothing in Home
let home: Loc;
let lake: Loc;
let drill: Json;

const paperless = (as: Person, loc = home) =>
  call(t, `/api/v1/locations/${loc.id}/paperless`, { as });
const connect = (as: Person, over: Record<string, unknown> = {}, loc = home) =>
  call(t, `/api/v1/locations/${loc.id}/paperless`, {
    as,
    method: 'PUT',
    body: { url: fake.url, token: fake.token, ...over },
  });
const link = (as: Person, body: Record<string, unknown>) =>
  call(t, '/api/v1/paperless-links', { as, body });
const linksOf = (as: Person, q: string) => call(t, `/api/v1/paperless-links?${q}`, { as });
/** When the running test began: each one reads its own audit events. */
let since = new Date();
const audit = (types: string[]) =>
  own<{ action: string; diff: unknown; entity_id: string }>(
    db,
    `SELECT action, diff, entity_id FROM public.audit_events
      WHERE entity_type = ANY ($1) AND at >= $2 ORDER BY at, id`,
    [types, since],
  );

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  fake = new FakePaperless();
  await fake.start();
  // https: a personal token is made only over https (the token test needs one).
  t = await peopleApp(db, {
    publicUrl: 'https://kept.example',
    files,
    secretKeys: fixedSecretKeys({ current: master, keyring }),
  });
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  home = await createLocation(t, db, ibrahim, 'complete');
  lake = await createLocation(t, db, alfred, 'complete', 'Lake house');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  // The stand-in is on 127.0.0.1: the admin's switch for private addresses, as on a LAN.
  await own(
    db,
    `INSERT INTO public.instance_settings (key, value) VALUES ('ssrf_allow_private', 'true')
     ON CONFLICT (key) DO UPDATE SET value = 'true'`,
  );
  drill = await createThing(t, ibrahim, home, { name: 'Drill' });
});

beforeEach(async () => {
  since = new Date();
  fake.down = false;
  fake.token = 'f'.repeat(40);
  await own(db, 'DELETE FROM public.paperless_connections');
  await db.pools.auth.query('DELETE FROM auth.sign_in_failures WHERE key = ANY ($1)', [
    [ibrahim, bruce, louis, talia, alfred].flatMap((p) => [
      limiterKey('paperless-check', p.userId),
      limiterKey('paperless-search', p.userId),
    ]),
  ]);
});

afterAll(async () => {
  await t.app.close();
  await fake.stop();
  await files.cleanup();
});

describe('the Paperless client', () => {
  it('asks for API version 9 with the token, and reads the version from X-Version', async () => {
    const client = new PaperlessClient(
      { baseUrl: fake.url, token: fake.token },
      { allowPrivate: true },
    );
    expect(await client.ping()).toEqual({ version: '3.3.1' });
    const sent = fake.requests.at(-1);
    expect(sent?.path).toBe('/api/documents/');
    expect(sent?.headers.accept).toBe('application/json; version=9');
    expect(sent?.headers.authorization).toBe(`Token ${fake.token}`);
  });

  it('says why a call failed: a refused token, an old server, a private or plain-http address', async () => {
    const reason = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (e) {
        return e instanceof PaperlessError ? e.reason : String(e);
      }
    };
    const bad = new PaperlessClient({ baseUrl: fake.url, token: 'nope' }, { allowPrivate: true });
    expect(await reason(bad.ping())).toBe('auth_failed');
    fake.versions = ['10'];
    const good = new PaperlessClient(
      { baseUrl: fake.url, token: fake.token },
      { allowPrivate: true },
    );
    expect(await reason(good.ping())).toBe('too_old');
    fake.versions = ['9', '10'];
    const guarded = new PaperlessClient(
      { baseUrl: fake.url, token: fake.token },
      { allowPrivate: false },
    );
    expect(await reason(guarded.ping())).toBe('private_address');
    // Plain http to an address on the internet: refused before a byte is sent.
    const before = fake.requests.length;
    const publicHttp = new PaperlessClient(
      { baseUrl: 'http://paperless.example.com', token: fake.token },
      { allowPrivate: true, resolve: async () => ['93.184.216.34'] },
    );
    expect(await reason(publicHttp.ping())).toBe('http_public');
    expect(fake.requests.length).toBe(before);
    fake.down = true;
    expect(await reason(good.ping())).toBe('unreachable');
  });

  it('reads what a real Paperless-ngx 3.3.1 answered (recorded, test/fixtures/paperless)', async () => {
    const dir = path.join(FIXTURES, '..', 'paperless');
    const read = (f: string) => readFile(path.join(dir, f));
    const seen: { url: string; accept: string | undefined }[] = [];
    const replay = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://replay');
      seen.push({ url: `${url.pathname}${url.search}`, accept: req.headers.accept });
      const authed = { 'x-api-version': '10', 'x-version': '3.3.1' };
      const json = async (f: string, status = 200) =>
        res.writeHead(status, { 'content-type': 'application/json', ...authed }).end(await read(f));
      if (url.pathname === '/api/documents/' && url.searchParams.get('fields') === 'id') {
        return json('ping.json');
      }
      if (url.pathname === '/api/documents/') {
        return json(url.searchParams.has('query') ? 'search.json' : 'list.json');
      }
      if (url.pathname === '/api/documents/1/') return json('doc.json');
      if (url.pathname === '/api/documents/9999/') return json('missing.json', 404);
      if (url.pathname === '/api/document_types/') return json('types.json');
      if (url.pathname === '/api/correspondents/') return json('corr.json');
      if (url.pathname === '/api/tags/') return json('tags.json');
      if (url.pathname === '/api/documents/1/thumb/') {
        return res.writeHead(200, { 'content-type': 'image/webp' }).end(await read('thumb.webp'));
      }
      return json('missing.json', 404);
    });
    await new Promise<void>((r) => replay.listen(0, '127.0.0.1', r));
    try {
      const port = (replay.address() as AddressInfo).port;
      const client = new PaperlessClient(
        { baseUrl: `http://127.0.0.1:${port}`, token: fake.token },
        { allowPrivate: true },
      );
      expect(await client.ping()).toEqual({ version: '3.3.1' });
      const list = await client.search('', 1);
      expect(list.count).toBe(5);
      expect(list.results.map((d) => [d.id, d.title, d.created])).toContainEqual([
        2,
        'Bosch GSR 18V-55 manual',
        '2025-11-02',
      ]);
      const found = await client.search('bosch', 1);
      expect(found.results.map((d) => d.id)).toEqual([2, 1, 3]);
      expect((await client.document(1)).title).toBe('Bosch drill receipt');
      expect(await client.names('document_types', [1, 2, 3, 4])).toEqual(
        new Map([
          [3, 'Invoice'],
          [2, 'Manual'],
          [4, 'Policy'],
          [1, 'Receipt'],
        ]),
      );
      const thumb = await client.thumb(1);
      expect(thumb.contentType).toBe('image/webp');
      await expect(client.document(9999)).rejects.toMatchObject({ reason: 'not_found' });
      // What Kept asked for: version 9 for JSON, `*/*` for the thumbnail (`image/*` is a 406).
      expect(seen.find((s) => s.url.startsWith('/api/documents/1/thumb/'))?.accept).toBe('*/*');
      expect(seen.find((s) => s.url.startsWith('/api/document_types/'))?.accept).toBe(
        'application/json; version=9',
      );
    } finally {
      await new Promise<void>((r) => replay.close(() => r()));
    }
  });

  it('reads an address and a token as people paste them', () => {
    expect(paperlessRoot('https://docs.example.com/paperless/api/')).toBe(
      'https://docs.example.com/paperless',
    );
    expect(paperlessRoot(' http://192.168.1.20:8000/ ')).toBe('http://192.168.1.20:8000');
    expect(() => paperlessRoot('ftp://x.example')).toThrow();
    expect(() => paperlessRoot('https://me:pw@x.example')).toThrow();
    expect(paperlessToken(`Token ${'a'.repeat(40)}`)).toBe('a'.repeat(40));
    expect(() => paperlessToken('two words')).toThrow();
  });

  it('names a kind from the document type first, then the tags, in any of five languages', () => {
    expect(kindOf('Receipt', [])).toBe('receipt');
    expect(kindOf('Rechnung', [])).toBe('invoice');
    expect(kindOf(null, ['tools', 'Garantie'])).toBe('warranty_doc');
    expect(kindOf('Mode d’emploi', ['manuel'])).toBe('manual');
    expect(kindOf('Reçu', [])).toBe('receipt');
    expect(kindOf('فاتورة الثلاجة', [])).toBe('invoice');
    expect(kindOf('Policy', ['home'])).toBe('document');
  });
});

describe('the connection', () => {
  // catalogue: PUT /api/v1/locations/:id/paperless
  it('connects after signing in, seals the token, never answers or audits it', async () => {
    expect(ok(await paperless(bruce))).toEqual({ connection: null });
    const view = ok(await connect(bruce, { url: `${fake.url}/api/` }));
    expect(view).toMatchObject({
      url: fake.url,
      version: '3.3.1',
      createdBy: { id: bruce.userId },
      links: 0,
    });
    expect(JSON.stringify(view)).not.toContain(fake.token);
    expect(JSON.stringify(ok(await paperless(ibrahim)))).not.toContain(fake.token);
    const [row] = await own<{ config_ciphertext: unknown; base_url: string }>(
      db,
      'SELECT config_ciphertext, base_url FROM public.paperless_connections WHERE location_id = $1',
      [home.id],
    );
    expect(row?.base_url).toBe(fake.url);
    expect(JSON.stringify(row?.config_ciphertext)).not.toContain(fake.token);
    const events = await audit(['paperless_connection']);
    expect(events.map((a) => a.action)).toEqual(['paperless.connect']);
    expect(JSON.stringify(events)).not.toContain(fake.token);

    // A second save without the token keeps it, and says the token didn't change.
    ok(await connect(bruce, { token: undefined }));
    expect(fake.requests.at(-1)?.headers.authorization).toBe(`Token ${fake.token}`);
    const after = await audit(['paperless_connection']);
    expect(after.at(-1)).toMatchObject({ action: 'paperless.update' });
    expect(JSON.stringify(after.at(-1)?.diff)).not.toContain('token_changed');
  });

  it('refuses a connection that fails to sign in, saying why, and saves nothing', async () => {
    const res = await connect(bruce, { token: 'not-the-token' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation', paperlessError: 'auth_failed' });
    expect(ok(await paperless(bruce))).toEqual({ connection: null });
    expect((await connect(bruce, { url: 'ftp://paperless.example' })).statusCode).toBe(400);
  });

  it('is for owners and admins only, and wants a token the first time', async () => {
    expect((await connect(louis)).statusCode).toBe(403);
    expect((await paperless(louis)).statusCode).toBe(403);
    expect((await paperless(alfred)).statusCode).toBe(404);
    expect((await connect(bruce, { token: undefined })).statusCode).toBe(400);
  });

  // catalogue: DELETE /api/v1/locations/:id/paperless
  it('tests the saved connection on request, and disconnects with its links, audited', async () => {
    ok(await connect(ibrahim));
    const check = () =>
      call(t, `/api/v1/locations/${home.id}/paperless/check`, { as: ibrahim, method: 'POST' });
    expect(ok(await check())).toEqual({ ok: true, version: '3.3.1', error: null });
    ok(await link(louis, { thingId: drill.id, documentIds: [13] }), 201);
    fake.token = 'g'.repeat(40); // revoked in Paperless
    expect(ok(await check())).toEqual({ ok: false, version: null, error: 'auth_failed' });
    const del = await call(t, `/api/v1/locations/${home.id}/paperless`, {
      as: ibrahim,
      method: 'DELETE',
    });
    expect(del.statusCode).toBe(204);
    const events = await audit(['paperless_connection']);
    expect(events.at(-1)).toMatchObject({ action: 'paperless.disconnect' });
    expect(events.at(-1)?.diff).toMatchObject({ links: { before: 1 } });
    expect(await own(db, 'SELECT id FROM public.paperless_links')).toEqual([]);
    expect(ok(await paperless(ibrahim))).toEqual({ connection: null });
  });
});

describe('searching and linking', () => {
  it('searches Paperless through Kept for members, naming each kind; never for viewers', async () => {
    ok(await connect(bruce));
    const all = ok(
      await call(t, `/api/v1/locations/${home.id}/paperless/documents`, { as: louis }),
    );
    expect(all.count).toBe(4);
    const items = all.items as Json[];
    // Newest first, as Paperless orders `-created` (the stand-in breaks ties by id).
    expect(items.map((d) => [d.documentId, d.kind])).toEqual([
      [14, 'warranty_doc'],
      [12, 'receipt'],
      [13, 'manual'],
      [21, 'invoice'],
    ]);
    expect(items[1]).toMatchObject({
      title: 'Drill receipt',
      typeName: 'Receipt',
      correspondent: 'Hardware Store',
      createdOn: '2026-03-14',
      tags: ['tools'],
      linked: false,
      openUrl: `${fake.url}/documents/12`,
    });
    const sent = fake.requests.find(
      (r) => r.path === '/api/documents/' && r.query.get('page_size') === '24',
    );
    expect(sent?.query.get('ordering')).toBe('-created');
    const found = ok(
      await call(t, `/api/v1/locations/${home.id}/paperless/documents?q=bosch`, { as: louis }),
    );
    expect((found.items as Json[]).map((d) => d.documentId)).toEqual([14, 13]);
    const searched = fake.requests.filter((r) => r.path === '/api/documents/').at(-1);
    expect(searched?.query.get('query')).toBe('bosch');
    expect(
      (await call(t, `/api/v1/locations/${home.id}/paperless/documents`, { as: talia })).statusCode,
    ).toBe(403);
    expect(
      (await call(t, `/api/v1/locations/${home.id}/paperless/documents`, { as: alfred }))
        .statusCode,
    ).toBe(404);
  });

  // catalogue: POST /api/v1/paperless-links
  it("links documents to a thing with Paperless's own words, audited on the thing", async () => {
    ok(await connect(bruce));
    const made = ok(await link(louis, { thingId: drill.id, documentIds: [13, 12, 13] }), 201);
    const items = made.items as Json[];
    expect(items.map((l) => [l.documentId, l.title, l.kind])).toEqual([
      [13, 'Bosch GSB 18V manual', 'manual'],
      [12, 'Drill receipt', 'receipt'],
    ]);
    // Linking again changes nothing and adds no event.
    ok(await link(louis, { thingId: drill.id, documentIds: [13] }), 201);
    const events = await audit(['paperless_link']);
    expect(events.map((e) => e.action)).toEqual(['paperless_link.create', 'paperless_link.create']);
    const history = ok(await call(t, `/api/v1/things/${drill.id}/history`, { as: louis }));
    expect(JSON.stringify(history)).toContain('paperless_link.create');
    // The picker now marks them.
    const found = ok(
      await call(t, `/api/v1/locations/${home.id}/paperless/documents?thingId=${drill.id}`, {
        as: louis,
      }),
    );
    expect(
      (found.items as Json[])
        .filter((d) => d.linked)
        .map((d) => d.documentId)
        .sort(),
    ).toEqual([12, 13]);
    // A document Paperless doesn't have is a 404; viewers and strangers can't link.
    expect((await link(louis, { thingId: drill.id, documentIds: [999] })).statusCode).toBe(404);
    expect((await link(talia, { thingId: drill.id, documentIds: [14] })).statusCode).toBe(403);
    expect((await link(alfred, { thingId: drill.id, documentIds: [14] })).statusCode).toBe(404);
  });

  it('links to a place too, and nothing in another location', async () => {
    ok(await connect(bruce));
    const kitchen = await place(db, home, 'Kitchen');
    const made = ok(await link(louis, { placeId: kitchen, documentIds: [21] }), 201);
    expect((made.items as Json[])[0]).toMatchObject({
      subject: { placeId: kitchen },
      kind: 'invoice',
    });
    const listed = ok(await linksOf(louis, `placeId=${kitchen}`));
    expect(listed).toMatchObject({ connected: true, url: fake.url });
    const shed = await createThing(t, alfred, lake, { name: 'Shed key' });
    expect((await link(louis, { thingId: shed.id, documentIds: [21] })).statusCode).toBe(404);
    // Lake house has no Paperless: linking there is a 404 for its owner.
    expect((await link(alfred, { thingId: shed.id, documentIds: [21] })).statusCode).toBe(404);
  });
});

describe('showing linked documents', () => {
  it('lists the cached words even when Paperless is down, and the status says why', async () => {
    ok(await connect(bruce));
    ok(await link(louis, { thingId: drill.id, documentIds: [13] }), 201);
    fake.down = true;
    const listed = ok(await linksOf(talia, `thingId=${drill.id}`));
    expect((listed.items as Json[]).map((l) => l.title)).toEqual(['Bosch GSB 18V manual']);
    const status = ok(
      await call(t, `/api/v1/locations/${home.id}/paperless/status`, { as: talia }),
    );
    expect(status).toMatchObject({ connected: true, reachable: false, error: 'unreachable' });
    const [one] = listed.items as Json[];
    const thumb = await call(t, `/api/v1/paperless-links/${one?.id}/thumb`, { as: talia });
    expect(thumb.statusCode).toBe(502);
    expect(thumb.json()).toMatchObject({
      code: 'paperless_unreachable',
      paperlessError: 'unreachable',
    });
  });

  it('serves thumbnails re-encoded and cached, after the access check, and money only where shown', async () => {
    ok(await connect(bruce));
    const made = ok(await link(louis, { thingId: drill.id, documentIds: [12, 13] }), 201);
    const byKind = (k: string) => (made.items as Json[]).find((l) => l.kind === k);
    const manual = byKind('manual');
    const receipt = byKind('receipt');
    const before = fake.count('/api/documents/13/thumb/');
    const first = await call(t, `/api/v1/paperless-links/${manual?.id}/thumb`, { as: talia });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(
      (await call(t, `/api/v1/paperless-links/${manual?.id}/thumb`, { as: louis })).statusCode,
    ).toBe(200);
    expect(fake.count('/api/documents/13/thumb/')).toBe(before + 1);
    // Someone outside the location: a 404 before Paperless is asked.
    expect(
      (await call(t, `/api/v1/paperless-links/${manual?.id}/thumb`, { as: alfred })).statusCode,
    ).toBe(404);
    // Receipts are money: a viewer doesn't see money in Home by default.
    const forTalia = ok(await linksOf(talia, `thingId=${drill.id}`));
    expect((forTalia.items as Json[]).map((l) => l.kind)).toEqual(['manual']);
    expect(
      (await call(t, `/api/v1/paperless-links/${receipt?.id}/thumb`, { as: talia })).statusCode,
    ).toBe(404);
    const forLouis = ok(await linksOf(louis, `thingId=${drill.id}`));
    expect((forLouis.items as Json[]).map((l) => l.kind).sort()).toEqual(['manual', 'receipt']);
  });

  it('downloads a document for members, never for viewers, with the protective headers', async () => {
    ok(await connect(bruce));
    const [l] = ok(await link(louis, { thingId: drill.id, documentIds: [13] }), 201)
      .items as Json[];
    const res = await call(t, `/api/v1/paperless-links/${l?.id}/preview`, { as: louis });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.rawPayload.equals(fake.pdf)).toBe(true);
    expect(
      (await call(t, `/api/v1/paperless-links/${l?.id}/preview`, { as: talia })).statusCode,
    ).toBe(403);
  });

  it('reads links with a personal token, and nothing else of Paperless', async () => {
    ok(await connect(bruce));
    ok(await link(louis, { thingId: drill.id, documentIds: [13] }), 201);
    const made = ok(
      await call(t, '/api/v1/tokens', {
        as: louis,
        body: { name: 'Script', scope: 'write', locationIds: [home.id] },
      }),
      201,
    ) as unknown as { secret: string };
    const bearer = (url: string, method: 'GET' | 'POST' = 'GET', body?: unknown) =>
      call(t, url, {
        method,
        ...(body ? { body } : {}),
        headers: { authorization: `Bearer ${made.secret}` },
      });
    const listed = ok(await bearer(`/api/v1/paperless-links?thingId=${drill.id}`));
    expect((listed.items as Json[]).map((l) => l.documentId)).toEqual([13]);
    expect(JSON.stringify(listed)).not.toContain(fake.token);
    expect((await bearer(`/api/v1/locations/${home.id}/paperless/documents`)).statusCode).toBe(403);
    expect(
      (await bearer('/api/v1/paperless-links', 'POST', { thingId: drill.id, documentIds: [12] }))
        .statusCode,
    ).toBe(403);
  });

  it('lets get_thing say which Paperless documents a thing has, without a token or a call', async () => {
    ok(await connect(bruce));
    ok(await link(louis, { thingId: drill.id, documentIds: [13, 12] }), 201);
    const calls = fake.requests.length;
    const env = (await runTool(
      {
        deps: { pools: db.pools, jobs: null, files: null, providerResolved: async () => true },
        principal: { userId: talia.userId, mfa: false, scope: 'read' },
        locale: 'en',
        requestId: 'paperless-tool',
        via: 'assistant',
      },
      'get_thing',
      { thing_id: drill.id },
    )) as { data: { thing: { paperless_documents?: unknown[] } } };
    expect(TOOL_DEFS.get_thing.output.safeParse(env.data).success).toBe(true);
    expect(env.data.thing.paperless_documents).toEqual([
      {
        document_id: 13,
        kind: 'manual',
        date: '2025-11-02',
        copied: false,
        untrusted: { title: 'Bosch GSB 18V manual', type: 'Manual' },
      },
    ]);
    expect(fake.requests.length).toBe(calls);
  });
});

describe('copying and unlinking', () => {
  // catalogue: POST /api/v1/paperless-links/:id/copy
  it('copies a document into Kept as an attachment in its kind, once, audited', async () => {
    ok(await connect(bruce));
    const [l] = ok(await link(louis, { thingId: drill.id, documentIds: [13] }), 201)
      .items as Json[];
    const copied = ok(
      await call(t, `/api/v1/paperless-links/${l?.id}/copy`, { as: louis, method: 'POST' }),
      201,
    );
    expect(copied.link).toMatchObject({ copiedAttachmentId: copied.attachmentId });
    const [att] = await own<{ role: string; thing_id: string; mime: string; bytes: string }>(
      db,
      `SELECT a.role, a.thing_id, f.mime, f.bytes::text FROM public.attachments a
         JOIN public.files f ON f.id = a.file_id WHERE a.id = $1`,
      [copied.attachmentId],
    );
    expect(att).toMatchObject({ role: 'manual', thing_id: drill.id, mime: 'application/pdf' });
    expect(Number(att?.bytes)).toBe(fake.pdf.length);
    const events = await audit(['paperless_link']);
    expect(events.at(-1)).toMatchObject({ action: 'paperless_link.copy', entity_id: l?.id });
    const again = await call(t, `/api/v1/paperless-links/${l?.id}/copy`, {
      as: louis,
      method: 'POST',
    });
    expect(again.statusCode).toBe(409);
    expect(
      (await call(t, `/api/v1/paperless-links/${l?.id}/copy`, { as: talia, method: 'POST' }))
        .statusCode,
    ).toBe(403);
    // The copy outlives the link and the connection.
    await call(t, `/api/v1/locations/${home.id}/paperless`, { as: ibrahim, method: 'DELETE' });
    expect(
      await own(db, 'SELECT id FROM public.attachments WHERE id = $1', [copied.attachmentId]),
    ).toHaveLength(1);
  });

  // catalogue: DELETE /api/v1/paperless-links/:id
  it('unlinks: your own as a member, anyone’s as an admin, audited', async () => {
    ok(await connect(bruce));
    const [mine] = ok(await link(louis, { thingId: drill.id, documentIds: [13] }), 201)
      .items as Json[];
    const [theirs] = ok(await link(bruce, { thingId: drill.id, documentIds: [14] }), 201)
      .items as Json[];
    const unlink = (as: Person, id: unknown) =>
      call(t, `/api/v1/paperless-links/${id}`, { as, method: 'DELETE' });
    expect((await unlink(louis, theirs?.id)).statusCode).toBe(403);
    expect((await unlink(talia, mine?.id)).statusCode).toBe(403);
    expect((await unlink(louis, mine?.id)).statusCode).toBe(204);
    expect((await unlink(bruce, theirs?.id)).statusCode).toBe(204);
    const events = await audit(['paperless_link']);
    expect(events.filter((e) => e.action === 'paperless_link.delete')).toHaveLength(2);
    expect(ok(await linksOf(louis, `thingId=${drill.id}`)).items).toEqual([]);
  });

  it('drops a thing’s links when it moves to another location (its documents stay behind)', async () => {
    ok(await connect(bruce));
    const box = await createThing(t, ibrahim, home, { name: 'Toolbox' });
    ok(await link(louis, { thingId: box.id, documentIds: [13] }), 201);
    const garage = await createLocation(t, db, ibrahim, 'complete', 'Garage');
    await own(db, 'UPDATE public.things SET location_id = $1, place_id = $2 WHERE id = $3', [
      garage.id,
      garage.unplacedId,
      box.id,
    ]);
    expect(
      await own(db, 'SELECT id FROM public.paperless_links WHERE thing_id = $1', [box.id]),
    ).toEqual([]);
  });
});
