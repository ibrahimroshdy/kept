import { STOCK_MIN_MAX } from '@kept/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { PAGE_DEFAULT, PAGE_MAX, requireIfMatch } from '../http/conventions.js';
import { locationOfThing } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { ThingRowSchema } from '../things/view.js';
import {
  adjustStock,
  type Ctx,
  deleteStockRule,
  getStockRule,
  listConsumables,
  putStockRule,
} from './service.js';
import { registerConsumablesUndo } from './undo.js';

// Consumables (step-7 plan T17; D14, D183; Q19), module `consumables`, in the shapes of the web
// contract (apps/web/src/api/portability/{types,paths}.ts):
//
// GET    /api/v1/consumables?locationId*&state=low|all&placeId&cursor&limit
//                                        → {items: [{thing, minQuantity, low}], next_cursor}
// GET    /api/v1/things/:id/stock-rule  → StockRule, 404 when the thing keeps no minimum
// PUT    /api/v1/things/:id/stock-rule  (If-Match when it exists) {minQuantity} → StockRule
//                                        409 not_consumable; thing.stock_rule, undoable
// DELETE /api/v1/things/:id/stock-rule  (If-Match) → 204; thing.stock_rule, undoable
// POST   /api/v1/things/:id/adjust      (If-Match: the thing's) {delta} | {quantity} → ThingRow
//                                        thing.update, undoable
//
// Consumables off: a read is 404 `module_off`, a write 409 (http/modules.ts). Writers are members
// and above (`things.edit`); a viewer reads.

const Id = z.uuid();
const Params = z.object({ id: Id });
const Amount = z.number().finite().multipleOf(0.001);

const ListQuery = z.object({
  locationId: Id,
  state: z.enum(['low', 'all']).optional(),
  placeId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: z.string().max(2048).optional(),
});
const PutBody = z.strictObject({ minQuantity: Amount.gt(0).max(STOCK_MIN_MAX) });
const AdjustBody = z.union([
  z.strictObject({ delta: Amount.refine((n) => n !== 0, 'not 0') }),
  z.strictObject({ quantity: Amount.min(0).max(999_999_999) }),
]);

const StockRuleSchema = z.object({
  thingId: z.uuid(),
  locationId: z.uuid(),
  minQuantity: z.number(),
  updatedAt: z.string(),
  rowVersion: z.number().int(),
});
const ConsumablesPage = z.object({
  items: z.array(z.object({ thing: ThingRowSchema, minQuantity: z.number(), low: z.boolean() })),
  next_cursor: z.string().nullable(),
});

export async function consumableRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerConsumablesUndo();
  const byThing = { module: 'consumables' as const, moduleLocation: locationOfThing(pools) };

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
  const lower = (id: string) => id.toLowerCase();

  app.get(
    '/api/v1/consumables',
    {
      config: { module: 'consumables' },
      schema: { querystring: ListQuery, response: { 200: ConsumablesPage } },
    },
    (req) => read(req, (ctx) => listConsumables(ctx, req.query)),
  );

  app.get(
    '/api/v1/things/:id/stock-rule',
    { config: byThing, schema: { params: Params, response: { 200: StockRuleSchema } } },
    (req) => read(req, (ctx) => getStockRule(ctx, lower(req.params.id))),
  );

  app.put(
    '/api/v1/things/:id/stock-rule',
    {
      config: byThing,
      schema: { params: Params, body: PutBody, response: { 200: StockRuleSchema } },
    },
    (req, reply) => {
      // If-Match only when the rule exists; the service asks for it then (428).
      const expected = req.headers['if-match'] ? requireIfMatch(req) : undefined;
      return write(req, reply, 200, (ctx) =>
        putStockRule(ctx, lower(req.params.id), expected, req.body.minQuantity),
      );
    },
  );

  app.delete(
    '/api/v1/things/:id/stock-rule',
    { config: byThing, schema: { params: Params } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 204, async (ctx) => {
        await deleteStockRule(ctx, lower(req.params.id), expected);
        return undefined;
      });
    },
  );

  app.post(
    '/api/v1/things/:id/adjust',
    {
      config: byThing,
      schema: { params: Params, body: AdjustBody, response: { 200: ThingRowSchema } },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        adjustStock(ctx, lower(req.params.id), expected, req.body),
      );
    },
  );
}
