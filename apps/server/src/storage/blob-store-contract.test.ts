import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { blobStoreContract } from '../../test/blob-store-contract.js';
import { LocalBlobStore } from './local.js';
import { createUrlSigner } from './signed-url.js';

// The shared BlobStore contract against the local driver, the reference the S3 driver is held
// to (storage/s3.test.ts). The local driver's own details are in local.test.ts.

let dataDir: string | undefined;
afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

blobStoreContract('LocalBlobStore', async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'kept-blobs-'));
  return new LocalBlobStore({ dataDir, signer: createUrlSigner(Buffer.alloc(32, 7)) });
});
