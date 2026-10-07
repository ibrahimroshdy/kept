import { FIELD_KINDS } from '@kept/shared';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import { AppError } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { writeCtx } from '../registries/routes.js';
import { convertField, previewConversion } from './convert.js';
import {
  createPlaceKind,
  createPlaceKindField,
  customisePlaceKind,
  listPlaceKinds,
  updatePlaceKind,
} from './place-kinds.js';
import {
  createType,
  createTypeField,
  customiseType,
  deleteType,
  getType,
  listTypes,
  mergeType,
  previewType,
  setFieldArchived,
  updateField,
  updateType,
} from './service.js';
import {
  CreateFieldBody,
  CreatePlaceKindBody,
  CreateTypeBody,
  CustomiseBody,
  CustomisePlaceKindResult,
  CustomiseResult,
  MergeBody,
  MergeResult,
  PatchTypeBody,
  PlaceKindNodeSchema,
  PlaceKindsResponse,
  ResolvedFieldSchema,
  TypeDetailSchema,
  TypeImpactSchema,
  TypesResponse,
  UpdateFieldBody,
  UpdatePlaceKindBody,
  UpdateTypeBody,
} from './view.js';

// Types, type fields and place kinds (T11; D11, D33, D92, D123, D154, D160, D172, D177, D192;
// plan Q3, Q4, Q13b, Q21; T28 contract decisions 2, 3, 4 and 7). Shapes:
// apps/web/src/api/inventory/types.ts.
//
// GET  /api/v1/accounts/:accountId/types?includeArchived      → {types: TypeNode[]}
// POST /api/v1/accounts/:accountId/types                       → 201 TypeDetail
// GET | PATCH (If-Match) | DELETE /api/v1/types/:id
// POST /api/v1/types/:id/preview                               → TypeImpact (read-only)
// POST /api/v1/types/:id/fields                                → 201 ResolvedField
// POST /api/v1/types/:id/customise {accountId}                 → {typeId}
// POST /api/v1/types/:id/merge-into {targetId}                 → {repointed}
// PATCH (If-Match) /api/v1/type-fields/:id                     → ResolvedField
// POST /api/v1/type-fields/:id/archive | /restore              → 204
// POST /api/v1/type-fields/:id/convert/preview {toSecret} | {kind, options?, unit?}
//                                                              → ConvertPreview (read-only)
// POST (If-Match) /api/v1/type-fields/:id/convert (same body)  → {converted, toNotes}
//      the account owner only; not undoable (step-7 T18, convert.ts)
// GET | POST /api/v1/accounts/:accountId/place-kinds           → {placeKinds} | 201 PlaceKindNode
// POST /api/v1/accounts/:accountId/place-kinds/:builtinKey/customise → {placeKindId}
// PATCH (If-Match) /api/v1/place-kinds/:id                     → PlaceKindNode
// POST /api/v1/place-kinds/:id/fields                          → 201 ResolvedField
//
// A 409 carries `reason` ('cycle' | 'field_redefined' | 'builtin' | 'in_use') and, for a
// redefined field, its `key`.

const Id = z.object({ id: z.uuid() });
const ConvertBody = z.union([
  z.strictObject({ toSecret: z.boolean() }),
  z.strictObject({
    kind: z.enum(FIELD_KINDS),
    options: z.array(z.string().trim().min(1).max(80)).min(1).max(100).optional(),
    unit: z.string().trim().min(1).max(12).optional(),
  }),
]);
const ConvertPreviewSchema = z.object({
  locations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().nullable(),
      values: z.number().int(),
      convertible: z.number().int(),
      toNotes: z.number().int(),
    }),
  ),
  total: z.number().int(),
});
const ConvertResultSchema = z.object({
  converted: z.number().int(),
  toNotes: z.number().int(),
});
const AccountParams = z.object({ accountId: z.uuid() });
const TypesQuery = z.object({
  includeArchived: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export async function typeRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const lower = (id: string) => id.toLowerCase();

  // ----- types -----

  app.get(
    '/api/v1/accounts/:accountId/types',
    {
      schema: { params: AccountParams, querystring: TypesQuery, response: { 200: TypesResponse } },
    },
    async (req) => ({
      types: await scopedRead(pools, req, (_tx, client) =>
        listTypes(client, lower(req.params.accountId), req.query.includeArchived),
      ),
    }),
  );

  app.post(
    '/api/v1/accounts/:accountId/types',
    {
      schema: { params: AccountParams, body: CreateTypeBody, response: { 201: TypeDetailSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createType(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.accountId),
          req.body,
        ),
      })),
  );

  app.get(
    '/api/v1/types/:id',
    { schema: { params: Id, response: { 200: TypeDetailSchema } } },
    (req) => scopedRead(pools, req, (_tx, client) => getType(client, lower(req.params.id))),
  );

  app.patch(
    '/api/v1/types/:id',
    { schema: { params: Id, body: PatchTypeBody, response: { 200: TypeDetailSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateType(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.id),
          expected,
          req.body,
        ),
      }));
    },
  );

  app.post(
    '/api/v1/types/:id/preview',
    { schema: { params: Id, body: UpdateTypeBody, response: { 200: TypeImpactSchema } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) => previewType(client, lower(req.params.id), req.body)),
  );

  app.post(
    '/api/v1/types/:id/fields',
    { schema: { params: Id, body: CreateFieldBody, response: { 201: ResolvedFieldSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createTypeField(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.id),
          req.body,
        ),
      })),
  );

  app.post(
    '/api/v1/types/:id/customise',
    { schema: { params: Id, body: CustomiseBody, response: { 200: CustomiseResult } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await customiseType(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.id),
          lower(req.body.accountId),
        ),
      })),
  );

  app.post(
    '/api/v1/types/:id/merge-into',
    { schema: { params: Id, body: MergeBody, response: { 200: MergeResult } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await mergeType(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.id),
          lower(req.body.targetId),
        ),
      })),
  );

  app.delete('/api/v1/types/:id', { schema: { params: Id } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteType(writeCtx(deps, req, tx, client, scope), lower(req.params.id));
      return { status: 204, body: undefined };
    }),
  );

  // ----- fields -----

  app.patch(
    '/api/v1/type-fields/:id',
    { schema: { params: Id, body: UpdateFieldBody, response: { 200: ResolvedFieldSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateField(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.id),
          expected,
          req.body,
        ),
      }));
    },
  );

  for (const op of ['archive', 'restore'] as const) {
    app.post(`/api/v1/type-fields/:id/${op}`, { schema: { params: Id } }, (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await setFieldArchived(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.id),
          op === 'archive',
        );
        return { status: 204, body: undefined };
      }),
    );
  }

  // ----- converting a field (step 7, T18) -----

  app.post(
    '/api/v1/type-fields/:id/convert/preview',
    { schema: { params: Id, body: ConvertBody, response: { 200: ConvertPreviewSchema } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        previewConversion(client, lower(req.params.id), req.body),
      ),
  );

  app.post(
    '/api/v1/type-fields/:id/convert',
    { schema: { params: Id, body: ConvertBody, response: { 200: ConvertResultSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      const keys = () => {
        if (!deps.secretKeys) {
          throw new AppError('internal', 503, 'Secret values are not configured on this server.');
        }
        return deps.secretKeys;
      };
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await convertField(
          writeCtx(deps, req, tx, client, scope),
          { keys },
          lower(req.params.id),
          expected,
          req.body,
        ),
      }));
    },
  );

  // ----- place kinds -----

  app.get(
    '/api/v1/accounts/:accountId/place-kinds',
    { schema: { params: AccountParams, response: { 200: PlaceKindsResponse } } },
    async (req) => ({
      placeKinds: await scopedRead(pools, req, (_tx, client) =>
        listPlaceKinds(client, lower(req.params.accountId)),
      ),
    }),
  );

  app.post(
    '/api/v1/accounts/:accountId/place-kinds',
    {
      schema: {
        params: AccountParams,
        body: CreatePlaceKindBody,
        response: { 201: PlaceKindNodeSchema },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createPlaceKind(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.accountId),
          req.body,
        ),
      })),
  );

  app.post(
    '/api/v1/accounts/:accountId/place-kinds/:builtinKey/customise',
    {
      schema: {
        params: AccountParams.extend({ builtinKey: z.string().max(40) }),
        response: { 200: CustomisePlaceKindResult },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await customisePlaceKind(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.accountId),
          req.params.builtinKey,
        ),
      })),
  );

  app.patch(
    '/api/v1/place-kinds/:id',
    { schema: { params: Id, body: UpdatePlaceKindBody, response: { 200: PlaceKindNodeSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updatePlaceKind(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.id),
          expected,
          req.body,
        ),
      }));
    },
  );

  app.post(
    '/api/v1/place-kinds/:id/fields',
    { schema: { params: Id, body: CreateFieldBody, response: { 201: ResolvedFieldSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createPlaceKindField(
          writeCtx(deps, req, tx, client, scope),
          lower(req.params.id),
          req.body,
        ),
      })),
  );
}
