import { SERVICE_LINE_KINDS } from '@kept/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { IDEMPOTENCY_HEADER, scopedRead, scopedWrite } from '../http/write.js';
import { METER_VALUE } from '../meters/check.js';
import type { Ctx } from '../schedules/service.js';
import { confirmService, serviceView } from '../schedules/services.js';
import { ServiceRecordSchema } from '../schedules/view.js';
import { createDraft, MAX_INVOICE_PAGES, registerDraftUndo } from './drafts.js';

// Step 5: service drafts from an invoice (Q12; plan T9), in the shapes of the web contract
// (apps/web/src/api/vehicles/{types,paths}.ts: ServiceRecordV5, CreateServiceDraftBody,
// ConfirmServiceBody). Only these routes live here; step 4's service-record routes (the list,
// POST, PATCH, DELETE) stay in schedules/routes.ts.
//
// POST /api/v1/service-records/drafts {id, subject: {thingId}|{placeId}, invoiceFileIds: [1–10]}
//        (`logs.add`; Idempotency-Key required)   → 201 {serviceRecord, extraction?: {id, status}}
//                                                    service_record.draft
// GET  /api/v1/service-records/:id                → ServiceRecord (step 4's, with step 5's fields)
// POST /api/v1/service-records/:id/confirm (If-Match) step 4's POST body without id and subject
//                                                 → 200 ServiceRecord; 409 `conflict` with
//        `reason` and the neighbour when the reading doesn't fit, nothing written (it stays a
//        draft); 409 `conflict` when it is no draft     service_record.confirm, undoable
//
// Service records are core (D113): no module gates these; `completes` needs Schedules on.

const Id = z.uuid();
const Params = z.object({ id: Id });
const Day = z.iso.date();
const Iso = z.iso.datetime({ offset: true });
const Value = z.string().regex(METER_VALUE, 'a reading of 0 or more, with at most 3 decimals');
const Amount = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'an amount, e.g. 1250.50');
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((c) => c.toUpperCase());
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

const DraftBody = z.strictObject({
  id: Id,
  subject: z.union([z.strictObject({ thingId: Id }), z.strictObject({ placeId: Id })]),
  invoiceFileIds: z.array(Id).min(1).max(MAX_INVOICE_PAGES),
});
const ConfirmBody = z.strictObject({
  servicedOn: Day,
  reading: z
    .strictObject({
      meterId: Id,
      value: Value,
      proofFileId: Id.optional(),
      takenAt: Iso.optional(),
    })
    .optional(),
  vendor: Vendor.optional(),
  total: Amount.optional(),
  currency: Currency.optional(),
  lines: z.array(Line).max(50).optional(),
  completes: z.array(Id).max(50).optional(),
  notes: z.string().trim().max(5000).optional(),
});
const DraftResult = z.object({
  serviceRecord: ServiceRecordSchema,
  extraction: z.object({ id: z.uuid(), status: z.string() }).optional(),
});

export async function serviceDraftRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerDraftUndo();

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

  app.post(
    '/api/v1/service-records/drafts',
    { schema: { body: DraftBody, response: { 201: DraftResult } } },
    (req, reply) => {
      if (!req.headers[IDEMPOTENCY_HEADER]) {
        throw invalid('Send an Idempotency-Key with a draft, so a retry is never a second one.');
      }
      return write(req, reply, 201, (ctx) => createDraft(ctx, req.body));
    },
  );

  app.get(
    '/api/v1/service-records/:id',
    { schema: { params: Params, response: { 200: ServiceRecordSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        serviceView(ctxOf(req, tx, client, scope), req.params.id.toLowerCase()),
      ),
  );

  app.post(
    '/api/v1/service-records/:id/confirm',
    { schema: { params: Params, body: ConfirmBody, response: { 200: ServiceRecordSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        confirmService(ctx, req.params.id.toLowerCase(), expected, req.body),
      );
    },
  );
}
