import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../test/app.js';
import { type TestDb, testDb } from '../../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../../test/people.js';
import { createLocation, type Loc, own } from '../../../test/things.js';
import { createLogger } from '../../http/logger.js';
import { homeboxRoot, readHomebox } from './api.js';

// T11 against a fake Homebox on 127.0.0.1 that answers the four calls as spike H3 recorded them
// (v0.26.2). Never the internet. The fake is on a loopback address, so the instance's
// `ssrf_allow_private` decides whether Kept may reach it at all.

const KEY = 'hb_FAKEKEY-must-never-be-stored-or-logged';
const PASSWORD = 'hunter2-must-never-be-stored-or-logged';
const TOKEN = 'session-token-must-never-be-stored';
const GROUP = '0b9e6c6e-6a3f-4c8e-9f55-0f7c3a1d2e01';
const FAMILY = '0b9e6c6e-6a3f-4c8e-9f55-0f7c3a1d2e02';

type Seen = { method: string; url: string; auth?: string; tenant?: string; body: string };
const seen: Seen[] = [];
let homebox: Server;
let base: string;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
    });
    req.on('end', () => resolve(s));
  });
}

beforeAll(async () => {
  homebox = createServer(async (req, res) => {
    const text = await body(req);
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      ...(typeof req.headers['x-tenant'] === 'string' ? { tenant: req.headers['x-tenant'] } : {}),
      body: text,
    });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const authed =
      req.headers.authorization === `Bearer ${KEY}` ||
      req.headers.authorization === `Bearer ${TOKEN}`;
    const url = req.url ?? '';
    if (url.startsWith('/moved/')) {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    if (url.startsWith('/web/')) return json(200, { not: 'homebox' });
    switch (url) {
      case '/api/v1/status':
        return json(200, {
          health: true,
          build: { version: 'v0.26.2', commit: 'e01dd737', buildTime: 'now' },
          latest: { version: 'v0.26.2' },
        });
      case '/api/v1/users/login': {
        const b = JSON.parse(text || '{}') as Record<string, unknown>;
        if (b.username === 'ibrahim@kept.test' && b.password === PASSWORD) {
          return json(200, { token: `Bearer ${TOKEN}`, expiresAt: 'later' });
        }
        return json(401, { error: 'authentication failed' });
      }
      case '/api/v1/groups/all':
        if (!authed) return json(401, { error: 'valid authorization token is required' });
        return json(200, [
          { id: FAMILY, name: 'بيت العائلة', currency: 'SAR', createdAt: 'x', updatedAt: 'x' },
          { id: GROUP, name: 'Home', currency: 'usd', createdAt: 'x', updatedAt: 'x' },
        ]);
      case '/api/v1/groups/members':
        if (!authed) return json(401, { error: 'valid authorization token is required' });
        if (req.headers['x-tenant'] !== GROUP && req.headers['x-tenant'] !== FAMILY) {
          return json(403, { error: 'user does not have access to the requested tenant' });
        }
        return json(200, [
          { id: newId(), name: 'Ibrahim', email: 'ibrahim@kept.test' },
          { id: newId(), name: 'Louis', email: 'louis@kept.test' },
        ]);
      default:
        return json(404, { error: 'not found' });
    }
  });
  await new Promise<void>((r) => homebox.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(homebox.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => homebox.close(r));
});

describe('homeboxRoot', () => {
  it.each([
    ['http://homebox.local:7745', 'http://homebox.local:7745/'],
    ['http://homebox.local:7745/', 'http://homebox.local:7745/'],
    ['https://hb.example/api/v1/', 'https://hb.example/'],
    ['https://example.org/homebox/', 'https://example.org/homebox'],
  ])('%s → %s', (raw, want) => {
    expect(homeboxRoot(raw).href).toBe(want);
  });

  it.each([
    'ftp://homebox.local',
    'homebox.local:7745',
    'http://me:secret@homebox.local',
    'http://homebox.local/?x=1',
  ])('refuses %s', (raw) => {
    expect(() => homeboxRoot(raw)).toThrow(expect.objectContaining({ code: 'validation' }));
  });
});

describe('readHomebox (fake server, plain fetch)', () => {
  it('reads the version, the ZIP collection first with its currency upper-cased, its members', async () => {
    seen.length = 0;
    const c = await readHomebox({
      root: homeboxRoot(base),
      credentials: { apiKey: KEY },
      collectionId: GROUP.toUpperCase(),
      fetch,
    });
    expect(c).toEqual({
      version: 'v0.26.2',
      collections: [
        { id: GROUP, name: 'Home', currency: 'USD' },
        { id: FAMILY, name: 'بيت العائلة', currency: 'SAR' },
      ],
      members: [
        { name: 'Ibrahim', email: 'ibrahim@kept.test' },
        { name: 'Louis', email: 'louis@kept.test' },
      ],
    });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /api/v1/status',
      'GET /api/v1/groups/all',
      'GET /api/v1/groups/members',
    ]);
    expect(seen[0]?.auth).toBeUndefined();
    expect(seen[1]?.auth).toBe(`Bearer ${KEY}`);
    expect(seen[2]?.tenant).toBe(GROUP);
  });

  it('signs in once with a password and uses the session token', async () => {
    seen.length = 0;
    const c = await readHomebox({
      root: homeboxRoot(`${base}/api/v1`),
      credentials: { username: 'ibrahim@kept.test', password: PASSWORD },
      collectionId: null,
      fetch,
    });
    expect(c.collections[0]?.id).toBe(FAMILY);
    const login = seen.filter((s) => s.url === '/api/v1/users/login');
    expect(login).toHaveLength(1);
    expect(JSON.parse(login[0]?.body ?? '{}')).toEqual({
      username: 'ibrahim@kept.test',
      password: PASSWORD,
      stayLoggedIn: false,
    });
    expect(seen.find((s) => s.url === '/api/v1/groups/all')?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('answers 502 homebox_unreachable for a refused key, a wrong sign-in and a non-Homebox', async () => {
    const read = (root: string, credentials: Parameters<typeof readHomebox>[0]['credentials']) =>
      readHomebox({ root: homeboxRoot(root), credentials, collectionId: null, fetch }).catch(
        (e) => e,
      );
    await expect(read(base, { apiKey: 'hb_wrong' })).resolves.toMatchObject({
      code: 'homebox_unreachable',
      status: 502,
      hint: expect.stringMatching(/didn't accept/),
    });
    await expect(
      read(base, { username: 'ibrahim@kept.test', password: 'nope' }),
    ).resolves.toMatchObject({
      code: 'homebox_unreachable',
      hint: "Homebox didn't accept that sign-in.",
    });
    await expect(read(`${base}/web`, { apiKey: KEY })).resolves.toMatchObject({
      code: 'homebox_unreachable',
      hint: expect.stringMatching(/doesn't answer like Homebox|didn't answer/),
    });
    await expect(read(`${base}/nothing-here`, { apiKey: KEY })).resolves.toMatchObject({
      code: 'homebox_unreachable',
      hint: expect.stringMatching(/404/),
    });
  });

  it("is 409 when the key's owner can't see the ZIP's collection", async () => {
    await expect(
      readHomebox({
        root: homeboxRoot(base),
        credentials: { apiKey: KEY },
        collectionId: newId(),
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});

describe('POST /api/v1/imports/:id/homebox-connect', () => {
  let db: TestDb;
  let t: TestApp;
  const logLines: string[] = [];
  let ibrahim: Person; // owner of Home, creates the runs
  let bruce: Person; // admin of Home
  let louis: Person; // member of Home
  let home: Loc;

  const url = (id: string) => `/api/v1/imports/${id}/homebox-connect`;

  /** A Homebox run as T8 leaves it after inspection: ZIP collection GROUP. */
  async function draftRun(creator: Person, locationId: string | null = null): Promise<string> {
    const id = newId();
    await own(
      db,
      `INSERT INTO public.import_runs (id, location_id, source, status, created_by, inspect)
       VALUES ($1, $2, 'homebox_zip', 'draft', $3, $4)`,
      [
        id,
        locationId,
        creator.userId,
        JSON.stringify({
          source: 'homebox_zip',
          sourceVersion: null,
          collections: [{ id: GROUP, counts: { entities: 21 } }],
        }),
      ],
    );
    return id;
  }

  const allowPrivate = (on: boolean) =>
    on
      ? own(
          db,
          `INSERT INTO public.instance_settings (key, value) VALUES ('ssrf_allow_private', 'true')
           ON CONFLICT (key) DO UPDATE SET value = 'true'`,
        )
      : own(db, `DELETE FROM public.instance_settings WHERE key = 'ssrf_allow_private'`);

  beforeAll(async () => {
    db = await testDb();
    await db.reset();
    const sink = new Writable({
      write(chunk, _enc, done) {
        logLines.push(String(chunk));
        done();
      },
    });
    t = await peopleApp(db, {
      logger: createLogger({ KEPT_LOG_LEVEL: 'trace', KEPT_LOG_FORMAT: 'json' }, sink),
    });
    ibrahim = await person(t, db, 'ibrahim');
    bruce = await person(t, db, 'bruce');
    louis = await person(t, db, 'louis');
    home = await createLocation(t, db, ibrahim, 'household');
    await join(db, home.id, bruce.userId, 'admin');
    await join(db, home.id, louis.userId, 'member');
  });
  afterAll(async () => {
    await t?.app.close();
  });
  beforeEach(() => allowPrivate(false));

  it('refuses a private address without the instance setting (400 private_address)', async () => {
    const id = await draftRun(ibrahim);
    const res = await call(t, url(id), { as: ibrahim, body: { baseUrl: base, apiKey: KEY } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'private_address' });
    expect(res.json().hint).toMatch(/Allow private addresses/);
  });

  // catalogue: POST /api/v1/imports/:id/homebox-connect
  it('reads the connection, records the version, and keeps the key out of storage, logs and the audit', async () => {
    await allowPrivate(true);
    const id = await draftRun(ibrahim);
    logLines.length = 0;
    const res = await call(t, `/api/v1/imports/${id}/homebox-connect`, {
      as: ibrahim,
      body: { baseUrl: `${base}/`, apiKey: KEY },
      headers: { 'idempotency-key': newId() },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      version: 'v0.26.2',
      collections: [
        { id: GROUP, name: 'Home', currency: 'USD' },
        { id: FAMILY, name: 'بيت العائلة', currency: 'SAR' },
      ],
      members: [
        { name: 'Ibrahim', email: 'ibrahim@kept.test' },
        { name: 'Louis', email: 'louis@kept.test' },
      ],
    });
    const [run] = await own<{ source_version: string | null }>(
      db,
      'SELECT source_version FROM public.import_runs WHERE id = $1',
      [id],
    );
    expect(run?.source_version).toBe('v0.26.2');
    const audit = await own<{ action: string; location_id: string | null; diff: unknown }>(
      db,
      `SELECT action, location_id, owner_account_id, diff FROM public.audit_events
        WHERE entity_id = $1 ORDER BY at`,
      [id],
    );
    expect(audit.map((a) => a.action)).toEqual(['import.homebox_connect']);
    expect(audit[0]?.diff).toMatchObject({
      host: { after: base.replace('http://', '') },
      version: { after: 'v0.26.2' },
    });
    // Nothing anywhere holds the key: not the audit, not the run, not the idempotency store,
    // not the request log.
    const everything = await own<{ dump: string }>(
      db,
      `SELECT (SELECT coalesce(string_agg(row_to_json(a)::text, ''), '') FROM public.audit_events a)
           || (SELECT coalesce(string_agg(row_to_json(r)::text, ''), '') FROM public.import_runs r)
           || (SELECT coalesce(string_agg(row_to_json(k)::text, ''), '')
                 FROM public.idempotency_keys k) AS dump`,
    );
    expect(everything[0]?.dump).not.toContain(KEY);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('\n')).toContain(id);
    expect(logLines.join('\n')).not.toContain(KEY);
  });

  it('keeps a password and its session token out of the log', async () => {
    await allowPrivate(true);
    const id = await draftRun(ibrahim);
    logLines.length = 0;
    const res = await call(t, url(id), {
      as: ibrahim,
      body: { baseUrl: base, username: 'ibrahim@kept.test', password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    const log = logLines.join('\n');
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain(TOKEN);
  });

  it('refuses a redirect (502 homebox_unreachable)', async () => {
    await allowPrivate(true);
    const id = await draftRun(ibrahim);
    const res = await call(t, url(id), {
      as: ibrahim,
      body: { baseUrl: `${base}/moved`, apiKey: KEY },
    });
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json()).toMatchObject({ code: 'homebox_unreachable' });
    expect(res.json().hint).toMatch(/redirect/);
    expect(seen.some((s) => s.url.includes('meta-data'))).toBe(false);
  });

  it('is the creator’s before a target, and the location’s owners’ and admins’ after', async () => {
    await allowPrivate(true);
    const draft = await draftRun(ibrahim);
    const body = { baseUrl: base, apiKey: KEY };
    expect((await call(t, url(draft), { as: bruce, body })).statusCode).toBe(404);
    const targeted = await draftRun(ibrahim, home.id);
    expect((await call(t, url(targeted), { as: louis, body })).statusCode).toBe(404);
    expect((await call(t, url(targeted), { as: bruce, body })).statusCode).toBe(200);
    const [audit] = await own<{ location_id: string }>(
      db,
      `SELECT location_id FROM public.audit_events WHERE entity_id = $1`,
      [targeted],
    );
    expect(audit?.location_id).toBe(home.id);
  });

  it('takes only a Homebox run before it starts, and an http(s) address', async () => {
    await allowPrivate(true);
    const id = await draftRun(ibrahim);
    const bad = await call(t, url(id), { as: ibrahim, body: { baseUrl: 'ftp://x', apiKey: KEY } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'validation' });
    const both = await call(t, url(id), {
      as: ibrahim,
      body: { baseUrl: base, apiKey: KEY, password: 'x' },
    });
    expect(both.statusCode).toBe(400);
    await own(db, `UPDATE public.import_runs SET status = 'cancelled' WHERE id = $1`, [id]);
    const done = await call(t, url(id), { as: ibrahim, body: { baseUrl: base, apiKey: KEY } });
    expect(done.statusCode).toBe(409);
  });
});
