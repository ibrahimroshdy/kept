import {
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_LIMITS,
  type ExportOptions,
  newId,
  PASSPHRASE_KDF,
  PASSPHRASE_MIN,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import type { SecretKeys } from '../crypto/keyring.js';
import type { Scope, Tx } from '../db/scope.js';
import { decodeCursor, encodeCursor } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound, pgErrorOf } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { deriveKey, type KdfParams, newSalt, sealRunKey } from '../portability/passphrase.js';
import { requireRecoveryKit } from '../secrets/service.js';
import { exportKey, type FileStorage } from '../storage/blob-store.js';
import { SIGNED_URL_TTL_SECONDS } from '../storage/signed-url.js';

// The Kept export's runs (D68, D69, D159, D180; step-7 plan T12, Q7, Q14, Q17). A run is an
// `export_runs` row of kind `location` or `me` (step 4's table, widened by 0079/0080): its
// creator's alone while they still own or administer the location (the policies), moved along
// only through the doors (kept.export_run_claim/_progress/_finish), and purged seven days after
// it is ready (kept.purge_expired_exports, the hourly `purge-exports` job).
//
// - POST /exports: owners and admins export a location (`location.export-import`); anyone exports
//   their own data (`me`: their Personal location, plus me.json). "Include secrets" is the
//   owner's, needs the recovery kit acknowledged (D193) and the passphrase twice; the key is
//   derived here, sealed under the keyring with the run's own AAD and inserted with the row,
//   and the passphrase goes no further (Q7). Five an hour per person, one running per location.
//   The `export` tenant job is sent in the same transaction, its `data` only `{exportId}`.
// - GET /exports/:id: the run, with a five-minute signed URL to `x/<id>.zip` while it is done
//   and unexpired. The policy re-checks the role on every read (D180): a creator who lost owner
//   or admin gets a 404. Handing out a URL is audited `export.download`.
// - POST /exports/:id/cancel: kept.export_run_finish(…, 'cancelled'); the job stops at its next
//   door call.

export const ExportOptionsBody = z
  .object({
    ended: z.boolean(),
    trashed: z.boolean(),
    history: z.boolean(),
    aiCalls: z.boolean(),
    readable: z.boolean(),
    pdf: z.boolean(),
    locale: z.enum(['en', 'ar', 'fr', 'de', 'it']),
    digits: z.enum(['western', 'eastern']),
  })
  .partial()
  .strict();

export const CreateExportBody = z
  .object({
    id: z.uuid().optional(),
    scope: z.union([
      z.object({ locationId: z.uuid() }).strict(),
      z.object({ me: z.literal(true) }).strict(),
    ]),
    options: ExportOptionsBody.optional(),
    includeSecrets: z.boolean().optional(),
    passphrase: z.string().max(1024).optional(),
    passphraseAgain: z.string().max(1024).optional(),
  })
  .strict();
export type CreateExportBody = z.infer<typeof CreateExportBody>;

const STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled', 'expired'] as const;

export const ExportRunView = z.object({
  id: z.uuid(),
  scope: z.enum(['location', 'me']),
  locationId: z.uuid().optional(),
  status: z.enum(STATUSES),
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  bytes: z.number().int().optional(),
  sha256: z.string().optional(),
  includesSecrets: z.boolean(),
  options: z.object({
    ended: z.boolean(),
    trashed: z.boolean(),
    history: z.boolean(),
    aiCalls: z.boolean(),
    readable: z.boolean(),
    pdf: z.boolean(),
    locale: z.string(),
    digits: z.enum(['western', 'eastern']),
  }),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  error: z.string().optional(),
  fileUrl: z.string().optional(),
});
export type ExportRunView = z.infer<typeof ExportRunView>;

export const ExportsQuery = z.object({
  locationId: z.uuid().optional(),
  cursor: z.string().max(512).optional(),
});

export const EXPORTS_PAGE = 50;
const RATE_WINDOW_SECONDS = 3600;
/** A run still `running` this long after it began has been abandoned (the job expires at two
 * hours, jobs/policies.ts; the purge fails it at three). */
const STALE_RUNNING_MS = 2.5 * 3600 * 1000;

/** What the job is sent: the run, and nothing else (never a passphrase or a key). */
export type ExportJobData = { exportId: string };

type RunRow = {
  id: string;
  location_id: string;
  location_name: string | null;
  kind: 'location' | 'me';
  include_secrets: boolean;
  options: Partial<ExportOptions>;
  status: (typeof STATUSES)[number];
  progress_done: number;
  progress_total: number;
  bytes: string | number | null;
  sha256: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date;
};

const RUN_COLUMNS = `x.id, x.location_id, l.name AS location_name, x.kind, x.include_secrets,
  x.options, x.status, x.progress_done, x.progress_total, x.bytes, x.sha256, x.error,
  x.created_at, x.started_at, x.finished_at, x.expires_at`;

export const optionsOf = (stored: Partial<ExportOptions> | null | undefined): ExportOptions => ({
  ...DEFAULT_EXPORT_OPTIONS,
  ...(stored ?? {}),
});

// ---------------------------------------------------------------------------------------------
// POST /api/v1/exports
// ---------------------------------------------------------------------------------------------

async function personalLocation(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT l.id FROM public.locations l
      WHERE l.owner_account_id = kept.current_owner_account_id() AND l.kind = 'personal'
        AND l.deleted_at IS NULL
      ORDER BY l.created_at, l.id LIMIT 1`,
  );
  const id = rows[0]?.id;
  if (!id) throw notFound('You have no Personal location to export.');
  return id;
}

async function checkRate(client: pg.ClientBase): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('kept.export:' || kept.current_user_id()::text, 0))`,
  );
  const { rows } = await client.query<{ n: number; oldest: Date | null }>(
    `SELECT count(*)::int AS n, min(created_at) AS oldest FROM public.export_runs
      WHERE created_by = kept.current_user_id() AND kind IN ('location', 'me')
        AND created_at > now() - make_interval(secs => $1)`,
    [RATE_WINDOW_SECONDS],
  );
  const { n = 0, oldest = null } = rows[0] ?? {};
  if (n >= EXPORT_LIMITS.perHour) {
    const retryAfter = oldest
      ? Math.max(1, Math.ceil((oldest.getTime() + RATE_WINDOW_SECONDS * 1000 - Date.now()) / 1000))
      : RATE_WINDOW_SECONDS;
    throw new AppError(
      'rate_limited',
      429,
      `At most ${EXPORT_LIMITS.perHour} exports an hour. Try again later.`,
      { retryAfter },
    );
  }
}

/**
 * 409 `export_running` while a Kept export of the location is queued or running, anyone's
 * (kept.export_running(), 0101: the policies show the caller only their own runs, D180).
 */
async function checkRunning(client: pg.ClientBase, locationId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('kept.export_loc:' || $1, 0))`,
    [locationId],
  );
  const { rows } = await client.query<{ busy: boolean }>('SELECT kept.export_running($1) AS busy', [
    locationId,
  ]);
  if (rows[0]?.busy) {
    throw new AppError('export_running', 409, 'An export of this location is already running.');
  }
}

export type CreateDeps = { jobs: JobQueue; secretKeys: SecretKeys | null; files: FileStorage };

/**
 * Records a run and sends its job. With `includeSecrets`, the passphrase-derived key is sealed
 * onto the row as it is inserted (kept_app may only ever clear it afterwards).
 */
export async function createExport(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  deps: CreateDeps,
  body: CreateExportBody,
  requestId: string,
): Promise<ExportRunView> {
  const kind: 'location' | 'me' = 'me' in body.scope ? 'me' : 'location';
  const locationId =
    'locationId' in body.scope
      ? body.scope.locationId.toLowerCase()
      : await personalLocation(client);
  const me = await requireMembership(client, locationId);
  if (kind === 'location') {
    requireCan(me.role, 'location.export-import', 'Only owners and admins can export a location.');
  }
  const id = (body.id ?? newId()).toLowerCase();
  if (body.id) {
    // The same id again (a retry after a lost answer): the run it made, if it is the caller's.
    const { rows } = await client.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM public.export_runs x
         LEFT JOIN public.locations l ON l.id = x.location_id
        WHERE x.id = $1 AND x.kind IN ('location', 'me')`,
      [id],
    );
    if (rows[0]) return viewOf(rows[0]);
  }

  const includeSecrets = body.includeSecrets === true;
  let sealed: { ciphertext: unknown; keyVersion: number } | null = null;
  if (includeSecrets) {
    if (me.role !== 'owner') throw forbidden('Only the owner can include secrets.');
    if (!deps.secretKeys) {
      throw new AppError('internal', 503, 'Secrets need the server key (KEPT_SECRET_KEY).');
    }
    await requireRecoveryKit(client);
    const pass = body.passphrase ?? '';
    if ([...pass].length < PASSPHRASE_MIN || pass !== (body.passphraseAgain ?? '')) {
      throw new AppError(
        'passphrase_weak',
        400,
        `Use a passphrase of at least ${PASSPHRASE_MIN} characters, the same both times.`,
      );
    }
  } else if (body.passphrase !== undefined || body.passphraseAgain !== undefined) {
    throw invalid('A passphrase is sent only with includeSecrets: true.');
  }

  await checkRate(client);
  await checkRunning(client, locationId);

  const { rows: profile } = await client.query<{ locale: string; digits: 'western' | 'eastern' }>(
    'SELECT locale, digits FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  const locale = (['en', 'ar', 'fr', 'de', 'it'] as const).find(
    (l) => l === (profile[0]?.locale ?? '').slice(0, 2),
  );
  const options: ExportOptions = optionsOf({
    ...(locale ? { locale } : {}),
    ...(profile[0]?.digits ? { digits: profile[0].digits } : {}),
    ...body.options,
  });

  if (includeSecrets && deps.secretKeys) {
    const salt = newSalt();
    const kdf = PASSPHRASE_KDF as KdfParams;
    const key = await deriveKey(body.passphrase as string, salt, kdf);
    try {
      sealed = sealRunKey(deps.secretKeys, 'export_runs', id, key, { salt, kdf });
    } finally {
      key.fill(0);
    }
  }

  try {
    await client.query(
      `INSERT INTO public.export_runs
         (id, location_id, kind, include_secrets, options, created_by, secrets_key_ciphertext,
          key_version)
       VALUES ($1, $2, $3, $4, $5::jsonb, kept.current_user_id(), $6::jsonb, $7)`,
      [
        id,
        locationId,
        kind,
        includeSecrets,
        JSON.stringify(options),
        sealed ? JSON.stringify(sealed.ciphertext) : null,
        sealed?.keyVersion ?? null,
      ],
    );
  } catch (err) {
    const pg = pgErrorOf(err);
    if (pg?.code === '23505') throw new AppError('conflict', 409, 'That export id is taken.');
    if (pg?.code === '42501') throw forbidden();
    throw err;
  }
  await audited(tx, {
    locationId,
    actor: { type: 'user', id: scope.userId },
    action: 'export.create',
    entity: { type: 'export_run', id },
    before: null,
    after: { scope: kind, include_secrets: includeSecrets, options },
    requestId,
  });
  const data: ExportJobData = { exportId: id };
  await deps.jobs.sendTenant(client, 'export', data);
  return exportView(tx, client, scope, deps.files, id, requestId, { sign: false });
}

// ---------------------------------------------------------------------------------------------
// GET /api/v1/exports/:id, GET /api/v1/exports
// ---------------------------------------------------------------------------------------------

function statusOf(run: RunRow): ExportRunView['status'] {
  if (run.status === 'done' && run.expires_at.getTime() <= Date.now()) return 'expired';
  if (
    (run.status === 'running' || run.status === 'queued') &&
    Date.now() - (run.started_at ?? run.created_at).getTime() > STALE_RUNNING_MS
  ) {
    return 'failed';
  }
  return run.status;
}

function viewOf(run: RunRow): ExportRunView {
  const status = statusOf(run);
  const view: ExportRunView = {
    id: run.id,
    scope: run.kind,
    locationId: run.location_id,
    status,
    progress: { done: run.progress_done, total: run.progress_total },
    includesSecrets: run.include_secrets,
    options: optionsOf(run.options),
    createdAt: run.created_at.toISOString(),
  };
  if (run.finished_at) view.finishedAt = run.finished_at.toISOString();
  if (run.status === 'done' || run.status === 'expired') {
    view.expiresAt = run.expires_at.toISOString();
  }
  if (status === 'done') {
    view.bytes = Number(run.bytes ?? 0);
    if (run.sha256) view.sha256 = run.sha256;
  }
  if (status === 'failed')
    view.error = run.status === 'failed' ? (run.error ?? 'failed') : 'timeout';
  return view;
}

/** An ASCII download name: `kept-<location>-<date>.zip`, or `kept-my-data-<date>.zip`. */
export function zipName(run: Pick<RunRow, 'kind' | 'location_name' | 'created_at'>): string {
  const day = run.created_at.toISOString().slice(0, 10);
  if (run.kind === 'me') return `kept-my-data-${day}.zip`;
  const slug = (run.location_name ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `kept-${slug || 'location'}-${day}.zip`;
}

async function readRun(client: pg.ClientBase, id: string): Promise<RunRow> {
  const { rows } = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM public.export_runs x
       LEFT JOIN public.locations l ON l.id = x.location_id
      WHERE x.id = $1 AND x.kind IN ('location', 'me')`,
    [id.toLowerCase()],
  );
  const run = rows[0];
  if (!run) throw notFound();
  return run;
}

/** The run as the caller sees it, with a fresh signed URL while it is ready (`sign`). */
export async function exportView(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage,
  id: string,
  requestId: string,
  opts: { sign: boolean } = { sign: true },
): Promise<ExportRunView> {
  const run = await readRun(client, id);
  const view = viewOf(run);
  if (opts.sign && view.status === 'done') {
    view.fileUrl = await files.blobs.signedUrl(exportKey(run.id), {
      expiresIn: SIGNED_URL_TTL_SECONDS,
      disposition: 'attachment',
      filename: zipName(run),
      contentType: 'application/zip',
    });
    await audited(tx, {
      locationId: run.location_id,
      actor: { type: 'user', id: scope.userId },
      action: 'export.download',
      entity: { type: 'export_run', id: run.id },
      before: null,
      after: { bytes: view.bytes ?? null },
      requestId,
    });
  }
  return view;
}

/** The caller's own Kept exports, newest first (`?locationId` narrows to one location). */
export async function listExports(
  client: pg.ClientBase,
  q: z.infer<typeof ExportsQuery>,
): Promise<{ items: ExportRunView[]; next_cursor: string | null }> {
  const params: unknown[] = [];
  const where = [`x.kind IN ('location', 'me')`, 'x.created_by = kept.current_user_id()'];
  if (q.locationId) {
    params.push(q.locationId.toLowerCase());
    where.push(`x.location_id = $${params.length}`);
  }
  if (q.cursor) {
    const key = decodeCursor<unknown>(q.cursor);
    if (
      !Array.isArray(key) ||
      typeof key[0] !== 'string' ||
      typeof key[1] !== 'string' ||
      Number.isNaN(Date.parse(key[0])) ||
      !z.uuid().safeParse(key[1]).success
    ) {
      throw invalid('Bad cursor.');
    }
    params.push(key[0], key[1]);
    where.push(
      `(x.created_at, x.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  const { rows } = await client.query<RunRow & { created_key: string }>(
    `SELECT ${RUN_COLUMNS}, x.created_at::text AS created_key FROM public.export_runs x
       LEFT JOIN public.locations l ON l.id = x.location_id
      WHERE ${where.join(' AND ')}
      ORDER BY x.created_at DESC, x.id DESC
      LIMIT ${EXPORTS_PAGE + 1}`,
    params,
  );
  const page = rows.slice(0, EXPORTS_PAGE);
  const last = page.at(-1);
  return {
    items: page.map(viewOf),
    next_cursor:
      rows.length > EXPORTS_PAGE && last ? encodeCursor([last.created_key, last.id]) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// POST /api/v1/exports/:id/cancel
// ---------------------------------------------------------------------------------------------

export async function cancelExport(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  files: FileStorage,
  id: string,
  requestId: string,
): Promise<ExportRunView> {
  const run = await readRun(client, id);
  if (run.status === 'queued' || run.status === 'running') {
    await client.query('SELECT kept.export_run_finish($1, NULL, $2, NULL)', [run.id, 'cancelled']);
    await audited(tx, {
      locationId: run.location_id,
      actor: { type: 'user', id: scope.userId },
      action: 'export.cancel',
      entity: { type: 'export_run', id: run.id },
      before: { status: run.status },
      after: { status: 'cancelled' },
      requestId,
    });
  }
  return exportView(tx, client, scope, files, run.id, requestId, { sign: false });
}
