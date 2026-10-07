import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { gatherInsurance, insuranceCsv } from '../incidents/report.js';
import {
  createInsuranceRun,
  createInventoryRun,
  createVehicleRun,
  InsuranceReportBody,
  InventoryReportBody,
  insuranceOptionsOf,
  insuranceScope,
  ReportRunView,
  reportRunView,
  requireInsuranceReader,
  VehicleHistoryReportBody,
} from './service.js';

// The inventory report (D201; step-2 plan T32). The web's "Print inventory" (the location
// page's actions, Settings → Account) posts the request, polls the run, then downloads it.
//
// POST /api/v1/reports/inventory
//   {scope: {locationId} | {accountId},
//    filters?: {placeIds?, typeIds?, tagIds?, includeEnded?, includeTrashed?},
//    include?: {photos? = true, qr? = false, money? = true},
//    locale?: 'en' | 'ar', digits?: 'western' | 'eastern'}
//   → 202 {id, status: 'queued', expiresAt}; 404 for a scope the caller can't see; 429 past
//   five an hour (`retryAfter` seconds in the body and the Retry-After header).
// GET /api/v1/reports/:id
//   → {id, status: 'queued'|'running'|'done'|'failed'|'expired', scope, progress: {done, total},
//      fileUrl? (five minutes, attachment), viewUrl? (the same, inline), bytes?, error?,
//      createdAt, expiresAt}
//   Someone else's run, or one past its purge, is a 404.
//
// The insurance report (D158, step-4 T18), in the Money module:
// POST /api/v1/reports/insurance
//   {scope: {locationId} | {incidentId}, asOf?, reportCurrency?, include?: {photos? = true},
//    locale?, digits?} → 202 {id, status: 'queued', expiresAt}, the same run and 5-an-hour limit;
//   403 for a reader who can't see money there, or a member asking about an incident; 409
//   `rate_missing` with `missing: [{from, to}]` when a reportCurrency lacks a rate (Q21).
// GET /api/v1/reports/insurance.csv?locationId|incidentId&asOf
//   → text/csv, one row per thing, formula-safe (D169); audited `report.export_csv`.
//
// The vehicle history report (D51, step-5 T15), in the Vehicles module of the vehicle's location:
// POST /api/v1/reports/vehicle-history
//   {thingId, from?, to?, include?: {costs?, proofPhotos?, fuel?, documents?} (all true),
//    locale?: 'en' | 'ar', digits?} → 202 {id, status: 'queued', expiresAt}; anyone who sees the
//   vehicle, viewers included (no money unless the location shows it to them); 404 for a vehicle
//   they can't see; 409 `module_off` where Vehicles is off; the same 5-an-hour limit.

const Created = z.object({
  id: z.uuid(),
  status: z.literal('queued'),
  expiresAt: z.string(),
});

const Params = z.object({ id: z.uuid() });

const CsvQuery = z
  .object({
    locationId: z.uuid().optional(),
    incidentId: z.uuid().optional(),
    asOf: z.iso.date().optional(),
  })
  .refine((q) => (q.locationId === undefined) !== (q.incidentId === undefined), {
    message: 'exactly one of locationId and incidentId',
    path: ['locationId'],
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reportRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const needs = () => {
    if (!deps.files || !deps.jobs) {
      throw new AppError('internal', 503, 'Reports need file storage and the job queue.');
    }
    return { files: deps.files, jobs: deps.jobs };
  };

  app.post(
    '/api/v1/reports/inventory',
    { schema: { body: InventoryReportBody, response: { 202: Created } } },
    async (req, reply) => {
      const { jobs } = needs();
      try {
        return await scopedWrite(pools, req, reply, async (tx, client, scope) => ({
          status: 202,
          body: await createInventoryRun(tx, client, scope, jobs, req.body, req.id),
        }));
      } catch (err) {
        const retryAfter = err instanceof AppError ? err.extra?.retryAfter : undefined;
        if (typeof retryAfter === 'number') reply.header('retry-after', String(retryAfter));
        throw err;
      }
    },
  );

  /** The Money module's location for an insurance request: the scope's location, or its
   * incident's as the caller sees it. */
  const insuranceLocation = async (
    req: FastifyRequest,
    at: { locationId?: unknown; incidentId?: unknown } | undefined,
  ): Promise<string | null> => {
    if (typeof at?.locationId === 'string') return at.locationId;
    const id = at?.incidentId;
    const scope = req.scope;
    if (!scope || typeof id !== 'string' || !UUID.test(id)) return null;
    return withScope(pools.app, scope, async (_tx, c) => {
      const { rows } = await c.query<{ location_id: string }>(
        'SELECT location_id FROM public.incidents WHERE id = $1',
        [id.toLowerCase()],
      );
      return rows[0]?.location_id ?? null;
    });
  };

  app.post(
    '/api/v1/reports/insurance',
    {
      config: {
        module: 'money',
        moduleLocation: (req) =>
          insuranceLocation(req, (req.body as { scope?: Record<string, unknown> } | null)?.scope),
      },
      schema: { body: InsuranceReportBody, response: { 202: Created } },
    },
    async (req, reply) => {
      const { jobs } = needs();
      try {
        return await scopedWrite(pools, req, reply, async (tx, client, scope) => ({
          status: 202,
          body: await createInsuranceRun(tx, client, scope, jobs, req.body, req.id),
        }));
      } catch (err) {
        const retryAfter = err instanceof AppError ? err.extra?.retryAfter : undefined;
        if (typeof retryAfter === 'number') reply.header('retry-after', String(retryAfter));
        throw err;
      }
    },
  );

  app.get(
    '/api/v1/reports/insurance.csv',
    {
      config: {
        module: 'money',
        moduleLocation: (req) => insuranceLocation(req, req.query as Record<string, unknown>),
      },
      schema: { querystring: CsvQuery },
    },
    async (req, reply) => {
      const q = req.query;
      const csv = await scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const at = await insuranceScope(
          client,
          q.incidentId ? { incidentId: q.incidentId } : { locationId: q.locationId as string },
        );
        await requireInsuranceReader(tx, client, scope, at);
        const options = await insuranceOptionsOf(client, at, {
          ...(q.asOf ? { asOf: q.asOf } : {}),
          include: { photos: false },
        });
        const gathered = await gatherInsurance(tx, client, scope, options);
        await audited(tx, {
          locationId: at.locationId,
          actor: { type: 'user', id: scope.userId },
          action: 'report.export_csv',
          entity: { type: 'report', id: null },
          before: null,
          after: {
            kind: 'insurance',
            scope: at.incidentId ? 'incident' : 'location',
            ...(at.incidentId ? { incidentId: at.incidentId } : {}),
            asOf: options.asOf,
            rows: gathered.things.length,
          },
          requestId: req.id,
        });
        return { status: 200, body: insuranceCsv(gathered) };
      });
      reply
        .type('text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="kept-insurance-${new Date().toISOString().slice(0, 10)}.csv"`,
        )
        .header('cache-control', 'no-store');
      return csv;
    },
  );

  /** The vehicle's location, as the caller sees it, for the Vehicles module gate. */
  const vehicleLocation = async (req: FastifyRequest): Promise<string | null> => {
    const id = (req.body as { thingId?: unknown } | null)?.thingId;
    const scope = req.scope;
    if (!scope || typeof id !== 'string' || !UUID.test(id)) return null;
    return withScope(pools.app, scope, async (_tx, c) => {
      const { rows } = await c.query<{ location_id: string }>(
        'SELECT location_id FROM public.things WHERE id = $1 AND deleted_at IS NULL',
        [id.toLowerCase()],
      );
      return rows[0]?.location_id ?? null;
    });
  };

  app.post(
    '/api/v1/reports/vehicle-history',
    {
      config: { module: 'vehicles', moduleLocation: vehicleLocation },
      schema: { body: VehicleHistoryReportBody, response: { 202: Created } },
    },
    async (req, reply) => {
      const { jobs } = needs();
      try {
        return await scopedWrite(pools, req, reply, async (tx, client, scope) => ({
          status: 202,
          body: await createVehicleRun(tx, client, scope, jobs, req.body, req.id),
        }));
      } catch (err) {
        const retryAfter = err instanceof AppError ? err.extra?.retryAfter : undefined;
        if (typeof retryAfter === 'number') reply.header('retry-after', String(retryAfter));
        throw err;
      }
    },
  );

  app.get(
    '/api/v1/reports/:id',
    { schema: { params: Params, response: { 200: ReportRunView } } },
    (req) => {
      const { files } = needs();
      return scopedRead(pools, req, (_tx, client) => reportRunView(client, files, req.params.id));
    },
  );
}
