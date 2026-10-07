import path from 'node:path';
import {
  BACKUP_KEEP_DEFAULT,
  type BackupKeep,
  type BackupSettingsInput,
  type BackupSettingsView,
  type BackupStorageMode,
  type BackupTargetView,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { envSchema } from '../config/env.js';
import {
  type Aad,
  type Keyring,
  type MasterKey,
  open,
  type Sealed,
  seal,
} from '../crypto/envelope.js';
import { AppError, invalid } from '../http/errors.js';
import { BACKUP_SETTINGS_KEY } from '../secrets/rotate.js';

// The backup settings (step-8 plan T10, Q6; D64, D186; engineering spec §7.11): where the restic
// repository lives, its password, when the nightly run starts and how many snapshots it keeps.
//
// Two sources, and the environment wins:
// - `instance_settings.backup`, written by Admin → Backups (PUT /api/v1/admin/backup). Its
//   secrets (the restic password, an S3 secret key, an SFTP private key) are sealed with the
//   envelope key, AAD `instance_settings|backup|<field>`, and registered for rotate-key in
//   secrets/rotate.ts SEALED_SETTINGS;
// - the raw environment: `KEPT_BACKUP_DIR` / `KEPT_BACKUP_S3_*` / `KEPT_BACKUP_SFTP*` lock the
//   target as a whole, `KEPT_BACKUP_PASSWORD` the password, `KEPT_BACKUP_TIME` and
//   `KEPT_BACKUP_KEEP_*` (or the alpha's `KEPT_BACKUP_KEEP`, read as the daily count, plan Q7)
//   each their own field. loadEnv() fills defaults in, so whether the operator set a variable is
//   read from the raw environment, never from the parsed one.
//
// No password, no backup (plan Q6): a target without a password is "not configured", and
// nothing runs. Nothing here logs or returns a secret: the view carries `…Set` booleans.

/** KEPT_BACKUP_TIME's default (config/env.ts; jobs/system.ts DEFAULT_BACKUP_TIME). */
export const DEFAULT_BACKUP_TIME_UTC = '02:30';

/** The sealed fields, as secrets/rotate.ts lists them. */
export const BACKUP_SECRET_FIELDS = ['password', 's3SecretAccessKey', 'sftpPrivateKey'] as const;
export type BackupSecretField = (typeof BACKUP_SECRET_FIELDS)[number];

/** `instance_settings|backup|<field>` (plan T4). */
export function backupAad(field: BackupSecretField): Aad {
  return { table: 'instance_settings', rowId: BACKUP_SETTINGS_KEY, fieldKey: field };
}

/** The raw environment: variable name → value, an empty string being unset. */
export type RawEnv = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------------------------
// What is stored

/** A target as stored: the input without its write-only fields. */
export type StoredBackupTarget =
  | { kind: 'dir'; path: string }
  | {
      kind: 's3';
      endpoint: string | null;
      region: string;
      bucket: string;
      prefix: string;
      forcePathStyle: boolean;
      accessKeyId: string;
    }
  | { kind: 'sftp'; host: string; port: number; user: string; path: string; hostKey: string };

/** `instance_settings.backup`'s value. Every field optional: an absent one is unset. */
export type StoredBackupSettings = {
  target?: StoredBackupTarget | null;
  time?: string;
  keep?: BackupKeep;
  password?: Sealed;
  s3SecretAccessKey?: Sealed;
  sftpPrivateKey?: Sealed;
  /** When anything in it last changed: the recovery kit is stale after this (plan T9). */
  changedAt?: string;
};

const SealedShape = z.object({
  v: z.literal(1),
  kv: z.number().int(),
  dek: z.string(),
  iv: z.string(),
  ct: z.string(),
  tag: z.string(),
});
const StoredTargetShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dir'), path: z.string() }),
  z.object({
    kind: z.literal('s3'),
    endpoint: z.string().nullable(),
    region: z.string(),
    bucket: z.string(),
    prefix: z.string(),
    forcePathStyle: z.boolean(),
    accessKeyId: z.string(),
  }),
  z.object({
    kind: z.literal('sftp'),
    host: z.string(),
    port: z.number().int(),
    user: z.string(),
    path: z.string(),
    hostKey: z.string(),
  }),
]);
const StoredShape = z.object({
  target: StoredTargetShape.nullable().optional(),
  time: z.string().optional(),
  keep: z
    .object({ daily: z.number().int(), weekly: z.number().int(), monthly: z.number().int() })
    .optional(),
  password: SealedShape.optional(),
  s3SecretAccessKey: SealedShape.optional(),
  sftpPrivateKey: SealedShape.optional(),
  changedAt: z.string().optional(),
});

/** The stored settings and their row version (the `If-Match` value; 0 before the first save). */
export async function readStoredBackupSettings(
  client: Pick<pg.ClientBase, 'query'>,
): Promise<{ stored: StoredBackupSettings; version: number }> {
  const { rows } = await client.query<{ value: unknown; row_version: number }>(
    'SELECT value, row_version FROM public.instance_settings WHERE key = $1',
    [BACKUP_SETTINGS_KEY],
  );
  const row = rows[0];
  if (!row) return { stored: {}, version: 0 };
  const parsed = StoredShape.safeParse(row.value);
  // A value Kept can't read is treated as nothing saved; the next save replaces it.
  return {
    stored: parsed.success ? (parsed.data as StoredBackupSettings) : {},
    version: row.row_version,
  };
}

// ---------------------------------------------------------------------------------------------
// What the environment fixes

/** A target the environment names. S3's secret and SFTP's key files are the operator's. */
export type EnvBackupTarget =
  | { kind: 'dir'; path: string }
  | {
      kind: 's3';
      endpoint: string | null;
      region: string;
      bucket: string;
      prefix: string;
      forcePathStyle: boolean;
      accessKeyId: string;
      secretAccessKey: string;
    }
  | {
      kind: 'sftp';
      /** KEPT_BACKUP_SFTP verbatim, in restic's `sftp:` syntax (R1). */
      location: string;
      host: string;
      port: number;
      user: string;
      path: string;
      keyFile: string;
      knownHostsFile: string;
    };

export type BackupEnvOverlay = {
  /** Non-null: the target is locked. */
  target: EnvBackupTarget | null;
  /** KEPT_BACKUP_PASSWORD; non-null locks the password. */
  password: string | null;
  /** KEPT_BACKUP_TIME, only when the operator set it. */
  time: string | null;
  keep: { daily: number | null; weekly: number | null; monthly: number | null };
  /** KEPT_STORAGE (the file storage, not the backup's). */
  storageMode: BackupStorageMode;
  /** KEPT_DATA_DIR. */
  dataDir: string;
};

const overlaySchema = envSchema.pick({
  KEPT_DATA_DIR: true,
  KEPT_STORAGE: true,
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
  KEPT_BACKUP_PASSWORD: true,
  KEPT_BACKUP_SFTP: true,
  KEPT_BACKUP_SFTP_KEY_FILE: true,
  KEPT_BACKUP_SFTP_KNOWN_HOSTS: true,
  KEPT_BACKUP_KEEP_DAILY: true,
  KEPT_BACKUP_KEEP_WEEKLY: true,
  KEPT_BACKUP_KEEP_MONTHLY: true,
});

const present = (raw: RawEnv, name: string) => {
  const value = raw[name];
  return value !== undefined && value !== '';
};

/**
 * `sftp:user@host:/path` (port 22) or `sftp://user@host:port//path` (R1,
 * docs/spikes/2026-10-06-step8-restic.md), for the view. Null when it is neither.
 */
export function parseSftpLocation(
  location: string,
): { host: string; port: number; user: string; path: string } | null {
  const url = /^sftp:\/\/([^@/]+)@(\[[^\]]+\]|[^:/]+)(?::(\d{1,5}))?\/(.+)$/.exec(location);
  if (url) {
    return {
      user: url[1] as string,
      host: url[2] as string,
      port: url[3] ? Number(url[3]) : 22,
      path: url[4] as string,
    };
  }
  const short = /^sftp:([^@:/]+)@(\[[^\]]+\]|[^:/]+):(.+)$/.exec(location);
  if (short) {
    return {
      user: short[1] as string,
      host: short[2] as string,
      port: 22,
      path: short[3] as string,
    };
  }
  return null;
}

/**
 * The environment's part of the backup settings, from the raw environment (process.env in the
 * server). loadEnv() has already refused an invalid one at boot, so a parse failure here is a
 * programming error, thrown.
 */
export function backupEnvOverlay(raw: RawEnv): BackupEnvOverlay {
  const cleaned = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v === '' ? undefined : v]),
  );
  const parsed = overlaySchema.safeParse(cleaned);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`backup settings: invalid environment: ${names}`);
  }
  const env = parsed.data;
  let target: EnvBackupTarget | null = null;
  if (env.KEPT_BACKUP_DIR) {
    target = { kind: 'dir', path: env.KEPT_BACKUP_DIR };
  } else if (env.KEPT_BACKUP_S3_BUCKET) {
    target = {
      kind: 's3',
      endpoint: env.KEPT_BACKUP_S3_ENDPOINT ?? null,
      region: env.KEPT_BACKUP_S3_REGION,
      bucket: env.KEPT_BACKUP_S3_BUCKET,
      prefix: env.KEPT_BACKUP_S3_PREFIX,
      forcePathStyle: env.KEPT_BACKUP_S3_FORCE_PATH_STYLE,
      accessKeyId: env.KEPT_BACKUP_S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.KEPT_BACKUP_S3_SECRET_ACCESS_KEY ?? '',
    };
  } else if (env.KEPT_BACKUP_SFTP) {
    const parts = parseSftpLocation(env.KEPT_BACKUP_SFTP);
    target = {
      kind: 'sftp',
      location: env.KEPT_BACKUP_SFTP,
      host: parts?.host ?? '',
      port: parts?.port ?? 22,
      user: parts?.user ?? '',
      path: parts?.path ?? env.KEPT_BACKUP_SFTP,
      keyFile: env.KEPT_BACKUP_SFTP_KEY_FILE ?? '',
      knownHostsFile: env.KEPT_BACKUP_SFTP_KNOWN_HOSTS ?? '',
    };
  }
  const daily = present(raw, 'KEPT_BACKUP_KEEP_DAILY')
    ? (env.KEPT_BACKUP_KEEP_DAILY ?? null)
    : present(raw, 'KEPT_BACKUP_KEEP')
      ? env.KEPT_BACKUP_KEEP
      : null;
  return {
    target,
    password: env.KEPT_BACKUP_PASSWORD ?? null,
    time: present(raw, 'KEPT_BACKUP_TIME') ? env.KEPT_BACKUP_TIME : null,
    keep: {
      daily,
      weekly: present(raw, 'KEPT_BACKUP_KEEP_WEEKLY')
        ? (env.KEPT_BACKUP_KEEP_WEEKLY ?? null)
        : null,
      monthly: present(raw, 'KEPT_BACKUP_KEEP_MONTHLY')
        ? (env.KEPT_BACKUP_KEEP_MONTHLY ?? null)
        : null,
    },
    storageMode: env.KEPT_STORAGE,
    dataDir: env.KEPT_DATA_DIR,
  };
}

// ---------------------------------------------------------------------------------------------
// The view (GET /api/v1/admin/backup)

function storedTargetView(t: StoredBackupTarget, stored: StoredBackupSettings): BackupTargetView {
  if (t.kind === 'dir') return { kind: 'dir', path: t.path };
  if (t.kind === 's3') return { ...t, secretAccessKeySet: stored.s3SecretAccessKey !== undefined };
  return { ...t, privateKeySet: stored.sftpPrivateKey !== undefined };
}

/** The environment's target as the screen shows it. SFTP's host key lives in the operator's
 * known_hosts file, which a request never reads: the view says `hostKey: ''`. */
export function envTargetView(t: EnvBackupTarget): BackupTargetView {
  if (t.kind === 'dir') return { kind: 'dir', path: t.path };
  if (t.kind === 's3') {
    const { secretAccessKey, ...rest } = t;
    return { ...rest, secretAccessKeySet: secretAccessKey !== '' };
  }
  return {
    kind: 'sftp',
    host: t.host,
    port: t.port,
    user: t.user,
    path: t.path,
    hostKey: '',
    privateKeySet: t.keyFile !== '',
  };
}

/** The effective target's kind and whether its credential is there, from either source. */
function effectiveTargetView(
  stored: StoredBackupSettings,
  overlay: BackupEnvOverlay,
): BackupTargetView | null {
  if (overlay.target) return envTargetView(overlay.target);
  return stored.target ? storedTargetView(stored.target, stored) : null;
}

function targetComplete(view: BackupTargetView | null): boolean {
  if (!view) return false;
  if (view.kind === 's3') return view.secretAccessKeySet;
  if (view.kind === 'sftp') return view.privateKeySet;
  return true;
}

export function backupKeepEffective(stored: StoredBackupSettings, overlay: BackupEnvOverlay) {
  const base = stored.keep ?? BACKUP_KEEP_DEFAULT;
  return {
    daily: overlay.keep.daily ?? base.daily,
    weekly: overlay.keep.weekly ?? base.weekly,
    monthly: overlay.keep.monthly ?? base.monthly,
  };
}

/** `HH:MM` UTC: the environment's, else the saved one, else the default. */
export function backupTimeEffective(stored: StoredBackupSettings, overlay: BackupEnvOverlay) {
  return overlay.time ?? stored.time ?? DEFAULT_BACKUP_TIME_UTC;
}

export function backupSettingsView(
  stored: StoredBackupSettings,
  version: number,
  overlay: BackupEnvOverlay,
): BackupSettingsView {
  const target = effectiveTargetView(stored, overlay);
  const passwordSet = overlay.password !== null || stored.password !== undefined;
  const keep = backupKeepEffective(stored, overlay);
  return {
    configured: targetComplete(target) && passwordSet,
    target: { value: target, locked: overlay.target !== null },
    passwordSet: { value: passwordSet, locked: overlay.password !== null },
    time: { value: backupTimeEffective(stored, overlay), locked: overlay.time !== null },
    keep: {
      daily: { value: keep.daily, locked: overlay.keep.daily !== null },
      weekly: { value: keep.weekly, locked: overlay.keep.weekly !== null },
      monthly: { value: keep.monthly, locked: overlay.keep.monthly !== null },
    },
    version,
  };
}

/** For logs, the status page and `backup_runs.target`: where, never a credential (≤ 300). */
export function describeBackupTarget(
  t: StoredBackupTarget | EnvBackupTarget | ResolvedBackupTarget,
): string {
  let text: string;
  if (t.kind === 'dir') text = `directory ${t.path}`;
  else if (t.kind === 's3') {
    const where = t.endpoint ? ` at ${new URL(t.endpoint).host}` : '';
    text = `S3 bucket ${t.bucket}${where}${t.prefix ? `, ${t.prefix}` : ''}`;
  } else {
    const port = t.port === 22 ? '' : `:${t.port}`;
    text = `SFTP ${t.user}@${t.host}${port}:${t.path}`;
  }
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

// ---------------------------------------------------------------------------------------------
// Resolved, for the engine (T5's repo.ts turns this into a ResticRepo)

export type ResolvedBackupTarget =
  | { kind: 'dir'; path: string }
  | {
      kind: 's3';
      endpoint: string | null;
      region: string;
      bucket: string;
      prefix: string;
      forcePathStyle: boolean;
      accessKeyId: string;
      secretAccessKey: string;
    }
  | {
      kind: 'sftp';
      host: string;
      port: number;
      user: string;
      path: string;
      /** The environment's location verbatim (KEPT_BACKUP_SFTP), else null: build it from the
       * parts. */
      location: string | null;
      /** One of each pair is set: the saved key and host key (written to 0600 files under
       * KEPT_DATA_DIR/tmp for a command's lifetime), or the environment's files. */
      privateKey: string | null;
      hostKey: string | null;
      keyFile: string | null;
      knownHostsFile: string | null;
    };

/** Everything a run needs, secrets opened. Never logged, never in job data. */
export type ResolvedBackupSettings = {
  target: ResolvedBackupTarget;
  password: string;
  /** `HH:MM`, UTC. */
  time: string;
  keep: BackupKeep;
  /** describeBackupTarget(target). */
  description: string;
  /** The target is fixed by the environment. */
  locked: boolean;
};

export type BackupNotConfigured = { reason: 'no_target' | 'no_password' | 'no_credentials' };

/**
 * The effective settings with their secrets opened, or why there are none. `keyring` opens the
 * saved secrets; it may be null where no keys are at hand (then only an environment-only
 * configuration resolves, and a saved secret counts as missing).
 */
export function resolveBackupSettings(
  stored: StoredBackupSettings,
  overlay: BackupEnvOverlay,
  keyring: Keyring | null,
): ResolvedBackupSettings | BackupNotConfigured {
  const openField = (field: BackupSecretField): string | null => {
    const sealed = stored[field];
    if (!sealed || !keyring) return null;
    return open(keyring, sealed, backupAad(field)).toString('utf8');
  };
  let target: ResolvedBackupTarget | null = null;
  const env = overlay.target;
  if (env) {
    target =
      env.kind === 'sftp'
        ? {
            kind: 'sftp',
            host: env.host,
            port: env.port,
            user: env.user,
            path: env.path,
            location: env.location,
            privateKey: null,
            hostKey: null,
            keyFile: env.keyFile,
            knownHostsFile: env.knownHostsFile,
          }
        : env;
  } else if (stored.target) {
    const t = stored.target;
    if (t.kind === 'dir') target = t;
    else if (t.kind === 's3') {
      const secret = openField('s3SecretAccessKey');
      if (secret === null) return { reason: 'no_credentials' };
      target = { ...t, secretAccessKey: secret };
    } else {
      const key = openField('sftpPrivateKey');
      if (key === null) return { reason: 'no_credentials' };
      target = {
        ...t,
        location: null,
        privateKey: key,
        keyFile: null,
        knownHostsFile: null,
      };
    }
  }
  if (!target) return { reason: 'no_target' };
  const password = overlay.password ?? openField('password');
  if (!password) return { reason: 'no_password' };
  return {
    target,
    password,
    time: backupTimeEffective(stored, overlay),
    keep: backupKeepEffective(stored, overlay),
    description: describeBackupTarget(target),
    locked: env !== null,
  };
}

export function isResolved(
  value: ResolvedBackupSettings | BackupNotConfigured,
): value is ResolvedBackupSettings {
  return 'target' in value;
}

// ---------------------------------------------------------------------------------------------
// Saving (PUT /api/v1/admin/backup)

const settingLocked = () =>
  new AppError(
    'setting_locked',
    400,
    "This is set by the server's environment (KEPT_BACKUP_*) and can't be changed here.",
  );

function sameTargetView(a: BackupTargetView | null, b: BackupTargetView): boolean {
  if (!a || a.kind !== b.kind) return false;
  const strip = (v: BackupTargetView) => {
    const {
      secretAccessKeySet: _s,
      privateKeySet: _p,
      ...rest
    } = v as BackupTargetView & {
      secretAccessKeySet?: boolean;
      privateKeySet?: boolean;
    };
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return strip(a) === strip(b);
}

export type BackupSettingsChange = {
  next: StoredBackupSettings;
  /** For the audit row: the target kind, and `true` for each secret replaced. Never a value. */
  audit: {
    targetKind: StoredBackupTarget['kind'] | null;
    changed: Partial<Record<BackupSecretField | 'target' | 'time' | 'keep', true>>;
  };
};

/**
 * The stored settings after `input`, its secrets sealed with `master`. 400 `setting_locked` when
 * the input changes what the environment fixes (sending it unchanged is fine), 400
 * `backup_password_weak` is the route's (before parsing), and 400 `validation` for a new S3 or
 * SFTP target without its credential, or a directory inside KEPT_DATA_DIR.
 */
export function applyBackupSettings(
  stored: StoredBackupSettings,
  input: BackupSettingsInput,
  overlay: BackupEnvOverlay,
  master: MasterKey,
  now: Date = new Date(),
): BackupSettingsChange {
  const next: StoredBackupSettings = { ...stored };
  const changed: BackupSettingsChange['audit']['changed'] = {};
  const t = input.target;

  if (overlay.target) {
    const envView = envTargetView(overlay.target);
    const sent: BackupTargetView =
      t.kind === 'dir'
        ? { kind: 'dir', path: t.path }
        : t.kind === 's3'
          ? {
              kind: 's3',
              endpoint: t.endpoint ?? null,
              region: t.region,
              bucket: t.bucket,
              prefix: t.prefix,
              forcePathStyle: t.forcePathStyle,
              accessKeyId: t.accessKeyId,
              secretAccessKeySet: true,
            }
          : {
              kind: 'sftp',
              host: t.host,
              port: t.port,
              user: t.user,
              path: t.path,
              hostKey: envView.kind === 'sftp' ? envView.hostKey : t.hostKey,
              privateKeySet: true,
            };
    const sentSecret =
      (t.kind === 's3' && t.secretAccessKey !== undefined) ||
      (t.kind === 'sftp' && t.privateKey !== undefined);
    if (sentSecret || !sameTargetView(envView, sent)) throw settingLocked();
  } else {
    const prev = stored.target ?? null;
    let target: StoredBackupTarget;
    if (t.kind === 'dir') {
      const data = path.resolve(overlay.dataDir);
      const dir = path.resolve(t.path);
      if (dir === data || dir.startsWith(`${data}${path.sep}`)) {
        throw invalid(
          'The backup directory is inside the data directory, so losing that disk loses the backups too. Choose another disk.',
        );
      }
      target = { kind: 'dir', path: t.path };
    } else if (t.kind === 's3') {
      target = {
        kind: 's3',
        endpoint: t.endpoint ?? null,
        region: t.region,
        bucket: t.bucket,
        prefix: t.prefix,
        forcePathStyle: t.forcePathStyle,
        accessKeyId: t.accessKeyId,
      };
      if (t.secretAccessKey !== undefined) {
        next.s3SecretAccessKey = seal(master, t.secretAccessKey, backupAad('s3SecretAccessKey'));
        changed.s3SecretAccessKey = true;
      } else if (prev?.kind !== 's3' || !stored.s3SecretAccessKey) {
        throw invalid('Give the bucket’s secret access key.');
      }
    } else {
      target = {
        kind: 'sftp',
        host: t.host,
        port: t.port,
        user: t.user,
        path: t.path,
        hostKey: t.hostKey,
      };
      if (t.privateKey !== undefined) {
        next.sftpPrivateKey = seal(master, t.privateKey, backupAad('sftpPrivateKey'));
        changed.sftpPrivateKey = true;
      } else if (prev?.kind !== 'sftp' || !stored.sftpPrivateKey) {
        throw invalid('Give the SFTP private key.');
      }
    }
    // A credential belongs to its kind of target: switching away drops it.
    if (target.kind !== 's3' && next.s3SecretAccessKey) {
      delete next.s3SecretAccessKey;
      changed.s3SecretAccessKey = true;
    }
    if (target.kind !== 'sftp' && next.sftpPrivateKey) {
      delete next.sftpPrivateKey;
      changed.sftpPrivateKey = true;
    }
    if (JSON.stringify(prev) !== JSON.stringify(target)) changed.target = true;
    next.target = target;
  }

  if (input.password !== undefined) {
    if (overlay.password !== null) throw settingLocked();
    next.password = seal(master, input.password, backupAad('password'));
    changed.password = true;
  }

  if (overlay.time !== null) {
    if (input.time !== overlay.time) throw settingLocked();
  } else {
    if (input.time !== backupTimeEffective(stored, overlay)) changed.time = true;
    next.time = input.time;
  }

  const keepNow = backupKeepEffective(stored, overlay);
  for (const k of ['daily', 'weekly', 'monthly'] as const) {
    if (overlay.keep[k] !== null && input.keep[k] !== overlay.keep[k]) throw settingLocked();
    if (input.keep[k] !== keepNow[k]) changed.keep = true;
  }
  next.keep = { ...input.keep };

  if (Object.keys(changed).length > 0) next.changedAt = now.toISOString();
  const kind = overlay.target?.kind ?? next.target?.kind ?? null;
  return { next, audit: { targetKind: kind, changed } };
}

/** Writes the settings (an instance admin's kept_app transaction, or kept_owner/kept_system),
 * bumping the row version. Returns the new version. */
export async function writeStoredBackupSettings(
  client: Pick<pg.ClientBase, 'query'>,
  next: StoredBackupSettings,
): Promise<number> {
  const { rows } = await client.query<{ row_version: number }>(
    `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value
     RETURNING row_version`,
    [BACKUP_SETTINGS_KEY, JSON.stringify(next)],
  );
  return rows[0]?.row_version ?? 0;
}

/**
 * The settings a backup run uses: read with `client` (any login that can read
 * instance_settings), overlaid with the raw environment, secrets opened with `keyring`.
 */
export async function loadBackupSettings(
  client: Pick<pg.ClientBase, 'query'>,
  raw: RawEnv,
  keyring: Keyring | null,
): Promise<ResolvedBackupSettings | BackupNotConfigured> {
  const { stored } = await readStoredBackupSettings(client);
  return resolveBackupSettings(stored, backupEnvOverlay(raw), keyring);
}
