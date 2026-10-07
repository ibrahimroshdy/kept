import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { METER_KINDS } from '../db/schema/meters.js';
import type { KeptApp } from '../http/app.js';
import { PAGE_DEFAULT, PAGE_MAX, requireIfMatch } from '../http/conventions.js';
import { notFound } from '../http/errors.js';
import { manyOf, notOf } from '../http/list-filters.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { METER_OFFSET, METER_VALUE } from './check.js';
import { EstimateSchema } from './estimate.js';
import { listProofs, ProofItemSchema, ProofRefSchema } from './proofs.js';
import {
  acceptReading,
  type Ctx,
  createMeter,
  createReading,
  deleteReading,
  listReadings,
  recordReplacement,
  updateMeter,
  updateReading,
} from './service.js';
import { registerReadingUndo } from './undo.js';

// Meters and readings, core (T16; D26, D52, D112, D113), in the shapes of the web contract
// (apps/web/src/api/inventory/{types,paths}.ts):
//
// POST   /api/v1/things/:id/meters {kind, unit, label?, maxPerDay?}   → 201 MeterView
// PATCH  /api/v1/meters/:id (If-Match) {label?, maxPerDay?, nudgeDays?} → MeterView; 412 per D156
// POST   /api/v1/meters/:id/replaced {at, offset} (If-Match optional) → 201 {event, meter}
// GET    /api/v1/meters/:id/readings?f.when&f.source*&f.state*&not*&sort&dir&cursor&limit
//                                                                    → {items: Reading[], next_cursor}
// POST   /api/v1/meters/:id/readings {id?, value, takenAt, note?, confirmJump?, proofFileId?}
//                                             → 201 {reading, state, reason?, undo}  undoable
//                                               409 {reason} when backwards (confirmJump or not)
// PATCH  /api/v1/readings/:id {value?, takenAt?, note?} (If-Match optional) → Reading
// DELETE /api/v1/readings/:id                                         → 204, undoable
//          (both: 409 `reading_owned` {ownedBy} for a fill's or a service's reading, Q11)
// POST   /api/v1/readings/:id/accept                                  → Reading
// GET    /api/v1/meters/:id/proofs?cursor&limit (the odometer proof strip, D195)
//                                                                    → {items: ProofItem[], next_cursor}
//
// MeterView is the contract's ThingMeter plus `thingId`, `maxPerDay`, `offset` and `rowVersion`
// (PATCH needs the version), and step 5's `nudgeDays` and `estimate` (ThingMeterV5); Reading
// carries `rowVersion` beyond the contract, and in lists its `proof` and `ownedBy` (step 5's
// ReadingRow). Meters are core (D113): no module gates them.

const Params = z.object({ id: z.uuid() });
const Iso = z.iso.datetime({ offset: true });
const Value = z
  .string()
  .regex(METER_VALUE, 'a reading of 0 or more, with at most 3 decimals, e.g. 53000.5');
/** numeric(14,3), > 0. */
const PerDay = z.number().gt(0).max(99_999_999_999.999).multipleOf(0.001);
const Label = z.string().trim().min(1).max(80);
const Note = z.string().trim().max(500);

const CreateMeterBody = z.strictObject({
  kind: z.enum(METER_KINDS),
  unit: z.string().trim().min(1).max(12),
  label: Label.optional(),
  maxPerDay: PerDay.optional(),
});
const UpdateMeterBody = z.strictObject({
  label: Label.nullable().optional(),
  maxPerDay: PerDay.nullable().optional(),
  nudgeDays: z.number().int().min(7).max(365).nullable().optional(),
});
const ReplacedBody = z.strictObject({
  at: Iso,
  offset: z.string().regex(METER_OFFSET, 'the reading the meter carries on from, e.g. 150000'),
});
const CreateReadingBody = z.strictObject({
  id: z.uuid().optional(),
  value: Value,
  takenAt: Iso,
  note: Note.optional().transform((s) => (s === '' ? undefined : s)),
  confirmJump: z.literal(true).optional(),
  proofFileId: z.uuid().optional(),
});
const UpdateReadingBody = z.strictObject({
  value: Value.optional(),
  takenAt: Iso.optional(),
  note: Note.nullable()
    .optional()
    .transform((s) => (s === '' ? null : s)),
});
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(2048).optional(),
});
const SOURCES = ['manual', 'photo', 'fuel', 'service', 'import', 'home_assistant'] as const;
const ReadingQuery = ListQuery.extend({
  'f.when': z.string().max(40).optional(),
  'f.source': manyOf(z.enum(SOURCES)).optional(),
  'f.state': manyOf(z.enum(['accepted', 'needs_review'])).optional(),
  not: notOf(['when', 'source', 'state']).optional(),
  sort: z.literal('takenAt').optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

const MeterSchema = z.object({
  id: z.uuid(),
  thingId: z.uuid(),
  kind: z.string(),
  unit: z.string(),
  label: z.string().nullable(),
  latest: z.object({ value: z.string(), takenAt: z.string() }).nullable(),
  needsReview: z.number(),
  maxPerDay: z.number().nullable(),
  offset: z.string(),
  rowVersion: z.number(),
  nudgeDays: z.number().nullable(),
  estimate: EstimateSchema,
});
// `ai_read`: a reading AI read that fits, waiting for review all the same (D19; step 3).
const ReviewReason = z.enum([
  'lower_than_previous',
  'higher_than_next',
  'implausible_jump',
  'ai_read',
]);
const State = z.enum(['accepted', 'needs_review']);
const ReadingSchema = z.object({
  id: z.uuid(),
  value: z.string(),
  takenAt: z.string(),
  source: z.string(),
  state: State,
  reviewReason: ReviewReason.nullable(),
  loggedBy: z.object({ displayName: z.string() }),
  note: z.string().nullable(),
  rowVersion: z.number(),
  proof: ProofRefSchema.optional(),
  ownedBy: z.object({ type: z.enum(['fuel', 'service']), id: z.uuid() }).optional(),
});
const ReadingPage = z.object({ items: z.array(ReadingSchema), next_cursor: z.string().nullable() });
const CreateReadingResult = z.object({
  reading: ReadingSchema,
  state: State,
  reason: ReviewReason.optional(),
  undo: z.object({ eventId: z.uuid(), until: z.string() }).optional(),
});
const ProofPage = z.object({ items: z.array(ProofItemSchema), next_cursor: z.string().nullable() });
const ReplacedResult = z.object({
  event: z.object({ id: z.uuid(), at: z.string(), offset: z.string() }),
  meter: MeterSchema,
});

/** An If-Match the client may send (the web sends none for readings). */
function optionalIfMatch(req: FastifyRequest): number | null {
  return req.headers['if-match'] === undefined ? null : requireIfMatch(req);
}

export async function meterRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerReadingUndo();

  const write = <B>(
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    fn: (ctx: Ctx) => Promise<B>,
  ) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => ({
      status,
      body: await fn({ tx, client, scope, requestId: req.id, files: deps.files }),
    }));

  app.post(
    '/api/v1/things/:id/meters',
    { schema: { params: Params, body: CreateMeterBody, response: { 201: MeterSchema } } },
    (req, reply) =>
      write(req, reply, 201, (ctx) => createMeter(ctx, req.params.id.toLowerCase(), req.body)),
  );

  app.patch(
    '/api/v1/meters/:id',
    { schema: { params: Params, body: UpdateMeterBody, response: { 200: MeterSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        updateMeter(ctx, req.params.id.toLowerCase(), expected, req.body),
      );
    },
  );

  app.post(
    '/api/v1/meters/:id/replaced',
    { schema: { params: Params, body: ReplacedBody, response: { 201: ReplacedResult } } },
    (req, reply) => {
      const expected = optionalIfMatch(req);
      return write(req, reply, 201, (ctx) =>
        recordReplacement(ctx, req.params.id.toLowerCase(), req.body, expected),
      );
    },
  );

  app.get(
    '/api/v1/meters/:id/readings',
    { schema: { params: Params, querystring: ReadingQuery, response: { 200: ReadingPage } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        listReadings({ client, files: deps.files }, req.params.id.toLowerCase(), req.query),
      ),
  );

  app.get(
    '/api/v1/meters/:id/proofs',
    { schema: { params: Params, querystring: ListQuery, response: { 200: ProofPage } } },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const id = req.params.id.toLowerCase();
        const { rows } = await client.query<{ id: string; thing_id: string }>(
          `SELECT m.id, m.thing_id FROM public.meters m
             JOIN public.things t ON t.id = m.thing_id AND t.deleted_at IS NULL
            WHERE m.id = $1`,
          [id],
        );
        const meter = rows[0];
        if (!meter) throw notFound();
        return listProofs(client, deps.files, meter, req.query);
      }),
  );

  // A reading logged here is undoable for 7 days (D150; undo/registry.ts `reading.create`).
  app.post(
    '/api/v1/meters/:id/readings',
    {
      schema: { params: Params, body: CreateReadingBody, response: { 201: CreateReadingResult } },
    },
    (req, reply) =>
      write(req, reply, 201, (ctx) =>
        createReading(
          ctx,
          req.params.id.toLowerCase(),
          req.body,
          req.body.proofFileId ? 'photo' : 'manual',
          { undoable: true },
        ),
      ),
  );

  app.patch(
    '/api/v1/readings/:id',
    { schema: { params: Params, body: UpdateReadingBody, response: { 200: ReadingSchema } } },
    (req, reply) => {
      const expected = optionalIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        updateReading(ctx, req.params.id.toLowerCase(), req.body, expected),
      );
    },
  );

  app.delete('/api/v1/readings/:id', { schema: { params: Params } }, (req, reply) =>
    write(req, reply, 204, async (ctx) => {
      await deleteReading(ctx, req.params.id.toLowerCase(), { undoable: true });
      return undefined;
    }),
  );

  app.post(
    '/api/v1/readings/:id/accept',
    { schema: { params: Params, response: { 200: ReadingSchema } } },
    (req, reply) =>
      write(req, reply, 200, (ctx) => acceptReading(ctx, req.params.id.toLowerCase())),
  );
}
