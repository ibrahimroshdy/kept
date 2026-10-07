import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import type { FileStorage } from '../src/storage/blob-store.js';
import { LocalBlobStore } from '../src/storage/local.js';
import { createUrlSigner } from '../src/storage/signed-url.js';
import type { TestApp } from './app.js';
import type { TestDb } from './db.js';
import { freshIp } from './people.js';
import { ownerTx } from './tenancy.js';

// File storage for the T17 route tests: a local blob store and an upload temp directory in a
// scratch directory of their own, and a signer with a random key. `upload()` speaks the web's
// upload protocol (apps/web/src/api/inventory/mock/files.ts): a raw PUT with X-Kept-Sha256.

export const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'files',
);

export const fixture = (name: string) => readFile(path.join(FIXTURES, name));

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export type TestFiles = FileStorage & {
  blobs: LocalBlobStore;
  authSecret: Buffer;
  dir: string;
  cleanup: () => Promise<void>;
};

export async function testFiles(
  opts: { maxFileBytes?: number; imageConcurrency?: number } = {},
): Promise<TestFiles> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kept-files-'));
  const authSecret = randomBytes(32);
  const signer = createUrlSigner(authSecret);
  return {
    blobs: new LocalBlobStore({ dataDir: dir, signer }),
    signer,
    maxFileBytes: opts.maxFileBytes ?? 25 * 1024 * 1024,
    imageConcurrency: opts.imageConcurrency ?? 2,
    tmpDir: path.join(dir, 'tmp'),
    authSecret,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export type UploadOptions = {
  id?: string;
  cls?: string;
  /** The X-Kept-Sha256 sent; defaults to the bytes' own. `null` sends none. */
  sha?: string | null;
  contentType?: string;
  headers?: Record<string, string>;
};

export function upload(
  t: TestApp,
  as: { cookie: string },
  locationId: string,
  bytes: Buffer,
  opts: UploadOptions = {},
): Promise<LightMyRequestResponse> {
  const id = opts.id ?? newId();
  const query = new URLSearchParams({ locationId });
  if (opts.cls) query.set('class', opts.cls);
  const headers: Record<string, string> = {
    origin: t.publicUrl,
    cookie: as.cookie,
    'content-type': opts.contentType ?? 'image/jpeg',
    ...opts.headers,
  };
  const sha = opts.sha === undefined ? sha256(bytes) : opts.sha;
  if (sha !== null) headers['x-kept-sha256'] = sha;
  return t.app.inject({
    method: 'PUT',
    url: `/api/v1/files/${id}?${query}`,
    headers,
    remoteAddress: freshIp(),
    payload: bytes,
  });
}

let counter = 0;
/** A small JPEG no other test uploaded (dedupe is per location, D177): a unique EXIF note. */
export async function uniqueJpeg(): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  counter += 1;
  const colour = randomBytes(3).toString('hex');
  return sharp({
    create: { width: 4 + (counter % 20), height: 3, channels: 3, background: `#${colour}` },
  })
    .jpeg({ quality: 60 })
    .withExif({ IFD0: { ImageDescription: `${newId()}` } })
    .toBuffer();
}

/** A thing in the location's Unplaced area, inserted as kept_owner. */
export function seedThing(db: TestDb, locationId: string, name = 'Thing'): Promise<string> {
  return ownerTx(db, async (c) => {
    const id = newId();
    await c.query(
      `INSERT INTO public.things (id, location_id, place_id, name)
       SELECT $1, $2, p.id, $3 FROM public.places p WHERE p.location_id = $2 AND p.is_unplaced`,
      [id, locationId, name],
    );
    return id;
  });
}

/** A place at the top of the location, inserted as kept_owner. */
export function seedPlace(db: TestDb, locationId: string, name = 'Shelf'): Promise<string> {
  return ownerTx(db, async (c) => {
    const id = newId();
    await c.query('INSERT INTO public.places (id, location_id, name) VALUES ($1, $2, $3)', [
      id,
      locationId,
      name,
    ]);
    return id;
  });
}
