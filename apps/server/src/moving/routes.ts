import { BOX_STATES, MOVE_STATUSES } from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Pools } from '../db/pools.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { paginate, requireIfMatch } from '../http/conventions.js';
import { locationModuleSet } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import type { Ctx } from '../things/service.js';
import {
  AddBoxBody,
  addBox,
  boxOfContainer,
  CreateMoveBody,
  createMove,
  deleteMove,
  listMoves,
  MovesQuery,
  moveView,
  registerMovingUndo,
  removeBox,
  UnpackBody,
  UpdateBoxBody,
  UpdateMoveBody,
  unpackBox,
  updateBox,
  updateMove,
} from './service.js';

// Moving mode (1.x, D39 (5), D251): the routes. moving/service.ts says who may do what; the web
// contract is apps/web/src/api/moving/types.ts. Every route but the list is in the Moving mode
// module of the move's location (404 `module_off` to read, 409 to write); the list leaves out
// moves of locations where it is off. The contents sheets are a report run
// (POST /api/v1/reports/move, reports/routes.ts). Offline, the phone sends the `move_box` op
// (sync/handlers/move-box.ts) and packs with the ordinary `move` op.

const Params = z.object({ id: z.uuid() });
const BoxParams = z.object({ id: z.uuid(), containerId: z.uuid() });
const ContainerParams = z.object({ containerId: z.uuid() });

const Person = z.object({ displayName: z.string() });
const Counts = z.object({
  packed: z.number().int(),
  in_transit: z.number().int(),
  unpacked: z.number().int(),
  total: z.number().int(),
});

const RowSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  toLocationId: z.uuid().nullable(),
  toLocationName: z.string().nullable(),
  name: z.string(),
  status: z.enum(MOVE_STATUSES),
  createdBy: Person,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: Counts,
  rowVersion: z.number().int(),
});

const BoxSchema = z.object({
  moveId: z.uuid(),
  containerId: z.uuid(),
  number: z.number().int(),
  state: z.enum(BOX_STATES),
  stateAt: z.string(),
  stateBy: Person.nullable(),
  visible: z.boolean(),
  name: z.string().nullable(),
  shortCode: z.string().nullable(),
  locationId: z.uuid().nullable(),
  placeId: z.uuid().nullable(),
  where: z.string().nullable(),
  contents: z.number().int(),
  destination: z.object({ placeId: z.uuid(), name: z.string(), locationId: z.uuid() }).nullable(),
  rowVersion: z.number().int(),
});

const MoveSchema = RowSchema.extend({ boxes: z.array(BoxSchema) });

const Page = z.object({ items: z.array(RowSchema), next_cursor: z.string().nullable() });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The location of the move a request names (`params.id`, or `body.moveId`), as the caller sees
 * it: the module gate's resolver. Null for a move they can't see (a plain 404). */
export function locationOfMove(
  pools: Pick<Pools, 'app'>,
  pick: (req: FastifyRequest) => unknown = (req) => (req.params as { id?: unknown })?.id,
) {
  return async (req: FastifyRequest): Promise<string | null> => {
    const id = pick(req);
    if (!req.scope || typeof id !== 'string' || !UUID.test(id)) return null;
    return withScope(pools.app, req.scope, async (_tx, c) => {
      const { rows } = await c.query<{ location_id: string }>(
        'SELECT location_id FROM public.moves WHERE id = $1',
        [id.toLowerCase()],
      );
      return rows[0]?.location_id ?? null;
    });
  };
}

/** The location of the move a container is a box of (an open move first). */
function locationOfBox(pools: Pick<Pools, 'app'>) {
  return async (req: FastifyRequest): Promise<string | null> => {
    const id = (req.params as { containerId?: unknown })?.containerId;
    if (!req.scope || typeof id !== 'string' || !UUID.test(id)) return null;
    return withScope(pools.app, req.scope, async (_tx, c) => {
      const { rows } = await c.query<{ location_id: string }>(
        `SELECT b.location_id FROM public.move_boxes b JOIN public.moves m ON m.id = b.move_id
          WHERE b.container_id = $1 ORDER BY m.status = 'active' DESC, m.created_at DESC LIMIT 1`,
        [id.toLowerCase()],
      );
      return rows[0]?.location_id ?? null;
    });
  };
}

export async function movingRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerMovingUndo();
  const ctxOf = (
    tx: Ctx['tx'],
    client: Ctx['client'],
    scope: Ctx['scope'],
    requestId: string,
  ): Ctx => ({ tx, client, scope, requestId, jobs: deps.jobs, files: deps.files });
  const byMove = { module: 'moving' as const, moduleLocation: locationOfMove(pools) };

  app.get(
    '/api/v1/moves',
    { schema: { querystring: MovesQuery, response: { 200: Page } } },
    (req) =>
      scopedRead(pools, req, async (tx, client) => {
        const page = await listMoves(client, req.query, paginate(req.query).after);
        // Moves of a location where Moving mode is off stay out of sight (D61).
        const on = new Map<string, boolean>();
        for (const id of new Set(page.items.map((m) => m.locationId))) {
          on.set(id, (await locationModuleSet(tx, id))?.has('moving') === true);
        }
        return { ...page, items: page.items.filter((m) => on.get(m.locationId)) };
      }),
  );

  app.get(
    '/api/v1/moves/:id',
    { config: byMove, schema: { params: Params, response: { 200: MoveSchema } } },
    (req) => scopedRead(pools, req, (_tx, client) => moveView(client, req.params.id)),
  );

  app.get(
    '/api/v1/move-boxes/:containerId',
    {
      config: { module: 'moving', moduleLocation: locationOfBox(pools) },
      schema: {
        params: ContainerParams,
        response: {
          200: BoxSchema.extend({
            move: z.object({ id: z.uuid(), name: z.string(), status: z.enum(MOVE_STATUSES) }),
          }),
        },
      },
    },
    (req) =>
      scopedRead(pools, req, (_tx, client) => boxOfContainer(client, req.params.containerId)),
  );

  app.post(
    '/api/v1/locations/:id/moves',
    {
      config: {
        module: 'moving',
        moduleLocation: (req) => (req.params as { id?: string }).id ?? null,
      },
      schema: { params: Params, body: CreateMoveBody, response: { 201: MoveSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createMove(ctxOf(tx, client, scope, req.id), req.params.id, req.body),
      })),
  );

  app.patch(
    '/api/v1/moves/:id',
    {
      config: byMove,
      schema: { params: Params, body: UpdateMoveBody, response: { 200: MoveSchema } },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateMove(ctxOf(tx, client, scope, req.id), req.params.id, expected, req.body),
      }));
    },
  );

  app.delete('/api/v1/moves/:id', { config: byMove, schema: { params: Params } }, (req, reply) => {
    const expected = requireIfMatch(req);
    return scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteMove(ctxOf(tx, client, scope, req.id), req.params.id, expected);
      return { status: 204, body: undefined };
    });
  });

  app.post(
    '/api/v1/moves/:id/boxes',
    { config: byMove, schema: { params: Params, body: AddBoxBody, response: { 201: BoxSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await addBox(ctxOf(tx, client, scope, req.id), req.params.id, req.body),
      })),
  );

  app.patch(
    '/api/v1/moves/:id/boxes/:containerId',
    {
      config: byMove,
      schema: { params: BoxParams, body: UpdateBoxBody, response: { 200: BoxSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: (
          await updateBox(
            ctxOf(tx, client, scope, req.id),
            req.params.id,
            req.params.containerId,
            req.body,
          )
        ).box,
      })),
  );

  app.post(
    '/api/v1/moves/:id/boxes/:containerId/unpack',
    {
      config: byMove,
      schema: { params: BoxParams, body: UnpackBody, response: { 200: BoxSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: (
          await unpackBox(
            ctxOf(tx, client, scope, req.id),
            req.params.id,
            req.params.containerId,
            req.body ?? {},
          )
        ).box,
      })),
  );

  app.delete(
    '/api/v1/moves/:id/boxes/:containerId',
    { config: byMove, schema: { params: BoxParams } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await removeBox(ctxOf(tx, client, scope, req.id), req.params.id, req.params.containerId);
        return { status: 204, body: undefined };
      }),
  );
}
