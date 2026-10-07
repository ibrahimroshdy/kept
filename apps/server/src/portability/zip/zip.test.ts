import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buffer as streamBuffer, text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_REFUSALS, newId, ZIP_LIMITS } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { z } from 'zod';
import { forgeZip } from '../../../test/zip-forge.js';
import { AppError } from '../../http/errors.js';
import { type BlobRange, type BlobStore, importArchiveKey } from '../../storage/blob-store.js';
import { LocalBlobStore } from '../../storage/local.js';
import { S3BlobStore } from '../../storage/s3.js';
import { createUrlSigner } from '../../storage/signed-url.js';
import {
  ARCHIVE_LIMITS,
  ArchiveContentError,
  ArchiveError,
  type ArchiveLimits,
  archiveHttpError,
} from './limits.js';
import { expectNames, inflateCounter, openArchive, UUID_ENTRY } from './read.js';
import { shouldCompress, writeArchive } from './write.js';

// The safe archive module (plan T7; spike Z1, docs/spikes/2026-09-30-step7-archive.md). Every
// hostile archive is made here, byte by byte (test/zip-forge.ts), never downloaded.
// The local store always runs; RustFS (compose.dev.yaml, profile s3, port 9452) runs when it
// answers, and must when KEPT_TEST_S3_URL is set (as storage/s3.test.ts).

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'kept-zip-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Counts every stream() call: one GET on S3. */
function counting(store: BlobStore): BlobStore & { gets: number; ranges: BlobRange[] } {
  const counted = {
    gets: 0,
    ranges: [] as BlobRange[],
    put: store.put.bind(store),
    delete: store.delete.bind(store),
    exists: store.exists.bind(store),
    signedUrl: store.signedUrl.bind(store),
    stream(key: string, range?: BlobRange) {
      counted.gets++;
      if (range) counted.ranges.push(range);
      return store.stream(key, range);
    },
  };
  return counted;
}

async function stored(store: BlobStore, bytes: Buffer): Promise<{ key: string; size: number }> {
  const key = importArchiveKey(newId());
  const file = path.join(scratch, `${newId()}.zip`);
  await writeFile(file, bytes);
  await store.put(key, file, { contentType: 'application/zip', bytes: bytes.length });
  await rm(file);
  return { key, size: bytes.length };
}

const MANIFEST = { name: 'manifest.json', data: Buffer.from('{"schemaVersion":1}\n') };
const ATTACHMENT = UUID_ENTRY('attachments');
const EXPECT = expectNames(['manifest.json', 'entities.json', 'data/things.ndjson'], [ATTACHMENT]);

async function refusal(promise: Promise<unknown>): Promise<ArchiveError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ArchiveError);
  return err as ArchiveError;
}

type Hostile = {
  name: string;
  bytes: () => Buffer;
  reason: (typeof ARCHIVE_REFUSALS)[number];
  limits?: Partial<ArchiveLimits>;
};

const hostile: Hostile[] = [
  {
    // 64 MiB of zeros deflates to about 64 KB: 1000 : 1, honestly declared.
    name: 'a bomb by ratio (declared)',
    bytes: () => forgeZip([MANIFEST, { name: 'entities.json', data: Buffer.alloc(64 << 20) }]),
    reason: 'ratio',
  },
  {
    name: 'a symlink (made by Unix, mode 0120777)',
    bytes: () =>
      forgeZip([
        MANIFEST,
        {
          name: `attachments/${newId()}`,
          data: Buffer.from('/etc/passwd'),
          madeBy: 3,
          unixMode: 0o120777,
        },
      ]),
    reason: 'symlink',
  },
  {
    name: 'path traversal: ../x',
    bytes: () => forgeZip([MANIFEST, { name: '../x', data: Buffer.from('x') }]),
    reason: 'bad_name',
  },
  {
    name: 'path traversal: attachments/../../x',
    bytes: () => forgeZip([MANIFEST, { name: 'attachments/../../x', data: Buffer.from('x') }]),
    reason: 'bad_name',
  },
  {
    name: 'an absolute path',
    bytes: () => forgeZip([MANIFEST, { name: '/etc/x', data: Buffer.from('x') }]),
    reason: 'bad_name',
  },
  {
    name: 'a backslash',
    bytes: () => forgeZip([MANIFEST, { name: 'a\\..\\b', data: Buffer.from('x') }]),
    reason: 'bad_name',
  },
  {
    name: 'a duplicate name',
    bytes: () => forgeZip([MANIFEST, { ...MANIFEST, data: Buffer.from('{"schemaVersion":2}') }]),
    reason: 'duplicate_name',
  },
  {
    name: 'an encrypted entry',
    bytes: () =>
      forgeZip([MANIFEST, { name: 'entities.json', data: Buffer.from('[]'), flags: 0x1 }]),
    reason: 'encrypted',
  },
  {
    name: 'too many entries (limit lowered to 10)',
    bytes: () =>
      forgeZip(
        Array.from({ length: 11 }, (_, i) => ({ name: `attachments/${i}`, data: Buffer.alloc(0) })),
      ),
    reason: 'too_many_entries',
    limits: { entries: 10 },
  },
  {
    name: 'too large in total (declared; limit lowered to 1 MiB)',
    bytes: () =>
      forgeZip([
        MANIFEST,
        { name: 'entities.json', data: randomBytes(700_000), method: 0 },
        { name: `attachments/${newId()}`, data: randomBytes(700_000), method: 0 },
      ]),
    reason: 'too_large',
    limits: { uncompressedBytes: 1 << 20 },
  },
  {
    name: 'a truncated archive',
    bytes: () => {
      const whole = forgeZip([MANIFEST, { name: 'entities.json', data: randomBytes(64 << 10) }]);
      return whole.subarray(0, whole.length >> 1);
    },
    reason: 'truncated',
  },
  {
    name: 'not a ZIP at all',
    bytes: () => randomBytes(4096),
    reason: 'truncated',
  },
];

function suite(label: string, makeStore: () => BlobStore) {
  describe(`${label}: hostile archives`, () => {
    for (const h of hostile) {
      it(`refuses ${h.name} as ${h.reason}, before inflating anything`, async () => {
        const store = counting(makeStore());
        const { key, size } = await stored(store, h.bytes());
        const err = await refusal(
          openArchive(store, key, size, {
            expect: EXPECT,
            ...(h.limits ? { limits: h.limits } : {}),
          }),
        );
        expect(err.reason).toBe(h.reason);
        // Only ranged block reads of the directory: no entry's data was fetched.
        expect(store.ranges.every((r) => r.end - r.start < 1 << 20)).toBe(true);
      });
    }

    it('refuses a header that understates its size once 1,000 bytes are out (ratio)', async () => {
      const store = makeStore();
      // 10 MiB of zeros declared as 1,000 bytes in both headers.
      const bytes = forgeZip([
        MANIFEST,
        { name: 'entities.json', data: Buffer.alloc(10 << 20), declaredSize: 1000 },
      ]);
      const { key, size } = await stored(store, bytes);
      const archive = await openArchive(store, key, size, { expect: EXPECT });
      const err = await refusal(streamBuffer(await archive.read('entities.json')));
      expect(err.reason).toBe('ratio');
      // The counter never saw more than was declared: yauzl stopped the stream there.
      expect(archive.inflatedBytes()).toBeLessThanOrEqual(1000);
      archive.close();
    });

    it('refuses an archive over the upload cap before a single read', async () => {
      const store = counting(makeStore());
      const err = await refusal(
        openArchive(store, importArchiveKey(newId()), ZIP_LIMITS.archiveBytes + 1, {
          expect: EXPECT,
        }),
      );
      expect(err.reason).toBe('too_large');
      expect(store.gets).toBe(0);
    });

    it('opens a nested archive as bytes, never as a ZIP', async () => {
      const store = makeStore();
      const inner = forgeZip([{ name: '../../escape', data: Buffer.from('nope') }]);
      const id = newId();
      const { key, size } = await stored(
        store,
        forgeZip([MANIFEST, { name: `attachments/${id}`, data: inner }]),
      );
      const archive = await openArchive(store, key, size, { expect: EXPECT });
      const names: string[] = [];
      for await (const e of archive.entries()) names.push(e.name);
      expect(names).toEqual(['manifest.json', `attachments/${id}`]);
      expect(await streamBuffer(await archive.read(`attachments/${id}`))).toEqual(inner);
      archive.close();
    });

    it('reads a good archive by expected names only, and counts the rest as ignored', async () => {
      const store = counting(makeStore());
      const id = newId();
      const photo = randomBytes(300_000);
      const lines = [
        { id: '1', name: 'Drill' },
        { id: '2', name: 'مثقاب, "كبير"' },
        { id: '3', name: 'Ladder\r\nwith a break' },
      ];
      const ndjson = `${lines.map((l) => JSON.stringify(l)).join('\r\n')}\r\n\r\n`;
      const { key, size } = await stored(
        store,
        forgeZip([
          { name: 'folder/', data: Buffer.alloc(0), method: 0 },
          MANIFEST,
          { name: 'data/things.ndjson', data: Buffer.from(ndjson) },
          { name: `attachments/${id}`, data: photo, method: 0 },
          { name: 'attachments/not-a-uuid.jpg', data: Buffer.from('x') },
          { name: 'notes.txt', data: Buffer.from('ignored') },
        ]),
      );
      const archive = await openArchive(store, key, size, { expect: EXPECT });
      expect(archive.entryCount).toBe(6);
      expect(archive.ignored).toBe(2);
      expect(archive.has('notes.txt')).toBe(false);
      expect(
        await archive.json('manifest.json', z.object({ schemaVersion: z.literal(1) })),
      ).toEqual({
        schemaVersion: 1,
      });
      const Row = z.object({ id: z.string(), name: z.string() });
      const rows = [];
      for await (const row of archive.ndjson('data/things.ndjson', Row)) rows.push(row);
      expect(rows).toEqual(lines);
      expect(await streamBuffer(await archive.read(`attachments/${id}`))).toEqual(photo);
      await expect(archive.read('notes.txt')).rejects.toBeInstanceOf(ArchiveContentError);
      await expect(
        archive.json('manifest.json', z.object({ schemaVersion: z.literal(2) })),
      ).rejects.toMatchObject({
        problem: 'schema',
      });
      archive.close();
    });
  });
}

const local = () =>
  new LocalBlobStore({ dataDir: scratch, signer: createUrlSigner(Buffer.alloc(32, 7)) });
suite('LocalBlobStore', local);

// RustFS, as storage/s3.test.ts reaches it.
const S3_URL = process.env.KEPT_TEST_S3_URL || 'http://localhost:9452';
const S3_REQUIRED = Boolean(process.env.KEPT_TEST_S3_URL);
const s3Live = await fetch(S3_URL, { signal: AbortSignal.timeout(2_000) }).then(
  () => true,
  () => false,
);
if (!s3Live && !S3_REQUIRED) {
  it.skip(`the archive reader on S3: nothing answers at ${S3_URL}`, () => {});
}
describe.skipIf(!s3Live && !S3_REQUIRED)('S3BlobStore', () => {
  const bucket = `kept-zip-${randomBytes(6).toString('hex')}`;
  const store = new S3BlobStore({
    bucket,
    region: 'us-east-1',
    endpoint: S3_URL,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.KEPT_TEST_S3_ACCESS_KEY_ID || 'kept-dev',
      secretAccessKey: process.env.KEPT_TEST_S3_SECRET_ACCESS_KEY || 'kept-dev-secret',
    },
  });
  beforeAll(async () => {
    await store.ensureBucket();
  });
  afterAll(async () => {
    const { DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } = await import(
      '@aws-sdk/client-s3'
    );
    for (;;) {
      const listed = await store.client.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length === 0) break;
      await store.client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
      );
    }
    await store.client.send(new DeleteBucketCommand({ Bucket: bucket }));
    store.destroy();
  });
  suite('S3BlobStore', () => store);
  bigDirectory('S3BlobStore', () => store);
});

/** 200,001 entries (ZIP64 by count; yazl takes minutes to make as many). */
function manyEntries(): Buffer {
  return forgeZip([
    MANIFEST,
    ...Array.from({ length: 200_000 }, (_, i) => ({
      name: `attachments/${String(i).padStart(6, '0')}`,
      method: 0 as const,
    })),
  ]);
}

function bigDirectory(label: string, makeStore: () => BlobStore) {
  describe(`${label}: a 200,001-entry directory`, () => {
    let big: { key: string; size: number };
    beforeAll(async () => {
      big = await stored(makeStore(), manyEntries());
    }, 60_000);

    it('is refused from the end record alone, with no directory read', async () => {
      const store = counting(makeStore());
      const err = await refusal(openArchive(store, big.key, big.size, { expect: EXPECT }));
      expect(err.reason).toBe('too_many_entries');
      expect(store.gets).toBeLessThanOrEqual(2);
    });

    it('costs at most 15 GETs to read whole (the 1 MiB block cache), under a raised limit', async () => {
      const store = counting(makeStore());
      const archive = await openArchive(store, big.key, big.size, {
        expect: EXPECT,
        limits: { entries: 200_001 },
      });
      expect(archive.entryCount).toBe(200_001);
      expect(archive.ignored).toBe(200_000);
      expect(await text(await archive.read('manifest.json'))).toBe(MANIFEST.data.toString());
      expect(store.gets).toBeLessThanOrEqual(16);
      archive.close();
    }, 60_000);
  });
}
bigDirectory('LocalBlobStore', local);

describe('inflateCounter: the rule on the bytes that came out', () => {
  const limits: ArchiveLimits = {
    ...ARCHIVE_LIMITS,
    ratioFloorBytes: 1024,
    uncompressedBytes: 8192,
  };
  const pump = (t: ReturnType<typeof inflateCounter>, chunks: number[]) =>
    streamBuffer(Readable.from(chunks.map((n) => Buffer.alloc(n))).pipe(t));

  it('judges the ratio only past the floor', async () => {
    // 1,000 bytes from 1 is 1000 : 1, but under the 1 KiB floor: fine.
    await expect(
      pump(inflateCounter('a', 1, limits, { inflated: 0 }), [1000]),
    ).resolves.toHaveLength(1000);
    await expect(
      pump(inflateCounter('a', 1, limits, { inflated: 0 }), [1000, 1000]),
    ).rejects.toMatchObject({
      reason: 'ratio',
    });
    // 2,000 from 100 is 20 : 1: fine.
    await expect(
      pump(inflateCounter('a', 100, limits, { inflated: 0 }), [1000, 1000]),
    ).resolves.toHaveLength(2000);
  });

  it('stops at the archive total across entries', async () => {
    const budget = { inflated: 0 };
    await pump(inflateCounter('a', 4096, limits, budget), [4096, 1024]);
    await expect(pump(inflateCounter('b', 4096, limits, budget), [4096])).rejects.toMatchObject({
      reason: 'too_large',
    });
  });
});

describe('writeArchive', () => {
  it('writes an archive that reads back through openArchive with identical bytes', async () => {
    const store = local();
    const id = newId();
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(200_000)]);
    const csv = '﻿name\r\nمثقاب\r\n';
    const file = path.join(scratch, `${newId()}.zip`);
    const out = await writeArchive(file, async (zip) => {
      zip.addBuffer('manifest.json', MANIFEST.data);
      zip.addBuffer('data/things.ndjson', '{"id":"1"}\n');
      zip.addStream(`attachments/${id}`, () => Readable.from([photo]), {
        contentType: 'image/jpeg',
      });
      zip.addBuffer('readable/things.csv', csv);
    });
    const bytes = await readFile(file);
    expect(out.bytes).toBe(bytes.length);
    expect(out.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // Stored or deflated by type; the same mtime and mode 0600 on every entry.
    const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true });
    const methods: Record<string, number> = {};
    for await (const e of zip.eachEntry()) {
      methods[e.fileName] = e.compressionMethod;
      expect((e.externalFileAttributes >>> 16) & 0o777).toBe(0o600);
    }
    zip.close();
    expect(methods).toEqual({
      'manifest.json': 8,
      'data/things.ndjson': 8,
      [`attachments/${id}`]: 0,
      'readable/things.csv': 8,
    });

    const { key, size } = await stored(store, bytes);
    const archive = await openArchive(store, key, size, {
      expect: expectNames(
        ['manifest.json', 'data/things.ndjson', 'readable/things.csv'],
        [ATTACHMENT],
      ),
    });
    expect(await streamBuffer(await archive.read(`attachments/${id}`))).toEqual(photo);
    expect(await streamBuffer(await archive.read('readable/things.csv'))).toEqual(
      Buffer.from(csv, 'utf8'),
    );
    archive.close();
  });

  it('writes the same bytes for the same contents', async () => {
    const build = (zip: Parameters<Parameters<typeof writeArchive>[1]>[0]) => {
      zip.addBuffer('manifest.json', MANIFEST.data);
      zip.addBuffer('a.json', '[]');
    };
    const a = await writeArchive(path.join(scratch, `${newId()}.zip`), build);
    const b = await writeArchive(path.join(scratch, `${newId()}.zip`), build);
    expect(a.sha256).toBe(b.sha256);
  });

  it('removes the partial file when a source fails', async () => {
    const file = path.join(scratch, `${newId()}.zip`);
    await expect(
      writeArchive(file, (zip) => {
        zip.addBuffer('manifest.json', MANIFEST.data);
        zip.addStream(`attachments/${newId()}`, () => {
          throw new Error('the blob is gone');
        });
      }),
    ).rejects.toThrow('the blob is gone');
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stores photos and PDFs, deflates text', () => {
    expect(shouldCompress('x', 'image/jpeg')).toBe(false);
    expect(shouldCompress('x', 'application/pdf')).toBe(false);
    expect(shouldCompress('x', 'text/csv; charset=utf-8')).toBe(true);
    expect(shouldCompress('index.html')).toBe(true);
    expect(shouldCompress('photo.HEIC')).toBe(false);
  });
});

describe('errors', () => {
  it('maps a size refusal to 413 and every other to 400, with the reason and no detail', () => {
    const big = archiveHttpError(new ArchiveError('too_large', 'secret/name.txt'));
    expect(big).toBeInstanceOf(AppError);
    expect(big.status).toBe(413);
    expect(big.code).toBe('archive_too_large');
    expect(big.extra).toEqual({ reason: 'too_large' });
    for (const reason of ARCHIVE_REFUSALS.filter((r) => r !== 'too_large')) {
      const e = archiveHttpError(new ArchiveError(reason, '../x'));
      expect([e.status, e.code, e.extra]).toEqual([400, 'archive_invalid', { reason }]);
    }
  });
});

describe('names never become paths', () => {
  // Nothing from an archive becomes a storage key or a path on disk (D157): the archive module
  // and the importers never join or resolve a path.
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dirs = ['portability/zip', 'imports/homebox', 'imports/kept'].map((d) => path.join(src, d));
  const files = dirs.flatMap((d) => {
    try {
      return readdirSync(d)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => path.join(d, f));
    } catch {
      return [];
    }
  });

  it('has no path.join, path.resolve or node:path import in those modules', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      if (!statSync(f).isFile()) continue;
      const source = readFileSync(f, 'utf8');
      expect(source, f).not.toMatch(/\bpath\.(join|resolve)\(|from 'node:path'|from 'path'/);
    }
  });
});
