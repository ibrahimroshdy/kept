import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Scope, Tx } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import type { WriteCtx } from './account.js';
import {
  createItem,
  deleteItem,
  getContact,
  getItem,
  listAccounts,
  listItems,
  mergeItem,
  putContact,
  updateItem,
} from './service.js';
import {
  AccountsSchema,
  ContactBody,
  ContactSchema,
  CreateBody,
  CreateResult,
  ItemSchema,
  ListQuery,
  MergeBody,
  MergeResult,
  PageSchema,
  PatchBody,
  REGISTRY_KINDS,
} from './view.js';

// The account switcher and the account registries: brands, vendors, people and tags (T11; D11,
// D55, D76, D123, D177; plan Q5, Q15, Q21). Shapes: apps/web/src/api/inventory/types.ts.
//
// GET  /api/v1/accounts                                        → {accounts}
// GET  /api/v1/accounts/:accountId/{brands|vendors|people|tags}?q&limit&cursor
//                                                              → {items, next_cursor}
// POST /api/v1/accounts/:accountId/{kind}                      → 201 {item, possibleDuplicates}
// GET | PATCH (If-Match) | DELETE /api/v1/{kind}/:id
// POST /api/v1/{kind}/:id/merge-into {targetId}                → {repointed}
// GET | PUT /api/v1/people/:id/contact                         (D177: 404 unless visible)

const Id = z.object({ id: z.uuid() });
const AccountParams = z.object({ accountId: z.uuid() });

/** The context a registry or type write runs with. */
export function writeCtx(
  deps: InventoryDeps,
  req: FastifyRequest,
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
): WriteCtx {
  return {
    tx,
    client,
    userId: scope.userId,
    tokenId: scope.tokenId ?? null,
    requestId: req.id,
    jobs: deps.jobs,
  };
}

export async function registryRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get('/api/v1/accounts', { schema: { response: { 200: AccountsSchema } } }, async (req) => ({
    accounts: await scopedRead(pools, req, (_tx, client) => listAccounts(client)),
  }));

  for (const kind of REGISTRY_KINDS) {
    const item = ItemSchema[kind];

    app.get(
      `/api/v1/accounts/:accountId/${kind}`,
      {
        schema: {
          params: AccountParams,
          querystring: ListQuery,
          response: { 200: PageSchema(item) },
        },
      },
      (req) =>
        scopedRead(pools, req, (_tx, client) =>
          listItems(client, kind, req.params.accountId.toLowerCase(), req.query),
        ),
    );

    app.post(
      `/api/v1/accounts/:accountId/${kind}`,
      {
        schema: {
          params: AccountParams,
          body: CreateBody[kind],
          response: { 201: CreateResult(item) },
        },
      },
      (req, reply) =>
        scopedWrite(pools, req, reply, async (tx, client, scope) => ({
          status: 201,
          body: await createItem(
            writeCtx(deps, req, tx, client, scope),
            kind,
            req.params.accountId.toLowerCase(),
            req.body as Record<string, unknown>,
          ),
        })),
    );

    app.get(`/api/v1/${kind}/:id`, { schema: { params: Id, response: { 200: item } } }, (req) =>
      scopedRead(pools, req, (_tx, client) => getItem(client, kind, req.params.id.toLowerCase())),
    );

    app.patch(
      `/api/v1/${kind}/:id`,
      { schema: { params: Id, body: PatchBody[kind], response: { 200: item } } },
      (req, reply) => {
        const expected = requireIfMatch(req);
        return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
          status: 200,
          body: await updateItem(
            writeCtx(deps, req, tx, client, scope),
            kind,
            req.params.id.toLowerCase(),
            expected,
            req.body as Record<string, unknown>,
          ),
        }));
      },
    );

    app.delete(`/api/v1/${kind}/:id`, { schema: { params: Id } }, (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await deleteItem(writeCtx(deps, req, tx, client, scope), kind, req.params.id.toLowerCase());
        return { status: 204, body: undefined };
      }),
    );

    app.post(
      `/api/v1/${kind}/:id/merge-into`,
      { schema: { params: Id, body: MergeBody, response: { 200: MergeResult } } },
      (req, reply) =>
        scopedWrite(pools, req, reply, async (tx, client, scope) => ({
          status: 200,
          body: await mergeItem(
            writeCtx(deps, req, tx, client, scope),
            kind,
            req.params.id.toLowerCase(),
            req.body.targetId.toLowerCase(),
          ),
        })),
    );
  }

  app.get(
    '/api/v1/people/:id/contact',
    { schema: { params: Id, response: { 200: ContactSchema } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) => getContact(client, req.params.id.toLowerCase())),
  );

  app.put(
    '/api/v1/people/:id/contact',
    { schema: { params: Id, body: ContactBody, response: { 200: ContactSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await putContact(
          writeCtx(deps, req, tx, client, scope),
          req.params.id.toLowerCase(),
          req.body,
        ),
      })),
  );
}
