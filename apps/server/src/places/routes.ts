import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import { locationOfPlace } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { requireMembership } from '../locations/access.js';
import {
  ConvertBody,
  CreatePlaceBody,
  type Ctx,
  convertToContainer,
  createPlace,
  deletePlace,
  labelPlace,
  MergeBody,
  mergePlace,
  restorePlace,
  TrashBody,
  trashPlace,
  UpdatePlaceBody,
  updatePlace,
} from './service.js';
import { registerPlaceUndo } from './undo.js';
import {
  ContentsQuery,
  PlaceContentsSchema,
  PlaceNodeSchema,
  PlaceViewSchema,
  placeContents,
  placeNodes,
  placeView,
  requirePlace,
} from './view.js';

// Places: every operation of D160 (T13; D45, D118, D162). The web contract is
// apps/web/src/api/inventory/{types,paths}.ts (PlaceNode, PlaceView, PlaceContents, TrashBody,
// TrashResult, RestoreResult, ConvertToContainerResult, LabelResult).
//
// GET    /api/v1/locations/:locationId/places     → {places: PlaceNode[]}
// POST   /api/v1/locations/:locationId/places     {id?, parentId?, name, kindKey, icon?} → 201 PlaceView
// GET    /api/v1/places/:id                       → PlaceView
// GET    /api/v1/places/:id/contents?q&type*&tag*&state*&brand*&belongsTo*&not*&group&sort&dir
//        &limit&cursor → PlaceContents (`*`: repeatable, "is any of"; `not` names those "none of", D205)
// PATCH  /api/v1/places/:id (If-Match)            {name?, kindKey?, icon?, sort?, parentId?, custom?}
// POST   /api/v1/places/:id/trash                 {contents?, moveTo?} → TrashResult, or 409
//                                                  contents_choice_required with {counts}
// POST   /api/v1/places/:id/restore               → {restored, hint?}
// DELETE /api/v1/places/:id                       → 204 (owners and admins; trashed places only)
// POST   /api/v1/places/:id/merge-into            {targetId, sourceRowVersion}, If-Match: the
//                                                  target's → PlaceView of the target
// POST   /api/v1/places/:id/convert-to-container  {typeId?}, If-Match optional → {thingId} (the
//                                                  same id, Q14)
// POST   /api/v1/places/:id/label                 (labels module) → {code}
//
// PATCH's `place.update` and `place.move` events are undoable for 7 days through
// POST /api/v1/audit/:eventId/undo (undo.ts registers their handlers).

const LocationParams = z.object({ locationId: z.uuid() });
const Params = z.object({ id: z.uuid() });

const TrashResultSchema = z.object({
  trashed: z.array(z.uuid()),
  moved: z.array(z.uuid()),
  trashBatchId: z.uuid(),
});
const RestoreResultSchema = z.object({ restored: z.array(z.uuid()), hint: z.string().optional() });

/** If-Match when the client sent one: trash takes it, but the web contract sends none. */
function optionalIfMatch(req: Parameters<typeof requireIfMatch>[0]): number | null {
  const raw = req.headers['if-match'];
  return raw === undefined || raw === '' ? null : requireIfMatch(req);
}

export async function placeRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools, jobs, files } = deps;
  registerPlaceUndo();
  const ctx = (
    tx: Ctx['tx'],
    client: Ctx['client'],
    scope: Ctx['scope'],
    requestId: string,
  ): Ctx => ({ tx, client, scope, jobs, requestId });

  app.get(
    '/api/v1/locations/:locationId/places',
    {
      schema: {
        params: LocationParams,
        response: { 200: z.object({ places: z.array(PlaceNodeSchema) }) },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const locationId = req.params.locationId.toLowerCase();
        await requireMembership(client, locationId);
        return { places: await placeNodes(client, locationId) };
      }),
  );

  app.post(
    '/api/v1/locations/:locationId/places',
    {
      schema: { params: LocationParams, body: CreatePlaceBody, response: { 201: PlaceViewSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const c = ctx(tx, client, scope, req.id);
        const created = await createPlace(c, req.params.locationId.toLowerCase(), req.body);
        return { status: 201, body: await placeView(tx, client, scope, files, created) };
      }),
  );

  app.get(
    '/api/v1/places/:id',
    { schema: { params: Params, response: { 200: PlaceViewSchema } } },
    (req) =>
      scopedRead(pools, req, async (tx, client, scope) => {
        const place = await requirePlace(client, req.params.id.toLowerCase());
        return placeView(tx, client, scope, files, place);
      }),
  );

  app.get(
    '/api/v1/places/:id/contents',
    {
      schema: {
        params: Params,
        querystring: ContentsQuery,
        response: { 200: PlaceContentsSchema },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const place = await requirePlace(client, req.params.id.toLowerCase());
        return placeContents(client, files, place, req.query);
      }),
  );

  app.patch(
    '/api/v1/places/:id',
    { schema: { params: Params, body: UpdatePlaceBody, response: { 200: PlaceViewSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const c = ctx(tx, client, scope, req.id);
        const after = await updatePlace(c, req.params.id.toLowerCase(), expected, req.body);
        return { status: 200, body: await placeView(tx, client, scope, files, after) };
      });
    },
  );

  app.post(
    '/api/v1/places/:id/trash',
    { schema: { params: Params, body: TrashBody, response: { 200: TrashResultSchema } } },
    (req, reply) => {
      const expected = optionalIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await trashPlace(
          ctx(tx, client, scope, req.id),
          req.params.id.toLowerCase(),
          expected,
          req.body,
        ),
      }));
    },
  );

  app.post(
    '/api/v1/places/:id/restore',
    { schema: { params: Params, response: { 200: RestoreResultSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await restorePlace(ctx(tx, client, scope, req.id), req.params.id.toLowerCase()),
      })),
  );

  app.delete('/api/v1/places/:id', { schema: { params: Params } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deletePlace(ctx(tx, client, scope, req.id), req.params.id.toLowerCase());
      return { status: 204, body: undefined };
    }),
  );

  app.post(
    '/api/v1/places/:id/merge-into',
    { schema: { params: Params, body: MergeBody, response: { 200: PlaceViewSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const c = ctx(tx, client, scope, req.id);
        const target = await mergePlace(c, req.params.id.toLowerCase(), expected, req.body);
        return { status: 200, body: await placeView(tx, client, scope, files, target) };
      });
    },
  );

  app.post(
    '/api/v1/places/:id/convert-to-container',
    {
      schema: {
        params: Params,
        body: ConvertBody,
        response: { 200: z.object({ thingId: z.uuid() }) },
      },
    },
    (req, reply) => {
      const expected = optionalIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await convertToContainer(
          ctx(tx, client, scope, req.id),
          req.params.id.toLowerCase(),
          expected,
          req.body,
        ),
      }));
    },
  );

  app.post(
    '/api/v1/places/:id/label',
    {
      schema: { params: Params, response: { 200: z.object({ code: z.string() }) } },
      config: { module: 'labels', moduleLocation: locationOfPlace(pools) },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await labelPlace(ctx(tx, client, scope, req.id), req.params.id.toLowerCase()),
      })),
  );
}
