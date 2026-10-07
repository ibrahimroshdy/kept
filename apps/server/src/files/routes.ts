import type { Readable } from 'node:stream';
import { ATTACHMENT_ROLES, FILE_CLASSES, newId } from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireScope } from '../auth/http.js';
import type { KeptApp } from '../http/app.js';
import { assertClientId, paginate, paginationQuery, requireIfMatch } from '../http/conventions.js';
import { AppError, invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { ImageLimiter } from '../storage/derivatives.js';
import {
  type AttachmentOwner,
  createAttachment,
  deleteAttachment,
  deleteOriginal,
  deleteUnreferencedBlobs,
  listAttachments,
  updateAttachment,
} from './attachments.js';
import { fileUrl, serveToken } from './serve.js';
import { declaredLength, tooManyUploads, UploadSlots, upload } from './upload.js';
import { AttachmentSubjectSchema } from './views.js';

// Files, attachments and the signed /f/<token> route (T17; D34, D36, D77, D117, D157, D162,
// D177; engineering spec §3.4, §7.2; plan Q8, Q9, Q16, Q17). The web contract is
// apps/web/src/api/inventory/{types,paths}.ts, "files and attachments (task 17)".
//
// PUT    /api/v1/files/:fileId?locationId=&class=    raw body, X-Kept-Sha256 → 201|200 FileView
// POST   /api/v1/files/:id/url[?thingId=] {variant}  → {url, expiresAt}
// DELETE /api/v1/files/:id {reason}                  "delete original", owners and admins → 204;
//                                                    its blobs go after the commit unless shared
// POST   /api/v1/attachments                         → 201 AttachmentView
// PATCH  /api/v1/attachments/:id (If-Match)          → 200 AttachmentView
// DELETE /api/v1/attachments/:id                     → 204
// GET    /api/v1/{things|places|purchases|locations}/:id/attachments?role&cursor&limit
// GET    /f/<token>                                  the bytes; no session is read

const Id = z.uuid();
const Params = z.object({ id: Id });

const FileViewSchema = z.object({
  id: z.uuid(),
  sha256: z.string(),
  bytes: z.number(),
  mime: z.string(),
  class: z.enum(FILE_CLASSES),
  hasGps: z.boolean(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  derivativeState: z.enum(['ready', 'pending', 'unavailable', 'not_applicable']),
  thumbUrl: z.string().nullable(),
  displayUrl: z.string().nullable(),
  deduplicatedFrom: z.uuid().optional(),
});

/** What POST /attachments may attach to. Step 4 adds each record's subject as its task opens it
 * (T12: an expiring document's files, `expiringDocumentId`). */
const Subject = z.union([
  z.strictObject({ thingId: Id }),
  z.strictObject({ placeId: Id }),
  z.strictObject({ purchaseId: Id }),
  z.strictObject({ meterReadingId: Id }),
  z.strictObject({ expiringDocumentId: Id }),
  // T8, T9: a valuation's, a warranty's and a claim's documents.
  z.strictObject({ valuationId: Id }),
  z.strictObject({ warrantyId: Id }),
  z.strictObject({ claimId: Id }),
  // T10, T11: a loan's condition photos, a service record's invoice.
  z.strictObject({ loanId: Id }),
  z.strictObject({ serviceRecordId: Id }),
  // T18: an incident's documents (police report, insurer letters, photos of the damage).
  z.strictObject({ incidentId: Id }),
  // Step 5 (T11): a fill's pump receipt.
  z.strictObject({ fuelEntryId: Id }),
  z.strictObject({ location: z.literal(true) }),
]);

const AttachmentViewSchema = z.object({
  id: z.uuid(),
  role: z.enum(ATTACHMENT_ROLES),
  sort: z.number(),
  file: FileViewSchema.nullable(),
  url: z.string().nullable(),
  subject: AttachmentSubjectSchema,
  createdBy: z.object({ displayName: z.string() }),
  rowVersion: z.number(),
});

const Sort = z.number().int().min(-1_000_000).max(1_000_000);

const CreateAttachmentBody = z
  .strictObject({
    id: Id.optional(),
    locationId: Id,
    fileId: Id.optional(),
    url: z
      .string()
      .max(2000)
      .regex(/^https?:\/\/\S+$/i, 'an http(s) URL')
      .optional(),
    subject: Subject,
    role: z.enum(ATTACHMENT_ROLES),
    sort: Sort.optional(),
  })
  .refine((b) => (b.fileId === undefined) !== (b.url === undefined), {
    message: 'exactly one of fileId and url',
    path: ['fileId'],
  });

const UpdateAttachmentBody = z.strictObject({
  role: z.enum(ATTACHMENT_ROLES).optional(),
  sort: Sort.optional(),
});

const ListQuery = paginationQuery.extend({ role: z.enum(ATTACHMENT_ROLES).optional() });

const ListResponse = z.object({
  items: z.array(AttachmentViewSchema),
  next_cursor: z.string().nullable(),
});

const OWNERS: readonly (readonly [AttachmentOwner, string])[] = [
  ['thing', '/api/v1/things/:id/attachments'],
  ['place', '/api/v1/places/:id/attachments'],
  ['purchase', '/api/v1/purchases/:id/attachments'],
  ['location', '/api/v1/locations/:id/attachments'],
];

const ListKey = z.tuple([z.number().int(), z.uuid()]);

export async function fileRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const files = deps.files;
  /** The routes are always registered (the route catalogue sees them); without storage the
   * ones that need it answer 503. */
  const need = (): FileStorage => {
    if (!files) throw new AppError('internal', 503, 'File storage is not configured.');
    return files;
  };
  const limiter = new ImageLimiter(files?.imageConcurrency ?? 1);
  const slots = new UploadSlots();

  // --- the upload, in a context of its own: its body is the raw stream, whatever its type ----
  await app.register(async (scope) => {
    const child = scope.withTypeProvider<ZodTypeProvider>();
    child.removeAllContentTypeParsers();
    // Fastify's bodyLimit applies only to parsers that buffer; this one hands the stream on, so
    // the size is checked here from Content-Length (413 before a byte is read) and counted again
    // while streaming (upload.ts).
    child.addContentTypeParser('*', async (req: FastifyRequest, payload: Readable) => {
      declaredLength(req, need().maxFileBytes);
      return payload;
    });
    child.put(
      '/api/v1/files/:fileId',
      {
        schema: {
          params: z.object({ fileId: Id }),
          querystring: z.object({
            locationId: Id,
            class: z.enum(FILE_CLASSES).default('photo'),
          }),
          response: { 200: FileViewSchema, 201: FileViewSchema },
        },
      },
      async (req, reply) => {
        const storage = need();
        const body = req.body as Readable | undefined;
        if (!body || typeof body.pipe !== 'function') {
          throw invalid('Send the file as the request body.');
        }
        const release = slots.take(requireScope(req).userId);
        try {
          if (!release) throw tooManyUploads();
          const result = await upload(
            { pools, files: storage, limiter, log: req.log, jobs: deps.jobs },
            req,
            body,
            {
              fileId: assertClientId(req.params.fileId),
              locationId: req.query.locationId.toLowerCase(),
              class: req.query.class,
            },
          );
          reply.code(result.status);
          return result.body;
        } catch (err) {
          // A refusal that says when to come back says it in the header too (review #15, #16).
          const wait = err instanceof AppError ? err.extra?.retryAfter : undefined;
          if (typeof wait === 'number') reply.header('retry-after', String(wait));
          throw err;
        } finally {
          release?.();
        }
      },
    );
  });

  // --- signed URLs, the /f/ route, and "delete original" --------------------------------------
  app.post(
    '/api/v1/files/:id/url',
    {
      schema: {
        params: Params,
        querystring: z.object({ thingId: Id.optional() }),
        body: z.strictObject({ variant: z.enum(['original', 'display', 'thumb', 'share']) }),
        response: { 200: z.object({ url: z.string(), expiresAt: z.string() }) },
      },
    },
    (req) => {
      const storage = need();
      return scopedRead(pools, req, (tx, client, scope) =>
        fileUrl(
          client,
          storage,
          (locationId) => gateFor(tx, locationId, scope),
          req.params.id.toLowerCase(),
          req.body.variant,
          req.query.thingId?.toLowerCase(),
        ),
      );
    },
  );

  app.get(
    // A wildcard, not `:token`: a token is longer than find-my-way's 100-character param limit.
    '/f/*',
    {
      // Q16: this route never reads the session; the token's HMAC is its whole authorisation.
      config: { auth: 'none' },
      // A token is a five-minute bearer credential, and the whole path: requests here are not
      // logged below warn, and a URL that is logged is redacted (http/logger.ts; review #11).
      logLevel: 'warn',
      schema: { hide: true, params: z.object({ '*': z.string().max(4096) }) },
    },
    (req, reply) => serveToken(need(), req.params['*'], reply),
  );

  app.delete(
    '/api/v1/files/:id',
    {
      schema: {
        params: Params,
        body: z.strictObject({ reason: z.string().trim().min(1).max(500) }),
      },
    },
    (req, reply) => {
      // Refused without storage rather than orphaning the blobs for good.
      const storage = need();
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const { storageKeys } = await deleteOriginal(
          tx,
          client,
          scope.userId,
          req.params.id.toLowerCase(),
          req.body.reason,
          req.id,
        );
        return {
          status: 204,
          body: undefined,
          afterCommit: async () => {
            await deleteUnreferencedBlobs(pools, storage, storageKeys, req.log);
          },
        };
      });
    },
  );

  // --- attachments -----------------------------------------------------------------------------
  app.post(
    '/api/v1/attachments',
    { schema: { body: CreateAttachmentBody, response: { 201: AttachmentViewSchema } } },
    (req, reply) => {
      const id = req.body.id ? assertClientId(req.body.id) : newId();
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createAttachment(
          tx,
          client,
          files,
          (locationId) => gateFor(tx, locationId, scope),
          scope.userId,
          { ...req.body, id },
          req.id,
        ),
      }));
    },
  );

  app.patch(
    '/api/v1/attachments/:id',
    {
      schema: {
        params: Params,
        body: UpdateAttachmentBody,
        response: { 200: AttachmentViewSchema },
      },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateAttachment(
          tx,
          client,
          files,
          (locationId) => gateFor(tx, locationId, scope),
          scope.userId,
          req.params.id.toLowerCase(),
          expected,
          req.body,
          req.id,
        ),
      }));
    },
  );

  app.delete('/api/v1/attachments/:id', { schema: { params: Params } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteAttachment(tx, client, scope.userId, req.params.id.toLowerCase(), req.id);
      return { status: 204, body: undefined };
    }),
  );

  for (const [owner, url] of OWNERS) {
    app.get(
      url,
      { schema: { params: Params, querystring: ListQuery, response: { 200: ListResponse } } },
      (req) => {
        const page = paginate(req.query);
        let after: [number, string] | null = null;
        if (page.after !== null) {
          const parsed = ListKey.safeParse(page.after);
          if (!parsed.success) {
            throw invalid('The cursor is not valid; start again from the first page.');
          }
          after = parsed.data;
        }
        return scopedRead(pools, req, (tx, client, scope) =>
          listAttachments(
            client,
            files,
            (locationId) => gateFor(tx, locationId, scope),
            owner,
            req.params.id.toLowerCase(),
            {
              role: req.query.role,
              limit: page.limit,
              after,
            },
          ),
        );
      },
    );
  }
}
