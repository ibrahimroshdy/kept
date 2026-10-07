import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import { locationOfThing } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { locationOfRow } from '../money/input.js';
import { claimPrefill, createClaim, deleteClaim, listClaims, updateClaim } from './claims.js';
import { logoRoutes } from './logo.js';
import {
  type Ctx,
  createWarranty,
  defaultsFor,
  deleteWarranty,
  listWarranties,
  updateWarranty,
} from './service.js';
import { registerWarrantyUndo } from './undo.js';
import {
  ClaimPrefillSchema,
  ClaimSchema,
  ClaimsSchema,
  CreateClaimBody,
  CreateWarrantyBody,
  UpdateClaimBody,
  UpdateWarrantyBody,
  WarrantiesSchema,
  WarrantyDefaultsSchema,
  WarrantySchema,
} from './view.js';

// Warranties and claims (step-4 plan T9; D53–D55, D158, D195; Q18, Q26, Q27). Shapes:
// apps/web/src/api/household/types.ts, "warranties and claims". Module `warranties` throughout.
//
// GET    /api/v1/things/:id/warranties          → {items, coverage}
// GET    /api/v1/things/:id/warranty-defaults   → {termMonths, from, startsOn}
// POST   /api/v1/things/:id/warranties          → 201 Warranty (409 quantity_not_one)
// PATCH  /api/v1/warranties/:id (If-Match)      → Warranty
// DELETE /api/v1/warranties/:id (If-Match)      → 204
// GET    /api/v1/things/:id/claims              → {items}
// GET    /api/v1/things/:id/claim-prefill       → {warrantyId, claimUrl, supportPhone, claimContact}
// POST   /api/v1/things/:id/claims              → 201 Claim (409 thing_in_repair)
// PATCH  /api/v1/claims/:id (If-Match)          → Claim (409 invalid_transition)
// DELETE /api/v1/claims/:id (If-Match)          → 204
//
// Brand logos (PUT, GET and DELETE /api/v1/brands/:id/logo) are logo.ts's, registered below: an
// account-owned PNG in brand_logos (0057, 0058).

const Id = z.object({ id: z.uuid() });

export async function warrantyRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools, files } = deps;
  registerWarrantyUndo();
  await logoRoutes(app, deps);
  const ctxOf = (req: FastifyRequest, tx: Tx, client: pg.ClientBase, scope: Scope): Ctx => ({
    tx,
    client,
    scope,
    requestId: req.id,
    files,
  });
  const onThing = { module: 'warranties' as const, moduleLocation: locationOfThing(pools) };
  const onWarranty = {
    module: 'warranties' as const,
    moduleLocation: locationOfRow(pools, 'warranties'),
  };
  const onClaim = { module: 'warranties' as const, moduleLocation: locationOfRow(pools, 'claims') };

  // --- warranties ----------------------------------------------------------------------------
  app.get(
    '/api/v1/things/:id/warranties',
    { config: onThing, schema: { params: Id, response: { 200: WarrantiesSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        listWarranties(tx, client, scope, files, req.params.id.toLowerCase()),
      ),
  );

  app.get(
    '/api/v1/things/:id/warranty-defaults',
    { config: onThing, schema: { params: Id, response: { 200: WarrantyDefaultsSchema } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) => defaultsFor(client, req.params.id.toLowerCase())),
  );

  app.post(
    '/api/v1/things/:id/warranties',
    {
      config: onThing,
      schema: { params: Id, body: CreateWarrantyBody, response: { 201: WarrantySchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createWarranty(
          ctxOf(req, tx, client, scope),
          req.params.id.toLowerCase(),
          req.body,
        ),
      })),
  );

  app.patch(
    '/api/v1/warranties/:id',
    {
      config: onWarranty,
      schema: { params: Id, body: UpdateWarrantyBody, response: { 200: WarrantySchema } },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateWarranty(
          ctxOf(req, tx, client, scope),
          req.params.id.toLowerCase(),
          expected,
          req.body,
        ),
      }));
    },
  );

  app.delete(
    '/api/v1/warranties/:id',
    { config: onWarranty, schema: { params: Id } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await deleteWarranty(ctxOf(req, tx, client, scope), req.params.id.toLowerCase(), expected);
        return { status: 204, body: undefined };
      });
    },
  );

  // --- claims --------------------------------------------------------------------------------
  app.get(
    '/api/v1/things/:id/claims',
    { config: onThing, schema: { params: Id, response: { 200: ClaimsSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        listClaims({ tx, client, scope, files }, req.params.id.toLowerCase()),
      ),
  );

  app.get(
    '/api/v1/things/:id/claim-prefill',
    { config: onThing, schema: { params: Id, response: { 200: ClaimPrefillSchema } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) => claimPrefill(client, req.params.id.toLowerCase())),
  );

  app.post(
    '/api/v1/things/:id/claims',
    {
      config: onThing,
      schema: { params: Id, body: CreateClaimBody, response: { 201: ClaimSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createClaim(
          ctxOf(req, tx, client, scope),
          req.params.id.toLowerCase(),
          req.body,
        ),
      })),
  );

  app.patch(
    '/api/v1/claims/:id',
    {
      config: onClaim,
      schema: { params: Id, body: UpdateClaimBody, response: { 200: ClaimSchema } },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateClaim(
          ctxOf(req, tx, client, scope),
          req.params.id.toLowerCase(),
          expected,
          req.body,
        ),
      }));
    },
  );

  app.delete('/api/v1/claims/:id', { config: onClaim, schema: { params: Id } }, (req, reply) => {
    const expected = requireIfMatch(req);
    return scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteClaim(ctxOf(req, tx, client, scope), req.params.id.toLowerCase(), expected);
      return { status: 204, body: undefined };
    });
  });
}
