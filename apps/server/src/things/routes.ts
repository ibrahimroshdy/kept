import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { undoRoutes } from '../audit/undo.js';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { listExportRoutes } from '../lists/routes.js';
import { applyTemplate } from '../templates/service.js';
import { moveRoutes } from './move-routes.js';
import {
  addLink,
  type Ctx,
  convertToPlace,
  createThing,
  duplicateThing,
  listThings,
  lookupCode,
  markNotHere,
  markSeen,
  removeLink,
  setLifecycle,
  splitThing,
  updateThing,
} from './service.js';
import { registerThingUndo } from './undo.js';
import {
  CodeParams,
  ConvertBody,
  CreateBody,
  DuplicateBody,
  LifecycleBody,
  LinkBody,
  LinkParams,
  ListQuery,
  Params,
  RetypeBody,
  SplitBody,
  UpdateBody,
} from './validate.js';
import { LinkSchema, ThingRowSchema, ThingViewSchema, viewOf } from './view.js';

// Things core (T14; D10, D40, D45, D76, D92, D119, D120, D137, D156, D158, D172, D183), in the
// shapes of the web contract (apps/web/src/api/inventory/{types,paths}.ts):
//
// GET    /api/v1/things?locationId*&placeId&containerId&typeId*&tagId*&belongsToId*&brandId*
//          &vendorId&state*&not*&lifecycle&container&q&group&sort&dir&limit
//          &cursor
//                                                                  → {items: ThingRow[], next_cursor}
//          &importRunId
//          `*`: repeatable, "is any of"; `not` names those that are "is none of" (D205);
//          `importRunId`: the things that import run brought in (owners and admins, step-7 T16)
// GET    /api/v1/things.csv?<the same, but limit and cursor>      → text/csv (lists/routes.ts)
// POST   /api/v1/things                                           → 201 ThingView & {ownCodes};
//          with `templateId` (quick add, T19) the template's payload is the base and the body
//          wins. `ownCodes`: the thing's own codes once the create committed, the one the
//          location's numbering gave it included (D208, T17a; see ownCodesAfterCommit)
// GET    /api/v1/things/:id                                       → ThingView
// PATCH  /api/v1/things/:id (If-Match)                            → ThingView; 412 per D156
// POST   /api/v1/things/:id/lifecycle (If-Match)                  → ThingView
// POST   /api/v1/things/:id/seen                                  → {lastSeenAt}
// POST   /api/v1/things/:id/not-here (If-Match optional)          → ThingView
// POST   /api/v1/things/:id/retype (If-Match)                     → ThingView
// POST   /api/v1/things/:id/duplicate                             → 201 ThingView & {ownCodes},
//          the copy's own codes once it committed, as for a create (T19)
// POST   /api/v1/things/:id/split (If-Match optional)             → {originalId, newId}
// POST   /api/v1/things/:id/links                                 → 201 ThingLink
// DELETE /api/v1/thing-links/:linkId                              → 204
// POST   /api/v1/things/:id/convert-to-place (If-Match; owners and admins) {parentId?, discard?}
//                                                                  → {placeId}; 409 reason
//                                                                  'discards' with what it loses
// GET    /api/v1/codes/:code                                      → {kind, id}; 404 alike (D137)
// POST   /api/v1/audit/:eventId/undo                              → {undoOf, eventId} (D150)
//
// Moves (T15: POST /things/move, /things/move/preview, /things/:id/empty-into) are in
// move-routes.ts, registered from here; meters (T16), files (T17), secrets (T19) and trash (T21)
// have their own modules.

/** An If-Match the client may send (split, not-here: the web may send none). */
function optionalIfMatch(req: FastifyRequest): number | null {
  return req.headers['if-match'] === undefined ? null : requireIfMatch(req);
}

const Page = z.object({ items: z.array(ThingRowSchema), next_cursor: z.string().nullable() });

/** POST /things' answer: the view, and the own codes the thing has once it committed (D208). */
const CreatedThingSchema = ThingViewSchema.extend({ ownCodes: z.array(z.string()) });

export async function thingRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerThingUndo();
  await undoRoutes(app, { pools, jobs: deps.jobs, files: deps.files, log: deps.log });
  await moveRoutes(app, deps);
  await listExportRoutes(app, deps);

  /** One scoped write, answering `status` with what `fn` returns. */
  const write = <B>(
    req: FastifyRequest,
    reply: FastifyReply,
    status: number,
    fn: (ctx: Ctx) => Promise<B>,
  ) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => ({
      status,
      body: await fn({ tx, client, scope, requestId: req.id, jobs: deps.jobs, files: deps.files }),
    }));

  app.get(
    '/api/v1/things',
    { schema: { querystring: ListQuery, response: { 200: Page } } },
    (req) => scopedRead(pools, req, (_tx, client) => listThings(client, deps.files, req.query)),
  );

  /**
   * A thing's own codes, read in a transaction of their own once the create has committed. A
   * location that numbers its codes numbers a new thing at commit (kept.number_new_thing(), a
   * deferred constraint trigger, 0046), after the view was read, so the create's own
   * transaction can't see the number. Read afterwards, not numbered earlier in the service: the
   * deferral keeps the counter's row lock for the commit alone (§7.16), and the trigger stays
   * the one place that decides. An idempotent replay reads them again the same way.
   */
  const ownCodesAfterCommit = (req: FastifyRequest, thingId: string) =>
    scopedRead(pools, req, async (_tx, client) => {
      const { rows } = await client.query<{ code: string }>(
        `SELECT code FROM public.legacy_codes
          WHERE thing_id = $1 AND source = 'own' ORDER BY code`,
        [thingId],
      );
      return rows.map((r) => r.code);
    });

  app.post(
    '/api/v1/things',
    { schema: { body: CreateBody, response: { 201: CreatedThingSchema } } },
    async (req, reply) => {
      const view = await write(req, reply, 201, async (ctx) =>
        createThing(
          ctx,
          req.body.templateId
            ? await applyTemplate(ctx.client, req.body.templateId, req.body.locationId, req.body)
            : req.body,
        ),
      );
      return { ...view, ownCodes: await ownCodesAfterCommit(req, view.id) };
    },
  );

  app.get(
    '/api/v1/things/:id',
    { schema: { params: Params, response: { 200: ThingViewSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        viewOf(tx, client, scope, deps.files, req.params.id.toLowerCase()),
      ),
  );

  app.patch(
    '/api/v1/things/:id',
    { schema: { params: Params, body: UpdateBody, response: { 200: ThingViewSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        updateThing(ctx, req.params.id.toLowerCase(), expected, req.body),
      );
    },
  );

  app.post(
    '/api/v1/things/:id/lifecycle',
    { schema: { params: Params, body: LifecycleBody, response: { 200: ThingViewSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        setLifecycle(ctx, req.params.id.toLowerCase(), expected, req.body),
      );
    },
  );

  app.post(
    '/api/v1/things/:id/seen',
    { schema: { params: Params, response: { 200: z.object({ lastSeenAt: z.string() }) } } },
    (req, reply) => write(req, reply, 200, (ctx) => markSeen(ctx, req.params.id.toLowerCase())),
  );

  app.post(
    '/api/v1/things/:id/not-here',
    { schema: { params: Params, response: { 200: ThingViewSchema } } },
    (req, reply) => {
      const expected = optionalIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        markNotHere(ctx, req.params.id.toLowerCase(), expected),
      );
    },
  );

  app.post(
    '/api/v1/things/:id/retype',
    { schema: { params: Params, body: RetypeBody, response: { 200: ThingViewSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        updateThing(
          ctx,
          req.params.id.toLowerCase(),
          expected,
          { typeId: req.body.typeId },
          'thing.retype',
        ),
      );
    },
  );

  app.post(
    '/api/v1/things/:id/duplicate',
    { schema: { params: Params, body: DuplicateBody, response: { 201: CreatedThingSchema } } },
    async (req, reply) => {
      const view = await write(req, reply, 201, (ctx) =>
        duplicateThing(ctx, req.params.id.toLowerCase(), req.body),
      );
      return { ...view, ownCodes: await ownCodesAfterCommit(req, view.id) };
    },
  );

  app.post(
    '/api/v1/things/:id/split',
    {
      schema: {
        params: Params,
        body: SplitBody,
        response: { 200: z.object({ originalId: z.uuid(), newId: z.uuid() }) },
      },
    },
    (req, reply) => {
      const expected = optionalIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        splitThing(ctx, req.params.id.toLowerCase(), req.body, expected),
      );
    },
  );

  app.post(
    '/api/v1/things/:id/links',
    { schema: { params: Params, body: LinkBody, response: { 201: LinkSchema } } },
    (req, reply) =>
      write(req, reply, 201, (ctx) => addLink(ctx, req.params.id.toLowerCase(), req.body)),
  );

  app.delete('/api/v1/thing-links/:linkId', { schema: { params: LinkParams } }, (req, reply) =>
    write(req, reply, 204, async (ctx) => {
      await removeLink(ctx, req.params.linkId.toLowerCase());
      return undefined;
    }),
  );

  app.post(
    '/api/v1/things/:id/convert-to-place',
    {
      schema: {
        params: Params,
        body: ConvertBody,
        response: { 200: z.object({ placeId: z.uuid() }) },
      },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return write(req, reply, 200, (ctx) =>
        convertToPlace(ctx, req.params.id.toLowerCase(), expected, req.body),
      );
    },
  );

  app.get(
    '/api/v1/codes/:code',
    {
      schema: {
        params: CodeParams,
        response: { 200: z.object({ kind: z.enum(['thing', 'place']), id: z.uuid() }) },
      },
    },
    (req) => scopedRead(pools, req, (_tx, client) => lookupCode(client, req.params.code)),
  );
}
