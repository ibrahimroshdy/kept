import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  createPurchase,
  ctxOf,
  deletePurchase,
  getPurchase,
  linkLine,
  unlinkLine,
  updatePurchase,
} from './service.js';
import { CreateBody, LinkBody, PatchBody, PurchaseViewSchema, UnlinkQuery } from './view.js';

// Purchases and their lines (T12; D13, D115, D136, D168, D189). Shapes: the web contract's
// "currencies and purchases" section (apps/web/src/api/inventory/types.ts, paths.ts).
//
// POST   /api/v1/purchases                    → 201 PurchaseView
// GET    /api/v1/purchases/:id                → PurchaseView (money gated, serialize/gates.ts)
// PATCH  /api/v1/purchases/:id (If-Match)     → PurchaseView
// DELETE /api/v1/purchases/:id                → 204 (lines and receipts cascade; links cleared)
// POST   /api/v1/purchase-lines/:id/link      {thingId} → PurchaseView (If-Match: the thing's,
//                                              optional)
// DELETE /api/v1/purchase-lines/:id/link      ?thingId → 204 (one thing, or every thing of it)
//
// Purchases are core, not a module: with the money module off they still carry date, vendor,
// notes and lines; their amounts are withheld, and so are their receipts and invoices, which show
// the amounts (D13, §7.1; security review #10). The same holds for a viewer where viewers don't
// see money.

const Id = z.object({ id: z.uuid() });

export async function purchaseRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools, files } = deps;

  app.post(
    '/api/v1/purchases',
    { schema: { body: CreateBody, response: { 201: PurchaseViewSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createPurchase(ctxOf(req, tx, client, scope, files), req.body),
      })),
  );

  app.get(
    '/api/v1/purchases/:id',
    { schema: { params: Id, response: { 200: PurchaseViewSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        getPurchase(tx, client, scope, files, req.params.id.toLowerCase()),
      ),
  );

  app.patch(
    '/api/v1/purchases/:id',
    { schema: { params: Id, body: PatchBody, response: { 200: PurchaseViewSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updatePurchase(
          ctxOf(req, tx, client, scope, files),
          req.params.id.toLowerCase(),
          expected,
          req.body,
        ),
      }));
    },
  );

  app.delete('/api/v1/purchases/:id', { schema: { params: Id } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deletePurchase(ctxOf(req, tx, client, scope, files), req.params.id.toLowerCase());
      return { status: 204, body: undefined };
    }),
  );

  app.post(
    '/api/v1/purchase-lines/:id/link',
    { schema: { params: Id, body: LinkBody, response: { 200: PurchaseViewSchema } } },
    (req, reply) => {
      // The thing's row_version, when the client sends one (the link changes the thing).
      const raw = req.headers['if-match'];
      const expected = raw === undefined || raw === '' ? null : requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await linkLine(
          ctxOf(req, tx, client, scope, files),
          req.params.id.toLowerCase(),
          req.body.thingId.toLowerCase(),
          expected,
        ),
      }));
    },
  );

  app.delete(
    '/api/v1/purchase-lines/:id/link',
    { schema: { params: Id, querystring: UnlinkQuery } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await unlinkLine(
          ctxOf(req, tx, client, scope, files),
          req.params.id.toLowerCase(),
          req.query.thingId?.toLowerCase(),
        );
        return { status: 204, body: undefined };
      }),
  );
}
