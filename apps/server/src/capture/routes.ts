import type { Readable } from 'node:stream';
import { FILE_CLASSES } from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { declaredLength } from '../files/upload.js';
import type { KeptApp } from '../http/app.js';
import { paginate, paginationQuery } from '../http/conventions.js';
import { AppError, invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { IDEMPOTENCY_HEADER, scopedRead, scopedWrite } from '../http/write.js';
import type { FileStorage } from '../storage/blob-store.js';
import { ImageLimiter } from '../storage/derivatives.js';
import { ThingRowSchema } from '../things/view.js';
import { registerCaptureUndo, undoCaptureBatch } from './batch-undo.js';
import { listBatches } from './batches.js';
import { setDisplay } from './display.js';
import { CaptureBody, capture } from './service.js';

// The online capture path (plan T13; D17, D18, D19, D34, D36, D150; engineering spec §7.7, §7.8).
// The web contract is apps/web/src/api/capture/{paths,types}.ts, "capture (T13)".
//
// POST /api/v1/captures (Idempotency-Key)            → 201 {thing?, purchaseId?, extraction?,
//                                                      inboxItemId?, undo?}
// PUT  /api/v1/files/:fileId/display (raw JPEG,
//      X-Kept-Sha256)                                → 200 FileView
// POST /api/v1/captures/batches/:batchId/undo         → 200 {trashed}
// GET  /api/v1/captures/batches?locationId&mine&cursor&limit
//                                                    → {items: CaptureBatch[], next_cursor}
//
// An undoable write answers `X-Kept-Audit-Event` (http/write.ts, §7.7): a new thing's capture and
// a batch undo that trashed something.

const Id = z.uuid();

const FileViewSchema = z.object({
  id: z.uuid(),
  sha256: z.string(),
  bytes: z.number(),
  mime: z.string(),
  class: z.enum(FILE_CLASSES),
  hasGps: z.boolean(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  derivativeState: z.enum(['ready', 'unavailable', 'not_applicable']),
  thumbUrl: z.string().nullable(),
  displayUrl: z.string().nullable(),
});

const CaptureResultSchema = z.object({
  thing: ThingRowSchema.optional(),
  purchaseId: z.uuid().optional(),
  extraction: z.object({ id: z.uuid(), status: z.enum(['queued', 'waiting_provider']) }).optional(),
  inboxItemId: z.uuid().optional(),
  undo: z.object({ eventId: z.uuid(), until: z.string() }).optional(),
});

const PathStep = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['place', 'container']),
  isUnplaced: z.boolean(),
});

const BatchSchema = z.object({
  batchId: z.uuid(),
  locationId: z.uuid(),
  placePath: z.array(PathStep),
  capturedAt: z.string(),
  count: z.number(),
  drafts: z.number(),
  byMe: z.boolean(),
});

const Flag = z
  .enum(['1', '0', 'true', 'false'])
  .transform((v) => v === '1' || v === 'true')
  .optional();

export async function captureRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerCaptureUndo();
  const need = (): FileStorage => {
    if (!deps.files) throw new AppError('internal', 503, 'File storage is not configured.');
    return deps.files;
  };
  // Its own small queue: a phone's display is at most a 2048 px JPEG, cheap next to an upload's.
  const limiter = new ImageLimiter(1);

  app.post(
    '/api/v1/captures',
    { schema: { body: CaptureBody, response: { 201: CaptureResultSchema } } },
    (req, reply) => {
      if (!req.headers[IDEMPOTENCY_HEADER]) {
        throw invalid('Send an Idempotency-Key with a capture, so a retry is never a second one.');
      }
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await capture(
          { tx, client, scope, requestId: req.id, jobs: deps.jobs, files: deps.files },
          req.body,
          { via: 'online' },
        ),
      }));
    },
  );

  app.post(
    '/api/v1/captures/batches/:batchId/undo',
    {
      schema: {
        params: z.object({ batchId: Id }),
        response: { 200: z.object({ trashed: z.array(z.uuid()) }) },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await undoCaptureBatch(
          { tx, client, scope, requestId: req.id },
          req.params.batchId.toLowerCase(),
        ),
      })),
  );

  app.get(
    '/api/v1/captures/batches',
    {
      schema: {
        querystring: paginationQuery.extend({ locationId: Id.optional(), mine: Flag }),
        response: {
          200: z.object({ items: z.array(BatchSchema), next_cursor: z.string().nullable() }),
        },
      },
    },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        listBatches(client, {
          locationId: req.query.locationId?.toLowerCase() ?? null,
          mine: req.query.mine ?? false,
          page: paginate(req.query),
        }),
      ),
  );

  // The phone's display, in a context of its own: the body is the raw JPEG stream.
  await app.register(async (scope) => {
    const child = scope.withTypeProvider<ZodTypeProvider>();
    child.removeAllContentTypeParsers();
    child.addContentTypeParser('*', async (req: FastifyRequest, payload: Readable) => {
      declaredLength(req, need().maxFileBytes);
      return payload;
    });
    child.put(
      '/api/v1/files/:fileId/display',
      {
        schema: {
          params: z.object({ fileId: Id }),
          response: { 200: FileViewSchema },
        },
      },
      async (req, reply) => {
        const files = need();
        const body = req.body as Readable | undefined;
        if (!body || typeof body.pipe !== 'function') {
          throw invalid('Send the JPEG as the request body.');
        }
        try {
          const result = await setDisplay(
            { pools, files, limiter, log: req.log },
            req,
            body,
            req.params.fileId.toLowerCase(),
          );
          reply.code(result.status);
          return result.body;
        } catch (err) {
          const wait = err instanceof AppError ? err.extra?.retryAfter : undefined;
          if (typeof wait === 'number') reply.header('retry-after', String(wait));
          throw err;
        }
      },
    );
  });
}
