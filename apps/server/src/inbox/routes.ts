import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { paginate, requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { BulkBody, BulkResultSchema, bulk, registerInboxUndo } from './bulk.js';
import {
  CandidatesQuery,
  CandidatesSchema,
  candidates,
  confirmReceipt,
  ReceiptBody,
} from './receipt.js';
import {
  AcceptBody,
  accept,
  type Ctx,
  CurrencyBody,
  discard,
  dismiss,
  MergeBody,
  merge,
  notDuplicate,
  ReadingBody,
  reading,
  restore,
  setCurrency,
} from './service.js';
import { InboxItemSchema, InboxPageSchema, InboxQuery, listInbox } from './view.js';

// The "To review" inbox (plan T15; D18, D19, D36, D175, D191). The web contract is
// apps/web/src/api/capture/{paths,types}.ts, "inbox (T15)"; the mock it started on is
// apps/web/src/api/capture/mock/inbox.ts.
//
// GET  /api/v1/inbox?locationId&mine&kind&batchId&q&cursor&limit → InboxPage          (view.ts)
// POST /api/v1/inbox/bulk {ids, action, typeId?, to?, tagIds?}   → {results, undo?}   (bulk.ts)
// GET  /api/v1/inbox/:id/candidates?line                         → {things}           (receipt.ts)
// POST /api/v1/inbox/:id/accept {accept?, reject?, set?}         → {}                 (service.ts)
// POST /api/v1/inbox/:id/receipt {vendor, purchasedOn, currency, total?, tax?, lines}
//                                                                → {}                 (receipt.ts)
// POST /api/v1/inbox/:id/currency {currency}                     → {} ({item} on a receipt)
// POST /api/v1/inbox/:id/merge {into}                            → {}
// POST /api/v1/inbox/:id/not-duplicate                           → {}
// POST /api/v1/inbox/:id/reading {action, value?, takenAt?, offset?} → {} ({item} still waiting)
// POST /api/v1/inbox/:id/restore                                 → {outcome}
// POST /api/v1/inbox/:id/dismiss                                 → {}
// POST /api/v1/inbox/:id/discard                                 → {undo?}
//
// Every POST on an item takes the item's `rowVersion` as If-Match. An undoable write answers
// X-Kept-Audit-Event (http/write.ts, §7.7): a bulk action's `inbox.bulk` event (one per location
// it spans), a discard's `thing.trash`, an accept's `thing.update`.

const Params = z.object({ id: z.uuid() });
const ActionResult = z.object({
  item: InboxItemSchema.optional(),
  undo: z.object({ eventId: z.uuid(), until: z.string() }).optional(),
});
const RestoreResult = z.object({ outcome: z.enum(['applied', 'needs_review', 'dropped']) });
const Empty = z.object({}).optional();

/** The "To review" inbox (T15). Registered by http/routes.ts; add routes here, never there. */
export async function inboxRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerInboxUndo();

  app.get(
    '/api/v1/inbox',
    { schema: { querystring: InboxQuery, response: { 200: InboxPageSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        listInbox(tx, client, scope, deps.files, req.query, paginate(req.query)),
      ),
  );

  app.post(
    '/api/v1/inbox/bulk',
    { schema: { body: BulkBody, response: { 200: BulkResultSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await bulk(
          { tx, client, scope, requestId: req.id, jobs: deps.jobs, files: deps.files },
          req.body,
        ),
      })),
  );

  app.get(
    '/api/v1/inbox/:id/candidates',
    {
      schema: { params: Params, querystring: CandidatesQuery, response: { 200: CandidatesSchema } },
    },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        candidates(
          { tx, client, scope, requestId: req.id, jobs: deps.jobs, files: deps.files },
          req.params.id.toLowerCase(),
          req.query.line,
        ),
      ),
  );

  /** One POST action on an item: If-Match, then `fn` in the caller's transaction. */
  const act = <R>(
    req: FastifyRequest,
    reply: FastifyReply,
    fn: (ctx: Ctx, id: string, expected: number) => Promise<R>,
  ): Promise<R> => {
    const expected = requireIfMatch(req);
    const id = (req.params as { id: string }).id.toLowerCase();
    return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
      status: 200,
      body: await fn(
        { tx, client, scope, requestId: req.id, jobs: deps.jobs, files: deps.files },
        id,
        expected,
      ),
    }));
  };
  const item = (body: z.ZodType, response: z.ZodType = ActionResult) => ({
    schema: { params: Params, body, response: { 200: response } },
  });

  app.post('/api/v1/inbox/:id/accept', item(AcceptBody.optional()), (req, reply) =>
    act(req, reply, (ctx, id, v) => accept(ctx, id, v, (req.body as AcceptBody | undefined) ?? {})),
  );
  app.post('/api/v1/inbox/:id/receipt', item(ReceiptBody), (req, reply) =>
    act(req, reply, (ctx, id, v) => confirmReceipt(ctx, id, v, req.body as ReceiptBody)),
  );
  app.post('/api/v1/inbox/:id/currency', item(CurrencyBody), (req, reply) =>
    act(req, reply, (ctx, id, v) =>
      setCurrency(ctx, id, v, req.body as z.infer<typeof CurrencyBody>),
    ),
  );
  app.post('/api/v1/inbox/:id/merge', item(MergeBody), (req, reply) =>
    act(req, reply, (ctx, id, v) => merge(ctx, id, v, req.body as z.infer<typeof MergeBody>)),
  );
  app.post('/api/v1/inbox/:id/not-duplicate', item(Empty), (req, reply) =>
    act(req, reply, notDuplicate),
  );
  app.post('/api/v1/inbox/:id/reading', item(ReadingBody), (req, reply) =>
    act(req, reply, (ctx, id, v) => reading(ctx, id, v, req.body as ReadingBody)),
  );
  app.post('/api/v1/inbox/:id/restore', item(Empty, RestoreResult), (req, reply) =>
    act(req, reply, restore),
  );
  app.post('/api/v1/inbox/:id/dismiss', item(Empty), (req, reply) => act(req, reply, dismiss));
  app.post('/api/v1/inbox/:id/discard', item(Empty), (req, reply) => act(req, reply, discard));
}
