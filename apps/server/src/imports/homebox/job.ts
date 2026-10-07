import { rm } from 'node:fs/promises';
import { HomeboxChoices, type ImportIssueCode, newId } from '@kept/shared';
import type pg from 'pg';
import { audited } from '../../audit/audited.js';
import type { Pools } from '../../db/pools.js';
import { type Scope, type Tx, withScope } from '../../db/scope.js';
import { ingestFile } from '../../files/ingest.js';
import { receive } from '../../files/upload.js';
import { AppError, toErrorReply } from '../../http/errors.js';
import { defineJob, type JobDefinition } from '../../jobs/boss.js';
import { JOB_POLICIES } from '../../jobs/policies.js';
import type { JobQueue } from '../../jobs/queue.js';
import type { SystemJobDeps } from '../../jobs/system.js';
import { ArchiveContentError, ArchiveError } from '../../portability/zip/limits.js';
import type { OpenArchive } from '../../portability/zip/read.js';
import { type FileStorage, importArchiveKey } from '../../storage/blob-store.js';
import { ImageLimiter } from '../../storage/derivatives.js';
import { requireRole } from '../../things/service.js';
import { readArchiveRun } from '../archive.js';
import type { ArchiveRunRow } from '../archive-types.js';
import { type ApplyCtx, applyOp, MissingRef } from './apply.js';
import { loadHomeboxLookups } from './lookups.js';
import { type AttachmentOp, type HbOp, planHomebox } from './plan.js';
import { type HomeboxData, openHomebox, readHomebox } from './read.js';

// The `import-homebox` job (D146; step-7 plan T10; engineering spec §3.1b: one attempt, two
// hours, resumable), the CSV job's shape (imports/job.ts).
//
// A tenant job: it runs as the person who pressed Import, under their row-level security, and
// `data` only names the run. It reads the archive by byte range (portability/zip/), plans it
// against the location as it is now (plan.ts: what import_source_ids already holds is left out,
// so a resumed or re-run import makes nothing twice), and works the steps CHUNK at a time:
// - before each chunk, in a short transaction, the run is read again: anything but `running`
//   (cancelled, or ended for someone who no longer administers the location, D180) stops the
//   job, and the role is checked again;
// - the chunk's files go in outside any transaction: each attachment's entry is streamed to the
//   temp directory (cut at the file size limit) and through ingestFile(), the upload's own path
//   (sniffing, per-location dedupe, derivatives, `pdf-text`), as a new file;
// - then one transaction, the run locked: each step through the step-2 services in its own
//   savepoint, remembered in import_source_ids; a step that fails is rolled back and listed in
//   the chunk's `import.run` audit event, which has the things made as its subjects (Q11);
//   `progress` moves;
// - the last chunk sets `done` and clears the archive's columns, and the archive is deleted.
// A run that fails (the database went away, the archive can't be read) is `failed` with a short
// code, keeping its progress: POST …/run resumes it.

/** Steps per transaction. */
export const CHUNK = 200;
/** How many failed steps one chunk's audit event lists. */
const FAILED_LISTED = 50;

export type HomeboxJobDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  files: FileStorage | null | undefined;
  jobs: JobQueue | null;
  log: SystemJobDeps['log'];
  /** Tests: steps per transaction. */
  chunk?: number;
  /** Tests: called after each chunk commits; throwing stops the job there (a crash). */
  afterChunk?: (index: number) => void | Promise<void>;
};

/** A short, data-free code for a failed run (`error`). */
function failureCode(err: unknown): string {
  if (err instanceof ArchiveError) {
    return `${err.reason === 'too_large' ? 'archive_too_large' : 'archive_invalid'}:${err.reason}`;
  }
  if (err instanceof ArchiveContentError) return 'archive_invalid';
  const { status, body } = toErrorReply(err);
  if (status === 403 || status === 404) return 'not_permitted';
  return status >= 500 ? 'internal' : String(body.code);
}

/** Why a file didn't come in, as the report's code. */
function fileIssue(err: unknown): ImportIssueCode {
  const { status } = toErrorReply(err);
  if (status === 415) return 'file_type_refused';
  if (status === 413) return 'file_too_large';
  return 'file_missing';
}

const fileClass = (op: AttachmentOp) =>
  op.role === 'photo'
    ? ('photo' as const)
    : op.role === 'receipt' || op.role === 'warranty_doc'
      ? ('evidence' as const)
      : ('document' as const);

/** The run, still running and still the caller's to import: null to stop. */
async function stillRunning(client: pg.ClientBase, runId: string): Promise<ArchiveRunRow | null> {
  const run = await readArchiveRun(client, runId);
  if (run?.status !== 'running' || !run.location_id) return null;
  await requireRole(client, run.location_id, 'location.export-import');
  return run;
}

type Failed = { key: string; code: string }[];

/** Streams each file of the chunk into Kept (outside any transaction). */
async function ingestChunk(
  deps: HomeboxJobDeps & { files: FileStorage },
  scope: Scope,
  archive: OpenArchive,
  locationId: string,
  steps: readonly HbOp[],
  limiter: ImageLimiter,
  ids: ReadonlyMap<string, string>,
  fileIds: Map<string, string>,
  failed: Failed,
): Promise<void> {
  for (const op of steps) {
    if (op.op !== 'attachment' || !op.file || fileIds.has(op.key) || ids.has(op.key)) continue;
    let tmp: string | null = null;
    try {
      const stream = await archive.read(op.file.entry);
      const received = await receive(stream, deps.files.tmpDir, deps.files.maxFileBytes);
      tmp = received.file;
      const result = await ingestFile(
        { pools: deps.pools, files: deps.files, limiter, log: deps.log, jobs: deps.jobs },
        scope,
        {
          file: received.file,
          sha256: received.sha256,
          bytes: received.bytes,
          fileId: newId(),
          locationId,
          class: fileClass(op),
        },
        { auditAction: 'file.import', requestId: null },
      );
      fileIds.set(op.key, result.body.deduplicatedFrom ?? result.body.id);
    } catch (err) {
      if (err instanceof ArchiveError) throw err;
      failed.push({ key: op.key, code: fileIssue(err) });
    } finally {
      if (tmp) await rm(tmp, { force: true });
    }
  }
}

async function applyChunk(
  tx: Tx,
  client: pg.PoolClient,
  base: Omit<ApplyCtx, 'tx' | 'client'>,
  steps: readonly HbOp[],
  failed: Failed,
  last: boolean,
): Promise<boolean> {
  const run = await readArchiveRun(client, base.runId, true);
  if (run?.status !== 'running') return false;
  const c: ApplyCtx = { ...base, tx, client };
  const made: string[] = [];
  for (const op of steps) {
    if (op.op !== 'type' && c.ids.has(op.key)) continue;
    if (failed.some((f) => f.key === op.key)) continue;
    const before = new Set(c.ids.keys());
    await client.query('SAVEPOINT import_step');
    try {
      const done = await applyOp(c, op);
      await client.query('RELEASE SAVEPOINT import_step');
      if (done.thingId) made.push(done.thingId);
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT import_step');
      // Forget what the step remembered before it failed.
      for (const k of [...c.ids.keys()]) if (!before.has(k)) c.ids.delete(k);
      failed.push({
        key: op.key,
        code: err instanceof MissingRef ? 'missing_parent' : String(toErrorReply(err).body.code),
      });
    }
  }
  await client.query(
    `UPDATE public.import_runs
        SET progress = least(progress + $2, coalesce(total, progress + $2)),
            status = CASE WHEN $3 THEN 'done' ELSE status END,
            finished_at = CASE WHEN $3 THEN now() ELSE finished_at END,
            archive_bytes = CASE WHEN $3 THEN NULL ELSE archive_bytes END,
            archive_sha256 = CASE WHEN $3 THEN NULL ELSE archive_sha256 END,
            archive_ready_at = CASE WHEN $3 THEN NULL ELSE archive_ready_at END
      WHERE id = $1`,
    [base.runId, steps.length, last],
  );
  await audited(tx, {
    locationId: base.locationId,
    actor: { type: 'user', id: base.scope.userId },
    action: 'import.run',
    entity: { type: 'import_run', id: base.runId },
    after: {
      steps: steps.length,
      things: made.length,
      failed: failed.length,
      ...(failed.length > 0 ? { failed_steps: failed.slice(0, FAILED_LISTED) } : {}),
      ...(last ? { status: 'done' } : {}),
    },
    subjects: made,
    requestId: base.requestId,
  });
  return !last;
}

/** Runs (or resumes) run `runId` to its end, as `scope`. */
export async function runHomeboxImport(
  deps: HomeboxJobDeps,
  scope: Scope,
  runId: string,
): Promise<void> {
  const { pools, files } = deps;
  let archive: OpenArchive | null = null;
  try {
    if (!files) throw new AppError('internal', 503, 'Imports need file storage.');
    const run = await withScope(pools.app, scope, (_tx, client) => stillRunning(client, runId));
    if (!run?.location_id) return;
    const locationId = run.location_id;
    const choices = HomeboxChoices.parse(run.choices);

    archive = await openHomebox(files.blobs, importArchiveKey(runId), Number(run.archive_bytes));
    const data: HomeboxData = await readHomebox(archive);

    // Plan against the location as it is now: steps done before are left out.
    const { ops, look } = await withScope(pools.app, scope, async (tx, client) => {
      const look = await loadHomeboxLookups(
        tx,
        client,
        scope,
        locationId,
        data,
        choices,
        files.maxFileBytes,
      );
      const plan = planHomebox(data, choices, look);
      await client.query('UPDATE public.import_runs SET total = progress + $2 WHERE id = $1', [
        runId,
        plan.ops.length,
      ]);
      return { ops: plan.ops, look };
    });

    const limiter = new ImageLimiter(Math.max(1, files.imageConcurrency));
    const fileIds = new Map<string, string>();
    const base: Omit<ApplyCtx, 'tx' | 'client'> = {
      scope,
      requestId: `import:${runId}`,
      runId,
      locationId,
      collection: data.manifest.groupId,
      look,
      files,
      jobs: deps.jobs,
      ids: new Map(look.sourceIds),
      fileIds,
      made: { brands: new Map(), vendors: new Map() },
    };
    const chunk = deps.chunk ?? CHUNK;
    for (let start = 0, index = 0; ; start += chunk, index++) {
      const steps = ops.slice(start, start + chunk);
      const last = start + chunk >= ops.length;
      const failed: Failed = [];
      const ok = await withScope(pools.app, scope, (_tx, client) => stillRunning(client, runId));
      if (!ok) return;
      await ingestChunk(
        { ...deps, files },
        scope,
        archive,
        locationId,
        steps,
        limiter,
        base.ids,
        fileIds,
        failed,
      );
      const more = await withScope(pools.app, scope, (tx, client) =>
        applyChunk(tx, client, base, steps, failed, last),
      );
      await deps.afterChunk?.(index);
      if (!more) break;
    }
    archive.close();
    archive = null;
    const final = await withScope(pools.app, scope, (_tx, client) => readArchiveRun(client, runId));
    if (final?.status === 'done') {
      await files.blobs.delete(importArchiveKey(runId)).catch((err: unknown) => {
        deps.log.error({ err, runId }, 'import-homebox: the archive could not be deleted');
      });
    }
  } catch (err) {
    // Kept for a resume: what was made stays, and the person sees why it stopped.
    const code = failureCode(err);
    deps.log.error({ runId, code, err }, 'Homebox import failed');
    await withScope(pools.app, scope, (_tx, client) =>
      client.query(
        `UPDATE public.import_runs SET status = 'failed', error = $2
          WHERE id = $1 AND status = 'running'`,
        [runId, code.slice(0, 500)],
      ),
    ).catch(() => {});
  } finally {
    archive?.close();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A JobQueue over the worker's sendTenant, for the `pdf-text` job an imported PDF sends. */
function tenantQueue(deps: SystemJobDeps): JobQueue | null {
  const send = deps.sendTenant;
  if (!send) return null;
  return {
    send: async () => {
      throw new Error('import-homebox sends tenant jobs only');
    },
    sendTenant: (client, name, data) => send(client, name, data, { startAfter: new Date() }),
  };
}

/** The `import-homebox` tenant job (T10), aggregated by jobs/portability.ts. */
export function homeboxImportJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'import-homebox',
      kind: 'tenant',
      policy: JOB_POLICIES['import-homebox'],
      handler: async ({ data, scope, client }) => {
        const runId = (data as { runId?: unknown } | null)?.runId;
        if (typeof runId !== 'string' || !UUID.test(runId)) {
          throw new Error('import-homebox job: data names no run');
        }
        const app = deps.pools.app;
        if (!app) throw new Error('import-homebox job: the worker has no kept_app pool');
        // runJob() holds this scoped transaction open while each chunk commits on its own
        // connection, up to the policy's two hours; it holds no lock and no transaction id.
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '7260s'`);
        await runHomeboxImport(
          {
            pools: { app, system: deps.pools.system },
            files: deps.files,
            jobs: tenantQueue(deps),
            log: deps.log,
          },
          scope,
          runId.toLowerCase(),
        );
      },
    }),
  ];
}
