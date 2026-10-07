import { randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { parseTrustedProxies } from '../auth/client-ip.js';
import { isCrockford, normaliseCrockford } from '../crypto/crockford.js';

export type EnvErrorCode =
  | 'invalid_env'
  | 'secret_key_invalid'
  | 'secret_key_too_short'
  | 'secret_keys_partial'
  | 'secret_key_version_invalid'
  | 'secrets_file_invalid'
  | 'source_url_required'
  | 'ai_mock_in_production'
  | 'backup_invalid'
  | 'vapid_keys_partial'
  | 'embeddings_unavailable'
  | 'oidc_incomplete';

export class EnvError extends Error {
  readonly code: EnvErrorCode;

  constructor(message: string, code: EnvErrorCode) {
    super(message);
    this.name = 'EnvError';
    this.code = code;
  }
}

const KEPT_ROLES = ['all', 'web', 'worker'] as const;
const KEPT_STORAGES = ['local', 's3'] as const;
const KEPT_LOG_FORMATS = ['json', 'pretty'] as const;
const KEPT_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const postgresUrl = () => z.url({ protocol: /^postgres(ql)?$/ });

// Step 4 (T2, plan Q11): VAPID keys as web-push reads them (web-push 3.6.7
// src/vapid-helper.js): unpadded base64url, the public key an uncompressed P-256 point of 65
// bytes, the private key 32 bytes; the subject an `https:` URL or a `mailto:` address.
const B64URL = /^[A-Za-z0-9_-]+$/;
const b64urlBytes = (length: number, what: string) =>
  z
    .string()
    .trim()
    .refine((v) => B64URL.test(v) && Buffer.from(v, 'base64url').length === length, {
      message: `${what}: unpadded base64url of ${length} bytes, as web-push's generateVAPIDKeys() writes it`,
    });
const vapidSubjectUrl = () =>
  z
    .string()
    .trim()
    .refine(
      (v) => {
        try {
          return ['https:', 'mailto:'].includes(new URL(v).protocol);
        } catch {
          return false;
        }
      },
      { message: 'an https: URL or a mailto: address' },
    );
const httpUrl = () => z.url({ protocol: /^https?$/ });
// Step 6 (T2, S6.7): comma-separated lists, empty items dropped; empty or unset is [].
const csvList = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );

/** Step 6 (D207): where vectors come from. `local` needs the local model's runtime installed. */
export const KEPT_EMBEDDINGS_SOURCES = ['provider', 'local', 'off'] as const;
/** The package `local` needs (spike S6.5). Not installed in 1.0: `local` is refused at boot. */
export const LOCAL_EMBEDDINGS_PACKAGE = '@huggingface/transformers';

// §7.11: the environment contract. Required variables have no `.optional()`/`.default()`.
// An empty string counts as unset (see `withoutEmpty`), so `KEPT_X=` in a compose file behaves
// like leaving the line out.
const schema = z.object({
  KEPT_DATABASE_URL: postgresUrl().describe('`kept_app` login (required)'),
  KEPT_AUTH_DATABASE_URL: postgresUrl().describe('`kept_auth` login (required)'),
  // Required for every role: workers run as kept_system, and `web` (and `all`) generate the
  // first-run setup code as kept_system at boot.
  KEPT_SYSTEM_DATABASE_URL: postgresUrl().describe(
    '`kept_system` login (required: workers, and the setup code at web boot)',
  ),
  KEPT_OWNER_DATABASE_URL: postgresUrl()
    .optional()
    .describe(
      'for `kept migrate` / `kept admin`, and on a worker with a backup target (the dump runs as kept_owner)',
    ),
  KEPT_SECRET_KEY: z
    .string()
    .optional()
    .describe('generated on first boot if unset (D193); set both or neither; see §7.3'),
  KEPT_AUTH_SECRET: z
    .string()
    .optional()
    .describe('generated on first boot if unset (D193); set both or neither; see §7.3'),
  // The keyring (§7.3, plan Q19). With generated keys the config volume's secrets.json holds
  // both, under the same names; these two apply only beside an operator-set KEPT_SECRET_KEY.
  KEPT_SECRET_KEY_VERSION: z
    .string()
    .optional()
    .describe(
      'the version of `KEPT_SECRET_KEY`: `1` when unset; `kept admin rotate-key` says what to set (§7.3)',
    ),
  KEPT_SECRET_KEYS_RETIRED: z
    .string()
    .optional()
    .describe(
      'earlier `KEPT_SECRET_KEY` versions, still needed to open values and backups sealed before a rotation: comma-separated `version:key` pairs; never logged',
    ),
  KEPT_PUBLIC_URL: httpUrl().describe('required; source of truth for links and QR codes'),
  KEPT_ROLE: z.enum(KEPT_ROLES).default('all').describe('`all` · `web` · `worker`'),
  KEPT_STORAGE: z.enum(KEPT_STORAGES).default('local').describe('`local` · `s3` (+ `KEPT_S3_*`)'),
  KEPT_SMTP_URL: z
    .url({ protocol: /^smtps?$/ })
    .optional()
    .describe(
      'optional; `smtp://` or `smtps://`, with credentials if needed; unset, mail is only logged as due',
    ),
  KEPT_SMTP_FROM: z
    .string()
    .trim()
    .refine((value) => value.includes('@'), { message: 'an address, e.g. Kept <kept@example.org>' })
    .optional()
    .describe('the From of every mail; default `Kept <no-reply@<KEPT_PUBLIC_URL host>>`'),
  KEPT_LOG_LEVEL: z.enum(KEPT_LOG_LEVELS).default('info').describe('pino log level'),
  KEPT_LOG_FORMAT: z.enum(KEPT_LOG_FORMATS).default('json').describe('`pretty` for `docker logs`'),
  KEPT_SOURCE_URL: httpUrl()
    .optional()
    .describe("the image's OCI `source` + `revision` labels; forks override it (D147)"),
  KEPT_SETUP_CODE: z
    .string()
    .optional()
    .refine((value) => value === undefined || isCrockford(normaliseCrockford(value), 6), {
      message: '6 Crockford base32 characters (0-9, A-Z without I, L, O, U)',
    })
    .describe('generated; app stores may preset it (D107); 6 Crockford base32 characters'),
  // §7.11's precedence rule (environment over instance_settings) needs a variable for each
  // setting it locks; `signup_open` is the first (task 23). Unset: the admin setting decides.
  KEPT_SIGNUP_OPEN: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'))
    .describe(
      '`true` · `false`; when set, locks sign-up open or closed and the admin setting shows as locked',
    ),
  KEPT_CONFIG_DIR: z
    .string()
    .default('/config')
    .describe('config volume; holds only the generated secret keys'),
  KEPT_DATA_DIR: z.string().default('/data').describe('data volume; local file storage'),
  // Step 2 (§3.4, Q23): the upload limit, and how many images are resized at once (Q17).
  KEPT_MAX_FILE_MB: z.coerce
    .number()
    .int()
    .min(1)
    .max(2048)
    .default(25)
    .describe('largest file one upload may be, in MB (§3.4)'),
  KEPT_IMAGE_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .describe('images resized at once, process-wide; default 1 with under 3 GB of RAM, else 2'),
  // Only read when KEPT_STORAGE=s3; then the bucket and both credentials are required (Q18).
  KEPT_S3_ENDPOINT: httpUrl()
    .optional()
    .describe('S3 endpoint URL; empty for AWS itself (e.g. `http://rustfs:9000`)'),
  KEPT_S3_PUBLIC_ENDPOINT: httpUrl()
    .optional()
    .describe(
      'S3 endpoint the browser reaches, for presigned URLs; empty: `KEPT_S3_ENDPOINT` (e.g. `https://files.example.com`)',
    ),
  KEPT_S3_REGION: z.string().default('us-east-1').describe('S3 region'),
  KEPT_S3_BUCKET: z.string().optional().describe('S3 bucket (required with `KEPT_STORAGE=s3`)'),
  KEPT_S3_ACCESS_KEY_ID: z
    .string()
    .optional()
    .describe('S3 access key id (required with `KEPT_STORAGE=s3`)'),
  KEPT_S3_SECRET_ACCESS_KEY: z
    .string()
    .optional()
    .describe('S3 secret access key (required with `KEPT_STORAGE=s3`); never logged'),
  KEPT_S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true')
    .describe('`true` for path-style URLs (RustFS, MinIO, most self-hosted S3)'),
  // Frozen here so the parsed env, itself frozen, holds no mutable array (Phase B review, item 2).
  KEPT_TRUSTED_PROXIES: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return Object.freeze(parseTrustedProxies(value ?? '')) as readonly string[];
      } catch (err) {
        ctx.issues.push({ code: 'custom', message: (err as Error).message, input: value });
        return z.NEVER;
      }
    })
    .describe(
      'comma-separated IPs/CIDRs of reverse proxies whose `X-Forwarded-For` is believed; empty: the socket address is the client',
    ),
  KEPT_METRICS_TOKEN: z
    .string()
    .optional()
    .describe('optional bearer token required to read `/metrics`'),
  // Step 8 (T14, D84): optional tracing and error reporting, both off unless set. No telemetry.
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl()
    .optional()
    .describe(
      "optional; your OpenTelemetry collector (OTLP over HTTP): traces requests and queries there, with the image's `--import` preload; the other `OTEL_*` variables apply; unset, nothing is loaded or sent (D84)",
    ),
  KEPT_ERROR_DSN: httpUrl()
    .optional()
    .describe(
      'optional; a Sentry-compatible DSN: a request that fails with a 5xx is reported with its request id, route and stack, never a body, header, message or user; unset, nothing is sent (D84)',
    ),
  // Step 3 (T2). The mock provider answers every AI call from fixtures (CI, e2e, dev); a
  // production boot refuses it (loadEnv), so a real instance never serves invented extractions.
  KEPT_AI_MOCK: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1')
    .describe(
      '`1`: every AI call answers from the mock provider (tests, dev); refused in production',
    ),
  // D126: barcode lookup is off by default. Like KEPT_SIGNUP_OPEN, a set value locks the admin
  // setting; unset, the setting decides.
  KEPT_BARCODE_LOOKUP: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'))
    .describe(
      '`true` · `false`; when set, locks barcode lookup (Open*Facts) on or off and the admin setting shows as locked',
    ),
  KEPT_BARCODE_CONTACT: z
    .email()
    .optional()
    .describe("an email for the barcode lookup's User-Agent, as Open*Facts asks (D104)"),
  KEPT_EVAL_DIR: z
    .string()
    .optional()
    .describe(
      'the extraction evaluation only (`pnpm eval:extraction`): the folder of labelled photos',
    ),
  // Step 3, alpha safety (D207, plan T31c): the nightly backup. One target, a directory or an S3
  // bucket; unset, nothing is backed up and the admin status page says so. The job runs as
  // kept_owner, so a worker with a target also needs KEPT_OWNER_DATABASE_URL (checkBackupEnv).
  KEPT_BACKUP_DIR: z
    .string()
    .optional()
    .describe(
      'nightly backup to this directory: an absolute path outside `KEPT_DATA_DIR`, ideally another disk; the worker also needs `KEPT_OWNER_DATABASE_URL`',
    ),
  KEPT_BACKUP_S3_BUCKET: z
    .string()
    .optional()
    .describe(
      'nightly backup to this S3 bucket instead of a directory (+ `KEPT_BACKUP_S3_*`); the worker also needs `KEPT_OWNER_DATABASE_URL`',
    ),
  KEPT_BACKUP_S3_PREFIX: z
    .string()
    .regex(/^(?:[A-Za-z0-9._-]+\/)*$/, { message: 'empty, or path segments each ending in /' })
    .default('kept-backups/')
    .describe('where in the backup bucket the backups go'),
  KEPT_BACKUP_S3_ENDPOINT: httpUrl()
    .optional()
    .describe("the backup bucket's S3 endpoint; empty for AWS itself"),
  KEPT_BACKUP_S3_REGION: z.string().default('us-east-1').describe("the backup bucket's region"),
  KEPT_BACKUP_S3_ACCESS_KEY_ID: z
    .string()
    .optional()
    .describe('access key id for the backup bucket (required with `KEPT_BACKUP_S3_BUCKET`)'),
  KEPT_BACKUP_S3_SECRET_ACCESS_KEY: z
    .string()
    .optional()
    .describe(
      'secret access key for the backup bucket (required with `KEPT_BACKUP_S3_BUCKET`); never logged',
    ),
  KEPT_BACKUP_S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true')
    .describe('`true` for path-style URLs (RustFS, MinIO, most self-hosted S3)'),
  KEPT_BACKUP_KEEP: z.coerce
    .number()
    .int()
    .min(1)
    .max(366)
    .default(7)
    .describe('how many backups are kept; older ones, and the files only they held, are removed'),
  KEPT_BACKUP_TIME: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { message: 'HH:MM, 24-hour, UTC' })
    .default('02:30')
    .describe('when the nightly backup starts, `HH:MM` in UTC'),
  // Step 8 (plan T2; D64, D66, D186; Q5–Q9): restic. The targets above name the restic
  // repository now (a `restic/` directory or prefix inside them, Q2); SFTP is the third target.
  // Each variable set here locks its field in Admin → Backups. Never logged: the password.
  KEPT_BACKUP_PASSWORD: z
    .string()
    .min(12, { message: 'at least 12 characters' })
    .optional()
    .describe(
      "the backup repository's password, at least 12 characters; set, it locks the password in Admin → Backups; never logged (no password, no backup)",
    ),
  KEPT_BACKUP_SFTP: z
    .string()
    .regex(/^sftp:\S+$/, { message: 'a restic SFTP repository, `sftp:…`' })
    .optional()
    .describe(
      "nightly backup over SFTP instead of a directory or a bucket: the repository location in restic's `sftp:` syntax (+ `KEPT_BACKUP_SFTP_KEY_FILE`, `KEPT_BACKUP_SFTP_KNOWN_HOSTS`)",
    ),
  KEPT_BACKUP_SFTP_KEY_FILE: z
    .string()
    .optional()
    .describe('the SFTP private key file, an absolute path (required with `KEPT_BACKUP_SFTP`)'),
  KEPT_BACKUP_SFTP_KNOWN_HOSTS: z
    .string()
    .optional()
    .describe(
      "a known_hosts file holding the SFTP server's pinned host key, an absolute path (required with `KEPT_BACKUP_SFTP`)",
    ),
  KEPT_BACKUP_KEEP_DAILY: keepCount(366).describe(
    'retention: the newest backup of each of the last N days; default 7 (D66); set, it locks the field',
  ),
  KEPT_BACKUP_KEEP_WEEKLY: keepCount(260, 0).describe(
    'retention: the newest backup of each of the last N weeks; default 4 (D66); set, it locks the field',
  ),
  KEPT_BACKUP_KEEP_MONTHLY: keepCount(120, 0).describe(
    'retention: the newest backup of each of the last N months; default 6 (D66); set, it locks the field',
  ),
  KEPT_RESTIC_BIN: z
    .string()
    .optional()
    .describe("the restic binary; default the image's pinned one, else `restic` on `PATH`"),
  KEPT_RESTIC_CACHE_DIR: z
    .string()
    .optional()
    .describe("restic's cache, never backed up; default `<KEPT_DATA_DIR>/.cache/restic`"),
  KEPT_UPDATE_CHECK: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'))
    .describe(
      '`true` · `false`; when set, locks "Check for new versions" (GitHub releases, off by default, D65) on or off',
    ),
  KEPT_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8080)
    .describe('the port the server listens on'),
  KEPT_ALLOW_DOWNGRADE: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1')
    .describe(
      '`1`: start on a database more than one release ahead of this image, audited; for a restore runbook only (plan Q9)',
    ),
  KEPT_UPGRADE_SNAPSHOT: z
    .enum(['auto', 'off'])
    .default('auto')
    .describe(
      '`auto` · `off`: whether `kept migrate` takes a database snapshot before migrating a populated database (plan Q8)',
    ),
  // Step 4 (T2, plan Q11): web push. Unset, Kept generates a pair at first run and keeps it in
  // instance_settings, the private key sealed; set, these override it.
  KEPT_VAPID_PUBLIC_KEY: b64urlBytes(65, 'the VAPID public key')
    .optional()
    .describe('web push: overrides the generated key pair; set both or neither'),
  KEPT_VAPID_PRIVATE_KEY: b64urlBytes(32, 'the VAPID private key')
    .optional()
    .describe('web push: the private half of `KEPT_VAPID_PUBLIC_KEY`; never logged'),
  KEPT_VAPID_SUBJECT: vapidSubjectUrl()
    .optional()
    .describe(
      'web push: who push services contact, an `https:` URL or `mailto:` address; default `KEPT_PUBLIC_URL` when https, else `mailto:` the `KEPT_SMTP_FROM` address, else push is unavailable',
    ),
  // Step 6 (T2, D207): semantic search's source. `provider` embeds with each location's resolved
  // AI provider (keyword-only where none has an embeddings model); `off` is keyword search only;
  // `local` is a model on this server and is refused unless its runtime is installed.
  KEPT_EMBEDDINGS: z
    .enum(KEPT_EMBEDDINGS_SOURCES)
    .default('provider')
    .describe(
      "`provider` · `local` · `off`: where search's embeddings come from; `local` is refused unless the local model's runtime is installed (D207)",
    ),
  KEPT_EMBEDDINGS_DIR: z
    .string()
    .optional()
    .describe(
      "the local embedding model's files, only read when `KEPT_EMBEDDINGS=local`; default `<KEPT_DATA_DIR>/models`",
    ),
  // Step 6 (T2, spike S6.7, plan Q16): generic OIDC sign-in, configured here and read at boot.
  // Unset issuer: no OIDC. Discovery goes through the SSRF guard (T16).
  KEPT_OIDC_ISSUER: httpUrl()
    .optional()
    .describe(
      'OIDC sign-in: the issuer URL exactly as its discovery document states it; set, OIDC is on (needs `KEPT_OIDC_CLIENT_ID`)',
    ),
  KEPT_OIDC_CLIENT_ID: z.string().optional().describe('OIDC sign-in: the client id'),
  KEPT_OIDC_CLIENT_SECRET: z
    .string()
    .optional()
    .describe('OIDC sign-in: the client secret (a confidential client); never logged'),
  KEPT_OIDC_NAME: z
    .string()
    .max(60)
    .default('OIDC')
    .describe('OIDC sign-in: the provider\'s name on "Sign in with <name>"'),
  KEPT_OIDC_AUTOPROVISION_DOMAINS: csvList().describe(
    'OIDC sign-in: comma-separated email domains (exact, no subdomains) whose people get an account on first sign-in; empty: invite only',
  ),
  KEPT_OIDC_AUTOPROVISION_GROUPS: csvList().describe(
    'OIDC sign-in: comma-separated groups (exact) whose members get an account on first sign-in; empty: invite only',
  ),
  KEPT_OIDC_GROUPS_CLAIM: z
    .string()
    .default('groups')
    .describe('OIDC sign-in: the ID token claim holding the groups'),
  KEPT_OIDC_SCOPES: z
    .string()
    .default('openid email profile')
    .describe('OIDC sign-in: the scopes asked for, space-separated'),
});

/** An optional retention count, 0 (or 1) to `max`. */
function keepCount(max: number, min = 1) {
  return z.coerce.number().int().min(min).max(max).optional();
}

/** The backup settings a command or the worker reads (backup/config.ts builds the target). */
export type BackupEnv = Pick<
  EnvSchema,
  | 'KEPT_BACKUP_DIR'
  | 'KEPT_BACKUP_S3_BUCKET'
  | 'KEPT_BACKUP_S3_PREFIX'
  | 'KEPT_BACKUP_S3_ENDPOINT'
  | 'KEPT_BACKUP_S3_REGION'
  | 'KEPT_BACKUP_S3_ACCESS_KEY_ID'
  | 'KEPT_BACKUP_S3_SECRET_ACCESS_KEY'
  | 'KEPT_BACKUP_S3_FORCE_PATH_STYLE'
  | 'KEPT_BACKUP_KEEP'
  | 'KEPT_BACKUP_TIME'
  | 'KEPT_BACKUP_SFTP'
  | 'KEPT_BACKUP_SFTP_KEY_FILE'
  | 'KEPT_BACKUP_SFTP_KNOWN_HOSTS'
>;

/** Whether a backup target is set at all. */
export function backupTargetSet(
  env: Pick<BackupEnv, 'KEPT_BACKUP_DIR' | 'KEPT_BACKUP_S3_BUCKET'> &
    Partial<Pick<BackupEnv, 'KEPT_BACKUP_SFTP'>>,
) {
  return Boolean(env.KEPT_BACKUP_DIR || env.KEPT_BACKUP_S3_BUCKET || env.KEPT_BACKUP_SFTP);
}

/**
 * Retention (D66, plan Q7): `KEPT_BACKUP_KEEP_*`, else 7/4/6. The alpha's `KEPT_BACKUP_KEEP` (a
 * count of runs) is read as the daily count for one release; loadEnv() logs it as deprecated.
 */
export function backupKeepOf(
  env: Pick<
    EnvSchema,
    | 'KEPT_BACKUP_KEEP'
    | 'KEPT_BACKUP_KEEP_DAILY'
    | 'KEPT_BACKUP_KEEP_WEEKLY'
    | 'KEPT_BACKUP_KEEP_MONTHLY'
  >,
): { daily: number; weekly: number; monthly: number } {
  return {
    daily: env.KEPT_BACKUP_KEEP_DAILY ?? env.KEPT_BACKUP_KEEP,
    weekly: env.KEPT_BACKUP_KEEP_WEEKLY ?? 4,
    monthly: env.KEPT_BACKUP_KEEP_MONTHLY ?? 6,
  };
}

/** restic's cache (plan Q5): KEPT_RESTIC_CACHE_DIR, else `<KEPT_DATA_DIR>/.cache/restic`, which
 * the backup leaves out. */
export function resticCacheDir(
  env: Pick<EnvSchema, 'KEPT_RESTIC_CACHE_DIR' | 'KEPT_DATA_DIR'>,
): string {
  return env.KEPT_RESTIC_CACHE_DIR ?? path.join(env.KEPT_DATA_DIR, '.cache', 'restic');
}

/**
 * The backup settings' own rules (T31c): one target, not both; a bucket with both credentials;
 * a directory that is absolute and outside the data volume (a backup inside it is lost with it,
 * and its tmp/ is swept at boot). `needsOwner`: this process runs the nightly job, which dumps as
 * kept_owner, so the owner login must be here too; otherwise backups would silently never run.
 */
export function checkBackupEnv(
  env: BackupEnv & { KEPT_DATA_DIR?: string; KEPT_OWNER_DATABASE_URL?: string | undefined },
  needsOwner: boolean,
): void {
  const invalid = (why: string) => new EnvError(`invalid environment: ${why}`, 'backup_invalid');
  const targets = (
    ['KEPT_BACKUP_DIR', 'KEPT_BACKUP_S3_BUCKET', 'KEPT_BACKUP_SFTP'] as const
  ).filter((name) => env[name]);
  if (targets.length > 1) {
    throw invalid(`set one backup target, not ${targets.join(' and ')}`);
  }
  if (env.KEPT_BACKUP_SFTP) {
    for (const name of ['KEPT_BACKUP_SFTP_KEY_FILE', 'KEPT_BACKUP_SFTP_KNOWN_HOSTS'] as const) {
      const file = env[name];
      if (!file) throw invalid(`KEPT_BACKUP_SFTP needs ${name}`);
      if (!path.isAbsolute(file)) throw invalid(`${name} must be absolute`);
    }
  }
  if (env.KEPT_BACKUP_S3_BUCKET) {
    const missing = (
      ['KEPT_BACKUP_S3_ACCESS_KEY_ID', 'KEPT_BACKUP_S3_SECRET_ACCESS_KEY'] as const
    ).filter((name) => !env[name]);
    if (missing.length > 0) throw invalid(`KEPT_BACKUP_S3_BUCKET needs ${missing.join(', ')}`);
  }
  if (env.KEPT_BACKUP_DIR) {
    if (!path.isAbsolute(env.KEPT_BACKUP_DIR)) throw invalid('KEPT_BACKUP_DIR must be absolute');
    if (env.KEPT_DATA_DIR) {
      const data = path.resolve(env.KEPT_DATA_DIR);
      const dir = path.resolve(env.KEPT_BACKUP_DIR);
      if (dir === data || dir.startsWith(`${data}${path.sep}`)) {
        throw invalid(
          'KEPT_BACKUP_DIR is inside KEPT_DATA_DIR, so losing the data volume loses the backups too; use another disk',
        );
      }
    }
  }
  if (needsOwner && backupTargetSet(env) && !env.KEPT_OWNER_DATABASE_URL) {
    throw invalid(
      'a backup target is set, and the nightly backup dumps the database as kept_owner: set KEPT_OWNER_DATABASE_URL for the worker too',
    );
  }
}

export type EnvSchema = z.infer<typeof schema>;

/**
 * The master keys for secrets at rest (§7.3, plan Q19): the current one, which seals, and the
 * retired ones, which still open what they sealed (values not yet re-wrapped, old backups).
 */
export type SecretKeyring = Readonly<{
  version: number;
  key: Buffer;
  retired: ReadonlyMap<number, Buffer>;
  /** `environment`, or the secrets.json the keys were read from (rotate-key rewrites it). */
  source: 'environment' | string;
}>;

/** The parsed environment. The key fields are present but non-enumerable, so
 * `JSON.stringify(env)`, `{ ...env }` and `console.log(env)` never carry them. */
export type Env = Readonly<
  Omit<
    EnvSchema,
    | 'KEPT_SECRET_KEY'
    | 'KEPT_AUTH_SECRET'
    | 'KEPT_SECRET_KEY_VERSION'
    | 'KEPT_SECRET_KEYS_RETIRED'
    | 'KEPT_IMAGE_CONCURRENCY'
    | 'KEPT_S3_SECRET_ACCESS_KEY'
    | 'KEPT_BACKUP_S3_SECRET_ACCESS_KEY'
    | 'KEPT_BACKUP_PASSWORD'
    | 'KEPT_VAPID_PRIVATE_KEY'
    | 'KEPT_OIDC_CLIENT_SECRET'
  > & {
    KEPT_SECRET_KEY: string;
    KEPT_AUTH_SECRET: string;
    secretKey: Buffer;
    authSecret: Buffer;
    /** Non-enumerable: the current key with its version, and the retired ones. */
    secretKeyring: SecretKeyring;
    /** Resolved: the variable, else defaultImageConcurrency() for this host. */
    KEPT_IMAGE_CONCURRENCY: number;
    /** Non-enumerable, like the keys. */
    KEPT_S3_SECRET_ACCESS_KEY: string | undefined;
    /** Non-enumerable, like the keys. */
    KEPT_BACKUP_S3_SECRET_ACCESS_KEY: string | undefined;
    /** Non-enumerable, like the keys (step 8). */
    KEPT_BACKUP_PASSWORD: string | undefined;
    /** Non-enumerable, like the keys. Set exactly when KEPT_VAPID_PUBLIC_KEY is. */
    KEPT_VAPID_PRIVATE_KEY: string | undefined;
    /** Non-enumerable, like the keys. */
    KEPT_OIDC_CLIENT_SECRET: string | undefined;
  }
>;

/**
 * The VAPID subject web push signs with (step-4 plan T2, Q11): KEPT_VAPID_SUBJECT; else
 * KEPT_PUBLIC_URL when it is https (and not localhost, which Apple's push service refuses, as
 * web-push warns); else `mailto:` the KEPT_SMTP_FROM address. Null: push reports "unavailable".
 */
export function vapidSubject(
  env: Pick<EnvSchema, 'KEPT_VAPID_SUBJECT' | 'KEPT_PUBLIC_URL' | 'KEPT_SMTP_FROM'>,
): string | null {
  if (env.KEPT_VAPID_SUBJECT) return env.KEPT_VAPID_SUBJECT;
  const pub = new URL(env.KEPT_PUBLIC_URL);
  if (pub.protocol === 'https:' && pub.hostname !== 'localhost') return pub.origin;
  const from = env.KEPT_SMTP_FROM;
  if (from) {
    const address = (/<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? from).trim();
    if (/^[^\s@<>]+@[^\s@<>]+$/.test(address)) return `mailto:${address}`;
  }
  return null;
}

/** The machine loadEnv() runs on, for defaults that depend on it. */
export type HostInfo = { arch: string; totalMemBytes: number };

const SMALL_HOST_BYTES = 3 * 1024 ** 3;

/** Q17, D209: one image at a time on a small host (the 2 GB floor), two anywhere else. */
export function defaultImageConcurrency(totalMemBytes: number): number {
  return totalMemBytes < SMALL_HOST_BYTES ? 1 : 2;
}

/** The S3 variables KEPT_STORAGE=s3 can't do without. */
const S3_REQUIRED = [
  'KEPT_S3_BUCKET',
  'KEPT_S3_ACCESS_KEY_ID',
  'KEPT_S3_SECRET_ACCESS_KEY',
] as const;

export type LoadEnvOptions = {
  /** Overrides `KEPT_CONFIG_DIR` for where first-boot keys are read from / written to. */
  configDir?: string;
  /** Receives the single log line written when keys are generated. */
  logger?: (line: string) => void;
  /** The host, for KEPT_IMAGE_CONCURRENCY's default. Defaults to this process's. */
  host?: HostInfo;
  /** Whether `KEPT_EMBEDDINGS=local` can run (its runtime resolves). Defaults to a resolve of
   * LOCAL_EMBEDDINGS_PACKAGE from here; tests pass their own. */
  localEmbeddingsAvailable?: () => boolean;
};

/** Whether the local embedding runtime is installed where this module can import it. */
export function localEmbeddingsInstalled(): boolean {
  try {
    import.meta.resolve(LOCAL_EMBEDDINGS_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/** Where the local embedding model's files live (D207): KEPT_EMBEDDINGS_DIR, else <data>/models. */
export function embeddingsDir(
  env: Pick<EnvSchema, 'KEPT_EMBEDDINGS_DIR' | 'KEPT_DATA_DIR'>,
): string {
  return env.KEPT_EMBEDDINGS_DIR ?? path.join(env.KEPT_DATA_DIR, 'models');
}

type Source = Record<string, string | undefined>;

function withoutEmpty(source: Source): Source {
  return Object.fromEntries(
    Object.entries(source).map(([name, value]) => [name, value === '' ? undefined : value]),
  );
}

function issuePaths(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.path.join('.')))].join(', ');
}

// Hex is recognised only as whole bytes, at least 32 of them (`openssl rand -hex 32`).
// Anything else must be canonical unpadded base64url: Buffer.from(…, 'base64url') silently
// drops characters it doesn't know, so a typo would otherwise shrink the key without a word.
const HEX = /^(?:[0-9a-f]{2}){32,}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function decodeKey(value: string, name: string): Buffer {
  let buf: Buffer;
  if (HEX.test(value)) {
    buf = Buffer.from(value, 'hex');
  } else if (BASE64URL.test(value)) {
    buf = Buffer.from(value, 'base64url');
    if (buf.toString('base64url') !== value) {
      throw new EnvError(`${name} is not canonical base64url`, 'secret_key_invalid');
    }
  } else {
    throw new EnvError(
      `${name} must be base64url (A-Z a-z 0-9 - _, no padding) or hex`,
      'secret_key_invalid',
    );
  }
  if (buf.length < 32) {
    throw new EnvError(`${name} decodes to fewer than 32 bytes`, 'secret_key_too_short');
  }
  return buf;
}

const VERSION = /^[1-9][0-9]{0,6}$/;

/** A key version: a positive integer (at most 7 digits). `undefined` is version 1, the version
 * of every key made before rotation existed. */
export function parseKeyVersion(value: string | number | undefined, name: string): number {
  if (value === undefined) return 1;
  const text = String(value);
  if (!VERSION.test(text)) {
    throw new EnvError(`${name} must be a positive whole number`, 'secret_key_version_invalid');
  }
  return Number(text);
}

/**
 * `KEPT_SECRET_KEYS_RETIRED`: comma-separated `version:key` pairs, each key in KEPT_SECRET_KEY's
 * format. A version appears once and is never the current one. Messages name versions, never
 * keys.
 */
export function parseRetiredKeys(
  value: string | undefined,
  currentVersion: number,
  name = 'KEPT_SECRET_KEYS_RETIRED',
): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const colon = entry.indexOf(':');
    if (colon < 0) {
      throw new EnvError(`${name}: each entry is version:key`, 'secret_key_version_invalid');
    }
    const version = parseKeyVersion(entry.slice(0, colon), `${name}'s versions`);
    if (version === currentVersion) {
      throw new EnvError(
        `${name} lists version ${version}, which is the current key's`,
        'secret_key_version_invalid',
      );
    }
    if (out.has(version)) {
      throw new EnvError(`${name} lists version ${version} twice`, 'secret_key_version_invalid');
    }
    out.set(version, decodeKey(entry.slice(colon + 1), `${name} version ${version}`));
  }
  return out;
}

/** secrets.json: the two keys, and after a rotation the key's version and the retired keys, under
 * the environment variables' own names (a file written before rotation has no version: 1). */
export type SecretsFile = {
  KEPT_SECRET_KEY: string;
  KEPT_AUTH_SECRET: string;
  KEPT_SECRET_KEY_VERSION?: number;
  KEPT_SECRET_KEYS_RETIRED?: string;
};

type ResolvedKeys = {
  secretKeyRaw: string;
  authSecretRaw: string;
  secretKey: Buffer;
  authSecret: Buffer;
  secretKeyVersion: number;
  retiredRaw: string | undefined;
  retired: Map<number, Buffer>;
  source: 'environment' | string;
};

type KeyInput = Omit<SecretsFile, 'KEPT_SECRET_KEY_VERSION'> & {
  KEPT_SECRET_KEY_VERSION?: number | string;
};

function resolved(raw: KeyInput, source: 'environment' | string): ResolvedKeys {
  const secretKeyVersion = parseKeyVersion(raw.KEPT_SECRET_KEY_VERSION, 'KEPT_SECRET_KEY_VERSION');
  return {
    secretKeyRaw: raw.KEPT_SECRET_KEY,
    authSecretRaw: raw.KEPT_AUTH_SECRET,
    secretKey: decodeKey(raw.KEPT_SECRET_KEY, 'KEPT_SECRET_KEY'),
    authSecret: decodeKey(raw.KEPT_AUTH_SECRET, 'KEPT_AUTH_SECRET'),
    secretKeyVersion,
    retiredRaw: raw.KEPT_SECRET_KEYS_RETIRED || undefined,
    retired: parseRetiredKeys(raw.KEPT_SECRET_KEYS_RETIRED, secretKeyVersion),
    source,
  };
}

/** Reads and validates secrets.json. `null` only when the file does not exist: anything else
 * wrong with it is fatal, because regenerating would orphan everything the old keys encrypted
 * or signed. */
async function readSecretsFile(filePath: string): Promise<ResolvedKeys | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const invalid = (why: string) =>
    new EnvError(`${filePath} exists but ${why}; fix or restore it`, 'secrets_file_invalid');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw invalid('is not valid JSON');
  }
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (typeof record.KEPT_SECRET_KEY !== 'string' || typeof record.KEPT_AUTH_SECRET !== 'string') {
    throw invalid('lacks KEPT_SECRET_KEY or KEPT_AUTH_SECRET');
  }
  const version = record.KEPT_SECRET_KEY_VERSION;
  const retired = record.KEPT_SECRET_KEYS_RETIRED;
  if (version !== undefined && typeof version !== 'number') {
    throw invalid('has a KEPT_SECRET_KEY_VERSION that is not a number');
  }
  if (retired !== undefined && typeof retired !== 'string') {
    throw invalid('has a KEPT_SECRET_KEYS_RETIRED that is not a string');
  }
  try {
    return resolved(
      {
        KEPT_SECRET_KEY: record.KEPT_SECRET_KEY,
        KEPT_AUTH_SECRET: record.KEPT_AUTH_SECRET,
        ...(version !== undefined ? { KEPT_SECRET_KEY_VERSION: version } : {}),
        ...(retired !== undefined ? { KEPT_SECRET_KEYS_RETIRED: retired } : {}),
      },
      filePath,
    );
  } catch (err) {
    throw invalid(`holds an unusable key (${(err as Error).message})`);
  }
}

/**
 * Publishes secrets.json with no window where a reader sees a partial file, and without two
 * concurrent first boots each keeping their own keys: the file is written and fsynced under a
 * unique temp name, then hard-linked into place. link() fails with EEXIST if another process
 * got there first, and that process's file is the one everybody uses. Returns false if lost.
 */
async function publishSecretsFile(filePath: string, data: SecretsFile): Promise<boolean> {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function resolveKeys(
  env: EnvSchema,
  configDir: string,
  logger?: (line: string) => void,
): Promise<ResolvedKeys> {
  // Any supplied value is validated first, so a bad value is reported as what it is.
  const secretKey = env.KEPT_SECRET_KEY && decodeKey(env.KEPT_SECRET_KEY, 'KEPT_SECRET_KEY');
  const authSecret = env.KEPT_AUTH_SECRET && decodeKey(env.KEPT_AUTH_SECRET, 'KEPT_AUTH_SECRET');

  // Both supplied: used as given, nothing written (§7.3, §7.11).
  if (env.KEPT_SECRET_KEY && env.KEPT_AUTH_SECRET && secretKey && authSecret) {
    return resolved(
      {
        KEPT_SECRET_KEY: env.KEPT_SECRET_KEY,
        KEPT_AUTH_SECRET: env.KEPT_AUTH_SECRET,
        ...(env.KEPT_SECRET_KEY_VERSION !== undefined
          ? { KEPT_SECRET_KEY_VERSION: env.KEPT_SECRET_KEY_VERSION }
          : {}),
        ...(env.KEPT_SECRET_KEYS_RETIRED !== undefined
          ? { KEPT_SECRET_KEYS_RETIRED: env.KEPT_SECRET_KEYS_RETIRED }
          : {}),
      },
      'environment',
    );
  }
  // The version and the retired keys go with an operator-set key. With generated keys they live
  // in secrets.json beside them, so a variable here would be a second, conflicting source.
  if (env.KEPT_SECRET_KEY_VERSION !== undefined || env.KEPT_SECRET_KEYS_RETIRED !== undefined) {
    if (!env.KEPT_SECRET_KEY && !env.KEPT_AUTH_SECRET) {
      throw new EnvError(
        `KEPT_SECRET_KEY_VERSION and KEPT_SECRET_KEYS_RETIRED go with KEPT_SECRET_KEY; with generated keys they live in ${path.join(configDir, 'secrets.json')}`,
        'secret_keys_partial',
      );
    }
  }
  // One supplied: the operator meant to manage keys and missed one. Generating the other would
  // mix an env-managed key with a volume-managed one, so refuse instead.
  if (env.KEPT_SECRET_KEY || env.KEPT_AUTH_SECRET) {
    const missing = env.KEPT_SECRET_KEY ? 'KEPT_AUTH_SECRET' : 'KEPT_SECRET_KEY';
    throw new EnvError(
      `KEPT_SECRET_KEY and KEPT_AUTH_SECRET are set together or not at all; ${missing} is missing`,
      'secret_keys_partial',
    );
  }

  // Neither supplied: both are generated (D193), once, into the config volume.
  const secretsPath = path.join(configDir, 'secrets.json');
  const existing = await readSecretsFile(secretsPath);
  if (existing) return existing;

  // The mode applies only to directories this call creates; an existing volume keeps its own.
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const generated = {
    KEPT_SECRET_KEY: randomBytes(32).toString('base64url'),
    KEPT_AUTH_SECRET: randomBytes(32).toString('base64url'),
  };
  if (await publishSecretsFile(secretsPath, generated)) {
    logger?.(`kept: generated KEPT_SECRET_KEY and KEPT_AUTH_SECRET at ${secretsPath}`);
    return resolved(generated, secretsPath);
  }
  const winner = await readSecretsFile(secretsPath);
  if (!winner) throw new Error(`${secretsPath} vanished after a concurrent first boot wrote it`);
  return winner;
}

export async function loadEnv(
  source: Source = process.env,
  opts: LoadEnvOptions = {},
): Promise<Env> {
  const parsed = schema.safeParse(withoutEmpty(source));
  if (!parsed.success) {
    throw new EnvError(`invalid environment: ${issuePaths(parsed.error)}`, 'invalid_env');
  }
  const {
    KEPT_SECRET_KEY: _secretKey,
    KEPT_AUTH_SECRET: _authSecret,
    KEPT_SECRET_KEY_VERSION: _secretKeyVersion,
    KEPT_SECRET_KEYS_RETIRED: _retired,
    KEPT_S3_SECRET_ACCESS_KEY: s3Secret,
    KEPT_BACKUP_S3_SECRET_ACCESS_KEY: backupS3Secret,
    KEPT_BACKUP_PASSWORD: backupPassword,
    KEPT_VAPID_PRIVATE_KEY: vapidPrivateKey,
    KEPT_OIDC_CLIENT_SECRET: oidcClientSecret,
    KEPT_IMAGE_CONCURRENCY: imageConcurrency,
    ...env
  } = parsed.data;

  // Step 6 (D207): the local model runs only where its runtime is installed.
  if (
    env.KEPT_EMBEDDINGS === 'local' &&
    !(opts.localEmbeddingsAvailable ?? localEmbeddingsInstalled)()
  ) {
    throw new EnvError(
      `KEPT_EMBEDDINGS=local needs ${LOCAL_EMBEDDINGS_PACKAGE}, which this build doesn't include (D207); use provider or off`,
      'embeddings_unavailable',
    );
  }

  // Step 6 (S6.7): an OIDC issuer needs its client id.
  if (env.KEPT_OIDC_ISSUER && !env.KEPT_OIDC_CLIENT_ID) {
    throw new EnvError('KEPT_OIDC_ISSUER is set without KEPT_OIDC_CLIENT_ID', 'oidc_incomplete');
  }

  // Step 4 (Q11): the VAPID pair overrides the generated one only whole.
  if (Boolean(env.KEPT_VAPID_PUBLIC_KEY) !== Boolean(vapidPrivateKey)) {
    const missing = env.KEPT_VAPID_PUBLIC_KEY ? 'KEPT_VAPID_PRIVATE_KEY' : 'KEPT_VAPID_PUBLIC_KEY';
    throw new EnvError(
      `KEPT_VAPID_PUBLIC_KEY and KEPT_VAPID_PRIVATE_KEY are set together or not at all; ${missing} is missing`,
      'vapid_keys_partial',
    );
  }

  // The nightly backup's target (T31c); the owner login is needed where the job runs.
  checkBackupEnv(parsed.data, env.KEPT_ROLE !== 'web');
  // Step 8 (plan Q7): the alpha's count is read as the daily count for one release.
  if (withoutEmpty(source).KEPT_BACKUP_KEEP !== undefined) {
    opts.logger?.(
      'kept: KEPT_BACKUP_KEEP is deprecated and read as KEPT_BACKUP_KEEP_DAILY; set KEPT_BACKUP_KEEP_DAILY, _WEEKLY and _MONTHLY instead',
    );
  }

  if (env.KEPT_STORAGE === 's3') {
    const missing = S3_REQUIRED.filter((name) => !parsed.data[name]);
    if (missing.length > 0) {
      throw new EnvError(
        `invalid environment: KEPT_STORAGE=s3 needs ${missing.join(', ')}`,
        'invalid_env',
      );
    }
  }
  const host = opts.host ?? { arch: process.arch, totalMemBytes: os.totalmem() };

  // D147: outside dev, the image sets KEPT_SOURCE_URL from its OCI labels; refuse to boot
  // without it so a production deploy is never silently unattributed.
  if (source.NODE_ENV === 'production' && !env.KEPT_SOURCE_URL) {
    throw new EnvError(
      'KEPT_SOURCE_URL is required when NODE_ENV=production (D147)',
      'source_url_required',
    );
  }

  // Step 3: invented extractions must never reach a real instance.
  if (source.NODE_ENV === 'production' && env.KEPT_AI_MOCK) {
    throw new EnvError(
      'KEPT_AI_MOCK=1 is for tests and development; unset it when NODE_ENV=production',
      'ai_mock_in_production',
    );
  }

  const configDir = opts.configDir ?? env.KEPT_CONFIG_DIR;
  const keys = await resolveKeys(parsed.data, configDir, opts.logger);

  const hidden = (value: unknown): PropertyDescriptor => ({ value, enumerable: false });
  return Object.freeze(
    Object.defineProperties(
      {
        ...env,
        KEPT_IMAGE_CONCURRENCY: imageConcurrency ?? defaultImageConcurrency(host.totalMemBytes),
      },
      {
        KEPT_S3_SECRET_ACCESS_KEY: hidden(s3Secret),
        KEPT_BACKUP_S3_SECRET_ACCESS_KEY: hidden(backupS3Secret),
        KEPT_BACKUP_PASSWORD: hidden(backupPassword),
        KEPT_VAPID_PRIVATE_KEY: hidden(vapidPrivateKey),
        KEPT_OIDC_CLIENT_SECRET: hidden(oidcClientSecret),
        KEPT_SECRET_KEY: hidden(keys.secretKeyRaw),
        KEPT_AUTH_SECRET: hidden(keys.authSecretRaw),
        secretKey: hidden(keys.secretKey),
        authSecret: hidden(keys.authSecret),
        secretKeyring: hidden(
          Object.freeze({
            version: keys.secretKeyVersion,
            key: keys.secretKey,
            retired: keys.retired,
            source: keys.source,
          }),
        ),
      },
    ),
  ) as Env;
}

const migrateSchema = z.object({ KEPT_OWNER_DATABASE_URL: postgresUrl() });

/** `kept migrate` needs the owner login and nothing else: no keys, no config volume, none of
 * the runtime logins. It must work from a bare CI job or an init container. */
export function loadMigrateEnv(source: Source = process.env): { ownerUrl: string } {
  const parsed = migrateSchema.safeParse(withoutEmpty(source));
  if (!parsed.success) {
    throw new EnvError(
      `KEPT_OWNER_DATABASE_URL (a postgres:// URL) is required for \`kept migrate\`: ${issuePaths(parsed.error)}`,
      'invalid_env',
    );
  }
  return { ownerUrl: parsed.data.KEPT_OWNER_DATABASE_URL };
}

export const envSchema = schema;

const adminSchema = z.object({
  KEPT_OWNER_DATABASE_URL: postgresUrl(),
  KEPT_PUBLIC_URL: httpUrl().optional(),
  KEPT_SMTP_URL: schema.shape.KEPT_SMTP_URL,
  KEPT_SMTP_FROM: schema.shape.KEPT_SMTP_FROM,
});

/** `kept admin` commands that touch the database: the owner login, the public URL to print
 * links with (a reset link), and the mail settings for the notices the commands send (D180). No
 * keys, no config volume, none of the runtime logins. */
export function loadAdminEnv(source: Source = process.env): {
  ownerUrl: string;
  publicUrl: string | undefined;
  smtpUrl: string | undefined;
  smtpFrom: string | undefined;
} {
  const parsed = adminSchema.safeParse(withoutEmpty(source));
  if (!parsed.success) {
    throw new EnvError(
      `KEPT_OWNER_DATABASE_URL (a postgres:// URL) is required for \`kept admin\`: ${issuePaths(parsed.error)}`,
      'invalid_env',
    );
  }
  return {
    ownerUrl: parsed.data.KEPT_OWNER_DATABASE_URL,
    publicUrl: parsed.data.KEPT_PUBLIC_URL,
    smtpUrl: parsed.data.KEPT_SMTP_URL,
    smtpFrom: parsed.data.KEPT_SMTP_FROM,
  };
}

/** Where `kept admin recovery-kit` and `kept admin rotate-key` found the keys, as written. */
export type KeyMaterial = {
  KEPT_SECRET_KEY: string;
  KEPT_AUTH_SECRET: string;
  KEPT_SECRET_KEY_VERSION: number;
  /** `version:key` pairs; undefined when there are none. */
  KEPT_SECRET_KEYS_RETIRED: string | undefined;
  source: 'environment' | string;
};

/**
 * The key material as the running server would use it (§7.3, D193), for the recovery kit and
 * rotation: the environment variables when both keys are set, else the config volume's
 * secrets.json. Unlike loadEnv() it never generates keys: a kit of freshly made keys would
 * restore nothing. Every key is validated, the retired ones too.
 */
export async function readKeyMaterial(source: Source = process.env): Promise<KeyMaterial> {
  const env = withoutEmpty(source);
  const configDir = env.KEPT_CONFIG_DIR ?? '/config';
  const keys = await resolveKeyMaterial(env, configDir);
  if (!keys) {
    const file = path.join(configDir, 'secrets.json');
    throw new EnvError(
      `no keys: KEPT_SECRET_KEY and KEPT_AUTH_SECRET are unset and ${file} does not exist (set KEPT_CONFIG_DIR to the config volume)`,
      'secrets_file_invalid',
    );
  }
  return {
    KEPT_SECRET_KEY: keys.secretKeyRaw,
    KEPT_AUTH_SECRET: keys.authSecretRaw,
    KEPT_SECRET_KEY_VERSION: keys.secretKeyVersion,
    KEPT_SECRET_KEYS_RETIRED: keys.retiredRaw,
    source: keys.source,
  };
}

/** The keys as given (environment or secrets.json), or null when there are none to read. */
async function resolveKeyMaterial(env: Source, configDir: string): Promise<ResolvedKeys | null> {
  const secret = env.KEPT_SECRET_KEY;
  const auth = env.KEPT_AUTH_SECRET;
  if (secret && auth) {
    return resolved(
      {
        KEPT_SECRET_KEY: secret,
        KEPT_AUTH_SECRET: auth,
        ...(env.KEPT_SECRET_KEY_VERSION !== undefined
          ? { KEPT_SECRET_KEY_VERSION: env.KEPT_SECRET_KEY_VERSION }
          : {}),
        ...(env.KEPT_SECRET_KEYS_RETIRED !== undefined
          ? { KEPT_SECRET_KEYS_RETIRED: env.KEPT_SECRET_KEYS_RETIRED }
          : {}),
      },
      'environment',
    );
  }
  if (secret || auth) {
    throw new EnvError(
      'KEPT_SECRET_KEY and KEPT_AUTH_SECRET are set together or not at all',
      'secret_keys_partial',
    );
  }
  if (env.KEPT_SECRET_KEY_VERSION !== undefined || env.KEPT_SECRET_KEYS_RETIRED !== undefined) {
    throw new EnvError(
      `KEPT_SECRET_KEY_VERSION and KEPT_SECRET_KEYS_RETIRED go with KEPT_SECRET_KEY; with generated keys they live in ${path.join(configDir, 'secrets.json')}`,
      'secret_keys_partial',
    );
  }
  return readSecretsFile(path.join(configDir, 'secrets.json'));
}

/** The keyring in a secrets.json, re-read (a server whose keys a rotation just rewrote). */
export async function readSecretKeyring(filePath: string): Promise<SecretKeyring | null> {
  const keys = await readSecretsFile(filePath);
  if (!keys) return null;
  return Object.freeze({
    version: keys.secretKeyVersion,
    key: keys.secretKey,
    retired: keys.retired,
    source: filePath,
  });
}
