import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { TrashBody } from '../places/service.js';
import {
  type Ctx,
  deleteThing,
  listTrash,
  restoreThing,
  TrashPageSchema,
  TrashQuery,
  trashThing,
} from './service.js';

// Trash (T21; D45, D162), in the shapes of the web contract (apps/web/src/api/inventory/types.ts
// TrashBody, TrashResult, RestoreResult, TrashItem):
//
// POST   /api/v1/things/:id/trash    {contents?: 'move'|'trash', moveTo?} → TrashResult, or 409
//                                    contents_choice_required with {counts} (members and above)
// POST   /api/v1/things/:id/restore  → {restored, hint?} (members and above; the whole batch)
// DELETE /api/v1/things/:id          → 204 (owners and admins; trashed things only)
// GET    /api/v1/trash?locationId*&kind*&deletedById*&not*&from&to&q&limit&cursor
//                                    → {items: TrashItem[], next_cursor}; `*`: repeatable, "is
//                                    any of"; `not` names those that are "is none of" (D205)
//
// Places have their own trash, restore and delete routes (places/routes.ts).

const Params = z.object({ id: z.uuid() });

const TrashResultSchema = z.object({
  trashed: z.array(z.uuid()),
  moved: z.array(z.uuid()),
  trashBatchId: z.uuid(),
});
const RestoreResultSchema = z.object({ restored: z.array(z.uuid()), hint: z.string().optional() });

export async function trashRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools, jobs } = deps;

  const write = <B>(
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    fn: (c: Ctx) => Promise<B>,
  ) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => ({
      status,
      body: await fn({ tx, client, scope, requestId: req.id, jobs }),
    }));

  app.post(
    '/api/v1/things/:id/trash',
    { schema: { params: Params, body: TrashBody, response: { 200: TrashResultSchema } } },
    (req, reply) =>
      write(req, reply, 200, (c) => trashThing(c, req.params.id.toLowerCase(), req.body)),
  );

  app.post(
    '/api/v1/things/:id/restore',
    { schema: { params: Params, response: { 200: RestoreResultSchema } } },
    (req, reply) => write(req, reply, 200, (c) => restoreThing(c, req.params.id.toLowerCase())),
  );

  app.delete('/api/v1/things/:id', { schema: { params: Params } }, (req, reply) =>
    write(req, reply, 204, async (c) => {
      await deleteThing(c, req.params.id.toLowerCase());
      return undefined;
    }),
  );

  app.get(
    '/api/v1/trash',
    { schema: { querystring: TrashQuery, response: { 200: TrashPageSchema } } },
    (req) => scopedRead(pools, req, (_tx, client) => listTrash(client, req.query)),
  );
}
