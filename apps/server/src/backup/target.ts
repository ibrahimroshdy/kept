import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// Where backups go (T31c, D207): a directory or an S3 bucket. Both hold the same names:
//
//   runs/<id>/db.dump         pg_dump, custom format
//   runs/<id>/manifest.json   written last: a run without one never finished, and is ignored
//   blobs/<blob key>          each file blob once, shared by every run that references it
//
// Names are built by the backup code from ids and blob keys only, and checked here again, so
// nothing a user named reaches a path or an object key. In a directory, files are 0600 and the
// directories Kept makes 0700: a backup holds every household's data (secret values stay sealed,
// but everything else is readable).

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const NAME = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

export function assertBackupName(name: string): string {
  if (!NAME.test(name) || name.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('not a backup name built by Kept');
  }
  return name;
}

export type BackupTarget = {
  /** For logs, the status page and the audit: `directory /backups`, `s3://bucket/prefix`. Never
   * a credential. */
  readonly description: string;
  readonly kind: 'dir' | 's3';
  /** Stores the local file `file` under `name`, replacing what was there. */
  put(name: string, file: string): Promise<void>;
  /** Copies `name` to the local file `file` (0600). */
  get(name: string, file: string): Promise<void>;
  read(name: string): Promise<Buffer>;
  exists(name: string): Promise<boolean>;
  /** Every name under `prefix` (`runs/`, `blobs/`), at any depth. */
  list(prefix: string): Promise<string[]>;
  remove(name: string): Promise<void>;
  /** The filesystem device a directory target sits on, for the same-disk warning (D66); null
   * for a bucket. */
  device(): Promise<number | null>;
};

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

export class LocalDirTarget implements BackupTarget {
  readonly kind = 'dir' as const;
  readonly root: string;
  readonly description: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
    this.description = `directory ${this.root}`;
  }

  #pathOf(name: string): string {
    const full = path.resolve(this.root, assertBackupName(name));
    if (!full.startsWith(`${this.root}${path.sep}`)) throw new Error('backup name escapes root');
    return full;
  }

  async #ensureDir(dir: string): Promise<void> {
    // mkdir's mode applies only to what it creates; every directory from the root down to `dir`
    // that Kept made is set to 0700 explicitly, whatever the umask.
    await mkdir(this.root, { recursive: true, mode: DIR_MODE });
    let current = this.root;
    for (const part of path.relative(this.root, dir).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        await mkdir(current, { mode: DIR_MODE });
        await chmod(current, DIR_MODE);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }

  async put(name: string, file: string) {
    const dest = this.#pathOf(name);
    await this.#ensureDir(path.dirname(dest));
    const tmp = `${dest}.${randomUUID()}.tmp`;
    try {
      await copyFile(file, tmp);
      await chmod(tmp, FILE_MODE);
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(name: string, file: string) {
    await pipeline(
      createReadStream(this.#pathOf(name)),
      createWriteStream(file, { mode: FILE_MODE }),
    );
  }

  read(name: string) {
    return readFile(this.#pathOf(name));
  }

  async exists(name: string) {
    try {
      return (await stat(this.#pathOf(name))).isFile();
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async list(prefix: string) {
    const base = this.#pathOf(prefix.replace(/\/$/, ''));
    let entries: string[];
    try {
      entries = await readdir(base, { recursive: true });
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.endsWith('.tmp')) continue;
      const full = path.join(base, entry);
      if ((await stat(full)).isFile()) {
        out.push(path.relative(this.root, full).split(path.sep).join('/'));
      }
    }
    return out.sort();
  }

  async remove(name: string) {
    const file = this.#pathOf(name);
    await rm(file, { force: true });
    // Tidy the run's directory once it is empty; blobs/ keeps its directories.
    const dir = path.dirname(file);
    if (path.dirname(dir) === path.join(this.root, 'runs')) {
      await rmdir(dir).catch(() => {});
    }
  }

  async device() {
    await mkdir(this.root, { recursive: true, mode: DIR_MODE });
    return (await stat(this.root)).dev;
  }
}

export type S3TargetOptions = {
  bucket: string;
  /** Empty, or segments each ending in `/`. */
  prefix: string;
  region: string;
  endpoint?: string | undefined;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** A ready client (tests). */
  client?: S3Client;
};

/** The bucket target. The bucket must exist: backups never create one (a typo would otherwise
 * back up somewhere nobody looks). */
export class S3Target implements BackupTarget {
  readonly kind = 's3' as const;
  readonly bucket: string;
  readonly prefix: string;
  readonly client: S3Client;
  readonly description: string;

  constructor(opts: S3TargetOptions) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix;
    this.description = `s3://${opts.bucket}/${opts.prefix}`;
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region,
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        forcePathStyle: opts.forcePathStyle,
        credentials: opts.credentials,
        // As storage/s3.ts: several S3-compatible stores reject the SDK's default checksums.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
  }

  #key(name: string) {
    return `${this.prefix}${assertBackupName(name)}`;
  }

  async put(name: string, file: string) {
    const { size } = await stat(file);
    const body = createReadStream(file);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.#key(name),
          Body: body,
          ContentLength: size,
          ContentType: 'application/octet-stream',
        }),
      );
    } finally {
      body.destroy();
    }
  }

  async #body(name: string): Promise<Readable> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.#key(name) }),
    );
    if (!(out.Body instanceof Readable)) throw new Error('S3 returned no readable body');
    return out.Body;
  }

  async get(name: string, file: string) {
    await pipeline(await this.#body(name), createWriteStream(file, { mode: FILE_MODE }));
  }

  async read(name: string) {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.#body(name)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async exists(name: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.#key(name) }));
      return true;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  async list(prefix: string) {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${this.prefix}${prefix}`,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key) out.push(item.Key.slice(this.prefix.length));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  }

  async remove(name: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.#key(name) }));
  }

  async device() {
    return null;
  }
}
