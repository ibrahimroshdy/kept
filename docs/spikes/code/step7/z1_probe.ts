/** Z1 extras: the inflate-time counters alone, and the GETs a 200,001-entry directory costs on S3. */
import { randomBytes, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { S3BlobStore } from '../../../../apps/server/src/storage/s3.ts';
import { ArchiveRefused, Budget, openArchive, readEntry } from './z1_reader.ts';

const s3 = new S3BlobStore({
  bucket: `kept-z1-${randomBytes(4).toString('hex')}`,
  region: 'us-east-1',
  endpoint: process.env.KEPT_TEST_S3_URL || 'http://localhost:9452',
  forcePathStyle: true,
  credentials: { accessKeyId: 'kept-dev', secretAccessKey: 'kept-dev-secret' },
});
await s3.ensureBucket();
const [file, mode] = process.argv.slice(2);
const size = statSync(file).size;
const key = `r/${randomUUID()}.pdf`;
await s3.put(key, file, { contentType: 'application/zip', bytes: size });
const budget = new Budget();
const t0 = performance.now();
let out: Record<string, unknown> = {};
try {
  const a = await openArchive(s3, key, size);
  out = { entries: a.entries.size, afterDirectory: { ...a.reader.stats } };
  if (mode === 'manifest') await readEntry(a, a.entries.get('manifest.json')!, budget);
  else for (const e of a.entries.values()) await readEntry(a, e, budget);
  out.result = 'ok';
  out.stats = a.reader.stats;
  a.zip.close();
} catch (e) {
  if (!(e instanceof ArchiveRefused)) throw e;
  out.result = `REFUSED ${e.message}`;
}
out.inflated = budget.inflated;
out.ms = Math.round(performance.now() - t0);
out.size = size;
console.log(JSON.stringify(out));
await s3.delete(key);
const { createRequire } = await import('node:module');
const { DeleteBucketCommand } = createRequire(new URL('../../../../apps/server/package.json', import.meta.url))('@aws-sdk/client-s3');
await s3.client.send(new DeleteBucketCommand({ Bucket: s3.bucket }));
s3.destroy();
