import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.js';
import {
  assertBlobKey,
  BlobNotFoundError,
  type BlobRange,
  type BlobStore,
  type SignedUrlOptions,
} from './blob-store.js';
import { contentDisposition } from './disposition.js';

// Moved to disposition.ts so /f/<token> can use it without loading the AWS SDK; re-exported.
export { contentDisposition };

// The S3 driver (KEPT_STORAGE=s3, Q18): the same BlobStore as local.ts, on any S3-compatible
// store (AWS, RustFS, MinIO, Garage, R2). Keys are the same id-built keys, checked the same way
// (assertBlobKey), so a bucket holds `f/<locationId>/<fileId>` and `d/<fileId>/<variant>.jpg`
// and nothing else. Files reach the browser through presigned GETs (D157), which carry the
// disposition and type as `response-content-*` overrides, so the bucket never has to store them.
//
// Checksums: SDK 3.7xx+ defaults to flexible checksums on every request (aws-chunked uploads
// with a CRC trailer, `x-amz-checksum-mode` on reads). Several S3-compatible stores reject or
// mangle those, so both are limited to the operations that require them. The upload's
// integrity is the caller's (T17 checks the SHA-256 before `put`) plus the byte count here and
// the request's Content-Length, which the store enforces.

/** A presigned URL's longest life: a day, the same bound as the local signer. */
const MAX_TTL_SECONDS = 86_400;

export type S3BlobStoreOptions = {
  bucket: string;
  region: string;
  /** Empty for AWS itself; e.g. `http://localhost:9452` for the dev RustFS. */
  endpoint?: string | undefined;
  /** Path-style URLs (`<endpoint>/<bucket>/<key>`): RustFS, MinIO and most self-hosted S3. */
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** KEPT_S3_PUBLIC_ENDPOINT: the endpoint the browser reaches, when it isn't `endpoint` (the
   * server talks to `http://rustfs:9000` inside Compose; the phone needs the public host).
   * Presigned URLs are signed for this host; everything else uses `endpoint`. */
  publicEndpoint?: string | undefined;
  /** A ready client (tests); otherwise one is built from the options above. */
  client?: S3Client;
};

/** The driver's options from KEPT_S3_*. loadEnv() already refused KEPT_STORAGE=s3 without the
 * bucket and both credentials; this checks again so the types hold. */
export function s3OptionsFromEnv(env: Env): S3BlobStoreOptions {
  const bucket = env.KEPT_S3_BUCKET;
  const accessKeyId = env.KEPT_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.KEPT_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'KEPT_STORAGE=s3 needs KEPT_S3_BUCKET, KEPT_S3_ACCESS_KEY_ID and KEPT_S3_SECRET_ACCESS_KEY',
    );
  }
  return {
    bucket,
    region: env.KEPT_S3_REGION,
    endpoint: env.KEPT_S3_ENDPOINT,
    publicEndpoint: env.KEPT_S3_PUBLIC_ENDPOINT,
    forcePathStyle: env.KEPT_S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId, secretAccessKey },
  };
}

/** An inclusive byte range as an HTTP Range header value. */
function rangeHeader(range: BlobRange): string {
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError('a blob range is 0 <= start <= end, whole bytes');
  }
  return `bytes=${start}-${end}`;
}

/** No such object. Not a missing bucket: that is a misconfiguration and must surface. */
function isMissingObject(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  if (e?.name === 'NoSuchKey' || e?.name === 'NotFound') return true;
  return e?.$metadata?.httpStatusCode === 404 && e.name !== 'NoSuchBucket';
}

export class S3BlobStore implements BlobStore {
  readonly bucket: string;
  readonly client: S3Client;
  /** Signs the browser's URLs: `client` unless KEPT_S3_PUBLIC_ENDPOINT names another host. */
  readonly presigner: S3Client;

  constructor(opts: S3BlobStoreOptions) {
    this.bucket = opts.bucket;
    const clientFor = (endpoint: string | undefined) =>
      new S3Client({
        region: opts.region,
        ...(endpoint ? { endpoint } : {}),
        forcePathStyle: opts.forcePathStyle,
        credentials: opts.credentials,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    this.client = opts.client ?? clientFor(opts.endpoint);
    this.presigner =
      opts.publicEndpoint && opts.publicEndpoint !== opts.endpoint
        ? clientFor(opts.publicEndpoint)
        : this.client;
  }

  static fromEnv(env: Env): S3BlobStore {
    return new S3BlobStore(s3OptionsFromEnv(env));
  }

  async put(key: string, file: string, opts: { contentType: string; bytes: number }) {
    assertBlobKey(key);
    // Refused before anything is sent, so a short or long temp file never becomes a blob.
    const { size } = await stat(file);
    if (size !== opts.bytes) throw new Error(`blob is ${size} bytes, expected ${opts.bytes}`);
    const body = createReadStream(file);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: opts.bytes,
          ContentType: opts.contentType,
        }),
      );
    } finally {
      body.destroy();
    }
  }

  async stream(key: string, range?: BlobRange): Promise<Readable> {
    assertBlobKey(key);
    const Range = range ? rangeHeader(range) : undefined;
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(Range ? { Range } : {}) }),
      );
      if (!(out.Body instanceof Readable)) throw new Error('S3 returned no readable body');
      return out.Body;
    } catch (err) {
      if (isMissingObject(err)) throw new BlobNotFoundError();
      throw err;
    }
  }

  async delete(key: string) {
    assertBlobKey(key);
    try {
      // S3 answers 204 for a key that isn't there; some compatible stores answer 404.
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (!isMissingObject(err)) throw err;
    }
  }

  async exists(key: string) {
    assertBlobKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isMissingObject(err)) return false;
      throw err;
    }
  }

  async signedUrl(key: string, opts: SignedUrlOptions) {
    assertBlobKey(key);
    if (
      !Number.isInteger(opts.expiresIn) ||
      opts.expiresIn < 1 ||
      opts.expiresIn > MAX_TTL_SECONDS
    ) {
      throw new RangeError(`a signed URL's lifetime is 1 to ${MAX_TTL_SECONDS} seconds`);
    }
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(opts.disposition, opts.filename),
        ResponseContentType: opts.contentType,
        // The same caching as `/f/<token>` (T17): the URL dies in minutes, so must the copy.
        ResponseCacheControl: `private, max-age=${opts.expiresIn}`,
      }),
      { expiresIn: opts.expiresIn },
    );
  }

  /** Creates the bucket when it isn't there (dev, CI and tests; production buckets are made by
   * whoever runs the store). */
  async ensureBucket() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) throw err;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  /** Closes the client's sockets (shutdown, tests). */
  destroy() {
    this.client.destroy();
    if (this.presigner !== this.client) this.presigner.destroy();
  }
}
