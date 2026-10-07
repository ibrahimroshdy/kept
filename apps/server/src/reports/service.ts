import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { can, newId } from '@kept/shared';
import type pg from 'pg';
import sharp from 'sharp';
import { renderSVG } from 'uqr';
import { z } from 'zod';
import { auditedMany } from '../audit/audited.js';
import type { Pools } from '../db/pools.js';
import { type Scope, type Tx, withScope, withSystem } from '../db/scope.js';
import { AppError, forbidden, notFound } from '../http/errors.js';
import {
  buildInsuranceView,
  gatherInsurance,
  type InsuranceOptions,
  missingRates,
  readIncident,
  totalsOf,
} from '../incidents/report.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireMembership } from '../locations/access.js';
import { gateFor } from '../serialize/gates.js';
import { type FileStorage, reportKey } from '../storage/blob-store.js';
import { SIGNED_URL_TTL_SECONDS } from '../storage/signed-url.js';
import { requireCurrencies } from '../things/validate.js';
import {
  gather,
  MAX_THINGS,
  type ReportOptions,
  type RunScope,
  TooManyThingsError,
} from './gather.js';
import type { ReportLocale } from './labels.js';
import {
  RenderError,
  type RenderOptions,
  type RenderResult,
  renderPdf,
  type TemplateKind,
  writeData,
} from './render/render.js';
import { gatherVehicle, type VehicleReportOptions } from './vehicle/gather.js';
import { buildVehicleView } from './vehicle/view.js';
import { buildView } from './view.js';

// The inventory report (D201; step-2 plan T32).
//
// POST /api/v1/reports/inventory records a run (report_runs, migration 0032), audits it as
// `report.generate` in every location it covers, and sends the `report` tenant job in the same
// transaction (jobs/queue.ts), so nothing is queued for a request that rolled back. The job
// (runReport) re-assumes the requester's scope, reads what the report holds under row-level
// security (gather.ts), writes thumbnails and QR codes into a scratch directory, renders the PDF
// in a child process (render/render.ts), stores it at `r/<runId>.pdf` and marks the run done.
// GET /api/v1/reports/:id answers the run's state, with a five-minute signed download URL once
// it is done. The run and its file go 24 hours after the request (purgeExpiredReports()).
//
// Who: anyone who can see the location, viewers included (D201): a viewer's report carries no
// money unless the location lets viewers see it (the response gates, serialize/gates.ts). An
// account report covers the account's locations the requester can see. A run is its requester's
// alone: anyone else's id, or one whose location they can no longer see, is a 404 (RLS, 0032).
// Each user may start RATE_LIMIT runs an hour.
//
// The insurance report (D158, step-4 T18) is a second kind on the same runs, job and engine:
// POST /api/v1/reports/insurance records a run with `kind = 'insurance'` for one location (a
// location report, or an incident's), its options in `options` (InsuranceOptions), and the job
// renders template/insurance.typ from incidents/report.ts's gather and view. Who: owners and
// admins for an incident (`incidents.manage`); for a location, whoever sees money there (members
// and above, viewers where the location allows it, D13): the report is mostly money, so a reader
// whose gate hides it is refused (403) rather than handed a report of blanks.
//
// The vehicle history report (D51, step-5 T15, Q16) is the third kind: POST
// /api/v1/reports/vehicle-history records a run with `kind = 'vehicle_history'` and its
// `thing_id`, in the vehicle's location, with VehicleReportOptions; the job renders
// template/vehicle.typ from reports/vehicle/{gather,view}.ts. Who: anyone who can see the vehicle,
// viewers included, where Vehicles is on (the route's module gate); money per the gate.

export const RATE_LIMIT = 5;
export const RATE_WINDOW_SECONDS = 3600;
/** How many thumbnails are resized at once in a job. */
const THUMB_CONCURRENCY = 4;
/** Printed at 15 mm, 200 px is about 340 dpi. */
const THUMB_PX = 200;
/** A run still `running` this long after it started has been abandoned by its worker. */
const STALE_RUNNING_MS = 10 * 60 * 1000;
/** How often, at most, progress is written while thumbnails are prepared. */
const PROGRESS_EVERY_MS = 500;

export const InventoryReportBody = z
  .object({
    scope: z.union([
      z.object({ locationId: z.uuid() }).strict(),
      z.object({ accountId: z.uuid() }).strict(),
    ]),
    filters: z
      .object({
        placeIds: z.array(z.uuid()).max(100).optional(),
        typeIds: z.array(z.uuid()).max(100).optional(),
        tagIds: z.array(z.uuid()).max(100).optional(),
        /** Exactly these things: "Print" on a list prints the list you're looking at (D169,
         * D201; step-7 T16). The other filters still apply. */
        thingIds: z.array(z.uuid()).max(MAX_THINGS).optional(),
        includeEnded: z.boolean().optional(),
        includeTrashed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    include: z
      .object({
        photos: z.boolean().optional(),
        qr: z.boolean().optional(),
        money: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Omitted: the requester's own language (Arabic when it is Arabic, else English). */
    locale: z.enum(['en', 'ar']).optional(),
    /** Omitted: the requester's own setting (D143). Applies to Arabic only. */
    digits: z.enum(['western', 'eastern']).optional(),
  })
  .strict();
export type InventoryReportBody = z.infer<typeof InventoryReportBody>;

export const REPORT_STATES = ['queued', 'running', 'done', 'failed', 'expired'] as const;

export const ReportRunView = z.object({
  id: z.uuid(),
  status: z.enum(REPORT_STATES),
  scope: z.union([z.object({ locationId: z.uuid() }), z.object({ accountId: z.uuid() })]),
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  /** A five-minute signed URL (attachment), only while `done`. */
  fileUrl: z.string().optional(),
  /** The same PDF as `fileUrl`, signed `inline`: opened in a tab (an installed iPhone app can't
   * download an attachment, and shows an inline PDF in its in-app browser). */
  viewUrl: z.string().optional(),
  bytes: z.number().int().optional(),
  /** Why it failed: `too_many_things`, `timeout`, `memory`, `render`, `no_storage`, `internal`. */
  error: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type ReportRunView = z.infer<typeof ReportRunView>;

type RunRow = {
  id: string;
  kind: 'inventory' | 'insurance' | 'vehicle_history';
  location_id: string | null;
  owner_account_id: string | null;
  location_ids: string[];
  /** ReportOptions for an inventory run, InsuranceOptions for an insurance run,
   * VehicleReportOptions for a vehicle history run. */
  options: ReportOptions | InsuranceOptions | VehicleReportOptions;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress_done: number;
  progress_total: number;
  bytes: number | string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  expires_at: Date;
};

const RUN_COLUMNS = `id, kind, location_id, owner_account_id, location_ids, options, status,
  progress_done, progress_total, bytes, error, created_at, started_at, expires_at`;

const scopeOf = (r: Pick<RunRow, 'location_id' | 'owner_account_id'>): RunScope =>
  r.location_id ? { locationId: r.location_id } : { accountId: r.owner_account_id as string };

// ---------------------------------------------------------------------------------------------
// POST /api/v1/reports/inventory
// ---------------------------------------------------------------------------------------------

async function optionsOf(client: pg.ClientBase, body: InventoryReportBody): Promise<ReportOptions> {
  const { rows } = await client.query<{ locale: string; digits: 'western' | 'eastern' }>(
    'SELECT locale, digits FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  const profile = rows[0];
  const locale = body.locale ?? (profile?.locale?.startsWith('ar') ? 'ar' : 'en');
  const dedupe = (ids: string[] | undefined) => [
    ...new Set((ids ?? []).map((i) => i.toLowerCase())),
  ];
  return {
    filters: {
      placeIds: dedupe(body.filters?.placeIds),
      typeIds: dedupe(body.filters?.typeIds),
      tagIds: dedupe(body.filters?.tagIds),
      thingIds: dedupe(body.filters?.thingIds),
      includeEnded: body.filters?.includeEnded ?? false,
      includeTrashed: body.filters?.includeTrashed ?? false,
    },
    include: {
      photos: body.include?.photos ?? true,
      qr: body.include?.qr ?? false,
      money: body.include?.money ?? true,
    },
    locale,
    digits: body.digits ?? profile?.digits ?? (locale === 'ar' ? 'eastern' : 'western'),
  };
}

/** The locations a request covers, as the caller sees them; 404 for a scope they can't see. */
async function coveredLocations(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  runScope: RunScope,
): Promise<string[]> {
  if ('locationId' in runScope) {
    const id = runScope.locationId.toLowerCase();
    await gateFor(tx, id, scope);
    const { rows } = await client.query(
      'SELECT 1 FROM public.locations WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (rows.length === 0) throw notFound();
    return [id];
  }
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM public.locations
      WHERE owner_account_id = $1 AND deleted_at IS NULL ORDER BY name, id`,
    [runScope.accountId.toLowerCase()],
  );
  if (rows.length === 0) throw notFound();
  return rows.map((r) => r.id);
}

/** RATE_LIMIT runs per user per RATE_WINDOW_SECONDS. Serialised per user with a transaction lock,
 * so two requests at once can't both take the last slot. */
async function checkRate(client: pg.ClientBase): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('kept.report:' || kept.current_user_id()::text, 0))`,
  );
  const { rows } = await client.query<{ n: number; oldest: Date | null }>(
    `SELECT count(*)::int AS n, min(created_at) AS oldest FROM public.report_runs
      WHERE user_id = kept.current_user_id()
        AND created_at > now() - make_interval(secs => $1)`,
    [RATE_WINDOW_SECONDS],
  );
  const { n = 0, oldest = null } = rows[0] ?? {};
  if (n >= RATE_LIMIT) {
    const retryAfter = oldest
      ? Math.max(1, Math.ceil((oldest.getTime() + RATE_WINDOW_SECONDS * 1000 - Date.now()) / 1000))
      : RATE_WINDOW_SECONDS;
    throw new AppError(
      'rate_limited',
      429,
      `At most ${RATE_LIMIT} reports an hour. Try again later.`,
      { retryAfter },
    );
  }
}

export type CreatedRun = { id: string; status: 'queued'; expiresAt: string };

export async function createInventoryRun(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  jobs: JobQueue,
  body: InventoryReportBody,
  requestId: string,
): Promise<CreatedRun> {
  const runScope: RunScope =
    'locationId' in body.scope
      ? { locationId: body.scope.locationId.toLowerCase() }
      : { accountId: body.scope.accountId.toLowerCase() };
  const locationIds = await coveredLocations(tx, client, scope, runScope);
  await checkRate(client);
  const options = await optionsOf(client, body);
  const id = newId();
  const { rows } = await client.query<{ expires_at: Date }>(
    `INSERT INTO public.report_runs (id, user_id, location_id, owner_account_id, location_ids, options)
     VALUES ($1, kept.current_user_id(), $2, $3, $4::uuid[], $5::jsonb)
     RETURNING expires_at`,
    [
      id,
      'locationId' in runScope ? runScope.locationId : null,
      'accountId' in runScope ? runScope.accountId : null,
      locationIds,
      JSON.stringify(options),
    ],
  );
  // One event in every location the report covers, so each location's history says who printed
  // an inventory of it (D201: "each generation is audited").
  const after = {
    scope: 'locationId' in runScope ? 'location' : 'account',
    ...('accountId' in runScope ? { accountId: runScope.accountId } : {}),
    locale: options.locale,
    digits: options.digits,
    include: options.include,
    filters: options.filters,
  };
  await auditedMany(
    tx,
    locationIds.map((locationId) => ({
      locationId,
      actor: { type: 'user' as const, id: scope.userId },
      action: 'report.generate',
      entity: { type: 'report', id },
      after,
      requestId,
    })),
  );
  await jobs.sendTenant(client, 'report', { runId: id });
  const expiresAt = rows[0]?.expires_at ?? new Date(Date.now() + 24 * 3600 * 1000);
  return { id, status: 'queued', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------------------------
// POST /api/v1/reports/insurance (D158, step-4 T18)
// ---------------------------------------------------------------------------------------------

const Day = z.iso.date();

export const InsuranceReportBody = z
  .object({
    scope: z.union([
      z.object({ locationId: z.uuid() }).strict(),
      z.object({ incidentId: z.uuid() }).strict(),
    ]),
    /** Default: today in the requester's time zone (Q20). */
    asOf: Day.optional(),
    /** A converted total beside the per-currency ones; needs a rate for every pair (Q21). */
    reportCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    include: z.object({ photos: z.boolean().optional() }).strict().optional(),
    /** The web's languages; a report is written in English or Arabic (D201), so French, German
     * and Italian readers get English. Omitted: the requester's own. */
    locale: z.enum(['en', 'ar', 'fr', 'de', 'it']).optional(),
    digits: z.enum(['western', 'eastern']).optional(),
  })
  .strict();
export type InsuranceReportBody = z.infer<typeof InsuranceReportBody>;

/** The location an insurance request or CSV is about, as the caller sees it, with the incident
 * when it names one. 404 for either the caller can't see. */
export async function insuranceScope(
  client: pg.ClientBase,
  scope: { locationId: string } | { incidentId: string },
): Promise<{ locationId: string; incidentId: string | null }> {
  if ('incidentId' in scope) {
    const incident = await readIncident(client, scope.incidentId);
    if (!incident) throw notFound();
    return { locationId: incident.locationId, incidentId: incident.id };
  }
  const id = scope.locationId.toLowerCase();
  const { rows } = await client.query(
    'SELECT 1 FROM public.locations WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  if (rows.length === 0) throw notFound();
  return { locationId: id, incidentId: null };
}

/** Who may read an insurance report (header): 403 otherwise, 404 for an invisible location. */
export async function requireInsuranceReader(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  at: { locationId: string; incidentId: string | null },
): Promise<void> {
  const me = await requireMembership(client, at.locationId);
  if (at.incidentId && !can(me.role, 'incidents.manage')) {
    throw forbidden('Only owners and admins can report on an incident.');
  }
  const gate = await gateFor(tx, at.locationId, scope);
  if (!gate.showMoney) {
    throw forbidden('The insurance report shows prices and values, which are hidden for you here.');
  }
}

/** Today in the requester's time zone, as `YYYY-MM-DD`. */
export async function todayFor(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query<{ today: string }>(
    `SELECT (now() AT TIME ZONE coalesce(
               (SELECT p.timezone FROM public.user_profiles p
                 WHERE p.user_id = kept.current_user_id()
                   AND p.timezone IN (SELECT name FROM pg_timezone_names)), 'UTC'))::date::text
              AS today`,
  );
  return rows[0]?.today as string;
}

/** The report's language: Arabic for Arabic, else English (D201). */
export const reportLocaleOf = (locale: string | null | undefined): ReportLocale =>
  locale?.startsWith('ar') ? 'ar' : 'en';

/** An insurance run's options from a request body and the requester's profile. */
export async function insuranceOptionsOf(
  client: pg.ClientBase,
  at: { locationId: string; incidentId: string | null },
  body: Pick<InsuranceReportBody, 'asOf' | 'reportCurrency' | 'include' | 'locale' | 'digits'>,
): Promise<InsuranceOptions> {
  const { rows } = await client.query<{ locale: string; digits: 'western' | 'eastern' }>(
    'SELECT locale, digits FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  const profile = rows[0];
  const locale = reportLocaleOf(body.locale ?? profile?.locale);
  if (body.reportCurrency) {
    await requireCurrencies(client, [body.reportCurrency], 'body.reportCurrency');
  }
  return {
    kind: 'insurance',
    locationId: at.locationId,
    incidentId: at.incidentId,
    asOf: body.asOf ?? (await todayFor(client)),
    reportCurrency: body.reportCurrency ?? null,
    include: { photos: body.include?.photos ?? true },
    locale,
    digits: body.digits ?? profile?.digits ?? (locale === 'ar' ? 'eastern' : 'western'),
  };
}

export async function createInsuranceRun(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  jobs: JobQueue,
  body: InsuranceReportBody,
  requestId: string,
): Promise<CreatedRun> {
  const at = await insuranceScope(client, body.scope);
  await requireInsuranceReader(tx, client, scope, at);
  const options = await insuranceOptionsOf(client, at, body);
  if (options.reportCurrency) {
    // Q21: a converted total only when every currency has a rate on or before asOf; refused
    // with the missing pairs now, so nobody waits for a report without the total they asked for.
    const g = await gatherInsurance(tx, client, scope, { ...options, include: { photos: false } });
    const missing = missingRates(totalsOf(g.things), options.reportCurrency, options.asOf, g.rates);
    if (missing.length > 0) {
      throw new AppError('rate_missing', 409, 'Add the missing exchange rates first.', {
        missing,
      });
    }
  }
  await checkRate(client);
  const id = newId();
  const { rows } = await client.query<{ expires_at: Date }>(
    `INSERT INTO public.report_runs (id, kind, user_id, location_id, location_ids, options)
     VALUES ($1, 'insurance', kept.current_user_id(), $2, ARRAY[$2]::uuid[], $3::jsonb)
     RETURNING expires_at`,
    [id, at.locationId, JSON.stringify(options)],
  );
  await auditedMany(tx, [
    {
      locationId: at.locationId,
      actor: { type: 'user' as const, id: scope.userId },
      action: 'report.generate',
      entity: { type: 'report', id },
      after: {
        kind: 'insurance',
        scope: at.incidentId ? 'incident' : 'location',
        ...(at.incidentId ? { incidentId: at.incidentId } : {}),
        asOf: options.asOf,
        reportCurrency: options.reportCurrency,
        locale: options.locale,
        digits: options.digits,
        include: options.include,
      },
      requestId,
    },
  ]);
  await jobs.sendTenant(client, 'report', { runId: id });
  const expiresAt = rows[0]?.expires_at ?? new Date(Date.now() + 24 * 3600 * 1000);
  return { id, status: 'queued', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------------------------
// POST /api/v1/reports/vehicle-history (D51, step-5 T15)
// ---------------------------------------------------------------------------------------------

export const VehicleHistoryReportBody = z
  .object({
    thingId: z.uuid(),
    /** Inclusive days in the vehicle's location; omitted: the whole history. */
    from: Day.optional(),
    to: Day.optional(),
    include: z
      .object({
        costs: z.boolean().optional(),
        proofPhotos: z.boolean().optional(),
        fuel: z.boolean().optional(),
        documents: z.boolean().optional(),
      })
      .strict()
      .optional(),
    locale: z.enum(['en', 'ar']).optional(),
    digits: z.enum(['western', 'eastern']).optional(),
  })
  .strict()
  .refine((b) => !b.from || !b.to || b.from <= b.to, {
    message: 'from is on or before to',
    path: ['from'],
  });
export type VehicleHistoryReportBody = z.infer<typeof VehicleHistoryReportBody>;

export async function createVehicleRun(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  jobs: JobQueue,
  body: VehicleHistoryReportBody,
  requestId: string,
): Promise<CreatedRun> {
  const thingId = body.thingId.toLowerCase();
  const { rows: things } = await client.query<{ location_id: string }>(
    `SELECT location_id FROM public.things
      WHERE id = $1 AND deleted_at IS NULL AND review_state = 'confirmed'`,
    [thingId],
  );
  const locationId = things[0]?.location_id;
  if (!locationId) throw notFound();
  await requireMembership(client, locationId);
  await checkRate(client);
  const { rows: me } = await client.query<{ locale: string; digits: 'western' | 'eastern' }>(
    'SELECT locale, digits FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  const locale = body.locale ?? reportLocaleOf(me[0]?.locale);
  const options: VehicleReportOptions = {
    kind: 'vehicle_history',
    thingId,
    from: body.from ?? null,
    to: body.to ?? null,
    include: {
      costs: body.include?.costs ?? true,
      proofPhotos: body.include?.proofPhotos ?? true,
      fuel: body.include?.fuel ?? true,
      documents: body.include?.documents ?? true,
    },
    locale,
    digits: body.digits ?? me[0]?.digits ?? (locale === 'ar' ? 'eastern' : 'western'),
  };
  const id = newId();
  const { rows } = await client.query<{ expires_at: Date }>(
    `INSERT INTO public.report_runs (id, kind, user_id, location_id, location_ids, thing_id, options)
     VALUES ($1, 'vehicle_history', kept.current_user_id(), $2, ARRAY[$2]::uuid[], $3, $4::jsonb)
     RETURNING expires_at`,
    [id, locationId, thingId, JSON.stringify(options)],
  );
  await auditedMany(tx, [
    {
      locationId,
      actor: { type: 'user' as const, id: scope.userId },
      action: 'report.generate',
      entity: { type: 'report', id },
      after: {
        kind: 'vehicle_history',
        thingId,
        from: options.from,
        to: options.to,
        include: options.include,
        locale: options.locale,
        digits: options.digits,
      },
      subjects: [thingId],
      rootThingId: thingId,
      requestId,
    },
  ]);
  await jobs.sendTenant(client, 'report', { runId: id });
  const expiresAt = rows[0]?.expires_at ?? new Date(Date.now() + 24 * 3600 * 1000);
  return { id, status: 'queued', expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------------------------
// GET /api/v1/reports/:id
// ---------------------------------------------------------------------------------------------

const FILE_STEM: Record<RunRow['kind'], string> = {
  inventory: 'inventory',
  insurance: 'insurance',
  vehicle_history: 'vehicle-history',
};

/** A download name: `kept-inventory-<date>.pdf`, `kept-insurance-<date>.pdf` or
 * `kept-vehicle-history-<date>.pdf`, ASCII (the header also carries it). */
function filenameOf(kind: RunRow['kind'], createdAt: Date): string {
  return `kept-${FILE_STEM[kind]}-${createdAt.toISOString().slice(0, 10)}.pdf`;
}

export async function reportRunView(
  client: pg.ClientBase,
  files: FileStorage,
  id: string,
): Promise<ReportRunView> {
  const { rows } = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM public.report_runs WHERE id = $1`,
    [id.toLowerCase()],
  );
  const run = rows[0];
  if (!run) throw notFound();
  const expired = run.expires_at.getTime() <= Date.now();
  // A job past its pg-boss expiry (policies.ts `report`) never reaches its own failure write:
  // a run still `running` long after that is shown as what it is.
  const stale =
    run.status === 'running' &&
    run.started_at !== null &&
    Date.now() - run.started_at.getTime() > STALE_RUNNING_MS;
  const view: ReportRunView = {
    id: run.id,
    status: expired ? 'expired' : stale ? 'failed' : run.status,
    scope: scopeOf(run),
    progress: { done: run.progress_done, total: run.progress_total },
    createdAt: run.created_at.toISOString(),
    expiresAt: run.expires_at.toISOString(),
  };
  if (run.status === 'failed' && run.error) view.error = run.error;
  if (stale) view.error = 'timeout';
  if (!expired && run.status === 'done') {
    view.bytes = Number(run.bytes ?? 0);
    const sign = (disposition: 'attachment' | 'inline') =>
      files.blobs.signedUrl(reportKey(run.id), {
        expiresIn: SIGNED_URL_TTL_SECONDS,
        disposition,
        filename: filenameOf(run.kind, run.created_at),
        contentType: 'application/pdf',
      });
    // The PDF is Kept's own render, so it may be shown in place: still under /f/'s nosniff and
    // `sandbox` CSP, which a browser's PDF viewer draws through (checked in Chromium).
    view.fileUrl = await sign('attachment');
    view.viewUrl = await sign('inline');
  }
  return view;
}

// ---------------------------------------------------------------------------------------------
// The `report` job
// ---------------------------------------------------------------------------------------------

export type ReportJobDeps = {
  pools: Pick<Pools, 'app'>;
  files: FileStorage | null;
  /** KEPT_PUBLIC_URL: the footer's instance, and what a QR code opens (`/l/<code>`, D120). */
  publicUrl: string;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  /** Render limits (tests). */
  render?: { memoryMb?: number; timeoutMs?: number };
  now?: () => Date;
};

export type ReportOutcome =
  | { status: 'done'; bytes: number; things: number; renderMs: number; peakMb: number }
  | { status: 'failed'; error: string }
  | { status: 'skipped' };

const inScope = <T>(
  deps: ReportJobDeps,
  scope: Scope,
  fn: (tx: Tx, c: pg.PoolClient) => Promise<T>,
) => withScope(deps.pools.app, scope, fn);

async function setProgress(
  deps: ReportJobDeps,
  scope: Scope,
  id: string,
  done: number,
  total: number,
) {
  await inScope(deps, scope, (_tx, c) =>
    c.query(
      `UPDATE public.report_runs SET progress_done = $2, progress_total = $3
        WHERE id = $1 AND status = 'running'`,
      [id, Math.min(done, total), total],
    ),
  );
}

async function fail(deps: ReportJobDeps, scope: Scope, id: string, error: string) {
  await inScope(deps, scope, (_tx, c) =>
    c.query(
      `UPDATE public.report_runs SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')`,
      [id, error],
    ),
  );
}

/** Runs `fn` over `items`, `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function readBlob(files: FileStorage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await files.blobs.stream(key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * A report ready to render: the things whose thumbnails (and QR codes) go in the job directory,
 * and the template's data once those are known.
 */
export type PreparedReport = {
  template: TemplateKind;
  things: readonly { id: string; thumbKey: string | null; shortCode: string | null }[];
  qr: boolean;
  view: (made: { withPhoto: ReadonlySet<string>; withQr: ReadonlySet<string> }) => unknown;
};

type PrepareContext = { publicUrl: string; now: () => Date };

async function prepareInventory(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  run: RunRow,
  ctx: PrepareContext,
): Promise<PreparedReport> {
  return prepareInventoryReport(
    tx,
    client,
    scope,
    { locationIds: run.location_ids, scope: scopeOf(run), options: run.options as ReportOptions },
    ctx,
  );
}

/** The inventory report of `locationIds`, ready for renderPrepared(): a report run's, and the
 * inventory PDF in an export's readable copy (exports/readable/, step-7 T13). Throws
 * TooManyThingsError past MAX_THINGS. */
export async function prepareInventoryReport(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  run: { locationIds: string[]; scope: RunScope; options: ReportOptions },
  ctx: PrepareContext,
): Promise<PreparedReport> {
  const options = run.options;
  const gathered = await gather(tx, client, scope, run);
  return {
    template: 'inventory',
    things: gathered.things,
    qr: options.include.qr,
    view: ({ withPhoto, withQr }) =>
      buildView(gathered, options, {
        instance: hostOf(ctx.publicUrl),
        now: ctx.now(),
        withPhoto,
        withQr,
      }),
  };
}

/** The vehicle history report (reports/vehicle/): the vehicle's cover photo and its short ID's QR
 * code, the proof photos and the invoice thumbnails, each by its own id in the job directory. */
async function prepareVehicle(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  options: VehicleReportOptions,
  ctx: PrepareContext,
): Promise<PreparedReport> {
  const g = await gatherVehicle(tx, client, scope, options);
  return {
    template: 'vehicle_history',
    things: [
      { id: g.thing.id, thumbKey: g.thing.thumbKey, shortCode: g.thing.shortCode },
      ...g.proofs.map((p) => ({ id: p.id, thumbKey: p.proofKey, shortCode: null })),
      ...g.services.flatMap((s) =>
        s.invoices.map((i) => ({ id: i.id, thumbKey: i.thumbKey, shortCode: null })),
      ),
    ],
    qr: true,
    view: ({ withPhoto, withQr }) =>
      buildVehicleView(g, options, {
        instance: hostOf(ctx.publicUrl),
        now: ctx.now(),
        withPhoto,
        withQr,
      }),
  };
}

/** The insurance report (incidents/report.ts), for a report run and for a claim pack's PDF. */
export async function prepareInsurance(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  options: InsuranceOptions,
  ctx: PrepareContext,
): Promise<PreparedReport> {
  const gathered = await gatherInsurance(tx, client, scope, options);
  return {
    template: 'insurance',
    things: gathered.things,
    qr: false,
    view: ({ withPhoto }) =>
      buildInsuranceView(gathered, options, {
        publicUrl: ctx.publicUrl,
        now: ctx.now(),
        withPhoto,
      }),
  };
}

/**
 * Writes a prepared report's thumbnails (and QR codes) into `dir`, its data, and renders it in
 * the child process: `<dir>/out.pdf`. `onProgress` hears how many things are done, at most every
 * PROGRESS_EVERY_MS and once at the end.
 */
export async function renderPrepared(
  files: FileStorage,
  dir: string,
  prepared: PreparedReport,
  opts: {
    publicUrl: string;
    log: ReportJobDeps['log'];
    render?: RenderOptions;
    onProgress?: (done: number) => Promise<unknown>;
  },
): Promise<RenderResult> {
  await mkdir(path.join(dir, 'thumbs'), { recursive: true });
  await mkdir(path.join(dir, 'qr'), { recursive: true });
  // Thumbnails: the thumbnail derivative (400 px JPEG), made smaller and always JPEG with sharp
  // (spike: WebP or PNG would go into the PDF as raw pixels, 25 times the size).
  const withPhoto = new Set<string>();
  const withQr = new Set<string>();
  let done = 0;
  let lastWrite = Date.now();
  await pool(prepared.things, THUMB_CONCURRENCY, async (t) => {
    if (t.thumbKey) {
      try {
        await sharp(await readBlob(files, t.thumbKey), { failOn: 'error' })
          .resize(THUMB_PX, THUMB_PX, { fit: 'cover' })
          .jpeg({ quality: 72, mozjpeg: true })
          .toFile(path.join(dir, 'thumbs', `${t.id}.jpg`));
        withPhoto.add(t.id);
      } catch (err) {
        // A missing or unreadable thumbnail leaves a blank square, not a failed report.
        opts.log.error({ err, thingId: t.id }, 'report: a thumbnail could not be read');
      }
    }
    if (prepared.qr && t.shortCode) {
      const svg = renderSVG(`${opts.publicUrl}/l/${t.shortCode}`, { ecc: 'M', border: 1 });
      await writeFile(path.join(dir, 'qr', `${t.id}.svg`), svg);
      withQr.add(t.id);
    }
    done += 1;
    if (opts.onProgress && Date.now() - lastWrite >= PROGRESS_EVERY_MS) {
      lastWrite = Date.now();
      await opts.onProgress(done);
    }
  });
  if (opts.onProgress) await opts.onProgress(prepared.things.length);
  await writeData(dir, prepared.view({ withPhoto, withQr }));
  return renderPdf(dir, opts.render ?? {}, prepared.template);
}

/**
 * One run of the `report` job for `runId`, in `scope` (the requester's, from the tenant job's
 * payload). Each step commits on its own, so the run's progress is visible while it works:
 * running → progress → done (or failed with a code). A run that is gone, expired, or no longer
 * visible to its requester is skipped.
 */
export async function runReport(
  deps: ReportJobDeps,
  scope: Scope,
  runId: string,
): Promise<ReportOutcome> {
  const now = deps.now ?? (() => new Date());
  const run = await inScope(deps, scope, async (_tx, c) => {
    const { rows } = await c.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM public.report_runs WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    const r = rows[0];
    if (!r || r.status === 'done' || r.status === 'failed' || r.expires_at <= now()) return null;
    await c.query(
      `UPDATE public.report_runs SET status = 'running', started_at = now(), progress_done = 0
        WHERE id = $1`,
      [runId],
    );
    return r;
  });
  if (!run) return { status: 'skipped' };

  const files = deps.files;
  if (!files) {
    await fail(deps, scope, runId, 'no_storage');
    return { status: 'failed', error: 'no_storage' };
  }

  let dir: string | null = null;
  try {
    const publicUrl = deps.publicUrl.replace(/\/+$/, '');
    const prepared = await inScope(deps, scope, (tx, c) =>
      run.kind === 'insurance'
        ? prepareInsurance(tx, c, scope, run.options as InsuranceOptions, { publicUrl, now })
        : run.kind === 'vehicle_history'
          ? prepareVehicle(tx, c, scope, run.options as VehicleReportOptions, { publicUrl, now })
          : prepareInventory(tx, c, scope, run, { publicUrl, now }),
    );
    const total = prepared.things.length + 1;
    await setProgress(deps, scope, runId, 0, total);

    await mkdir(files.tmpDir, { recursive: true });
    dir = await mkdtemp(path.join(files.tmpDir, 'report-'));
    const rendered = await renderPrepared(files, dir, prepared, {
      publicUrl,
      log: deps.log,
      render: deps.render ?? {},
      onProgress: (done) => setProgress(deps, scope, runId, done, total),
    });

    const key = reportKey(run.id);
    await files.blobs.put(key, rendered.file, {
      contentType: 'application/pdf',
      bytes: rendered.bytes,
    });
    const marked = await inScope(deps, scope, async (_tx, c) => {
      const { rowCount } = await c.query(
        `UPDATE public.report_runs
            SET status = 'done', bytes = $2, finished_at = now(), progress_done = progress_total
          WHERE id = $1 AND status = 'running'`,
        [runId, rendered.bytes],
      );
      return (rowCount ?? 0) > 0;
    });
    if (!marked) {
      // Purged or no longer visible while it rendered: the file has no run to serve it.
      await files.blobs.delete(key);
      return { status: 'skipped' };
    }
    deps.log.info(
      {
        runId,
        things: prepared.things.length,
        bytes: rendered.bytes,
        renderMs: rendered.ms,
        peakMb: rendered.peakMb,
      },
      'report rendered',
    );
    return {
      status: 'done',
      bytes: rendered.bytes,
      things: prepared.things.length,
      renderMs: rendered.ms,
      peakMb: rendered.peakMb,
    };
  } catch (err) {
    const code =
      err instanceof TooManyThingsError
        ? 'too_many_things'
        : err instanceof RenderError
          ? err.code
          : 'internal';
    await fail(deps, scope, runId, code).catch(() => {});
    if (code === 'too_many_things') return { status: 'failed', error: code };
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { reportError: code });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------
// The purge
// ---------------------------------------------------------------------------------------------

const PURGE_BATCH = 500;
const PURGE_ROUNDS = 100;

export type ReportPurge = { runs: number; failedBlobs: string[] };

/** Deletes runs past their 24 hours (kept.purge_expired_reports(), kept_system's door) and then,
 * after that commits, their files. A blob that won't delete is logged and named. */
export async function purgeExpiredReports(deps: {
  pools: Pick<Pools, 'system'>;
  files: FileStorage | null;
  log: ReportJobDeps['log'];
}): Promise<ReportPurge> {
  const out: ReportPurge = { runs: 0, failedBlobs: [] };
  if (!deps.files) {
    deps.log.info(
      {},
      'purge-reports: no file storage configured for this worker; left for one that has it',
    );
    return out;
  }
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const ids = await withSystem(deps.pools.system, async (_tx, c) => {
      const { rows } = await c.query<{ id: string }>(
        'SELECT id FROM kept.purge_expired_reports($1) AS id',
        [PURGE_BATCH],
      );
      return rows.map((r) => r.id);
    });
    out.runs += ids.length;
    for (const id of ids) {
      const key = reportKey(id);
      try {
        await deps.files.blobs.delete(key);
      } catch (err) {
        out.failedBlobs.push(key);
        deps.log.error({ err, key }, 'purge-reports: a report file could not be deleted');
      }
    }
    if (ids.length < PURGE_BATCH) break;
  }
  return out;
}
