import { CONDITION_REPORT_KINDS, ROOM_CONDITIONS } from '@kept/shared';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { paginate, requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  CreateReportBody,
  CreateRoomBody,
  createReport,
  createRoom,
  deleteReport,
  deleteRoom,
  finishReport,
  listReports,
  ReportsQuery,
  reportView,
  UpdateReportBody,
  UpdateRoomBody,
  updateReport,
  updateRoom,
  type WriteCtx,
} from './service.js';

// Renters' condition reports (1.x, D171, D174; D235): the routes. condition/service.ts says who
// may do what; the web contract is apps/web/src/api/condition/types.ts. The PDF is a report run
// (POST /api/v1/reports/condition, reports/routes.ts). A room's photos are attachments
// (POST /api/v1/attachments with subject {conditionRoomId}, files/routes.ts).

const Params = z.object({ id: z.uuid() });

const Person = z.object({ displayName: z.string() });

const RowSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  kind: z.enum(CONDITION_REPORT_KINDS),
  heldOn: z.string(),
  notes: z.string().nullable(),
  createdBy: Person,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  finishedBy: Person.nullable(),
  roomCount: z.number().int(),
  photoCount: z.number().int(),
  rowVersion: z.number().int(),
});

const RoomSchema = z.object({
  id: z.uuid(),
  reportId: z.uuid(),
  placeId: z.uuid().nullable(),
  name: z.string(),
  condition: z.enum(ROOM_CONDITIONS).nullable(),
  note: z.string().nullable(),
  sort: z.number().int(),
  // files/views.ts AttachmentView, with when Kept received it.
  photos: z.array(z.looseObject({ id: z.uuid(), addedAt: z.string() })),
  rowVersion: z.number().int(),
});

const ReportSchema = RowSchema.extend({
  timezone: z.string(),
  rooms: z.array(RoomSchema),
  others: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(CONDITION_REPORT_KINDS),
      heldOn: z.string(),
      finishedAt: z.string().nullable(),
    }),
  ),
});

const Page = z.object({ items: z.array(RowSchema), next_cursor: z.string().nullable() });

export async function conditionRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const ctxOf = (
    tx: WriteCtx['tx'],
    client: WriteCtx['client'],
    scope: WriteCtx['scope'],
    requestId: string,
  ): WriteCtx => ({ tx, client, scope, files: deps.files, requestId });

  app.get(
    '/api/v1/condition-reports',
    { schema: { querystring: ReportsQuery, response: { 200: Page } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        listReports(client, req.query, paginate(req.query).after),
      ),
  );

  app.get(
    '/api/v1/condition-reports/:id',
    { schema: { params: Params, response: { 200: ReportSchema } } },
    (req) => scopedRead(pools, req, (_tx, client) => reportView(client, deps.files, req.params.id)),
  );

  app.post(
    '/api/v1/locations/:id/condition-reports',
    { schema: { params: Params, body: CreateReportBody, response: { 201: ReportSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createReport(ctxOf(tx, client, scope, req.id), req.params.id, req.body),
      })),
  );

  app.patch(
    '/api/v1/condition-reports/:id',
    { schema: { params: Params, body: UpdateReportBody, response: { 200: ReportSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateReport(
          ctxOf(tx, client, scope, req.id),
          req.params.id,
          expected,
          req.body,
        ),
      }));
    },
  );

  app.post(
    '/api/v1/condition-reports/:id/finish',
    { schema: { params: Params, response: { 200: ReportSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await finishReport(ctxOf(tx, client, scope, req.id), req.params.id, expected),
      }));
    },
  );

  app.delete('/api/v1/condition-reports/:id', { schema: { params: Params } }, (req, reply) => {
    const expected = requireIfMatch(req);
    return scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteReport(ctxOf(tx, client, scope, req.id), req.params.id, expected);
      return { status: 204, body: undefined };
    });
  });

  app.post(
    '/api/v1/condition-reports/:id/rooms',
    { schema: { params: Params, body: CreateRoomBody, response: { 201: RoomSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createRoom(ctxOf(tx, client, scope, req.id), req.params.id, req.body),
      })),
  );

  app.patch(
    '/api/v1/condition-rooms/:id',
    { schema: { params: Params, body: UpdateRoomBody, response: { 200: RoomSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateRoom(ctxOf(tx, client, scope, req.id), req.params.id, expected, req.body),
      }));
    },
  );

  app.delete('/api/v1/condition-rooms/:id', { schema: { params: Params } }, (req, reply) => {
    const expected = requireIfMatch(req);
    return scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteRoom(ctxOf(tx, client, scope, req.id), req.params.id, expected);
      return { status: 204, body: undefined };
    });
  });
}
