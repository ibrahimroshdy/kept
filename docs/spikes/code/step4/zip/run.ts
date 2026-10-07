// Step-4 spike T0: the claim pack's ZIP (D158, D201). yazl 3.3.1 writes a report PDF plus 200
// files read from the blob store (the local driver, and the S3 driver on the dev RustFS at 9452)
// into one ZIP, and the result is stored as one blob. Records time, the process's peak resident
// memory, and whether yazl's outputStream can go straight into the store. Run from apps/server
// with RustFS up (docker compose -f compose.dev.yaml --profile s3 up -d s3):
//   pnpm exec tsx ../../docs/spikes/code/step4/zip/run.ts
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { originalKey, type BlobStore } from '../../../../../apps/server/src/storage/blob-store.ts';
import { LocalBlobStore } from '../../../../../apps/server/src/storage/local.ts';
import { S3BlobStore } from '../../../../../apps/server/src/storage/s3.ts';
import type { UrlSigner } from '../../../../../apps/server/src/storage/signed-url.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.resolve(here, '../../../../../apps/server/package.json'));
const sharp = req('sharp') as typeof import('sharp');
const yazl = req('yazl') as typeof import('yazl');
const { DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = req('@aws-sdk/client-s3') as typeof import('@aws-sdk/client-s3');

const N = 200;
const location = randomUUID();
const work = await mkdtemp(path.join(tmpdir(), 'kept-zip-'));
const bucket = `kept-spike-zip-${Date.now()}`;
let peak = 0;
const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
const mb = (b: number) => Math.round(b / 1024 / 1024);

// 200 photo-like JPEGs (noise, so they don't compress) and a 1 MB "report".
const files: { key: string; name: string; bytes: number; tmp: string }[] = [];
for (let i = 0; i < N; i++) {
  const tmp = path.join(work, `src-${i}.jpg`);
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#888', noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg({ quality: 80 }).toFile(tmp);
  files.push({ key: originalKey(location, randomUUID()), name: `photos/${String(i).padStart(3, '0')}-photo.jpg`, bytes: (await stat(tmp)).size, tmp });
}
const report = randomBytes(1024 * 1024);
const total = files.reduce((a, f) => a + f.bytes, 0) + report.length;
console.log(`sources: ${N} JPEGs, ${mb(total)} MB with the report`);

const local = new LocalBlobStore({ dataDir: path.join(work, 'data'), signer: {} as UrlSigner });
const s3 = new S3BlobStore({ bucket, region: 'us-east-1', endpoint: 'http://localhost:9452', forcePathStyle: true, credentials: { accessKeyId: 'kept-dev', secretAccessKey: 'kept-dev-secret' } });
await s3.ensureBucket();
for (const f of files) {
  await local.put(f.key, f.tmp, { contentType: 'image/jpeg', bytes: f.bytes });
  await s3.put(f.key, f.tmp, { contentType: 'image/jpeg', bytes: f.bytes });
}

function zipOf(store: BlobStore, compress: boolean) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(report, 'insurance-report.pdf', { compress });
  for (const f of files) {
    zip.addReadStreamLazy(f.name, { size: f.bytes, compress }, (cb) => {
      store.stream(f.key).then((s: Readable) => cb(null, s), (e: unknown) => cb(e, undefined as never));
    });
  }
  const size = new Promise<number>((resolve) => zip.end(undefined, ((n: number) => resolve(n)) as () => void));
  return { stream: zip.outputStream as unknown as Readable, size };
}

async function measure(label: string, fn: () => Promise<{ bytes: number; expected: number }>) {
  if (global.gc) global.gc();
  peak = process.memoryUsage().rss;
  const before = peak;
  const t0 = performance.now();
  const r = await fn();
  console.log(`${label}: ${Math.round(performance.now() - t0)} ms, ${mb(r.bytes)} MB zip (calculated ${r.expected === -1 ? 'unknown (-1)' : `${r.expected} = ${r.expected === r.bytes ? 'exact' : 'WRONG'}`}), rss ${mb(before)} → peak ${mb(peak)} MB`);
}

const spool = path.join(work, 'pack.zip');
// A. Local store → temp file → put (the BlobStore API takes a file and its size).
await measure('A local → spool file → put', async () => {
  const { stream, size } = zipOf(local, false);
  await pipeline(stream, createWriteStream(spool));
  const bytes = (await stat(spool)).size;
  return { bytes, expected: await size };
});
execFileSync('unzip', ['-tq', spool], { stdio: 'inherit' });
// B. S3 store → temp file → PutObject with the file (what S3BlobStore.put does).
await measure('B s3 → spool file → PutObject', async () => {
  const { stream, size } = zipOf(s3, false);
  await pipeline(stream, createWriteStream(spool));
  const bytes = (await stat(spool)).size;
  await s3.client.send(new PutObjectCommand({ Bucket: bucket, Key: 'x/spooled.zip', Body: createReadStream(spool), ContentLength: bytes, ContentType: 'application/zip' }));
  return { bytes, expected: await size };
});
// C. S3 store → PutObject straight from outputStream, ContentLength from yazl's calculated size.
await measure('C s3 → outputStream straight into PutObject', async () => {
  const { stream, size } = zipOf(s3, false);
  const expected = await size;
  await s3.client.send(new PutObjectCommand({ Bucket: bucket, Key: 'x/direct.zip', Body: stream, ContentLength: expected, ContentType: 'application/zip' }));
  const head = await s3.client.send(new GetObjectCommand({ Bucket: bucket, Key: 'x/direct.zip' }));
  await pipeline(head.Body as Readable, createWriteStream(spool));
  return { bytes: (await stat(spool)).size, expected };
});
execFileSync('unzip', ['-tq', spool], { stdio: 'inherit' });
// D. Compression on (deflate), for comparison: the size can't be known up front.
await measure('D local, deflate on → spool file', async () => {
  const { stream, size } = zipOf(local, true);
  await pipeline(stream, createWriteStream(spool));
  return { bytes: (await stat(spool)).size, expected: await size };
});

clearInterval(sample);
// Clean up: the spike's bucket and its objects, and the temp directory.
const listed = await s3.client.send(new ListObjectsV2Command({ Bucket: bucket }));
for (const o of listed.Contents ?? []) await s3.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
let more = await s3.client.send(new ListObjectsV2Command({ Bucket: bucket }));
while ((more.Contents ?? []).length) {
  for (const o of more.Contents ?? []) await s3.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
  more = await s3.client.send(new ListObjectsV2Command({ Bucket: bucket }));
}
await s3.client.send(new DeleteBucketCommand({ Bucket: bucket }));
s3.destroy();
await rm(work, { recursive: true, force: true });
console.log('cleaned up');
