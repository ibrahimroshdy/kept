/**
 * Z1 harness: every fixture through openArchive() + readEntry() on the local BlobStore and on S3
 * (RustFS, compose.dev.yaml's `s3` profile, port 9452).
 *
 *   apps/server/node_modules/.bin/tsx docs/spikes/code/step7/z1_run.ts <dir-of-zips>...
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalBlobStore } from '../../../../apps/server/src/storage/local.ts';
import { S3BlobStore } from '../../../../apps/server/src/storage/s3.ts';
import { createUrlSigner } from '../../../../apps/server/src/storage/signed-url.ts';
import type { BlobStore } from '../../../../apps/server/src/storage/blob-store.ts';
import { ArchiveRefused, Budget, openArchive, readEntry } from './z1_reader.ts';

const dataDir = mkdtempSync(path.join(tmpdir(), 'kept-z1-'));
const local = new LocalBlobStore({ dataDir, signer: createUrlSigner(randomBytes(32)) });
const bucket = `kept-z1-${randomBytes(4).toString('hex')}`;
const s3 = new S3BlobStore({
  bucket,
  region: 'us-east-1',
  endpoint: process.env.KEPT_TEST_S3_URL || 'http://localhost:9452',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.KEPT_TEST_S3_ACCESS_KEY_ID || 'kept-dev',
    secretAccessKey: process.env.KEPT_TEST_S3_SECRET_ACCESS_KEY || 'kept-dev-secret',
  },
});

// There is no `i/<runId>.zip` key shape yet (T2 adds it); a report key has the same id-only shape.
const keyFor = () => `r/${randomUUID()}.pdf`;

async function run(store: BlobStore, name: string, file: string) {
  const size = statSync(file).size;
  const key = keyFor();
  await store.put(key, file, { contentType: 'application/zip', bytes: size });
  const budget = new Budget();
  const t0 = performance.now();
  let result = 'ok';
  let stats = { gets: 0, bytesFetched: 0, metaGets: 0, dataGets: 0 };
  let entries = 0;
  try {
    const a = await openArchive(store, key, size);
    stats = a.reader.stats;
    entries = a.entries.size;
    for (const e of a.entries.values()) await readEntry(a, e, budget);
    a.zip.close();
  } catch (e) {
    if (!(e instanceof ArchiveRefused)) throw e;
    result = `REFUSED ${e.message.slice(0, 110)}`;
  }
  const ms = Math.round(performance.now() - t0);
  await store.delete(key);
  return { name, size, entries, inflated: budget.inflated, ms, ...stats, result };
}

async function onlyManifest(store: BlobStore, name: string, file: string) {
  // "Reads the central directory and one entry with ranged GETs only."
  const size = statSync(file).size;
  const key = keyFor();
  await store.put(key, file, { contentType: 'application/zip', bytes: size });
  const a = await openArchive(store, key, size);
  const budget = new Budget();
  let bytes = 0;
  await readEntry(a, a.entries.get('manifest.json')!, budget, (c) => {
    bytes += c.length;
  });
  a.zip.close();
  await store.delete(key);
  return { name, size, manifestBytes: bytes, ...a.reader.stats };
}

await s3.ensureBucket();
const files = process.argv
  .slice(2)
  .flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.zip')).map((f) => path.join(d, f)))
  .sort();
for (const [label, store] of [
  ['local', local],
  ['s3', s3],
] as const) {
  console.log(`\n## ${label}`);
  for (const f of files) {
    const r = await run(store, path.basename(f), f);
    console.log(JSON.stringify(r));
  }
  for (const f of files.filter((f) => path.basename(f).startsWith('homebox-'))) {
    console.log('manifest only', JSON.stringify(await onlyManifest(store, path.basename(f), f)));
  }
}
const serverRequire = createRequire(new URL('../../../../apps/server/package.json', import.meta.url));
const { DeleteBucketCommand } = serverRequire('@aws-sdk/client-s3');
await s3.client.send(new DeleteBucketCommand({ Bucket: bucket }));
s3.destroy();
rmSync(dataDir, { recursive: true, force: true });
