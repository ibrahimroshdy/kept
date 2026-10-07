import { Writable } from 'node:stream';
import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { setCookies } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  fixture,
  seedThing,
  sha256,
  type TestFiles,
  testFiles,
  uniqueJpeg,
  upload,
} from '../../test/files.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { withScope } from '../db/scope.js';
import { createLogger } from '../http/logger.js';
import { originalKey } from '../storage/blob-store.js';
import { createUrlSigner } from '../storage/signed-url.js';

// T17: serving files (D117, D157; plan Q16). Signed URLs from POST /api/v1/files/:id/url, bytes
// from GET /f/:token, which reads no session and marks every response as inert.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ann: Person; // owner
let bob: Person; // member
let vic: Person; // viewer
let home: string;
let thing: string;

type FileView = { id: string; thumbUrl: string | null };
type FileUrl = { url: string; expiresAt: string };

async function newLocation(as: Person, name: string): Promise<string> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: {
      name,
      kind: 'home',
      preset: 'household',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      rooms: [],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** Uploads and attaches a photo to `thing`, returning the file id and its bytes. */
async function attachedPhoto(bytes?: Buffer): Promise<{ id: string; bytes: Buffer }> {
  const b = bytes ?? (await uniqueJpeg());
  const up = await upload(t, bob, home, b);
  expect(up.statusCode, up.body).toBe(201);
  const id = (up.json() as FileView).id;
  const a = await call(t, '/api/v1/attachments', {
    as: bob,
    body: { locationId: home, fileId: id, subject: { thingId: thing }, role: 'photo' },
  });
  expect(a.statusCode, a.body).toBe(201);
  return { id, bytes: b };
}

const urlFor = (as: Person, fileId: string, variant: string, query = '') =>
  call(t, `/api/v1/files/${fileId}/url${query}`, { as, body: { variant } });

const fetchFile = (url: string, cookie?: string): Promise<LightMyRequestResponse> =>
  t.app.inject({ method: 'GET', url, ...(cookie ? { headers: { cookie } } : {}) });

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  vic = await person(t, db, 'vic');
  home = await newLocation(ann, 'Home');
  await join(db, home, bob.userId, 'member');
  await join(db, home, vic.userId, 'viewer');
  thing = await seedThing(db, home, 'Lamp');
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

describe('POST /api/v1/files/:id/url and GET /f/:token', () => {
  it('serves a member the original, byte-identical, as an inert download', async () => {
    const { id, bytes } = await attachedPhoto(await fixture('photo.jpg'));
    const res = await urlFor(bob, id, 'original');
    expect(res.statusCode, res.body).toBe(200);
    const { url, expiresAt } = res.json() as FileUrl;
    expect(url).toMatch(/^\/f\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const left = new Date(expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(250_000);
    expect(left).toBeLessThanOrEqual(300_000);

    // The browser sends its session cookie along; the route never looks at it or sets one.
    const got = await fetchFile(url, bob.cookie);
    expect(got.statusCode).toBe(200);
    expect(sha256(got.rawPayload)).toBe(sha256(bytes));
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(got.headers['content-disposition']).toMatch(/^attachment; filename="[0-9a-f-]+\.jpg"/);
    expect(got.headers['cache-control']).toMatch(/^private, max-age=\d+$/);
    expect(setCookies(got)).toEqual([]);
  });

  it('serves derivatives inline as JPEG, to a viewer too', async () => {
    const { id } = await attachedPhoto();
    for (const variant of ['thumb', 'display', 'share']) {
      const res = await urlFor(vic, id, variant);
      expect(res.statusCode, `${variant}: ${res.body}`).toBe(200);
      const got = await fetchFile((res.json() as FileUrl).url);
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('image/jpeg');
      expect(got.headers['content-disposition']).toMatch(/^inline; /);
      expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    }
  });

  it('refuses a viewer the original: 403 (D117)', async () => {
    const { id } = await attachedPhoto();
    const res = await urlFor(vic, id, 'original');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
  });

  it('keeps an unattached upload to its uploader (§7.2), and other tenants out', async () => {
    const up = await upload(t, ann, home, await uniqueJpeg());
    const id = (up.json() as FileView).id;
    expect((await urlFor(ann, id, 'original')).statusCode).toBe(200);
    expect((await urlFor(bob, id, 'thumb')).statusCode).toBe(404);
    expect((await urlFor(bob, id, 'original')).statusCode).toBe(404);
    const eve = await person(t, db, 'eve');
    const { id: attached } = await attachedPhoto();
    expect((await urlFor(eve, attached, 'thumb')).statusCode).toBe(404);
    expect((await urlFor(eve, attached, 'original')).statusCode).toBe(404);
    expect((await urlFor(eve, newId(), 'thumb')).statusCode).toBe(404);
  });

  it('has no preview URL for a file without one (a PDF): 404', async () => {
    const up = await upload(t, bob, home, await fixture('doc.pdf'), {
      contentType: 'application/pdf',
    });
    const id = (up.json() as FileView).id;
    expect((await urlFor(bob, id, 'thumb')).statusCode).toBe(404);
    const original = await urlFor(bob, id, 'original');
    expect(original.statusCode).toBe(200);
    const got = await fetchFile((original.json() as FileUrl).url);
    expect(got.headers['content-type']).toBe('application/pdf');
    expect(got.headers['content-disposition']).toMatch(/^attachment; filename="[0-9a-f-]+\.pdf"/);
  });

  it('answers 404 for a tampered, forged, malformed or expired token, and never sets a cookie', async () => {
    const { id } = await attachedPhoto();
    const { url } = (await urlFor(bob, id, 'thumb')).json() as FileUrl;
    const token = url.slice('/f/'.length);
    const [payload, mac] = token.split('.') as [string, string];

    // Pointing a real signature at another key.
    const other = JSON.parse(Buffer.from(payload, 'base64url').toString());
    other.k = originalKey(home, id);
    const swapped = `${Buffer.from(JSON.stringify(other)).toString('base64url')}.${mac}`;
    // Signed with the right secret, but already expired.
    const past = createUrlSigner(files.authSecret, { now: () => Date.now() - 3_600_000 });
    const expired = past.sign({
      key: originalKey(home, id),
      disposition: 'attachment',
      filename: 'x.jpg',
      contentType: 'image/jpeg',
    });
    // Signed with another secret.
    const forged = createUrlSigner(Buffer.alloc(32, 7)).sign({
      key: originalKey(home, id),
      disposition: 'attachment',
      filename: 'x.jpg',
      contentType: 'image/jpeg',
    });
    for (const bad of [
      `${token.slice(0, -2)}AA`,
      swapped,
      expired,
      forged,
      'not-a-token',
      '..%2F..%2Fetc%2Fpasswd',
    ]) {
      const got = await fetchFile(`/f/${bad}`, bob.cookie);
      expect(got.statusCode, bad).toBe(404);
      expect(setCookies(got)).toEqual([]);
    }
    // The genuine one still works.
    expect((await fetchFile(url)).statusCode).toBe(200);
  });

  it('answers 404 when the blob is gone, rather than failing', async () => {
    const signed = files.signer.sign({
      key: originalKey(home, newId()),
      disposition: 'attachment',
      filename: 'gone.jpg',
      contentType: 'image/jpeg',
    });
    expect((await fetchFile(`/f/${signed}`)).statusCode).toBe(404);
  });
});

describe("a thing's receipt after a move (?thingId=, D115)", () => {
  it('serves the original to a member of the thing’s location, even when the purchase is elsewhere', async () => {
    // Ann's purchase (with its receipt) is in her Office; the thing was moved to Home, where Bob
    // is a member and Vic a viewer, neither of whom can see the Office.
    const office = await newLocation(ann, 'Office');
    const up = await upload(t, ann, office, await uniqueJpeg(), { cls: 'evidence' });
    const receipt = (up.json() as FileView).id;
    const moved = await seedThing(db, office, 'Printer');
    await ownerTx(db, async (c) => {
      const purchase = newId();
      const line = newId();
      await c.query(
        `INSERT INTO public.purchases (id, location_id, purchased_on) VALUES ($1, $2, '2026-09-01')`,
        [purchase, office],
      );
      await c.query(
        `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description)
         VALUES ($1, $2, $3, 'Printer')`,
        [line, office, purchase],
      );
      await c.query(
        `INSERT INTO public.attachments (location_id, file_id, purchase_id, role, created_by)
         VALUES ($1, $2, $3, 'receipt', $4)`,
        [office, receipt, purchase, ann.userId],
      );
      await c.query('UPDATE public.things SET purchase_line_id = $1 WHERE id = $2', [line, moved]);
    });
    // Ann moves it Home the real way (kept.move_things): within her account, the purchase stays.
    await withScope(db.pools.app, { userId: ann.userId, mfa: false }, (_tx, c) =>
      c.query(
        `SELECT kept.move_things(ARRAY[$1]::uuid[], $2,
                (SELECT id FROM public.places WHERE location_id = $2 AND is_unplaced), NULL)`,
        [moved, home],
      ),
    );

    expect((await urlFor(bob, receipt, 'original')).statusCode).toBe(404);
    const res = await urlFor(bob, receipt, 'original', `?thingId=${moved}`);
    expect(res.statusCode, res.body).toBe(200);
    const got = await fetchFile((res.json() as FileUrl).url);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-disposition']).toMatch(/^attachment; /);

    // Only the original travels this way, only for members and above, only for that thing.
    expect((await urlFor(bob, receipt, 'thumb', `?thingId=${moved}`)).statusCode).toBe(404);
    expect((await urlFor(vic, receipt, 'original', `?thingId=${moved}`)).statusCode).toBe(404);
    expect((await urlFor(bob, receipt, 'original', `?thingId=${thing}`)).statusCode).toBe(404);
  });
});

describe('the /f/ route in the logs (security review #11)', () => {
  it('never writes a token to the log, whatever the level', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = createLogger({ KEPT_LOG_LEVEL: 'trace', KEPT_LOG_FORMAT: 'json' }, stream);
    const logged = await peopleApp(db, { files, logger });
    try {
      const { id } = await attachedPhoto();
      const res = await urlFor(bob, id, 'thumb');
      const { url } = res.json() as FileUrl;
      const token = url.slice('/f/'.length);
      const got = await logged.app.inject({ method: 'GET', url });
      expect(got.statusCode).toBe(200);
      const bad = await logged.app.inject({ method: 'GET', url: `/f/${token}x` });
      expect(bad.statusCode).toBe(404);
      const text = lines.join('');
      expect(text).not.toContain(token);
      expect(text).not.toContain(token.split('.')[0]);
    } finally {
      await logged.app.close();
    }
  });
});
