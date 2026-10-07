import {
  CSV_LIMITS,
  DATE_FORMATS,
  IMPORT_ISSUE_CODES,
  IMPORT_STALE_MINUTES,
  isMappable,
  newId,
} from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import type { Scope, Tx } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { assertClientId, pageOf, paginate } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireRole } from '../things/service.js';
import { requireCurrencies } from '../things/validate.js';
import {
  ARCHIVE_RUN_COLUMNS,
  ArchiveImportRunView,
  ArchiveReport,
  archiveCancel,
  archiveDryRun,
  archiveRunView,
  archiveStart,
  isArchiveSource,
  readArchiveRun,
  runSourceOf,
} from './archive.js';
import type { ArchiveRunRow } from './archive-types.js';
import { BODY_LIMIT, CreateImportBody, mappingProblem } from './csv.js';
import { type DryRunReport, dryRun } from './dry-run.js';
import { type RunRow, readRun, runInputOf } from './job.js';

// CSV import (D73; plan T18, Q18; engineering spec §1.10, §5, §7.13), in the shapes of the web
// contract (apps/web/src/api/capture/{paths,types}.ts, `ImportRun`, `DryRunReport`):
//
// POST /api/v1/imports/csv                {id?, locationId, columns, rows (≤ 10,000; 413 past it),
//                                          mapping, choices}              → 201 ImportRun (draft)
// POST /api/v1/imports/:id/dry-run                                        → {report} (checked)
// POST /api/v1/imports/:id/run                                            → 202 ImportRun (running)
// GET  /api/v1/imports/:id                                                → ImportRun (+ report)
// GET  /api/v1/imports?locationId&limit&cursor                → {items: ImportRun[], next_cursor}
// POST /api/v1/imports/:id/cancel                                         → ImportRun (cancelled)
//
// Owners and admins only (`location.export-import`, §7.1): a member of the location gets 403, and
// a run is invisible (404) to anyone who isn't an owner or admin of its location (0038's policies).
// The rows are kept on the run (the header row first) until it is done or cancelled.
//
// Statuses: draft → (dry run) checked → (run) running → done. A dry run may be repeated before
// the run starts. `failed` (the job stopped: the reason is in `error`) is resumed by …/run from
// where it stopped; so is a `running` run whose job died (no progress for STALE_MINUTES).
// Cancelling stops the job at its next chunk and clears the rows; a done run stays done.
//
// Step 7 (plan T8): the same routes serve archive runs (a Homebox or Kept export), whose view,
// dry run, run and cancel are imports/archive.ts's; each route dispatches on the run's source.

/** A `running` run whose row hasn't moved for this long has lost its job, and may be resumed. */
export const STALE_MINUTES = IMPORT_STALE_MINUTES;

const Params = z.object({ id: z.uuid() });
const ListQuery = z.object({
  locationId: z.uuid().optional(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().max(200).optional(),
});

/** A row's reason (T30's contract change): the code the web translates, the values its sentence
 * names, and the English sentence as a fallback. */
const Issue = z.object({
  column: z.string(),
  code: z.enum(IMPORT_ISSUE_CODES),
  params: z
    .object({
      max: z.number().int().optional(),
      row: z.number().int().optional(),
      format: z.enum(DATE_FORMATS).optional(),
      kind: z.string().optional(),
      rule: z.string().optional(),
    })
    .optional(),
  message: z.string(),
});
const Report = z.object({
  summary: z.object({
    things: z.number().int(),
    places: z.number().int(),
    purchases: z.number().int(),
    legacyCodes: z.number().int(),
    skipped: z.number().int(),
    asText: z.number().int(),
  }),
  rows: z.array(
    z.object({
      row: z.number().int(),
      status: z.enum(['ok', 'text', 'skipped']),
      issues: z.array(Issue),
    }),
  ),
});

const ImportRunView = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  source: z.literal('csv'),
  status: z.enum(['draft', 'checked', 'running', 'done', 'failed', 'cancelled']),
  mapping: z.record(z.string(), z.string().refine(isMappable)),
  choices: z.object({
    placeSeparator: z.enum(['>', '/', '\\']),
    createPlaces: z.boolean(),
    dateFormat: z.enum(DATE_FORMATS),
    currency: z.string().optional(),
    defaultTarget: z.union([
      z.object({ placeId: z.uuid() }),
      z.object({ unplaced: z.literal(true) }),
    ]),
    typeByName: z.boolean(),
  }),
  progress: z.number().int(),
  total: z.number().int().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  /** When the run last changed: a `running` run that hasn't moved for STALE_MINUTES may be
   * resumed, and the web offers Resume from this. */
  updatedAt: z.string(),
  report: Report.optional(),
  rowVersion: z.number().int(),
});
type ImportRunView = z.infer<typeof ImportRunView>;

/** A CSV run, or an archive run (archive.ts): the archive's schema first, as only it has
 * `source` in its report. */
const AnyRunView = z.union([ArchiveImportRunView, ImportRunView]);
const AnyReport = z.union([ArchiveReport, Report]);

const Page = z.object({ items: z.array(AnyRunView), next_cursor: z.string().nullable() });

/** A report stored before issues carried codes is left out; a new dry run replaces it. */
const hasCodes = (report: DryRunReport) =>
  report.rows.every((r) => r.issues.every((i) => typeof i.code === 'string'));

function viewOf(run: RunRow, withReport: boolean): ImportRunView {
  const view: ImportRunView = {
    id: run.id,
    locationId: run.location_id,
    source: 'csv',
    status: run.status,
    mapping: run.mapping,
    choices: run.choices,
    progress: run.progress,
    total: run.total,
    createdAt: run.created_at.toISOString(),
    startedAt: run.started_at?.toISOString() ?? null,
    finishedAt: run.finished_at?.toISOString() ?? null,
    error: run.error,
    updatedAt: run.updated_at.toISOString(),
    rowVersion: run.row_version,
  };
  if (withReport && run.dry_run_report && hasCodes(run.dry_run_report as DryRunReport)) {
    view.report = run.dry_run_report as DryRunReport;
  }
  return view;
}

type Ctx = { tx: Tx; client: pg.PoolClient; scope: Scope; requestId: string };

const actor = (scope: Scope) => ({ type: 'user' as const, id: scope.userId });

/** The run, locked, once the caller may import into its location: 404 when they can't see it
 * (only owners and admins can), 403 if their role no longer allows it. */
async function importableRun(client: pg.ClientBase, id: string): Promise<RunRow> {
  const seen = await readRun(client, id);
  if (!seen) throw notFound();
  await requireRole(client, seen.location_id, 'location.export-import');
  const run = await readRun(client, id, { lock: true, rows: true });
  if (!run) throw notFound();
  return run;
}

async function reread(client: pg.ClientBase, id: string): Promise<RunRow> {
  const run = await readRun(client, id);
  if (!run) throw notFound();
  return run;
}

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------

async function createRun(c: Ctx, body: CreateImportBody): Promise<ImportRunView> {
  const locationId = body.locationId.toLowerCase();
  await requireRole(c.client, locationId, 'location.export-import');
  const problem = mappingProblem(body.columns, body.mapping);
  if (problem) throw invalid(problem);
  if (body.choices.currency) {
    await requireCurrencies(c.client, [body.choices.currency], 'body.choices.currency');
  }
  const target = body.choices.defaultTarget;
  if ('placeId' in target) {
    const { rowCount } = await c.client.query(
      `SELECT 1 FROM public.places WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL`,
      [target.placeId, locationId],
    );
    if (!rowCount) throw notFound('Check body.choices.defaultTarget: no such place here.');
  }
  const id = body.id ? assertClientId(body.id) : newId();
  const choices = {
    ...body.choices,
    ...('placeId' in target ? { defaultTarget: { placeId: target.placeId.toLowerCase() } } : {}),
  };
  await c.client.query(
    `INSERT INTO public.import_runs (id, location_id, source, status, mapping, choices, rows,
                                     total, created_by)
     VALUES ($1, $2, 'csv', 'draft', $3, $4, $5, $6, $7)`,
    [
      id,
      locationId,
      JSON.stringify(body.mapping),
      JSON.stringify(choices),
      JSON.stringify([body.columns, ...body.rows]),
      body.rows.length,
      c.scope.userId,
    ],
  );
  // The file's contents stay out of the audit; its shape and choices are what it records.
  await audited(c.tx, {
    locationId,
    actor: actor(c.scope),
    action: 'import.create',
    entity: { type: 'import_run', id },
    after: {
      source: 'csv',
      status: 'draft',
      total: body.rows.length,
      mapping: body.mapping,
      choices,
    },
    requestId: c.requestId,
  });
  return viewOf(await reread(c.client, id), false);
}

async function checkRun(c: Ctx, id: string): Promise<{ report: DryRunReport }> {
  const run = await importableRun(c.client, id);
  if (run.status !== 'draft' && run.status !== 'checked') {
    throw conflict(`This import is ${run.status}; a dry run is before it starts.`);
  }
  const report = await dryRun(c.tx, c.client, c.scope, runInputOf(run));
  await c.client.query(
    `UPDATE public.import_runs SET status = 'checked', dry_run_report = $2 WHERE id = $1`,
    [run.id, JSON.stringify(report)],
  );
  await audited(c.tx, {
    locationId: run.location_id,
    actor: actor(c.scope),
    action: 'import.check',
    entity: { type: 'import_run', id: run.id },
    before: { status: run.status },
    after: { status: 'checked', summary: report.summary },
    requestId: c.requestId,
  });
  return { report };
}

async function startRun(c: Ctx, jobs: JobQueue, id: string): Promise<ImportRunView> {
  const run = await importableRun(c.client, id);
  const stale =
    run.status === 'running' && Date.now() - run.updated_at.getTime() > STALE_MINUTES * 60_000;
  if (run.status !== 'checked' && run.status !== 'failed' && !stale) {
    throw conflict(
      run.status === 'draft'
        ? 'Run the dry run first.'
        : `This import is ${run.status}; it can't be started again.`,
    );
  }
  await c.client.query(
    `UPDATE public.import_runs
        SET status = 'running', started_at = coalesce(started_at, now()), error = NULL
      WHERE id = $1`,
    [run.id],
  );
  await audited(c.tx, {
    locationId: run.location_id,
    actor: actor(c.scope),
    action: 'import.start',
    entity: { type: 'import_run', id: run.id },
    before: { status: run.status },
    after: { status: 'running', ...(run.progress > 0 ? { resumed_at_row: run.progress + 1 } : {}) },
    requestId: c.requestId,
  });
  await jobs.sendTenant(c.client, 'import-csv', { runId: run.id });
  return viewOf(await reread(c.client, run.id), false);
}

async function cancelRun(c: Ctx, id: string): Promise<ImportRunView> {
  const run = await importableRun(c.client, id);
  if (run.status === 'done' || run.status === 'cancelled') return viewOf(run, false);
  await c.client.query(
    `UPDATE public.import_runs SET status = 'cancelled', rows = NULL, finished_at = now()
      WHERE id = $1`,
    [run.id],
  );
  await audited(c.tx, {
    locationId: run.location_id,
    actor: actor(c.scope),
    action: 'import.cancel',
    entity: { type: 'import_run', id: run.id },
    before: { status: run.status },
    after: { status: 'cancelled', progress: run.progress },
    requestId: c.requestId,
  });
  return viewOf(await reread(c.client, run.id), false);
}

async function listRuns(
  client: pg.ClientBase,
  query: z.infer<typeof ListQuery>,
): Promise<{ items: (ImportRunView | ArchiveImportRunView)[]; next_cursor: string | null }> {
  const page = paginate<string>({ limit: query.limit, cursor: query.cursor });
  const after = typeof page.after === 'string' ? page.after : null;
  if (after !== null && !Params.shape.id.safeParse(after).success) {
    throw invalid('The cursor is not valid; start again from the first page.');
  }
  // Newest first by id (UUIDv7); only owners' and admins' locations are visible (0038), and an
  // archive run with no target yet only to its creator (0080), listed when no location is asked.
  const { rows } = await client.query<{ id: string; source: string }>(
    `SELECT ${ARCHIVE_RUN_COLUMNS}, mapping, NULL::jsonb AS rows
       FROM public.import_runs
      WHERE ($1::uuid IS NULL OR location_id = $1) AND ($2::uuid IS NULL OR id < $2)
        AND source IN ('csv', 'homebox_zip', 'kept_zip')
      ORDER BY id DESC LIMIT $3`,
    [query.locationId?.toLowerCase() ?? null, after, page.limit + 1],
  );
  const result = pageOf(rows, page.limit, (r) => r.id);
  return {
    items: result.items.map((r) =>
      isArchiveSource(r.source)
        ? archiveRunView(r as unknown as ArchiveRunRow, false)
        : viewOf(r as unknown as RunRow, false),
    ),
    next_cursor: result.next_cursor,
  };
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** CSV import: mapping, dry run and the import job (T18; D73). Registered by http/routes.ts. */
export async function importRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  /** Whether `id` is an archive run the caller can see (its routes are archive.ts's). */
  const isArchiveRun = (req: FastifyRequest, id: string) =>
    scopedRead(pools, req, async (_tx, client) => isArchiveSource(await runSourceOf(client, id)));

  app.post(
    '/api/v1/imports/csv',
    {
      bodyLimit: BODY_LIMIT,
      schema: { body: CreateImportBody, response: { 201: ImportRunView } },
    },
    async (req, reply) => {
      if (req.body.rows.length > CSV_LIMITS.rows) {
        throw new AppError(
          'payload_too_large',
          413,
          `At most ${CSV_LIMITS.rows.toLocaleString('en')} rows in one import; split the file.`,
        );
      }
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createRun({ tx, client, scope, requestId: req.id }, req.body),
      }));
    },
  );

  app.post(
    '/api/v1/imports/:id/dry-run',
    { schema: { params: Params, response: { 200: z.object({ report: AnyReport }) } } },
    async (req, reply) => {
      const id = req.params.id.toLowerCase();
      if (await isArchiveRun(req, id)) {
        return archiveDryRun({ pools, files: deps.files, jobs: deps.jobs }, req, reply, id);
      }
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await checkRun({ tx, client, scope, requestId: req.id }, id),
      }));
    },
  );

  app.post(
    '/api/v1/imports/:id/run',
    { schema: { params: Params, response: { 202: AnyRunView } } },
    async (req, reply) => {
      const jobs = deps.jobs;
      if (!jobs) throw new AppError('internal', 503, 'Imports need the job queue.');
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const c = { tx, client, scope, requestId: req.id };
        const id = req.params.id.toLowerCase();
        const archive = isArchiveSource(await runSourceOf(client, id));
        return {
          status: 202,
          body: archive ? await archiveStart(c, jobs, id) : await startRun(c, jobs, id),
        };
      });
    },
  );

  app.post(
    '/api/v1/imports/:id/cancel',
    { schema: { params: Params, response: { 200: AnyRunView } } },
    async (req, reply) => {
      const id = req.params.id.toLowerCase();
      if (await isArchiveRun(req, id)) {
        return archiveCancel({ pools, files: deps.files, jobs: deps.jobs }, req, reply, id);
      }
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await cancelRun({ tx, client, scope, requestId: req.id }, id),
      }));
    },
  );

  app.get(
    '/api/v1/imports/:id',
    { schema: { params: Params, response: { 200: AnyRunView } } },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const id = req.params.id.toLowerCase();
        const archive = await readArchiveRun(client, id);
        if (archive) return archiveRunView(archive, true);
        const run = await readRun(client, id);
        if (!run) throw notFound();
        return viewOf(run, true);
      }),
  );

  app.get(
    '/api/v1/imports',
    { schema: { querystring: ListQuery, response: { 200: Page } } },
    (req) => scopedRead(pools, req, (_tx, client) => listRuns(client, req.query)),
  );
}
