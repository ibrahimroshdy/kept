import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  ARCHIVE_REFUSALS,
  ARCHIVE_SOURCES,
  type ArchiveRefusal,
  type ArchiveSource,
  HomeboxChoices,
  IMPORT_ISSUE_CODES,
  IMPORT_STALE_MINUTES,
  IMPORT_STATUSES,
  ZIP_LIMITS,
} from '@kept/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { requireScope } from '../auth/http.js';
import type { Pools } from '../db/pools.js';
import { LOCATION_KINDS } from '../db/schema/index.js';
import { type Scope, type Tx, withScope } from '../db/scope.js';
import { receive } from '../files/upload.js';
import type { KeptApp } from '../http/app.js';
import { assertClientId, checkVersion, requireIfMatch } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import type { JobQueue } from '../jobs/queue.js';
import { createLocation } from '../locations/create.js';
import { ArchiveContentError, ArchiveError } from '../portability/zip/limits.js';
import type { OpenArchive } from '../portability/zip/read.js';
import { type FileStorage, importArchiveKey } from '../storage/blob-store.js';
import { requireRole } from '../things/service.js';
import type {
  ArchiveCtx,
  ArchiveDryRunReport,
  ArchiveImporter,
  ArchiveInspect,
  ArchiveRunRow,
} from './archive-types.js';
import { homeboxConnectRoutes } from './homebox/api.js';
import { homeboxImporter } from './homebox/importer.js';
import { keptImporter } from './kept/importer.js';
import { keptImportRoutes } from './kept/routes.js';

// Step 7: archive imports (D146, D157; plan T8, T11, T14; screens §6). Registered in
// http/routes.ts; T11 and T14 add their routes here. A Homebox export or a Kept export is
// declared, uploaded whole, inspected, given a target (a new location, or for Homebox an existing
// one), then checked by a dry run and imported by a tenant job (T10, T14), in the shapes of
// apps/web/src/api/portability/types.ts:
//
// POST /api/v1/imports/archive              {id, source, bytes, sha256} → 201 ImportRun (draft)
// PUT  /api/v1/imports/:id/archive          raw application/zip → ImportRun (archiveReadyAt);
//                                           stored under importArchiveKey(id), never a name
// POST /api/v1/imports/:id/inspect          → ArchiveInspect
// POST /api/v1/imports/:id/target           {locationId} | {newLocation} → ImportRun
// POST /api/v1/imports/:id/choices          {choices: HomeboxChoices} (If-Match) → ImportRun
// POST /api/v1/imports/:id/homebox-connect  {baseUrl, apiKey} | {baseUrl, username, password}
//                                           → HomeboxConnection (T11; nothing stored or logged)
// POST /api/v1/imports/:id/passphrase       {passphrase} → ImportRun (T14; no Idempotency-Key store)
//
// GET /imports/:id, GET /imports, /dry-run, /run and /cancel are step 3's (imports/routes.ts),
// which hand an archive run to archiveRunView(), archiveDryRun(), archiveStart() and
// archiveCancel() below.
//
// Who: a run with no target yet is its creator's alone (row-level security, 0080: anyone else
// gets 404); once targeted, the location's owners and admins' (`location.export-import`, §7.1),
// a member getting 403. The target is set once (kept.set_import_target, 0080).
//
// The archive itself (D157, Q18): declared with its size and SHA-256 first (413 over
// ZIP_LIMITS.archiveBytes before a byte is stored), then one streamed PUT of exactly those bytes
// to KEPT_DATA_DIR/tmp, checked, and put() under `i/<runId>.zip`, a key built from the run's id
// only. It is read by byte range through portability/zip/ (never unpacked to disk). A refused
// archive fails the run with `archive_invalid` (or `archive_too_large`) and its reason. The
// archive is deleted when the run is cancelled or done; abandoned ones by `prune-imports`
// (prune.ts).

/** How each archive format is read, inspected and checked: Homebox's (T9) and the Kept
 * export's (T14). */
const IMPORTERS: Partial<Record<ArchiveSource, ArchiveImporter>> = {
  homebox_zip: homeboxImporter as ArchiveImporter,
  kept_zip: keptImporter as ArchiveImporter,
};

function importerOf(source: ArchiveSource): ArchiveImporter {
  const importer = IMPORTERS[source];
  if (!importer) {
    throw new AppError('internal', 503, 'Importing this kind of archive is not available yet.');
  }
  return importer;
}

const Params = z.object({ id: z.uuid() });
const SHA256 = /^[0-9a-f]{64}$/;

const CreateArchiveBody = z.strictObject({
  id: z.uuid(),
  source: z.enum(ARCHIVE_SOURCES),
  /** Checked against ZIP_LIMITS.archiveBytes in the handler: 413, not a 400. */
  bytes: z.number().int().min(1),
  sha256: z
    .string()
    .transform((s) => s.toLowerCase())
    .refine((s) => SHA256.test(s), 'the SHA-256 in hex'),
});

const CreatableKind = z.enum(
  LOCATION_KINDS.filter((k) => k !== 'personal') as [string, ...string[]],
);
const TargetBody = z.union([
  z.strictObject({ locationId: z.uuid() }),
  z.strictObject({
    newLocation: z.strictObject({
      name: z.string().trim().min(1).max(100),
      kind: CreatableKind,
      timezone: z.string().min(1).max(64),
      currency: z
        .string()
        .regex(/^[A-Za-z]{3}$/)
        .transform((c) => c.toUpperCase()),
      languages: z
        .array(z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/))
        .max(10)
        .optional(),
    }),
  }),
]);

const ChoicesBody = z.strictObject({ choices: HomeboxChoices });

/** The run as the web reads it (ArchiveImportRun). */
export const ArchiveImportRunView = z.object({
  id: z.uuid(),
  locationId: z.uuid().nullable(),
  source: z.enum(ARCHIVE_SOURCES),
  sourceVersion: z.string().nullable(),
  status: z.enum(IMPORT_STATUSES),
  bytes: z.number().int(),
  sha256: z.string(),
  archiveReadyAt: z.string().nullable(),
  inspect: z.record(z.string(), z.unknown()).nullable(),
  choices: HomeboxChoices.nullable(),
  secrets: z.object({ present: z.boolean(), unlocked: z.boolean() }).nullable(),
  progress: z.number().int(),
  total: z.number().int().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  reason: z.enum(ARCHIVE_REFUSALS).optional(),
  updatedAt: z.string(),
  report: z.record(z.string(), z.unknown()).optional(),
  rowVersion: z.number().int(),
});
export type ArchiveImportRunView = z.infer<typeof ArchiveImportRunView>;

const IssueRef = z.object({ kind: z.string(), id: z.string(), name: z.string().optional() });
const Issue = z.object({
  column: z.string(),
  code: z.enum(IMPORT_ISSUE_CODES),
  params: z.record(z.string(), z.unknown()).optional(),
  message: z.string(),
  ref: IssueRef.optional(),
});
/** An archive dry run's report (ArchiveDryRunReport): the summary, then only rows with issues. */
export const ArchiveReport = z.object({
  source: z.enum(ARCHIVE_SOURCES),
  summary: z.record(z.string(), z.unknown()),
  rows: z.array(
    z.object({
      status: z.enum(['ok', 'text', 'skipped']),
      ref: IssueRef,
      issues: z.array(Issue),
    }),
  ),
});

/** Every column the archive routes read. Never the sealed key, only whether there is one. */
export const ARCHIVE_RUN_COLUMNS = `id, location_id, source, source_version, status, choices,
  dry_run_report, progress, total, created_by, created_at, started_at, finished_at, error,
  archive_bytes, archive_sha256, archive_ready_at, inspect,
  secrets_key_ciphertext IS NOT NULL AS has_key, row_version, updated_at`;

/** The archive run `id` as the caller sees it (null when they can't), optionally locked. */
export async function readArchiveRun(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<ArchiveRunRow | null> {
  const { rows } = await client.query<ArchiveRunRow>(
    `SELECT ${ARCHIVE_RUN_COLUMNS} FROM public.import_runs
      WHERE id = $1 AND source IN ('homebox_zip', 'kept_zip')${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/** An import run's source as the caller sees it (null when they can't see it). */
export async function runSourceOf(client: pg.ClientBase, id: string): Promise<string | null> {
  const { rows } = await client.query<{ source: string }>(
    'SELECT source FROM public.import_runs WHERE id = $1',
    [id],
  );
  return rows[0]?.source ?? null;
}

export const isArchiveSource = (source: string | null): source is ArchiveSource =>
  (ARCHIVE_SOURCES as readonly string[]).includes(source ?? '');

/** `error` as stored for a refused archive: `archive_invalid` or `archive_too_large`, then the
 * reason after a colon (`archive_invalid:symlink`). The view splits them (web `error`, `reason`). */
function refusalOf(error: string | null): { error: string; reason?: ArchiveRefusal } | null {
  if (!error?.startsWith('archive_')) return null;
  const [code, reason] = error.split(':');
  const known = (ARCHIVE_REFUSALS as readonly string[]).includes(reason ?? '');
  return { error: code as string, ...(known ? { reason: reason as ArchiveRefusal } : {}) };
}

export function archiveRunView(run: ArchiveRunRow, withReport: boolean): ArchiveImportRunView {
  const refusal = refusalOf(run.error);
  const choices = run.source === 'homebox_zip' ? HomeboxChoices.safeParse(run.choices) : null;
  const inspect = run.inspect as { kept?: { includesSecrets?: unknown } } | null;
  const view: ArchiveImportRunView = {
    id: run.id,
    locationId: run.location_id,
    source: run.source,
    sourceVersion: run.source_version,
    status: run.status,
    bytes: Number(run.archive_bytes ?? 0),
    sha256: run.archive_sha256 ?? '',
    archiveReadyAt: run.archive_ready_at?.toISOString() ?? null,
    inspect: run.inspect,
    choices: choices?.success ? choices.data : null,
    secrets:
      run.source === 'kept_zip' && inspect?.kept
        ? { present: inspect.kept.includesSecrets === true, unlocked: run.has_key }
        : null,
    progress: run.progress,
    total: run.total,
    createdAt: run.created_at.toISOString(),
    startedAt: run.started_at?.toISOString() ?? null,
    finishedAt: run.finished_at?.toISOString() ?? null,
    error: refusal?.error ?? run.error,
    ...(refusal?.reason ? { reason: refusal.reason } : {}),
    updatedAt: run.updated_at.toISOString(),
    rowVersion: run.row_version,
  };
  const report = run.dry_run_report;
  if (withReport && report && ArchiveReport.safeParse(report).success) {
    view.report = report as Record<string, unknown>;
  }
  return view;
}

type Ctx = { tx: Tx; client: pg.PoolClient; scope: Scope; requestId: string };

/** Writes the run's audit event: in its location once it has one, else in the caller's account
 * (a draft with no target yet). Never the archive's contents: sizes, counts and choices. */
export async function auditRun(
  c: Ctx,
  run: Pick<ArchiveRunRow, 'id' | 'location_id'>,
  action: string,
  after: Record<string, unknown>,
  before: Record<string, unknown> | null = null,
): Promise<void> {
  let ownerAccountId: string | null | undefined;
  if (!run.location_id) {
    const { rows } = await c.client.query<{ id: string | null }>(
      'SELECT kept.current_owner_account_id() AS id',
    );
    ownerAccountId = rows[0]?.id ?? null;
  }
  await audited(c.tx, {
    locationId: run.location_id,
    ...(ownerAccountId !== undefined ? { ownerAccountId } : {}),
    actor: { type: 'user', id: c.scope.userId },
    action,
    entity: { type: 'import_run', id: run.id },
    before,
    after,
    requestId: c.requestId,
  });
}

/** The run, once the caller may work on it: 404 when they can't see it; once it has a target,
 * 403 unless they may import there. */
export async function workableRun(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<ArchiveRunRow> {
  const seen = await readArchiveRun(client, id);
  if (!seen) throw notFound();
  if (seen.location_id) await requireRole(client, seen.location_id, 'location.export-import');
  if (!lock) return seen;
  const run = await readArchiveRun(client, id, true);
  if (!run) throw notFound();
  return run;
}

async function reread(client: pg.ClientBase, id: string): Promise<ArchiveRunRow> {
  const run = await readArchiveRun(client, id);
  if (!run) throw notFound();
  return run;
}

const tooLarge = () =>
  new AppError('archive_too_large', 413, 'This archive is too large to import.', {
    reason: 'too_large',
  });

/** The HTTP error for an archive the reader refused, or whose content isn't the format's (no
 * rule broken, so no reason: "Kept can't read this archive"). */
function refusalError(err: ArchiveError | ArchiveContentError): AppError {
  if (err instanceof ArchiveContentError) return new AppError('archive_invalid', 400);
  return err.reason === 'too_large'
    ? tooLarge()
    : new AppError('archive_invalid', 400, undefined, { reason: err.reason });
}

/** What `error` records for a refusal. */
const storedRefusal = (err: ArchiveError | ArchiveContentError) =>
  err instanceof ArchiveContentError
    ? 'archive_invalid'
    : `${err.reason === 'too_large' ? 'archive_too_large' : 'archive_invalid'}:${err.reason}`;

const isRefusal = (err: unknown): err is ArchiveError | ArchiveContentError =>
  err instanceof ArchiveError || err instanceof ArchiveContentError;

/** Fails the run for a refused archive (in its own transaction, so the request's 400 doesn't
 * roll it back), and answers the error to throw. */
async function refuse(
  pools: Pick<Pools, 'app'>,
  req: FastifyRequest,
  run: ArchiveRunRow,
  err: ArchiveError | ArchiveContentError,
  action: string,
): Promise<AppError> {
  // The detail may hold a name from the archive: logged, never answered.
  req.log.info(
    {
      runId: run.id,
      reason: storedRefusal(err),
      detail: err instanceof ArchiveError ? err.detail : err.message,
    },
    'import: archive refused',
  );
  await scopedRead(pools, req, async (tx, client, scope) => {
    const { rowCount } = await client.query(
      `UPDATE public.import_runs SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1 AND status IN ('draft', 'checked')`,
      [run.id, storedRefusal(err)],
    );
    if (rowCount) {
      await auditRun({ tx, client, scope, requestId: req.id }, run, action, {
        status: 'failed',
        error: storedRefusal(err),
      });
    }
  });
  return refusalError(err);
}

/** Reads from the run's archive with `fn`, outside any transaction, closing it after. A refusal
 * fails the run and throws its 400 or 413. */
async function withArchive<T>(
  pools: Pick<Pools, 'app'>,
  req: FastifyRequest,
  files: FileStorage,
  run: ArchiveRunRow,
  action: string,
  fn: (archive: OpenArchive, importer: ArchiveImporter) => Promise<T>,
): Promise<T> {
  const importer = importerOf(run.source);
  let archive: OpenArchive | null = null;
  try {
    archive = await importer.open(files, run);
    return await fn(archive, importer);
  } catch (err) {
    if (isRefusal(err)) throw await refuse(pools, req, run, err, action);
    throw err;
  } finally {
    archive?.close();
  }
}

/** A refused archive answers its refusal again, rather than being read a second time. */
function rethrowRefusal(run: ArchiveRunRow): void {
  if (run.status !== 'failed') return;
  const refusal = refusalOf(run.error);
  if (!refusal) return;
  if (refusal.error === 'archive_too_large') throw tooLarge();
  throw new AppError(
    'archive_invalid',
    400,
    undefined,
    refusal.reason ? { reason: refusal.reason } : undefined,
  );
}

function needFiles(files: FileStorage | null): FileStorage {
  if (!files) throw new AppError('internal', 503, 'File storage is not configured.');
  return files;
}

/** Deletes a run's archive blob (a missing one is fine); a failure is left to the prune. */
export async function dropArchive(
  files: FileStorage | null | undefined,
  log: { error: (obj: object, msg: string) => void },
  runId: string,
): Promise<void> {
  if (!files) return;
  try {
    await files.blobs.delete(importArchiveKey(runId));
  } catch (err) {
    log.error({ err, runId }, 'import: an archive could not be deleted; the prune will');
  }
}

// ---------------------------------------------------------------------------------------------
// The run routes step 3 dispatches here (imports/routes.ts)
// ---------------------------------------------------------------------------------------------

export type ArchiveRouteDeps = {
  pools: Pick<Pools, 'app'>;
  files: FileStorage | null;
  jobs: JobQueue | null;
};

/** 409 unless the run can be checked now: it has its target, its archive and (Homebox) its
 * choices, and hasn't started. */
function checkable(run: ArchiveRunRow): void {
  rethrowRefusal(run);
  if (run.status !== 'draft' && run.status !== 'checked') {
    throw conflict(`This import is ${run.status}; a dry run is before it starts.`);
  }
  if (!run.location_id) throw new AppError('import_target_needed', 409);
  if (!run.archive_ready_at) throw conflict('Upload the archive first.');
  if (run.source === 'homebox_zip' && !HomeboxChoices.safeParse(run.choices).success) {
    throw invalid('Make the choices first.');
  }
}

/** POST /imports/:id/dry-run for an archive run: reads the archive outside any transaction, then
 * plans against the target in one, writing nothing but the run's report (status `checked`). */
export async function archiveDryRun(
  deps: ArchiveRouteDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<{ report: ArchiveDryRunReport }> {
  const files = needFiles(deps.files);
  const seen = await scopedRead(deps.pools, req, async (_tx, client) => {
    const run = await workableRun(client, id);
    checkable(run);
    return run;
  });
  const loaded = await withArchive(deps.pools, req, files, seen, 'import.check', (archive, imp) =>
    imp.load(archive, seen),
  );
  return scopedWrite(deps.pools, req, reply, async (tx, client, scope) => {
    const c = { tx, client, scope, requestId: req.id };
    const run = await workableRun(client, id, true);
    checkable(run);
    if (run.updated_at.getTime() !== seen.updated_at.getTime()) {
      throw conflict('This import changed while it was being checked; check it again.');
    }
    const ctx: ArchiveCtx = { ...c, files: deps.files, jobs: deps.jobs };
    const { report, total } = await importerOf(run.source).dryRun(
      ctx,
      run as ArchiveRunRow & { location_id: string },
      loaded,
    );
    await client.query(
      `UPDATE public.import_runs SET status = 'checked', dry_run_report = $2, total = $3,
              progress = 0
        WHERE id = $1`,
      [run.id, JSON.stringify(report), total],
    );
    await auditRun(
      c,
      run,
      'import.check',
      { status: 'checked', summary: report.summary },
      { status: run.status },
    );
    return { status: 200, body: { report } };
  });
}

/** POST /imports/:id/run for an archive run: starts (or resumes) its job. */
export async function archiveStart(
  c: Ctx,
  jobs: JobQueue,
  id: string,
): Promise<ArchiveImportRunView> {
  const run = await workableRun(c.client, id, true);
  rethrowRefusal(run);
  const stale =
    run.status === 'running' &&
    Date.now() - run.updated_at.getTime() > IMPORT_STALE_MINUTES * 60_000;
  if (run.status !== 'checked' && run.status !== 'failed' && !stale) {
    throw conflict(
      run.status === 'draft'
        ? 'Run the dry run first.'
        : `This import is ${run.status}; it can't be started again.`,
    );
  }
  if (!run.location_id) throw new AppError('import_target_needed', 409);
  if (!run.archive_ready_at) throw conflict('The archive is gone; start a new import.');
  await c.client.query(
    `UPDATE public.import_runs
        SET status = 'running', started_at = coalesce(started_at, now()), error = NULL
      WHERE id = $1`,
    [run.id],
  );
  await auditRun(
    c,
    run,
    'import.start',
    { status: 'running', ...(run.progress > 0 ? { resumed_at: run.progress } : {}) },
    { status: run.status },
  );
  await jobs.sendTenant(c.client, importerOf(run.source).job, { runId: run.id });
  return archiveRunView(await reread(c.client, run.id), false);
}

/** POST /imports/:id/cancel for an archive run: the job stops at its next step; the archive and
 * any sealed key are cleared at once, and the archive deleted after the commit. */
export async function archiveCancel(
  deps: ArchiveRouteDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<ArchiveImportRunView> {
  let drop = false;
  const view = await scopedWrite(deps.pools, req, reply, async (tx, client, scope) => {
    const c = { tx, client, scope, requestId: req.id };
    const run = await workableRun(client, id, true);
    if (run.status === 'done' || run.status === 'cancelled') {
      return { status: 200, body: archiveRunView(run, false) };
    }
    await client.query(
      `UPDATE public.import_runs
          SET status = 'cancelled', finished_at = now(), archive_bytes = NULL,
              archive_sha256 = NULL, archive_ready_at = NULL, secrets_key_ciphertext = NULL,
              key_version = NULL
        WHERE id = $1`,
      [run.id],
    );
    drop = run.archive_bytes !== null;
    await auditRun(
      c,
      run,
      'import.cancel',
      { status: 'cancelled', progress: run.progress },
      { status: run.status },
    );
    return { status: 200, body: archiveRunView(await reread(client, run.id), false) };
  });
  if (drop) await dropArchive(deps.files, req.log, id);
  return view;
}

// ---------------------------------------------------------------------------------------------
// The upload
// ---------------------------------------------------------------------------------------------

function header(req: Pick<FastifyRequest, 'headers'>, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/** The archive's Content-Length: 411 without one, 413 over the cap, before a byte is read. */
function archiveLength(req: Pick<FastifyRequest, 'headers'>): number {
  const raw = header(req, 'content-length');
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) {
    throw new AppError('validation', 411, 'Send the archive with a Content-Length.');
  }
  const bytes = Number(raw);
  if (bytes > ZIP_LIMITS.archiveBytes) throw tooLarge();
  if (bytes === 0) throw invalid('The archive is empty.');
  return bytes;
}

/** Reads and discards the rest of a body this request won't store (a replay of a finished
 * upload), so the connection stays usable. */
async function drain(body: Readable): Promise<void> {
  await new Promise<void>((resolve) => {
    if (body.readableEnded) return resolve();
    body.once('end', resolve);
    body.once('error', () => resolve());
    body.once('close', resolve);
    body.resume();
  });
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export async function archiveImportRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  // T11: the optional Homebox connection (imports/homebox/api.ts).
  await homeboxConnectRoutes(app, deps);
  // T14: the Kept export's passphrase (imports/kept/routes.ts).
  await keptImportRoutes(app, deps);

  const { pools } = deps;
  /** Runs whose archive is uploading now, in this process: a second PUT is refused. */
  const uploading = new Set<string>();

  app.post(
    '/api/v1/imports/archive',
    { schema: { body: CreateArchiveBody, response: { 201: ArchiveImportRunView } } },
    async (req, reply) => {
      const body = req.body;
      if (body.bytes > ZIP_LIMITS.archiveBytes) throw tooLarge();
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const id = assertClientId(body.id);
        const existing = await readArchiveRun(client, id);
        if (existing) {
          // The same declaration again (a retried request) answers the run; another doesn't.
          if (
            existing.source !== body.source ||
            Number(existing.archive_bytes) !== body.bytes ||
            existing.archive_sha256 !== body.sha256
          ) {
            throw new AppError(
              'idempotency_mismatch',
              409,
              'That import id was used for another archive. Start a new import.',
            );
          }
          return { status: 201, body: archiveRunView(existing, false) };
        }
        await client.query(
          `INSERT INTO public.import_runs (id, location_id, source, status, archive_bytes,
                                           archive_sha256, created_by)
           VALUES ($1, NULL, $2, 'draft', $3, $4, $5)`,
          [id, body.source, body.bytes, body.sha256, scope.userId],
        );
        await auditRun(
          { tx, client, scope, requestId: req.id },
          { id, location_id: null },
          'import.create',
          { source: body.source, status: 'draft', bytes: body.bytes, sha256: body.sha256 },
        );
        return { status: 201, body: archiveRunView(await reread(client, id), false) };
      });
    },
  );

  // --- the archive's bytes, in a context of its own: the body is the raw stream ---------------
  await app.register(async (scope) => {
    const child = scope.withTypeProvider<ZodTypeProvider>();
    child.removeAllContentTypeParsers();
    // Fastify's bodyLimit applies only to parsers that buffer; this one hands the stream on, so
    // the size is checked from Content-Length (413 before a byte is read) and counted again while
    // streaming (files/upload.ts receive()).
    child.addContentTypeParser('*', async (req: FastifyRequest, payload: Readable) => {
      archiveLength(req);
      return payload;
    });
    child.put(
      '/api/v1/imports/:id/archive',
      {
        bodyLimit: ZIP_LIMITS.archiveBytes,
        schema: { params: Params, response: { 200: ArchiveImportRunView } },
      },
      async (req) => {
        const files = needFiles(deps.files);
        const body = req.body as Readable | undefined;
        if (!body || typeof body.pipe !== 'function') {
          throw invalid('Send the archive as the request body.');
        }
        const userScope = requireScope(req);
        const id = req.params.id.toLowerCase();
        const declared = archiveLength(req);
        const sha = header(req, 'x-kept-sha256')?.toLowerCase();
        if (!sha || !SHA256.test(sha)) {
          throw invalid('Send X-Kept-Sha256: the SHA-256 of the archive, in hex.');
        }

        // Who, and which bytes, before a byte is stored.
        const seen = await withScope(pools.app, userScope, (_tx, client) =>
          workableRun(client, id),
        );
        if (seen.archive_sha256 !== sha) {
          throw new AppError(
            'idempotency_mismatch',
            409,
            'This import was declared with another archive. Start a new import for this one.',
          );
        }
        if (Number(seen.archive_bytes) !== declared) {
          throw invalid('Send exactly the bytes declared for this import (Content-Length).');
        }
        if (seen.archive_ready_at) {
          // A replay of an upload that already arrived: the same bytes, nothing to store.
          await drain(body);
          return archiveRunView(seen, false);
        }
        if (seen.status !== 'draft') throw conflict(`This import is ${seen.status}.`);
        if (uploading.has(id)) throw conflict('This archive is already being uploaded.');

        uploading.add(id);
        let tmp: string | null = null;
        try {
          const received = await receive(body, files.tmpDir, declared);
          tmp = received.file;
          if (received.bytes !== declared) {
            throw invalid('The upload ended before the whole archive arrived. Send it again.');
          }
          if (received.sha256 !== sha) {
            throw new AppError(
              'checksum_mismatch',
              400,
              "The bytes that arrived don't match X-Kept-Sha256. Upload the archive again.",
            );
          }
          await files.blobs.put(importArchiveKey(id), received.file, {
            contentType: 'application/zip',
            bytes: received.bytes,
          });
          let kept = false;
          try {
            const view = await withScope(pools.app, userScope, async (tx, client) => {
              const run = await workableRun(client, id, true);
              if (run.archive_ready_at) return archiveRunView(run, false);
              if (run.status !== 'draft') throw conflict(`This import is ${run.status}.`);
              await client.query(
                'UPDATE public.import_runs SET archive_ready_at = now() WHERE id = $1',
                [id],
              );
              await auditRun(
                { tx, client, scope: userScope, requestId: req.id },
                run,
                'import.archive',
                { bytes: received.bytes, sha256: received.sha256 },
              );
              return archiveRunView(await reread(client, id), false);
            });
            kept = true;
            return view;
          } finally {
            if (!kept) await dropArchive(files, req.log, id);
          }
        } finally {
          uploading.delete(id);
          if (tmp) await rm(tmp, { force: true });
        }
      },
    );
  });

  app.post(
    '/api/v1/imports/:id/inspect',
    { schema: { params: Params, response: { 200: z.record(z.string(), z.unknown()) } } },
    async (req, reply) => {
      const files = needFiles(deps.files);
      const id = req.params.id.toLowerCase();
      const seen = await scopedRead(pools, req, (_tx, client) => workableRun(client, id));
      rethrowRefusal(seen);
      if (seen.inspect) return seen.inspect;
      if (!seen.archive_ready_at) throw conflict('Upload the archive first.');
      if (seen.status !== 'draft' && seen.status !== 'checked') {
        throw conflict(`This import is ${seen.status}.`);
      }
      const inspect: ArchiveInspect = await withArchive(
        pools,
        req,
        files,
        seen,
        'import.inspect',
        (archive, importer) => importer.inspect(archive, seen),
      );
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const run = await workableRun(client, id, true);
        if (run.inspect) return { status: 200, body: run.inspect };
        await client.query('UPDATE public.import_runs SET inspect = $2 WHERE id = $1', [
          id,
          JSON.stringify(inspect),
        ]);
        await auditRun({ tx, client, scope, requestId: req.id }, run, 'import.inspect', {
          source: inspect.source,
          counts:
            inspect.source === 'homebox_zip'
              ? (inspect.collections[0]?.counts ?? null)
              : inspect.kept.counts,
        });
        return { status: 200, body: inspect as unknown as Record<string, unknown> };
      });
    },
  );

  app.post(
    '/api/v1/imports/:id/target',
    { schema: { params: Params, body: TargetBody, response: { 200: ArchiveImportRunView } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const c = { tx, client, scope, requestId: req.id };
        const id = req.params.id.toLowerCase();
        const run = await workableRun(client, id, true);
        if (run.location_id) throw conflict('This import already has its location.');
        rethrowRefusal(run);
        if (run.status !== 'draft') throw conflict(`This import is ${run.status}.`);
        const body = req.body;
        let locationId: string;
        let created = false;
        if ('locationId' in body) {
          // A Kept export always lands in a new location (plan Q8).
          if (run.source === 'kept_zip') {
            throw invalid('A Kept export goes into a new location: send body.newLocation.');
          }
          locationId = body.locationId.toLowerCase();
          await requireRole(client, locationId, 'location.export-import');
        } else {
          const n = body.newLocation;
          locationId = await createLocation(c, {
            name: n.name,
            kind: n.kind,
            preset: 'household',
            timezone: n.timezone,
            currency: n.currency,
            rooms: [],
            languages: n.languages,
          });
          created = true;
        }
        await client.query('SELECT kept.set_import_target($1, $2)', [id, locationId]);
        await auditRun(c, { id, location_id: locationId }, 'import.target', {
          source: run.source,
          location_id: locationId,
          new_location: created,
        });
        return { status: 200, body: archiveRunView(await reread(client, id), false) };
      }),
  );

  app.post(
    '/api/v1/imports/:id/choices',
    { schema: { params: Params, body: ChoicesBody, response: { 200: ArchiveImportRunView } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const id = req.params.id.toLowerCase();
        const run = await workableRun(client, id, true);
        if (run.source !== 'homebox_zip') {
          throw invalid('Only a Homebox import has these choices.');
        }
        if (!run.location_id) throw new AppError('import_target_needed', 409);
        checkVersion({ rowVersion: run.row_version }, expected, ['choices']);
        if (run.status !== 'draft' && run.status !== 'checked') {
          throw conflict(`This import is ${run.status}; its choices are made before it starts.`);
        }
        const choices = req.body.choices;
        // New choices make the last dry run's report stale: the run is a draft again.
        await client.query(
          `UPDATE public.import_runs SET choices = $2, status = 'draft', dry_run_report = NULL
            WHERE id = $1`,
          [id, JSON.stringify(choices)],
        );
        await auditRun(
          { tx, client, scope, requestId: req.id },
          run,
          'import.choices',
          { choices },
          { status: run.status },
        );
        return { status: 200, body: archiveRunView(await reread(client, id), false) };
      });
    },
  );
}
