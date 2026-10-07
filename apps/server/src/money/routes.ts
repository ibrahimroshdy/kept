import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import { locationOfThing } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { deleteRate, type FxCtx, listRates, putRate } from './fx.js';
import { locationOfRow } from './input.js';
import { registerMoneyUndo } from './undo.js';
import {
  createValuation,
  deleteValuation,
  listValuations,
  updateValuation,
  type ValCtx,
} from './valuations.js';
import {
  CreateValuationBody,
  FxAccountParams,
  FxKeyParams,
  FxListQuery,
  FxRateSchema,
  FxRatesSchema,
  PutFxRateBody,
  UpdateValuationBody,
  ValuationSchema,
  ValuationsSchema,
} from './view.js';

// Money: exchange rates, valuations and the current value (step-4 plan T8; D14, D76, D136, D158,
// Q21, Q22). Shapes: apps/web/src/api/household/types.ts, "money: exchange rates and valuations".
//
// GET    /api/v1/accounts/:accountId/fx-rates?from&to              → {items: FxRate[]}
// PUT    /api/v1/accounts/:accountId/fx-rates (If-Match to replace) → FxRate
// DELETE /api/v1/accounts/:accountId/fx-rates/:from/:to/:validFrom (If-Match) → 204
// GET    /api/v1/things/:id/valuations                              → {items, current}
// POST   /api/v1/things/:id/valuations                              → 201 Valuation
// PATCH  /api/v1/valuations/:id (If-Match)                          → Valuation
// DELETE /api/v1/valuations/:id (If-Match)                          → 204
//
// Rates are the account's, not a location's: no module gate (a location's Money module decides
// where amounts show, not whether its account keeps rates). Valuations are module `money`. The
// thing view's `currentValue` is things/view.ts's, through valuations.ts currentValueOf().

const Id = z.object({ id: z.uuid() });

const fxCtx = (req: FastifyRequest, tx: Tx, client: pg.ClientBase, scope: Scope): FxCtx => ({
  tx,
  client,
  scope,
  requestId: req.id,
});

export async function moneyRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools, files } = deps;
  registerMoneyUndo();
  const valCtx = (req: FastifyRequest, tx: Tx, client: pg.ClientBase, scope: Scope): ValCtx => ({
    tx,
    client,
    scope,
    requestId: req.id,
    files,
  });
  const thingMoney = { module: 'money' as const, moduleLocation: locationOfThing(pools) };
  const valuationMoney = {
    module: 'money' as const,
    moduleLocation: locationOfRow(pools, 'valuations'),
  };

  // --- exchange rates ------------------------------------------------------------------------
  app.get(
    '/api/v1/accounts/:accountId/fx-rates',
    {
      schema: {
        params: FxAccountParams,
        querystring: FxListQuery,
        response: { 200: FxRatesSchema },
      },
    },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        listRates(client, req.params.accountId.toLowerCase(), req.query),
      ),
  );

  app.put(
    '/api/v1/accounts/:accountId/fx-rates',
    { schema: { params: FxAccountParams, body: PutFxRateBody, response: { 200: FxRateSchema } } },
    (req, reply) => {
      // Only a replace needs it (putRate() says so with a 428); a new rate has no version yet.
      const raw = req.headers['if-match'];
      const expected = raw === undefined || raw === '' ? null : requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await putRate(
          fxCtx(req, tx, client, scope),
          req.params.accountId.toLowerCase(),
          req.body,
          expected,
        ),
      }));
    },
  );

  app.delete(
    '/api/v1/accounts/:accountId/fx-rates/:from/:to/:validFrom',
    { schema: { params: FxKeyParams } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await deleteRate(
          fxCtx(req, tx, client, scope),
          {
            accountId: req.params.accountId.toLowerCase(),
            from: req.params.from,
            to: req.params.to,
            validFrom: req.params.validFrom,
          },
          expected,
        );
        return { status: 204, body: undefined };
      });
    },
  );

  // --- valuations ----------------------------------------------------------------------------
  app.get(
    '/api/v1/things/:id/valuations',
    { config: thingMoney, schema: { params: Id, response: { 200: ValuationsSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        listValuations(tx, client, scope, files, req.params.id.toLowerCase()),
      ),
  );

  app.post(
    '/api/v1/things/:id/valuations',
    {
      config: thingMoney,
      schema: { params: Id, body: CreateValuationBody, response: { 201: ValuationSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createValuation(
          valCtx(req, tx, client, scope),
          req.params.id.toLowerCase(),
          req.body,
        ),
      })),
  );

  app.patch(
    '/api/v1/valuations/:id',
    {
      config: valuationMoney,
      schema: { params: Id, body: UpdateValuationBody, response: { 200: ValuationSchema } },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateValuation(
          valCtx(req, tx, client, scope),
          req.params.id.toLowerCase(),
          expected,
          req.body,
        ),
      }));
    },
  );

  app.delete(
    '/api/v1/valuations/:id',
    { config: valuationMoney, schema: { params: Id } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await deleteValuation(
          valCtx(req, tx, client, scope),
          req.params.id.toLowerCase(),
          expected,
        );
        return { status: 204, body: undefined };
      });
    },
  );
}
