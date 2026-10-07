import path from 'node:path';
import type { Env } from '../config/env.js';
import type { BlobStore, FileStorage } from './blob-store.js';
import { LocalBlobStore } from './local.js';
import { createUrlSigner, type UrlSigner } from './signed-url.js';
import { sweepStaleTemps } from './sweep.js';

/** The BlobStore KEPT_STORAGE names. The S3 driver is imported only when it is chosen, so a
 * local install (the default, and the Pi) never loads the AWS SDK. */
export async function createBlobStore(env: Env, signer: UrlSigner): Promise<BlobStore> {
  if (env.KEPT_STORAGE === 's3') {
    const { S3BlobStore } = await import('./s3.js');
    return S3BlobStore.fromEnv(env);
  }
  return new LocalBlobStore({ dataDir: env.KEPT_DATA_DIR, signer });
}

const MIB = 1024 * 1024;

/**
 * Everything the file routes need, from the environment (T17, wired by main.ts): the blob store,
 * the `/f/<token>` signer (HKDF of KEPT_AUTH_SECRET), the upload limit (KEPT_MAX_FILE_MB, in
 * MiB), the image concurrency (KEPT_IMAGE_CONCURRENCY, Q17) and the upload temp directory
 * (KEPT_DATA_DIR/tmp). With KEPT_STORAGE=s3 the bucket is created when it is missing, at boot,
 * so a misconfigured store fails the start and not the first upload (T18). What a crash left in
 * the temp directory, and a local store's half-written `.tmp` blobs, older than an hour, are
 * swept (storage/sweep.ts; security review #16); a sweep that fails doesn't stop the start.
 */
export async function createFileStorage(env: Env): Promise<FileStorage> {
  const signer = createUrlSigner(env.authSecret);
  const blobs = await createBlobStore(env, signer);
  if ('ensureBucket' in blobs && typeof blobs.ensureBucket === 'function') {
    await (blobs as { ensureBucket: () => Promise<void> }).ensureBucket();
  }
  const tmpDir = path.join(env.KEPT_DATA_DIR, 'tmp');
  await sweepStaleTemps({
    tmpDir,
    blobsRoot: blobs instanceof LocalBlobStore ? blobs.root : null,
  }).catch(() => 0);
  return {
    blobs,
    signer,
    maxFileBytes: env.KEPT_MAX_FILE_MB * MIB,
    imageConcurrency: env.KEPT_IMAGE_CONCURRENCY,
    tmpDir,
  };
}
