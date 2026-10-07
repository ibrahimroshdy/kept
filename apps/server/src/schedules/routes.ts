import { SERVICE_LINE_KINDS } from '@kept/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { PAGE_DEFAULT, PAGE_MAX, requireIfMatch } from '../http/conventions.js';
import { manyOf, notOf } from '../http/list-filters.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { METER_VALUE } from '../meters/check.js';
import {
  type Ctx,
  createSchedule,
  deleteSchedule,
  listSchedules,
  skipSchedule,
  snoozeSchedule,
  subjectSchedules,
  unsnoozeSchedule,
  updateSchedule,
} from './service.js';
import {
  completeSchedule,
  createService,
  deleteService,
  subjectServices,
  updateService,
} from './services.js';
import { registerScheduleUndo } from './undo.js';
import { ScheduleSchema, ServiceRecordSchema } from './view.js';

// Schedules and service records (plan T11; D29, D39, D52, D113, D146, D162; Q1, Q2, Q9, Q28), in
// the shapes of the web contract (apps/web/src/api/household/{types,paths}.ts):
//
// GET    /api/v1/schedules?locationId&state&subjectType&q&cursor&limit
//                                         → {items: Schedule[], counts: {due, overdue}, next_cursor}
// GET    /api/v1/things/:id/schedules · /api/v1/places/:id/schedules → {items: Schedule[]}
// POST   /api/v1/schedules                    → 201 Schedule (400 schedule_interval_required)
// PATCH  /api/v1/schedules/:id (If-Match)     → Schedule        schedule.update, undoable
// DELETE /api/v1/schedules/:id (If-Match)     → 204             schedule.delete, undoable
// POST   /api/v1/schedules/:id/complete (If-Match) → {serviceRecord, schedule}   undoable
// POST   /api/v1/schedules/:id/snooze (If-Match) {untilDate} | {untilValue} | {} → Schedule
// POST   /api/v1/schedules/:id/skip · …/unsnooze (If-Match) → Schedule           undoable
// GET    /api/v1/things/:id/service-records · /api/v1/places/:id/service-records
//          ?q&f.when&f.vendor*&f.kind*&f.draft&not*&sort&dir&cursor&limit (step 5, T9)
//                                         → {items: ServiceRecord[], next_cursor}, drafts first
// POST   /api/v1/service-records              → 201 ServiceRecord (core; `completes` needs Schedules)
// PATCH  /api/v1/service-records/:id (If-Match) → ServiceRecord  service_record.update, undoable
// DELETE /api/v1/service-records/:id (If-Match) → 204           service_record.delete, undoable
//
// Schedules are the `schedules` module's: a read where it is off is 404 `module_off`, a write
// 409 (§7.6). The module is checked in the service, in the request's transaction, where the
// location is known (a body's subject, a schedule's row). Service records are core (D113).
// A reading refused by the meters' check is 409 `conflict` with `reason` and the neighbour it
// collides with, the meters section's shape (meters/service.ts).

const Id = z.uuid();
const Params = z.object({ id: Id });
const Day = z.iso.date();
const Iso = z.iso.datetime({ offset: true });
/** numeric(14,3): a meter interval or lead. */
const Units = z
  .string()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'a number with at most 3 decimals, e.g. 10000');
const Positive = Units.refine((u) => Number(u) > 0, 'more than 0');
const Value = z.string().regex(METER_VALUE, 'a reading of 0 or more, with at most 3 decimals');
/** numeric(16,4) ≥ 0: an amount. */
const Amount = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'an amount, e.g. 1250.50');
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((c) => c.toUpperCase());
const Name = z.string().trim().min(1).max(120);
const Notes = z.string().trim().max(5000);
const SubjectBody = z.union([z.strictObject({ thingId: Id }), z.strictObject({ placeId: Id })]);
const Vendor = z.union([
  z.strictObject({ id: Id }),
  z.strictObject({ name: z.string().trim().min(1).max(120) }),
]);
const Line = z.strictObject({
  kind: z.enum(SERVICE_LINE_KINDS),
  description: z.string().trim().min(1).max(300),
  quantity: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,3})?$/, 'a quantity, e.g. 2 or 4.5')
    .refine((q) => Number(q) > 0, 'more than 0')
    .optional(),
  unitCost: Amount.optional(),
});

const CreateScheduleBody = z.strictObject({
  id: Id.optional(),
  subject: SubjectBody,
  name: Name,
  everyMonths: z.number().int().min(1).max(600).optional(),
  everyUnits: Positive.optional(),
  meterId: Id.optional(),
  dueOn: Day.optional(),
  leadDays: z.number().int().min(0).max(365).optional(),
  leadUnits: Units.optional(),
  anchorOn: Day.optional(),
  anchorValue: Value.optional(),
});
const UpdateScheduleBody = z.strictObject({
  name: Name.optional(),
  everyMonths: z.number().int().min(1).max(600).nullable().optional(),
  everyUnits: Positive.nullable().optional(),
  meterId: Id.nullable().optional(),
  dueOn: Day.nullable().optional(),
  leadDays: z.number().int().min(0).max(365).optional(),
  leadUnits: Units.nullable().optional(),
  anchorOn: Day.optional(),
  anchorValue: Value.nullable().optional(),
  active: z.boolean().optional(),
});
const SnoozeBody = z.union([
  z.strictObject({ untilDate: Day }),
  z.strictObject({ untilValue: Value }),
  z.strictObject({}),
]);
const CompleteBody = z.strictObject({
  servicedOn: Day.optional(),
  reading: z.strictObject({ value: Value, takenAt: Iso.optional() }).optional(),
  vendor: Vendor.optional(),
  total: Amount.optional(),
  currency: Currency.optional(),
  notes: Notes.optional(),
});
const ReadingBody = z.strictObject({ meterId: Id, value: Value, proofFileId: Id.optional() });
const CreateServiceBody = z.strictObject({
  id: Id.optional(),
  subject: SubjectBody,
  servicedOn: Day,
  reading: ReadingBody.optional(),
  vendor: Vendor.optional(),
  total: Amount.optional(),
  currency: Currency.optional(),
  lines: z.array(Line).max(50).optional(),
  completes: z.array(Id).max(50).optional(),
  notes: Notes.optional(),
});
const UpdateServiceBody = z.strictObject({
  servicedOn: Day.optional(),
  reading: ReadingBody.optional(),
  vendor: Vendor.nullable().optional(),
  total: Amount.nullable().optional(),
  currency: Currency.optional(),
  lines: z.array(Line).max(50).optional(),
  completes: z.array(Id).max(50).optional(),
  notes: Notes.nullable().optional(),
});

const ListQuery = z.object({
  locationId: Id.optional(),
  state: z.enum(['upcoming', 'due', 'overdue']).optional(),
  subjectType: z.enum(['thing', 'place']).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(2048).optional(),
});
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(2048).optional(),
});

/** A thing's or place's service records (the `services` surface, step 5 T9, D205). */
const ServiceQuery = PageQuery.extend({
  q: z.string().trim().max(200).optional(),
  'f.when': z.string().max(40).optional(),
  'f.vendor': manyOf(Id).optional(),
  'f.kind': manyOf(z.enum(SERVICE_LINE_KINDS)).optional(),
  'f.draft': z.enum(['0', '1']).optional(),
  not: notOf(['when', 'vendor', 'kind', 'draft']).optional(),
  sort: z.enum(['servicedOn', 'total']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const SchedulesPage = z.object({
  items: z.array(ScheduleSchema),
  counts: z.object({ due: z.number(), overdue: z.number() }),
  next_cursor: z.string().nullable(),
});
const ScheduleList = z.object({ items: z.array(ScheduleSchema) });
const ServicePage = z.object({
  items: z.array(ServiceRecordSchema),
  next_cursor: z.string().nullable(),
});
const CompleteResult = z.object({ serviceRecord: ServiceRecordSchema, schedule: ScheduleSchema });

export async function scheduleRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerScheduleUndo();

  const ctxOf = (
    req: FastifyRequest,
    tx: Ctx['tx'],
    client: Ctx['client'],
    scope: Ctx['scope'],
  ): Ctx => ({ tx, client, scope, requestId: req.id, files: deps.files, jobs: deps.jobs });
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
  const read = <B>(req: FastifyRequest, fn: (ctx: Ctx) => Promise<B>) =>
    scopedRead(pools, req, (tx, client, scope) => fn(ctxOf(req, tx, client, scope)));
  const lower = (id: string) => id.toLowerCase();

  // --- schedules ---------------------------------------------------------------------------
  app.get(
    '/api/v1/schedules',
    { schema: { querystring: ListQuery, response: { 200: SchedulesPage } } },
    (req) => read(req, (ctx) => listSchedules(ctx.client, req.query)),
  );

  for (const [kind, url] of [
    ['thing', '/api/v1/things/:id/schedules'],
    ['place', '/api/v1/places/:id/schedules'],
  ] as const) {
    app.get(url, { schema: { params: Params, response: { 200: ScheduleList } } }, (req) =>
      read(req, (ctx) =>
        subjectSchedules(
          ctx,
          kind === 'thing' ? { thingId: req.params.id } : { placeId: req.params.id },
        ),
      ),
    );
  }

  app.post(
    '/api/v1/schedules',
    { schema: { body: CreateScheduleBody, response: { 201: ScheduleSchema } } },
    (req, reply) => write(req, reply, 201, (ctx) => createSchedule(ctx, req.body)),
  );

  app.patch(
    '/api/v1/schedules/:id',
    { schema: { params: Params, body: UpdateScheduleBody, response: { 200: ScheduleSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        updateSchedule(ctx, lower(req.params.id), expected, req.body),
      );
    },
  );

  app.delete('/api/v1/schedules/:id', { schema: { params: Params } }, (req, reply) => {
    const expected = requireIfMatch(req);
    return write(req, reply, 204, async (ctx) => {
      await deleteSchedule(ctx, lower(req.params.id), expected);
      return undefined;
    });
  });

  app.post(
    '/api/v1/schedules/:id/complete',
    { schema: { params: Params, body: CompleteBody, response: { 200: CompleteResult } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        completeSchedule(ctx, lower(req.params.id), expected, req.body),
      );
    },
  );

  app.post(
    '/api/v1/schedules/:id/snooze',
    { schema: { params: Params, body: SnoozeBody, response: { 200: ScheduleSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        snoozeSchedule(ctx, lower(req.params.id), expected, req.body),
      );
    },
  );

  app.post(
    '/api/v1/schedules/:id/skip',
    { schema: { params: Params, response: { 200: ScheduleSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) => skipSchedule(ctx, lower(req.params.id), expected));
    },
  );

  app.post(
    '/api/v1/schedules/:id/unsnooze',
    { schema: { params: Params, response: { 200: ScheduleSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) => unsnoozeSchedule(ctx, lower(req.params.id), expected));
    },
  );

  // --- service records ---------------------------------------------------------------------
  for (const [kind, url] of [
    ['thing', '/api/v1/things/:id/service-records'],
    ['place', '/api/v1/places/:id/service-records'],
  ] as const) {
    app.get(
      url,
      { schema: { params: Params, querystring: ServiceQuery, response: { 200: ServicePage } } },
      (req) =>
        read(req, (ctx) =>
          subjectServices(
            ctx,
            kind === 'thing' ? { thingId: req.params.id } : { placeId: req.params.id },
            req.query,
          ),
        ),
    );
  }

  app.post(
    '/api/v1/service-records',
    { schema: { body: CreateServiceBody, response: { 201: ServiceRecordSchema } } },
    (req, reply) => write(req, reply, 201, (ctx) => createService(ctx, req.body)),
  );

  app.patch(
    '/api/v1/service-records/:id',
    {
      schema: { params: Params, body: UpdateServiceBody, response: { 200: ServiceRecordSchema } },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        updateService(ctx, lower(req.params.id), expected, req.body),
      );
    },
  );

  app.delete('/api/v1/service-records/:id', { schema: { params: Params } }, (req, reply) => {
    const expected = requireIfMatch(req);
    return write(req, reply, 204, async (ctx) => {
      await deleteService(ctx, lower(req.params.id), expected);
      return undefined;
    });
  });
}
