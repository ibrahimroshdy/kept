import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  checkBackupEnv,
  EnvError,
  type EnvSchema,
  envSchema,
  readKeyMaterial,
  resticCacheDir,
} from '../config/env.js';
import type { Keyring } from '../crypto/envelope.js';
import { keyringOfMaterial } from '../crypto/keyring.js';
import type { BlobStore } from '../storage/blob-store.js';
import { LocalBlobStore } from '../storage/local.js';
import { createUrlSigner } from '../storage/signed-url.js';
import { ResticCli } from './restic/run.js';

// What the backup commands and the worker's job need beyond the backup settings (settings.ts):
// the owner login, the file storage, KEPT_DATA_DIR, and restic itself (step-8 plan T5). The
// worker gets them from loadEnv(); the `kept admin backup | restore | export` commands from
// loadBackupCliEnv() below, which needs none of the runtime logins. The commands open the saved
// backup secrets with the keys when they can read them (the environment or the config volume's
// secrets.json, as `kept admin recovery-kit` does); without the keys only an environment-only
// backup configuration (KEPT_BACKUP_PASSWORD and an environment target) works.

/** `HH:MM` (UTC) as the daily cron expression pg-boss schedules in UTC. */
export function backupCron(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`backup time ${time}: HH:MM`);
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}

/** The restic wrapper the environment names: KEPT_RESTIC_BIN (else `restic` on PATH, the
 * image's pinned one), its cache at KEPT_RESTIC_CACHE_DIR or KEPT_DATA_DIR/.cache/restic (Q5). */
export function resticOf(
  env: Pick<EnvSchema, 'KEPT_RESTIC_BIN' | 'KEPT_RESTIC_CACHE_DIR' | 'KEPT_DATA_DIR'>,
  onLog?: (line: string, command: string) => void,
): ResticCli {
  return new ResticCli({
    bin: env.KEPT_RESTIC_BIN ?? 'restic',
    cacheDir: resticCacheDir(env),
    ...(onLog ? { onLog } : {}),
  });
}

const cliSchema = envSchema
  .pick({
    KEPT_DATA_DIR: true,
    KEPT_STORAGE: true,
    KEPT_S3_ENDPOINT: true,
    KEPT_S3_REGION: true,
    KEPT_S3_BUCKET: true,
    KEPT_S3_ACCESS_KEY_ID: true,
    KEPT_S3_SECRET_ACCESS_KEY: true,
    KEPT_S3_FORCE_PATH_STYLE: true,
    KEPT_BACKUP_DIR: true,
    KEPT_BACKUP_S3_BUCKET: true,
    KEPT_BACKUP_S3_PREFIX: true,
    KEPT_BACKUP_S3_ENDPOINT: true,
    KEPT_BACKUP_S3_REGION: true,
    KEPT_BACKUP_S3_ACCESS_KEY_ID: true,
    KEPT_BACKUP_S3_SECRET_ACCESS_KEY: true,
    KEPT_BACKUP_S3_FORCE_PATH_STYLE: true,
    KEPT_BACKUP_KEEP: true,
    KEPT_BACKUP_TIME: true,
    KEPT_BACKUP_SFTP: true,
    KEPT_BACKUP_SFTP_KEY_FILE: true,
    KEPT_BACKUP_SFTP_KNOWN_HOSTS: true,
    KEPT_BACKUP_PASSWORD: true,
    KEPT_BACKUP_KEEP_DAILY: true,
    KEPT_BACKUP_KEEP_WEEKLY: true,
    KEPT_BACKUP_KEEP_MONTHLY: true,
    KEPT_RESTIC_BIN: true,
    KEPT_RESTIC_CACHE_DIR: true,
  })
  .extend({ KEPT_OWNER_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) });

type Source = Record<string, string | undefined>;

export type BackupCliEnv = {
  ownerUrl: string;
  /** The file storage KEPT_STORAGE names (the files a backup reads, a restore puts back). */
  blobs: BlobStore;
  /** KEPT_STORAGE. */
  storage: 'local' | 's3';
  /** Scratch space (KEPT_DATA_DIR/tmp). */
  tmpDir: string;
  /** KEPT_DATA_DIR: the backup's stable directory and, with local storage, the files. */
  dataDir: string;
  restic: ResticCli;
  /** The raw environment, which settings.ts lays over the saved settings. */
  source: Readonly<Source>;
  /** The keys that open the saved backup secrets, or null when none can be read. */
  keyring: Keyring | null;
};

/**
 * `kept admin backup | export | restore`: the owner login, the file storage and restic,
 * validated like loadEnv() validates them, and the keys when they can be read.
 */
export async function loadBackupCliEnv(source: Source = process.env): Promise<BackupCliEnv> {
  const cleaned = Object.fromEntries(
    Object.entries(source).map(([k, v]) => [k, v === '' ? undefined : v]),
  );
  const parsed = cliSchema.safeParse(cleaned);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new EnvError(`invalid environment for \`kept admin\`: ${names}`, 'invalid_env');
  }
  const env = parsed.data;
  checkBackupEnv(env, false);
  let keyring: Keyring | null = null;
  try {
    keyring = keyringOfMaterial(await readKeyMaterial(source)).keyring;
  } catch (err) {
    if (!(err instanceof EnvError)) throw err;
  }
  return {
    ownerUrl: env.KEPT_OWNER_DATABASE_URL,
    blobs: await blobStoreOf(env),
    storage: env.KEPT_STORAGE,
    tmpDir: path.join(env.KEPT_DATA_DIR, 'tmp'),
    dataDir: env.KEPT_DATA_DIR,
    restic: resticOf(env),
    source,
    keyring,
  };
}

/** The file storage, without the signer the web needs: these commands never sign a URL. */
async function blobStoreOf(
  env: Pick<
    EnvSchema,
    | 'KEPT_DATA_DIR'
    | 'KEPT_STORAGE'
    | 'KEPT_S3_ENDPOINT'
    | 'KEPT_S3_REGION'
    | 'KEPT_S3_BUCKET'
    | 'KEPT_S3_ACCESS_KEY_ID'
    | 'KEPT_S3_SECRET_ACCESS_KEY'
    | 'KEPT_S3_FORCE_PATH_STYLE'
  >,
): Promise<BlobStore> {
  if (env.KEPT_STORAGE === 's3') {
    const {
      KEPT_S3_BUCKET: bucket,
      KEPT_S3_ACCESS_KEY_ID: id,
      KEPT_S3_SECRET_ACCESS_KEY: key,
    } = env;
    if (!bucket || !id || !key) {
      throw new EnvError(
        'invalid environment: KEPT_STORAGE=s3 needs KEPT_S3_BUCKET, KEPT_S3_ACCESS_KEY_ID, KEPT_S3_SECRET_ACCESS_KEY',
        'invalid_env',
      );
    }
    const { S3BlobStore } = await import('../storage/s3.js');
    return new S3BlobStore({
      bucket,
      region: env.KEPT_S3_REGION,
      endpoint: env.KEPT_S3_ENDPOINT,
      forcePathStyle: env.KEPT_S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: id, secretAccessKey: key },
    });
  }
  return new LocalBlobStore({
    dataDir: env.KEPT_DATA_DIR,
    signer: createUrlSigner(randomBytes(32)),
  });
}
