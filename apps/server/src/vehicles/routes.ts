import { STARTER_KEYS } from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { PAGE_DEFAULT, PAGE_MAX } from '../http/conventions.js';
import { manyOf, notOf } from '../http/list-filters.js';
import { locationOfMeter, locationOfThing } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { EstimateSchema } from '../meters/estimate.js';
import type { Ctx } from '../schedules/service.js';
import { createStarterSchedules, registerStarterUndo } from '../schedules/starter.js';
import { ScheduleSchema } from '../schedules/view.js';
import { ThingRowSchema } from '../things/view.js';
import { costReport } from './costs.js';
import { listVehicles } from './list.js';
import { meterSeries } from './series.js';

// Vehicles (step-5 plan T13; D26, D52, D188; screens §1, §8; Q2, Q5, Q8, Q22, Q24, Q25), in the
// shapes of the web contract (apps/web/src/api/vehicles/{types,paths}.ts: VehicleRow,
// VehiclesParams, CostReport, MeterSeries, StarterSchedulesBody, StarterSchedulesResult). Module
// `vehicles`: the list reads every visible location with it on (so it declares none, as the
// global lists do); the rest gate on the thing's or meter's location (404 `module_off` to read,
// 409 to write).
//
// GET  /api/v1/vehicles?q&f.location*&f.type*&f.state*&f.reading*&f.due*&not*&sort&dir&cursor&limit
//                                          → {items: VehicleRow[], next_cursor}   (list.ts)
// GET  /api/v1/things/:id/costs?from&to    → CostReport                           (costs.ts)
// GET  /api/v1/meters/:id/series?from&to   → MeterSeries                          (series.ts)
// POST /api/v1/things/:id/starter-schedules {keys?} (Schedules on too; `schedules-claims.manage`)
//                                          → 201 {schedules, undo?}  schedule.starter, undoable
//                                                               (schedules/starter.ts)

const Id = z.uuid();
const Params = z.object({ id: Id });

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(2048).optional(),
  q: z.string().trim().max(200).optional(),
  'f.location': manyOf(Id).optional(),
  'f.type': manyOf(Id).optional(),
  'f.state': manyOf(z.string().regex(/^[a-z_]{1,40}$/)).optional(),
  'f.reading': manyOf(z.enum(['fresh', 'stale', 'unknown', 'none'])).optional(),
  'f.due': manyOf(z.enum(['overdue', 'soon'])).optional(),
  not: notOf(['location', 'type', 'state', 'reading', 'due']).optional(),
  sort: z.enum(['name', 'lastReading', 'nextDue', 'location']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});
const RangeQuery = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});
const StarterBody = z
  .strictObject({ keys: z.array(z.enum(STARTER_KEYS)).min(1).max(STARTER_KEYS.length).optional() })
  .optional();

const VehicleRowSchema = z.object({
  thing: ThingRowSchema,
  meter: z
    .object({
      id: Id,
      unit: z.string(),
      latest: z
        .object({
          value: z.string(),
          takenAt: z.string(),
          source: z.string(),
          by: z.object({ displayName: z.string() }),
        })
        .optional(),
      estimate: EstimateSchema,
    })
    .optional(),
  nextDue: z
    .object({
      name: z.string(),
      dueOn: z.string().optional(),
      dueValue: z.string().optional(),
      estimated: z.boolean(),
      state: z.string(),
    })
    .optional(),
  documentsDue: z.array(
    z.object({ id: Id, kind: z.string(), expiresOn: z.string(), state: z.string() }),
  ),
  fuel: z
    .object({
      perHundred: z.string(),
      unit: z.enum(['L', 'kWh', 'gal']),
      distanceUnit: z.string(),
    })
    .optional(),
});
const Amounts = {
  fuel: z.string(),
  service: z.string(),
  fees: z.string(),
  total: z.string(),
};
const CostReportSchema = z.object({
  period: z.object({ from: z.string(), to: z.string() }),
  distance: z
    .object({ value: z.string(), unit: z.string(), basis: z.literal('readings') })
    .nullable(),
  months: z.array(
    z.object({
      month: z.string(),
      soFar: z.boolean(),
      byCurrency: z.array(z.object({ currency: z.string(), ...Amounts })),
      notes: z.array(z.string()),
    }),
  ),
  totals: z.array(
    z.object({
      currency: z.string(),
      ...Amounts,
      perDistance: z.string().optional(),
      monthlyAverage: z.string(),
    }),
  ),
  moneyHidden: z.literal(true).optional(),
});
const SeriesSchema = z.object({
  unit: z.string(),
  points: z.array(z.object({ takenAt: z.string(), value: z.string(), source: z.string() })),
  estimate: z
    .object({
      perDay: z.string(),
      through: z.array(z.object({ at: z.string(), value: z.string() })),
    })
    .optional(),
  thresholds: z.array(
    z.object({
      scheduleId: Id,
      name: z.string(),
      value: z.string(),
      estimatedOn: z.string().nullable(),
    }),
  ),
});
const StarterResult = z.object({
  schedules: z.array(ScheduleSchema),
  undo: z.object({ eventId: Id, until: z.string() }).optional(),
});

export async function vehicleRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerStarterUndo();
  const byThing = { module: 'vehicles' as const, moduleLocation: locationOfThing(pools) };
  const byMeter = { module: 'vehicles' as const, moduleLocation: locationOfMeter(pools) };
  const ctxOf = (
    req: FastifyRequest,
    tx: Ctx['tx'],
    client: Ctx['client'],
    scope: Ctx['scope'],
  ): Ctx => ({ tx, client, scope, requestId: req.id, files: deps.files, jobs: deps.jobs });
  const read = <B>(req: FastifyRequest, fn: (ctx: Ctx) => Promise<B>) =>
    scopedRead(pools, req, (tx, client, scope) => fn(ctxOf(req, tx, client, scope)));

  app.get(
    '/api/v1/vehicles',
    {
      schema: {
        querystring: ListQuery,
        response: {
          200: z.object({ items: z.array(VehicleRowSchema), next_cursor: z.string().nullable() }),
        },
      },
    },
    (req) => read(req, (ctx) => listVehicles(ctx, req.query)),
  );

  app.get(
    '/api/v1/things/:id/costs',
    {
      config: byThing,
      schema: { params: Params, querystring: RangeQuery, response: { 200: CostReportSchema } },
    },
    (req) => read(req, (ctx) => costReport(ctx, req.params.id.toLowerCase(), req.query)),
  );

  app.get(
    '/api/v1/meters/:id/series',
    {
      config: byMeter,
      schema: { params: Params, querystring: RangeQuery, response: { 200: SeriesSchema } },
    },
    (req) => read(req, (ctx) => meterSeries(ctx, req.params.id.toLowerCase(), req.query)),
  );

  app.post(
    '/api/v1/things/:id/starter-schedules',
    {
      config: byThing,
      schema: { params: Params, body: StarterBody, response: { 201: StarterResult } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createStarterSchedules(
          ctxOf(req, tx, client, scope),
          req.params.id.toLowerCase(),
          req.body?.keys,
        ),
      })),
  );
}
