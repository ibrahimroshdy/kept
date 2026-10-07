/**
 * Operations (step 8; D64–D66, D84, D144, D159, D165, D166, D181, D182, D186, D193; engineering
 * spec §1.10, §7.11): the backup settings and their runs, the admin status page's step-8 fields,
 * the update check, semver, and the app lock's and "keep this location available offline" limits.
 * The server's routes parse with these schemas and the web types its mock and screens with them.
 *
 * Secrets are write-only (plan T1): the restic password, an S3 secret key and an SFTP private key
 * are accepted on write and never sent back; a read carries `…Set` booleans instead.
 */

import { z } from 'zod';
import type { AttachmentRole } from './inventory.js';

// ---------------------------------------------------------------------------------------------
// Backup settings (D64, D66, D186; plan Q3, Q6, Q7)

/** Where the restic repository lives (plan Q3): a directory (a NAS mount or another disk), an
 * S3-compatible bucket (AWS, and B2's and R2's S3 endpoints) or SFTP with a pinned host key. */
export const BACKUP_TARGET_KINDS = ['dir', 's3', 'sftp'] as const;
export type BackupTargetKind = (typeof BACKUP_TARGET_KINDS)[number];

/** The retention D66 names: 7 daily, 4 weekly, 6 monthly. `pre_upgrade` snapshots keep their
 * last 3 separately (plan Q7). */
export const BACKUP_KEEP_DEFAULT = Object.freeze({ daily: 7, weekly: 4, monthly: 6 });
export const BACKUP_KEEP_PRE_UPGRADE = 3;
/** Bounds for each retention count. */
export const BACKUP_KEEP_MAX = Object.freeze({ daily: 366, weekly: 260, monthly: 120 });

/** At least 12 characters, no composition rules (plan Q6, step 7's passphrase rule). No
 * password, no backup: Kept never writes an unencrypted backup. */
export const BACKUP_PASSWORD_MIN = 12;
export const BACKUP_PASSWORD_MAX = 1024;

/** The nightly start, `HH:MM`, 24-hour, UTC (as KEPT_BACKUP_TIME). */
export const BACKUP_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** An S3 prefix: empty, or path segments each ending in `/` (as KEPT_BACKUP_S3_PREFIX). */
export const BACKUP_S3_PREFIX = /^(?:[A-Za-z0-9._-]+\/)*$/;
/** A host key as one known_hosts entry's key part: `<type> <base64>`, e.g. `ssh-ed25519 AAAA…`.
 * The accepted types are T0a R1's to confirm; this only checks the shape. */
export const SSH_HOST_KEY = /^[a-z0-9][a-z0-9@.-]{2,63} [A-Za-z0-9+/]{16,8192}={0,3}$/;

/** No C0 control character or DEL (a newline in a path or key would split a config line). */
const noControl = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
};
const text = (max: number) => z.string().trim().min(1).max(max).refine(noControl);
const absolutePath = z
  .string()
  .min(2)
  .max(1024)
  .refine((value) => value.startsWith('/') && noControl(value), { message: 'an absolute path' })
  .refine((value) => !value.split('/').includes('..'), { message: 'no `..` segments' });
const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);

const dirTarget = z.object({ kind: z.literal('dir'), path: absolutePath }).strict();
const s3Target = z
  .object({
    kind: z.literal('s3'),
    /** Empty for AWS itself. */
    endpoint: httpUrl.nullable().optional(),
    region: text(64).default('us-east-1'),
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, { message: 'an S3 bucket name' }),
    prefix: z.string().max(512).regex(BACKUP_S3_PREFIX).default('kept-backups/'),
    forcePathStyle: z.boolean().default(false),
    accessKeyId: text(256),
    /** Write-only. Absent on a PUT keeps the stored one. */
    secretAccessKey: z.string().min(1).max(1024).refine(noControl).optional(),
  })
  .strict();
const sftpTarget = z
  .object({
    kind: z.literal('sftp'),
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.:[\]-]+$/, { message: 'a host name or address' }),
    port: z.number().int().min(1).max(65535).default(22),
    user: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/, { message: 'a user name' }),
    /** The repository's path on the server (absolute, or relative to the user's home). */
    path: text(1024),
    /** Write-only: an OpenSSH private key. Absent on a PUT keeps the stored one. */
    privateKey: z
      .string()
      .max(16_384)
      .refine((value) => value.includes('-----BEGIN ') && value.includes('PRIVATE KEY-----'), {
        message: 'an OpenSSH private key',
      })
      .optional(),
    /** The server's host key, pinned: the only key the known_hosts file holds (plan T5). */
    hostKey: z.string().trim().regex(SSH_HOST_KEY, { message: 'a host key: <type> <base64>' }),
  })
  .strict();

export const BackupTargetInput = z.discriminatedUnion('kind', [dirTarget, s3Target, sftpTarget]);
export type BackupTargetInput = z.infer<typeof BackupTargetInput>;

export const BackupKeep = z
  .object({
    daily: z.number().int().min(1).max(BACKUP_KEEP_MAX.daily),
    weekly: z.number().int().min(0).max(BACKUP_KEEP_MAX.weekly),
    monthly: z.number().int().min(0).max(BACKUP_KEEP_MAX.monthly),
  })
  .strict();
export type BackupKeep = z.infer<typeof BackupKeep>;

/**
 * `PUT /api/v1/admin/backup` (plan T10), with `If-Match`. `password` is write-only: absent keeps
 * the stored one; a new target without any password stays "not configured" (plan Q6). A field the
 * environment locks may be sent unchanged; a changed one is 400 `setting_locked`.
 */
export const BackupSettingsInput = z
  .object({
    target: BackupTargetInput,
    password: z
      .string()
      .min(BACKUP_PASSWORD_MIN)
      .max(BACKUP_PASSWORD_MAX)
      .refine(noControl)
      .optional(),
    time: z.string().regex(BACKUP_TIME),
    keep: BackupKeep,
  })
  .strict();
export type BackupSettingsInput = z.infer<typeof BackupSettingsInput>;

/** A setting with whether the environment fixes it (D186, §7.11: the environment wins). */
export type Locked<T> = { value: T; locked: boolean };

/** A target as read back: every write-only field replaced by whether it is set. */
export type BackupTargetView =
  | { kind: 'dir'; path: string }
  | {
      kind: 's3';
      endpoint: string | null;
      region: string;
      bucket: string;
      prefix: string;
      forcePathStyle: boolean;
      accessKeyId: string;
      secretAccessKeySet: boolean;
    }
  | {
      kind: 'sftp';
      host: string;
      port: number;
      user: string;
      path: string;
      hostKey: string;
      privateKeySet: boolean;
    };

/**
 * `GET /api/v1/admin/backup` (plan T10). `configured`: a target and a password are both set (no
 * password, no backup). The target locks as a whole: any `KEPT_BACKUP_DIR`, `KEPT_BACKUP_S3_*` or
 * `KEPT_BACKUP_SFTP*` variable fixes it. `version` is the `If-Match` value for the PUT.
 */
export type BackupSettingsView = {
  configured: boolean;
  target: Locked<BackupTargetView | null>;
  passwordSet: Locked<boolean>;
  time: Locked<string>;
  keep: { daily: Locked<number>; weekly: Locked<number>; monthly: Locked<number> };
  version: number;
};

// ---------------------------------------------------------------------------------------------
// Backup runs and snapshots (engineering spec §1.10; plan T4, T5, T7)

/** `backup_runs.kind` (T4). */
export const BACKUP_RUN_KINDS = ['nightly', 'manual', 'pre_upgrade', 'drill', 'verify'] as const;
export type BackupRunKind = (typeof BACKUP_RUN_KINDS)[number];

/** `backup_runs.status` (T4). `warning`: the snapshot was taken but something needs a look (a
 * suspiciously small dump, whose retention was skipped; a location left out of the readable
 * copy). */
export const BACKUP_RUN_STATES = ['running', 'ok', 'warning', 'failed'] as const;
export type BackupRunState = (typeof BACKUP_RUN_STATES)[number];

export const BACKUP_STORAGE_MODES = ['local', 's3'] as const;
export type BackupStorageMode = (typeof BACKUP_STORAGE_MODES)[number];

/**
 * Why a restic command failed (plan T2's `ResticError.reason`). Also `backup_runs.error` for a
 * failed run and `BackupTestResult.error`. `partial`: some files could not be read.
 */
export const RESTIC_ERROR_REASONS = [
  'no_repository',
  'wrong_password',
  'locked',
  'partial',
  'unreachable',
  'failed',
] as const;
export type ResticErrorReason = (typeof RESTIC_ERROR_REASONS)[number];

/**
 * One `backup_runs` row in camelCase (T4). Never a credential: `target` is a description
 * ("S3 bucket kept-backups at s3.example.org"), `error` a code (`^[a-z_]{1,48}$`), `detail` counts
 * and a digests summary only. Bytes are numbers (well under 2^53).
 */
export type BackupRun = {
  id: string;
  kind: BackupRunKind;
  status: BackupRunState;
  startedAt: string;
  finishedAt: string | null;
  storageMode: BackupStorageMode;
  target: string;
  snapshotId: string | null;
  dbBytes: number | null;
  bytesAdded: number | null;
  bytesTotal: number | null;
  filesTotal: number | null;
  filesNew: number | null;
  /** Referenced files the snapshot didn't hold (a purge that raced the run). */
  missing: number;
  readableLocations: number | null;
  readableBytes: number | null;
  /** A directory target on the data's own filesystem (D66). */
  sameVolume: boolean | null;
  /** S3 file storage only (D144). */
  bucketVersioningOk: boolean | null;
  /** `pre_upgrade` runs. */
  fromVersion: string | null;
  toVersion: string | null;
  verifiedAt: string | null;
  error: string | null;
  detail: Record<string, unknown>;
};

/** `GET /api/v1/admin/backup/runs?kind&status&q&cursor` (plan T10). */
export type BackupRunsPage = { items: BackupRun[]; next_cursor: string | null };

/** One restic snapshot, read-only in the UI (plan Q4). `kind` from its tags, null for a snapshot
 * Kept didn't tag; `version` from its `v<version>` tag. */
export type BackupSnapshot = {
  id: string;
  time: string;
  kind: BackupRunKind | null;
  version: string | null;
  tags: string[];
};

/** `GET /api/v1/admin/backup/snapshots` (plan T10): from `restic snapshots`, cached 5 minutes. */
export type BackupSnapshotsPage = { items: BackupSnapshot[]; cachedAt: string };

/** `POST /api/v1/admin/backup/test` `{init?}` (plan T10). */
export const BackupTestInput = z.object({ init: z.boolean().optional() }).strict();
export type BackupTestInput = z.infer<typeof BackupTestInput>;
export type BackupTestResult = { ok: boolean; initialised: boolean; error?: ResticErrorReason };

/** A backup is stale after 36 hours without a good one (D66, D166). */
export const BACKUP_STALE_HOURS = 36;
/** The restore drill is due 30 days after the last (D66's monthly nudge). */
export const DRILL_DUE_DAYS = 30;
/** A disk at or over 85 % raises `disk_space_low` (D166). */
export const DISK_WARN_RATIO = 0.85;

// ---------------------------------------------------------------------------------------------
// The status page's step-8 fields (D66, D166, §14; plan T10)

export type BucketVersioning = 'on' | 'off' | 'unknown' | 'not_applicable';
export type DiskUsage = { usedRatio: number; freeBytes: number };

/**
 * Why the last update check has no answer (docs/spikes/2026-10-06-step8-updates.md):
 * - `unreachable`: no answer (network, timeout, a redirect, a 5xx, an unsupported API version);
 * - `not_found`: GitHub's 404, which a private repository, one with no release and a missing one
 *   all give alike (while Kept's repository is private, every official image gets this);
 * - `rate_limited`: GitHub's 403/429 with `x-ratelimit-remaining: 0` (60 an hour per IP, shared
 *   with everything else on the server's address); the next try is the next day's;
 * - `not_github`: KEPT_SOURCE_URL isn't a `https://github.com/<owner>/<repo>` URL, so nothing
 *   was asked;
 * - `bad_response`: an answer Kept couldn't read (not JSON, over the size cap, no semver tag).
 */
export const UPDATE_CHECK_ERRORS = [
  'unreachable',
  'not_found',
  'rate_limited',
  'not_github',
  'bad_response',
] as const;
export type UpdateCheckError = (typeof UPDATE_CHECK_ERRORS)[number];

/** The opt-in update check (D65; plan T11), stored in `instance_settings.update_check`. Off by
 * default; `locked` when KEPT_UPDATE_CHECK sets it. Nothing is ever downloaded or installed.
 * `latest` is a release **newer than the running version** ("Kept X is available"), null when
 * this one is current or the check failed; `url` is the release page GitHub's API returned. */
export type UpdateCheckState = {
  enabled: boolean;
  locked: boolean;
  lastCheckedAt: string | null;
  latest: { version: string; url: string; publishedAt: string } | null;
  error: UpdateCheckError | null;
};

/**
 * The fields step 8 adds to (or replaces in) `GET /api/v1/admin/status` (plan T10). The full
 * response is the existing status (version, dbOk, alerts, mail, reminders, oidc, connectors,
 * embeddings) with these; `backup` replaces the alpha's `{configured, last, lastOk}`. Every field
 * comes from rows already kept, never a restic call in the request.
 */
export type AdminOpsStatus = {
  release: {
    version: string;
    revision: string | null;
    sourceUrl: string | null;
    /** The journal tag the database is migrated to. */
    lastMigration: string | null;
    /** Set while this image runs a database one release ahead (plan Q9). */
    rolledBackFrom: string | null;
  };
  backup: {
    /** A target and a password (plan Q6). */
    configured: boolean;
    /** The environment fixes the target (D186). */
    locked: boolean;
    /** The target's description, never a credential. */
    target: string | null;
    storageMode: BackupStorageMode;
    last: BackupRun | null;
    lastOk: BackupRun | null;
    /** No good backup for BACKUP_STALE_HOURS with a target set. */
    stale: boolean;
    snapshots: number | null;
    repositoryBytes: number | null;
    readableBytes: number | null;
    sameVolume: boolean | null;
    bucketVersioning: BucketVersioning;
    lastDrillAt: string | null;
    drillDue: boolean;
    lastVerifyAt: string | null;
    /** "Upgraded from X to Y without a snapshot", until the next good backup (plan T8). */
    upgradeWithoutSnapshot: { fromVersion: string; toVersion: string; at: string } | null;
  };
  recoveryKit: {
    acknowledgedAt: string | null;
    downloadedAt: string | null;
    /** The backup settings or the key version changed after the last download (plan T9). */
    stale: boolean;
  };
  disk: { data: DiskUsage | null; backup: DiskUsage | null };
  updates: UpdateCheckState;
  jobs: { failedLastDay: number };
  /** Whether KEPT_PUBLIC_URL is `https:`; without it backup settings and the kit can't be
   * changed or downloaded (D181). */
  https: boolean;
};

// ---------------------------------------------------------------------------------------------
// The recovery kit download (D182; plan T9)

export const RECOVERY_KIT_FORMATS = ['text', 'html'] as const;
export type RecoveryKitFormat = (typeof RECOVERY_KIT_FORMATS)[number];

/** `POST /api/v1/admin/recovery-kit/download`: the password re-authenticates (D176); an account
 * without one needs a fresh sign-in instead. */
export const RecoveryKitDownloadInput = z
  .object({
    password: z.string().min(1).max(1024).optional(),
    format: z.enum(RECOVERY_KIT_FORMATS).default('text'),
  })
  .strict();
export type RecoveryKitDownloadInput = z.infer<typeof RecoveryKitDownloadInput>;

/** `GET /api/v1/admin/recovery-kit` after T9: step 1's `acknowledgedAt` with `downloadedAt`
 * and `stale`. */
export type RecoveryKitState = {
  acknowledgedAt: string | null;
  downloadedAt: string | null;
  stale: boolean;
};

// ---------------------------------------------------------------------------------------------
// Semver (semver 2.0.0), for the update check and the release guard

export type Semver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
  build: readonly string[];
};

const NUMERIC = /^(?:0|[1-9]\d*)$/;
const IDENT = /^[0-9A-Za-z-]+$/;
const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** `1.2.3`, `1.2.3-rc.1`, `1.2.3+abc` (a leading `v`, as a git tag has, is allowed). Null when
 * it isn't one: no leading zeros, no empty identifier, numbers within the safe range. */
export function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  const nums = [match[1], match[2], match[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const pre = match[4] === undefined ? [] : match[4].split('.');
  const build = match[5] === undefined ? [] : match[5].split('.');
  if (pre.some((p) => !IDENT.test(p) || (/^\d+$/.test(p) && !NUMERIC.test(p)))) return null;
  if (build.some((b) => !IDENT.test(b))) return null;
  const prerelease = pre.map((p) => (NUMERIC.test(p) ? Number(p) : p));
  if (prerelease.some((p) => typeof p === 'number' && !Number.isSafeInteger(p))) return null;
  return {
    major: nums[0] as number,
    minor: nums[1] as number,
    patch: nums[2] as number,
    prerelease,
    build,
  };
}

/** Semver 2.0.0 precedence (§11): -1, 0 or 1. Build metadata is ignored. Throws on a value that
 * isn't a version, so a caller never compares garbage silently. */
export function compareSemver(a: string | Semver, b: string | Semver): -1 | 0 | 1 {
  const x = typeof a === 'string' ? parseSemver(a) : a;
  const y = typeof b === 'string' ? parseSemver(b) : b;
  if (!x || !y) throw new Error(`not a semver: ${!x ? String(a) : String(b)}`);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  const xp = x.prerelease;
  const yp = y.prerelease;
  if (xp.length === 0 || yp.length === 0) {
    if (xp.length === yp.length) return 0;
    return xp.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const p = xp[i];
    const q = yp[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// This device: the app lock and "keep this location available offline" (D159, D181; Q21, Q22)

/**
 * The app lock (D181, plan Q22). `pbkdf2Iterations`: T0b's L1 count, about 288 ms in Chromium on
 * the laptop (docs/spikes/2026-10-06-step8-app-lock.md); the count is stored with each PIN-wrapped
 * key, so it can be lowered for new wraps if a slower phone unlocks in over about a second.
 * OWASP's 600,000 for PBKDF2-HMAC-SHA256 is the floor.
 */
export const APP_LOCK = Object.freeze({
  idleMinutes: 5,
  pinMin: 6,
  pinMax: 12,
  maxPinTries: 10,
  pbkdf2Iterations: 2_850_000,
});

/** Keep-offline limits (plan Q21): documents only, 25 MB a file, 250 MB a device. */
export const KEEP_OFFLINE = Object.freeze({
  deviceBytes: 250 * 1024 ** 2,
  fileBytes: 25 * 1024 ** 2,
});

/** The attachment roles a kept location carries to the device: documents, never photos (the
 * snapshot already has thumbnails) (plan Q21, T12). */
export const KEEP_OFFLINE_ROLES = [
  'receipt',
  'invoice',
  'manual',
  'warranty_doc',
  'registration',
  'document',
] as const satisfies readonly AttachmentRole[];
export type KeepOfflineRole = (typeof KEEP_OFFLINE_ROLES)[number];

/** Rows per `GET /api/v1/sync/extras` page (plan T12). */
export const SYNC_EXTRAS_PAGE = 500;

/** Amounts are decimal strings, as everywhere (AMOUNT_STRING); currencies ISO 4217. */
export type SyncExtraDocument = {
  attachmentId: string;
  fileId: string;
  kind: KeepOfflineRole;
  title: string | null;
  mime: string;
  bytes: number;
  sha256: string;
};

/** One thing's extras: money only where the reader's role sees it (`moneyHidden` otherwise),
 * never a secret value, never a person's contact details (D36, D159). */
export type SyncExtra = {
  thingId: string;
  purchase: { date: string | null; price: string | null; currency: string | null } | null;
  currentValue: { amount: string; currency: string } | null;
  moneyHidden?: boolean;
  documents: SyncExtraDocument[];
};

/** `GET /api/v1/sync/extras?locationId&cursor` (plan T12). */
export type SyncExtrasPage = { items: SyncExtra[]; next_cursor: string | null; totalBytes: number };

/** `GET /api/v1/sync/extras?locationId&estimate=1`: what keeping it offline would take. */
export type SyncExtrasEstimate = { things: number; documents: number; totalBytes: number };

/** The query of `GET /api/v1/sync/extras`. */
export const SyncExtrasQuery = z
  .object({
    locationId: z.uuid(),
    cursor: z.string().max(2400).optional(),
    estimate: z.enum(['0', '1']).optional(),
  })
  .strict();
export type SyncExtrasQuery = z.infer<typeof SyncExtrasQuery>;
