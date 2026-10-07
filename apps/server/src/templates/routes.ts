import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { writeCtx } from '../registries/routes.js';
import {
  AccountTemplateSchema,
  CreateTemplateBody,
  createTemplate,
  deleteTemplate,
  listAccount,
  listUsable,
  SaveAsTemplateBody,
  saveAsTemplate,
  TemplateSchema,
  UpdateTemplateBody,
  updateTemplate,
} from './service.js';

// Templates and quick add (plan T19; D76, D177, Q17). Shapes: apps/web/src/api/capture/types.ts
// "templates and quick add (T19)"; the rules are in service.ts. Quick add itself is `templateId`
// on POST /api/v1/things (things/routes.ts) and on a capture (capture/service.ts).
//
// GET    /api/v1/templates?locationId                  → {items: Template[]} (members and above)
// GET    /api/v1/accounts/:accountId/templates         → {items: AccountTemplate[]} (the ones the
//                                                        caller can change)
// POST   /api/v1/accounts/:accountId/templates         → 201 AccountTemplate
// PATCH  /api/v1/templates/:id (If-Match)              → AccountTemplate
// DELETE /api/v1/templates/:id                         → 204
// POST   /api/v1/things/:id/save-as-template           → 201 AccountTemplate

const Id = z.object({ id: z.uuid() });
const AccountParams = z.object({ accountId: z.uuid() });
const UsableQuery = z.object({ locationId: z.uuid() });

export async function templateRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/templates',
    {
      schema: {
        querystring: UsableQuery,
        response: { 200: z.object({ items: z.array(TemplateSchema) }) },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => ({
        items: await listUsable(client, req.query.locationId.toLowerCase()),
      })),
  );

  app.get(
    '/api/v1/accounts/:accountId/templates',
    {
      schema: {
        params: AccountParams,
        response: { 200: z.object({ items: z.array(AccountTemplateSchema) }) },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => ({
        items: await listAccount(client, req.params.accountId.toLowerCase()),
      })),
  );

  app.post(
    '/api/v1/accounts/:accountId/templates',
    {
      schema: {
        params: AccountParams,
        body: CreateTemplateBody,
        response: { 201: AccountTemplateSchema },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createTemplate(
          writeCtx(deps, req, tx, client, scope),
          req.params.accountId.toLowerCase(),
          req.body,
        ),
      })),
  );

  app.patch(
    '/api/v1/templates/:id',
    { schema: { params: Id, body: UpdateTemplateBody, response: { 200: AccountTemplateSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateTemplate(
          writeCtx(deps, req, tx, client, scope),
          req.params.id.toLowerCase(),
          expected,
          req.body,
        ),
      }));
    },
  );

  app.delete('/api/v1/templates/:id', { schema: { params: Id } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteTemplate(writeCtx(deps, req, tx, client, scope), req.params.id.toLowerCase());
      return { status: 204, body: undefined };
    }),
  );

  app.post(
    '/api/v1/things/:id/save-as-template',
    {
      schema: { params: Id, body: SaveAsTemplateBody, response: { 201: AccountTemplateSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await saveAsTemplate(
          writeCtx(deps, req, tx, client, scope),
          req.params.id.toLowerCase(),
          req.body,
        ),
      })),
  );
}
