import { FUEL_UNITS } from '@kept/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Pools } from '../db/pools.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { PAGE_DEFAULT, PAGE_MAX, requireIfMatch } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import { manyOf, notOf } from '../http/list-filters.js';
import { locationOfThing } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { IDEMPOTENCY_HEADER, scopedRead, scopedWrite } from '../http/write.js';
import { METER_VALUE } from '../meters/check.js';
import type { Ctx } from '../schedules/service.js';
import { deleteFuel, listFuel, logFuel, updateFuel } from './service.js';
import { fuelSummary } from './summary.js';
import { registerFuelUndo } from './undo.js';

// Fuel and charging (step-5 plan T11; D28, D170; Q3, Q6, Q7, Q14, Q22), in the shapes of the web
// contract (apps/web/src/api/vehicles/{types,paths}.ts: FuelRow, FuelParams, CreateFuelBody,
// CreateFuelResult, UpdateFuelBody, DeleteFuelResult, FuelSummary). Module `fuel` (which needs
// `vehicles`) in the thing's location: 404 `module_off` to read, 409 to write. Fuel carries money,
// which the phone never holds: it needs a connection (Q3).
//
// GET    /api/v1/things/:id/fuel?f.when&f.unit*&f.vendor*&f.full&not*&sort&dir&cursor&limit
//                                         → {items: FuelRow[], next_cursor}
// POST   /api/v1/things/:id/fuel {id, takenAt, amount, unit, cost?, currency?, isFull,
//        missedBefore?, vendor?: {id}|{name}, reading?: {meterId?, value, proofFileId?},
//        receiptFileId?, note?} (`logs.add`; Idempotency-Key required)
//                                         → 201 {entry, reading?: {id, state, reason?}, undo};
//        400 `fuel_needs_meter`; 409 `conflict` with `reason` and the neighbour when the odometer
//        runs backwards, nothing written                                  fuel.create, undoable
// PATCH  /api/v1/fuel/:id (If-Match) the POST's fields but `id` → FuelRow  fuel.update, undoable
// DELETE /api/v1/fuel/:id (If-Match)       → {undo}; its reading goes with it
//                                                                          fuel.delete, undoable
// GET    /api/v1/things/:id/fuel/summary?window=5&months=6 → FuelSummary

const Id = z.uuid();
const Params = z.object({ id: Id });
const Iso = z.iso.datetime({ offset: true });
const Amount = z
  .string()
  .regex(/^\d{1,7}(\.\d{1,3})?$/, 'an amount, e.g. 42.5')
  .refine((a) => Number(a) > 0, 'more than 0');
const Money = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'a cost of 0 or more, e.g. 1049.59');
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((c) => c.toUpperCase());
const Station = z.union([
  z.strictObject({ id: Id }),
  z.strictObject({ name: z.string().trim().min(1).max(120) }),
]);
const Reading = z.strictObject({
  meterId: Id.optional(),
  value: z.string().regex(METER_VALUE, 'a reading of 0 or more, with at most 3 decimals'),
  proofFileId: Id.optional(),
});
const Note = z.string().trim().max(500);

const CreateBody = z.strictObject({
  id: Id,
  takenAt: Iso,
  amount: Amount,
  unit: z.enum(FUEL_UNITS),
  cost: Money.optional(),
  currency: Currency.optional(),
  isFull: z.boolean(),
  missedBefore: z.boolean().optional(),
  vendor: Station.optional(),
  reading: Reading.optional(),
  receiptFileId: Id.optional(),
  note: Note.optional(),
});
const UpdateBody = z.strictObject({
  takenAt: Iso.optional(),
  amount: Amount.optional(),
  unit: z.enum(FUEL_UNITS).optional(),
  cost: Money.nullable().optional(),
  currency: Currency.optional(),
  isFull: z.boolean().optional(),
  missedBefore: z.boolean().optional(),
  vendor: Station.optional(),
  reading: Reading.optional(),
  receiptFileId: Id.optional(),
  note: Note.nullable().optional(),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(2048).optional(),
  'f.when': z.string().max(40).optional(),
  'f.unit': manyOf(z.enum(FUEL_UNITS)).optional(),
  'f.vendor': manyOf(Id).optional(),
  'f.full': z.enum(['0', '1']).optional(),
  not: notOf(['when', 'unit', 'vendor', 'full']).optional(),
  sort: z.enum(['takenAt', 'amount', 'cost']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});
const SummaryQuery = z.object({
  window: z.coerce.number().int().min(1).max(50).default(5),
  months: z.coerce.number().int().min(1).max(120).default(6),
});

const ReadingState = z.enum(['accepted', 'needs_review']);
export const FuelRowSchema = z.object({
  id: Id,
  takenAt: z.string(),
  amount: z.string(),
  unit: z.enum(FUEL_UNITS),
  isFull: z.boolean(),
  missedBefore: z.boolean(),
  cost: z.string().optional(),
  currency: z.string().optional(),
  moneyHidden: z.literal(true).optional(),
  pricePerUnit: z.string().optional(),
  vendor: z.object({ id: Id, name: z.string() }).optional(),
  reading: z.object({ id: Id, value: z.string(), state: ReadingState }).optional(),
  receipt: z.object({ attachmentId: Id, fileId: Id, thumbUrl: z.string().nullable() }).optional(),
  loggedBy: z.object({ displayName: z.string() }),
  rowVersion: z.number().int(),
});
const Undo = z.object({ eventId: Id, until: z.string() });
const CreateResult = z.object({
  entry: FuelRowSchema,
  reading: z.object({ id: Id, state: ReadingState, reason: z.string().optional() }).optional(),
  undo: Undo,
});
const Page = z.object({ items: z.array(FuelRowSchema), next_cursor: z.string().nullable() });
const Consumption = z.object({
  perHundred: z.string(),
  distanceUnit: z.string(),
  fills: z.number().int(),
  from: z.string(),
  to: z.string(),
});
const SummarySchema = z.object({
  byUnit: z.array(
    z.object({
      unit: z.enum(FUEL_UNITS),
      consumption: Consumption.nullable(),
      whyNone: z
        .enum(['too_few_full_fills', 'missed_fill', 'mixed_units', 'no_readings'])
        .optional(),
      trend: z.array(z.object({ at: z.string(), perHundred: z.string() })),
    }),
  ),
  pricePerUnit: z
    .array(
      z.object({
        unit: z.enum(FUEL_UNITS),
        currency: z.string(),
        latest: z.string(),
        trend: z.array(z.object({ at: z.string(), price: z.string() })),
      }),
    )
    .optional(),
  perDistance: z
    .array(
      z.object({
        currency: z.string(),
        amount: z.string(),
        distanceUnit: z.string(),
        from: z.string(),
        to: z.string(),
      }),
    )
    .optional(),
  monthlyAverage: z
    .array(z.object({ currency: z.string(), amount: z.string(), months: z.number().int() }))
    .optional(),
  moneyHidden: z.literal(true).optional(),
});

/** The location of the fill in `params.id`, as the caller sees it (the module gate's). */
function locationOfFill(pools: Pick<Pools, 'app'>) {
  return async (req: FastifyRequest): Promise<string | null> => {
    const id = (req.params as { id?: unknown } | undefined)?.id;
    if (!req.scope || typeof id !== 'string' || !Id.safeParse(id).success) return null;
    return withScope(pools.app, req.scope, async (_tx, client) => {
      const { rows } = await client.query<{ location_id: string }>(
        'SELECT location_id FROM public.fuel_entries WHERE id = $1',
        [id.toLowerCase()],
      );
      return rows[0]?.location_id ?? null;
    });
  };
}

export async function fuelRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerFuelUndo();
  const byThing = { module: 'fuel' as const, moduleLocation: locationOfThing(pools) };
  const byFill = { module: 'fuel' as const, moduleLocation: locationOfFill(pools) };

  const ctxOf = (
    req: FastifyRequest,
    tx: Ctx['tx'],
    client: Ctx['client'],
    scope: Ctx['scope'],
  ): Ctx => ({ tx, client, scope, requestId: req.id, files: deps.files, jobs: deps.jobs });
  const read = <B>(req: FastifyRequest, fn: (ctx: Ctx) => Promise<B>) =>
    scopedRead(pools, req, (tx, client, scope) => fn(ctxOf(req, tx, client, scope)));
  const write = <B>(
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    fn: (ctx: Ctx) => Promise<B>,
  ) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => ({
      status,
      body: await fn(ctxOf(req, tx, client, scope)),
    }));

  app.get(
    '/api/v1/things/:id/fuel',
    {
      config: byThing,
      schema: { params: Params, querystring: ListQuery, response: { 200: Page } },
    },
    (req) => read(req, (ctx) => listFuel(ctx, req.params.id.toLowerCase(), req.query)),
  );

  app.post(
    '/api/v1/things/:id/fuel',
    {
      config: byThing,
      schema: { params: Params, body: CreateBody, response: { 201: CreateResult } },
    },
    (req, reply) => {
      if (!req.headers[IDEMPOTENCY_HEADER]) {
        throw invalid('Send an Idempotency-Key with a fill, so a retry is never a second one.');
      }
      return write(req, reply, 201, (ctx) => logFuel(ctx, req.params.id.toLowerCase(), req.body));
    },
  );

  app.patch(
    '/api/v1/fuel/:id',
    {
      config: byFill,
      schema: { params: Params, body: UpdateBody, response: { 200: FuelRowSchema } },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        updateFuel(ctx, req.params.id.toLowerCase(), expected, req.body),
      );
    },
  );

  app.delete(
    '/api/v1/fuel/:id',
    { config: byFill, schema: { params: Params, response: { 200: z.object({ undo: Undo }) } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        deleteFuel(ctx, req.params.id.toLowerCase(), expected),
      );
    },
  );

  app.get(
    '/api/v1/things/:id/fuel/summary',
    {
      config: byThing,
      schema: { params: Params, querystring: SummaryQuery, response: { 200: SummarySchema } },
    },
    (req) => read(req, (ctx) => fuelSummary(ctx, req.params.id.toLowerCase(), req.query)),
  );
}
