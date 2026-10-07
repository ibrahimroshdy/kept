import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { newId } from '@kept/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  fixture,
  sha256,
  type TestFiles,
  testFiles,
  uniqueJpeg,
  upload,
} from '../../test/files.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { originalKey } from '../storage/blob-store.js';

// T17 through the front door: PUT /api/v1/files/:fileId, as the web sends it (a raw body with
// X-Kept-Sha256; apps/web/src/api/inventory/mock/files.ts). D36, D117, D157, D177; §3.4.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ann: Person;

type FileView = {
  id: string;
  sha256: string;
  bytes: number;
  mime: string;
  class: string;
  hasGps: boolean;
  width: number | null;
  height: number | null;
  derivativeState: string;
  thumbUrl: string | null;
  displayUrl: string | null;
  deduplicatedFrom?: string;
};

const own = <T>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query(text, values)).rows as T[]);

const fileRow = async (id: string) =>
  (
    await own<{ storage_key: string; created_by: string; derivative_state: string }>(
      'SELECT storage_key, created_by, derivative_state FROM public.files WHERE id = $1',
      [id],
    )
  )[0];

const derivativesOf = (id: string) =>
  own<{ variant: string; storage_key: string; width: number; height: number }>(
    'SELECT variant, storage_key, width, height FROM public.file_derivatives WHERE file_id = $1 ORDER BY variant',
    [id],
  );

/** The bytes a blob key holds on the local store. */
const blob = (key: string) => readFile(path.join(files.blobs.root, key));

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ann = await person(t, db, 'ann');
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

describe('PUT /api/v1/files/:fileId', () => {
  // catalogue: PUT /api/v1/files/:fileId
  it('stores a JPEG byte-identical, makes stripped derivatives, and audits file.upload', async () => {
    const bytes = await fixture('photo.jpg');
    const id = newId();
    const res = await upload(t, ann, ann.personalLocationId, bytes, { id, cls: 'evidence' });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json() as FileView;
    expect(view).toMatchObject({
      id,
      sha256: sha256(bytes),
      bytes: bytes.length,
      mime: 'image/jpeg',
      class: 'evidence',
      hasGps: true,
      width: 8,
      height: 4,
      derivativeState: 'ready',
    });
    expect(view.thumbUrl).toMatch(/^\/f\//);
    expect(view.displayUrl).toMatch(/^\/f\//);

    // The original: under the key the database stamped, exactly the bytes sent (D117).
    const row = await fileRow(id);
    expect(row?.storage_key).toBe(originalKey(ann.personalLocationId, id));
    expect(row?.created_by).toBe(ann.userId);
    const stored = await blob(row?.storage_key as string);
    expect(sha256(stored)).toBe(sha256(bytes));
    expect((await sharp(stored).metadata()).exif).toBeDefined();

    // Derivatives: display, share, thumb, each a JPEG with no metadata at all.
    const ds = await derivativesOf(id);
    expect(ds.map((d) => d.variant)).toEqual(['display', 'share', 'thumb']);
    for (const d of ds) {
      expect(d.storage_key).toBe(`d/${id}/${d.variant}.jpg`);
      const meta = await sharp(await blob(d.storage_key)).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
    }

    const audit = (await auditOf(db, ann.personalLocationId)).filter(
      (e) => e.action === 'file.upload',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_id).toBe(ann.userId);
    const diff = JSON.stringify(audit[0]?.diff);
    expect(diff).toContain('image/jpeg');
    expect(diff).not.toContain('photo.jpg');
    expect(diff).not.toContain(sha256(bytes));
  });

  it('bakes the EXIF rotation into the derivatives (portrait for an orientation-6 photo)', async () => {
    const bytes = await fixture('rotated.jpg');
    const res = await upload(t, ann, ann.personalLocationId, bytes);
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json() as FileView;
    expect([view.width, view.height]).toEqual([4, 8]);
    expect(view.hasGps).toBe(false);
    const thumb = (await derivativesOf(view.id)).find((d) => d.variant === 'thumb');
    const meta = await sharp(await blob(thumb?.storage_key as string)).metadata();
    expect([meta.width, meta.height]).toEqual([4, 8]);
    expect(meta.orientation).toBeUndefined();
    // …and the original keeps its orientation tag, untouched.
    const original = await blob(originalKey(ann.personalLocationId, view.id));
    expect((await sharp(original).metadata()).orientation).toBe(6);
  });

  it('takes a PNG, whatever Content-Type the client declared', async () => {
    const bytes = await sharp({
      create: { width: 3000, height: 1000, channels: 4, background: '#08f8' },
    })
      .png()
      .toBuffer();
    const res = await upload(t, ann, ann.personalLocationId, bytes, {
      contentType: 'application/octet-stream',
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json() as FileView;
    expect(view).toMatchObject({ mime: 'image/png', class: 'photo', derivativeState: 'ready' });
    const sizes = Object.fromEntries(
      (await derivativesOf(view.id)).map((d) => [d.variant, [d.width, d.height]]),
    );
    // Fit inside 2048 / 1200 / 400 on the long side (§3.4), never enlarged.
    expect(sizes).toEqual({ display: [2048, 683], share: [1200, 400], thumb: [400, 133] });
  });

  it('stores a PDF with no derivatives (not_applicable until step 3, Q8)', async () => {
    const res = await upload(t, ann, ann.personalLocationId, await fixture('doc.pdf'), {
      cls: 'document',
      contentType: 'application/pdf',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      mime: 'application/pdf',
      derivativeState: 'not_applicable',
      width: null,
      height: null,
      thumbUrl: null,
      displayUrl: null,
    });
    expect(await derivativesOf((res.json() as FileView).id)).toEqual([]);
  });

  it('keeps a HEIC as "preview unavailable", never refusing it (D36)', async () => {
    const res = await upload(t, ann, ann.personalLocationId, await fixture('image.heic'), {
      contentType: 'image/heic',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      mime: 'image/heic',
      derivativeState: 'unavailable',
      thumbUrl: null,
      displayUrl: null,
    });
  });

  it.each([
    ['fake.jpg', 'image/jpeg'],
    ['drawing.svg', 'image/svg+xml'],
    ['clip.mp4', 'video/mp4'],
  ])('refuses %s by its content: 415, and nothing is stored', async (name, contentType) => {
    const id = newId();
    const res = await upload(t, ann, ann.personalLocationId, await fixture(name), {
      id,
      contentType,
    });
    expect(res.statusCode, res.body).toBe(415);
    expect(res.json()).toMatchObject({ code: 'unsupported_media_type' });
    expect(await fileRow(id)).toBeUndefined();
    expect(await files.blobs.exists(originalKey(ann.personalLocationId, id))).toBe(false);
  });

  it('refuses bytes that do not match X-Kept-Sha256: 400 checksum_mismatch', async () => {
    const id = newId();
    const res = await upload(t, ann, ann.personalLocationId, await fixture('photo.jpg'), {
      id,
      sha: 'a'.repeat(64),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'checksum_mismatch' });
    expect(await fileRow(id)).toBeUndefined();
  });

  it('needs X-Kept-Sha256', async () => {
    const res = await upload(t, ann, ann.personalLocationId, await fixture('photo.jpg'), {
      sha: null,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation' });
  });

  it('refuses a path-traversal id by its shape, before anything is read', async () => {
    const bytes = await fixture('photo.jpg');
    for (const id of ['..%2F..%2Fetc%2Fpasswd', 'not-a-uuid']) {
      const res = await t.app.inject({
        method: 'PUT',
        url: `/api/v1/files/${id}?locationId=${ann.personalLocationId}`,
        headers: {
          origin: t.publicUrl,
          cookie: ann.cookie,
          'content-type': 'image/jpeg',
          'x-kept-sha256': sha256(bytes),
        },
        payload: bytes,
      });
      expect(res.statusCode, id).toBe(400);
    }
  });

  it('needs a session', async () => {
    const res = await upload(t, { cookie: '' }, ann.personalLocationId, await fixture('photo.jpg'));
    expect(res.statusCode).toBe(401);
  });
});

describe('upload size (§3.4, KEPT_MAX_FILE_MB)', () => {
  it('refuses a 26 MB upload with 413 from Content-Length, without reading the body', async () => {
    let read = false;
    const body = new Readable({
      read() {
        read = true;
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/files/${newId()}?locationId=${ann.personalLocationId}`,
      headers: {
        origin: t.publicUrl,
        cookie: ann.cookie,
        'content-type': 'image/jpeg',
        'content-length': String(26 * 1024 * 1024),
        'x-kept-sha256': 'a'.repeat(64),
      },
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(413);
    expect(res.json()).toMatchObject({ code: 'payload_too_large' });
    expect(read).toBe(false);
  });

  it('refuses a body over the limit on a smaller instance, and stores nothing', async () => {
    const small = await testFiles({ maxFileBytes: 400 });
    const s = await peopleApp(db, { files: small });
    try {
      const bea = await person(s, db, 'bea');
      const id = newId();
      const res = await upload(s, bea, bea.personalLocationId, await fixture('photo.jpg'), { id });
      expect(res.statusCode, res.body).toBe(413);
      expect(await fileRow(id)).toBeUndefined();
    } finally {
      await s.app.close();
      await small.cleanup();
    }
  });
});

describe('replays and dedupe (D36, D177)', () => {
  it('answers a replay of the same id and bytes with the same file (200)', async () => {
    const bytes = await uniqueJpeg();
    const id = newId();
    const first = await upload(t, ann, ann.personalLocationId, bytes, { id });
    expect(first.statusCode).toBe(201);
    const again = await upload(t, ann, ann.personalLocationId, bytes, { id });
    expect(again.statusCode, again.body).toBe(200);
    const { thumbUrl: _a, displayUrl: _b, ...one } = first.json() as FileView;
    const { thumbUrl: _c, displayUrl: _d, ...two } = again.json() as FileView;
    expect(two).toEqual(one);
    expect(await own('SELECT 1 FROM public.files WHERE id = $1', [id])).toHaveLength(1);
  });

  it('refuses the same id with other bytes: 409 idempotency_mismatch', async () => {
    const id = newId();
    expect(
      (await upload(t, ann, ann.personalLocationId, await uniqueJpeg(), { id })).statusCode,
    ).toBe(201);
    const res = await upload(t, ann, ann.personalLocationId, await uniqueJpeg(), { id });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'idempotency_mismatch' });
  });

  it('dedupes the same bytes within a location, never across locations', async () => {
    const bytes = await uniqueJpeg();
    const first = await upload(t, ann, ann.personalLocationId, bytes);
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as FileView).id;

    const dup = await upload(t, ann, ann.personalLocationId, bytes);
    expect(dup.statusCode, dup.body).toBe(200);
    expect(dup.json()).toMatchObject({ id: firstId, deduplicatedFrom: firstId });

    const created = await call(t, '/api/v1/locations', {
      as: ann,
      body: {
        name: 'Garage',
        kind: 'home',
        preset: 'household',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        rooms: [],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const garage = (created.json() as { id: string }).id;
    const elsewhere = await upload(t, ann, garage, bytes);
    expect(elsewhere.statusCode, elsewhere.body).toBe(201);
    const view = elsewhere.json() as FileView;
    expect(view.id).not.toBe(firstId);
    expect(view.deduplicatedFrom).toBeUndefined();
  });
});

describe('who may upload', () => {
  it('404 for a location the caller cannot see, 403 for a viewer, 201 for a member', async () => {
    const bob = await person(t, db, 'bob');
    const bytes = await fixture('photo.jpg');
    const hidden = await upload(t, bob, ann.personalLocationId, bytes);
    expect(hidden.statusCode).toBe(404);

    const created = await call(t, '/api/v1/locations', {
      as: ann,
      body: {
        name: 'Flat',
        kind: 'home',
        preset: 'household',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        rooms: [],
      },
    });
    const flat = (created.json() as { id: string }).id;
    const vic = await person(t, db, 'vic');
    await join(db, flat, vic.userId, 'viewer');
    await join(db, flat, bob.userId, 'member');
    const viewer = await upload(t, vic, flat, bytes);
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json()).toMatchObject({ code: 'forbidden' });
    const member = await upload(t, bob, flat, bytes);
    expect(member.statusCode, member.body).toBe(201);
  });

  it('never reuses an id that exists in another tenant: 404, as for any unseen row (D178)', async () => {
    const id = newId();
    expect(
      (await upload(t, ann, ann.personalLocationId, await uniqueJpeg(), { id })).statusCode,
    ).toBe(201);
    const cat = await person(t, db, 'cat');
    const res = await upload(t, cat, cat.personalLocationId, await uniqueJpeg(), { id });
    expect(res.statusCode, res.body).toBe(404);
  });
});

describe('uploads under load (review #16)', () => {
  /** Other sessions' locks on public.files right now: an upload's transaction holds one from its
   * INSERT until it ends. (pg_stat_activity hides other roles' states from kept_owner.) */
  const openTransactions = () =>
    own<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE relation = 'public.files'::regclass AND pid <> pg_backend_pid()
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    ).then((r) => r[0]?.n ?? 0);

  it('stores the blobs with no transaction open, so a slow store holds no locks', async () => {
    const watched = await testFiles();
    const during: number[] = [];
    const put = watched.blobs.put.bind(watched.blobs);
    watched.blobs.put = async (key, file, opts) => {
      during.push(await openTransactions());
      return put(key, file, opts);
    };
    const app = await peopleApp(db, { files: watched });
    try {
      const me = await person(app, db, 'slow-store');
      const res = await upload(app, me, me.personalLocationId, await uniqueJpeg());
      expect(res.statusCode, res.body).toBe(201);
      expect(during).toHaveLength(4);
      expect(during).toEqual([0, 0, 0, 0]);
    } finally {
      await app.app.close();
      await watched.cleanup();
    }
  });

  it('takes at most three uploads from one person at a time: 429 with Retry-After', async () => {
    const watched = await testFiles();
    let entered = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const put = watched.blobs.put.bind(watched.blobs);
    watched.blobs.put = async (key, file, opts) => {
      if (key.startsWith('f/')) {
        entered += 1;
        await held;
      }
      return put(key, file, opts);
    };
    const app = await peopleApp(db, { files: watched });
    try {
      const me = await person(app, db, 'busy');
      const other = await person(app, db, 'other');
      const three = await Promise.all([uniqueJpeg(), uniqueJpeg(), uniqueJpeg()]);
      const running = three.map((b) => upload(app, me, me.personalLocationId, b));
      while (entered < 3) await new Promise((r) => setTimeout(r, 10));

      const fourth = await upload(app, me, me.personalLocationId, await uniqueJpeg());
      expect(fourth.statusCode, fourth.body).toBe(429);
      expect(fourth.json()).toMatchObject({ code: 'rate_limited' });
      expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);

      // Someone else is not held up by it (their upload waits only for the store).
      const theirs = upload(app, other, other.personalLocationId, await uniqueJpeg());
      release();
      expect((await Promise.all(running)).map((r) => r.statusCode)).toEqual([201, 201, 201]);
      expect((await theirs).statusCode).toBe(201);
      // And with the slots free again, the fourth goes through.
      const again = await upload(app, me, me.personalLocationId, await uniqueJpeg());
      expect(again.statusCode, again.body).toBe(201);
    } finally {
      await app.app.close();
      await watched.cleanup();
    }
  });

  it('leaves no blob behind when the insert fails', async () => {
    const watched = await testFiles();
    const app = await peopleApp(db, { files: watched });
    try {
      const me = await person(app, db, 'fails');
      const id = newId();
      // The row can't be inserted: a check on files refuses this one id (as kept_owner).
      await own(
        `ALTER TABLE public.files ADD CONSTRAINT upload_test_refuse CHECK (id <> '${id}'::uuid) NOT VALID`,
      );
      try {
        const res = await upload(app, me, me.personalLocationId, await uniqueJpeg(), { id });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
      } finally {
        await own('ALTER TABLE public.files DROP CONSTRAINT upload_test_refuse');
      }
      expect(await watched.blobs.exists(originalKey(me.personalLocationId, id))).toBe(false);
    } finally {
      await app.app.close();
      await watched.cleanup();
    }
  });
});
