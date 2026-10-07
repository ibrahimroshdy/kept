import { newId } from '@kept/shared';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { assertClientId, paginate, paginationQuery, requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  CreateDocumentBody,
  createDocument,
  DocumentsQuery,
  deleteDocument,
  listDocuments,
  RenewDocumentBody,
  renewDocument,
  requireDocumentModule,
  UpdateDocumentBody,
  updateDocument,
} from './documents.js';
import { listPaperwork, PaperworkQuery } from './library.js';
import { registerPaperworkUndo } from './undo.js';
import {
  documentView,
  ExpiringDocumentSchema,
  PaperworkRowSchema,
  readDocumentRow,
} from './view.js';

// The paperwork library and expiring documents (plan T12; D39, D155, D172). The web contract is
// apps/web/src/api/household/{types,paths}.ts, "the paperwork library and expiring documents".
//
// GET    /api/v1/paperwork?q&locationId&role&subjectType&expiry&cursor&limit
//                                        → {items: PaperworkRow[], next_cursor}      (library.ts)
// GET    /api/v1/documents?locationId&kind&subjectType&subjectId&state&includeSuperseded&cursor
//                                        → {items: ExpiringDocument[], next_cursor}
// GET    /api/v1/documents/:id          → ExpiringDocument
// POST   /api/v1/documents {id?, subject, kind, title?, expiresOn, leadDays?} → 201
// PATCH  /api/v1/documents/:id (If-Match) {kind?, title?, expiresOn?, leadDays?} → 200
// DELETE /api/v1/documents/:id (If-Match) → 204
// POST   /api/v1/documents/:id/renew (If-Match) {id?, expiresOn, leadDays?}
//                                        → {renewed, previous}
//
// The two lists are global (screens §1): they read every visible location with Paperwork on and
// narrow with `locationId`, so they declare no module (the gate would need one location). The
// rest gate on Paperwork in the document's location: 404 `module_off` to read, 409 to write.
//
// Step 5 (T12): a document on a vehicle works with Paperwork or Vehicles on, so these routes
// gate in documents.ts requireDocumentModule() (a route's config names one module). The bodies of
// POST, PATCH and renew gain `issuedOn`, `cost` and `currency`; GET /documents gains `thingId`;
// an ExpiringDocument gains `issuedOn`, and `cost` and `currency` through the money gate.

const Params = z.object({ id: z.uuid() });

export async function paperworkRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools, files } = deps;
  registerPaperworkUndo();

  app.get(
    '/api/v1/paperwork',
    {
      schema: {
        querystring: paginationQuery.extend(PaperworkQuery.shape),
        response: {
          200: z.object({
            items: z.array(PaperworkRowSchema),
            next_cursor: z.string().nullable(),
          }),
        },
      },
    },
    (req) => {
      const page = paginate(req.query);
      return scopedRead(pools, req, (tx, client, scope) =>
        listPaperwork(tx, client, files, scope, req.query, page),
      );
    },
  );

  app.get(
    '/api/v1/documents',
    {
      schema: {
        querystring: paginationQuery.extend(DocumentsQuery.shape),
        response: {
          200: z.object({
            items: z.array(ExpiringDocumentSchema),
            next_cursor: z.string().nullable(),
          }),
        },
      },
    },
    (req) => {
      const page = paginate(req.query);
      return scopedRead(pools, req, (tx, client, scope) =>
        listDocuments(tx, client, files, scope, req.query, page),
      );
    },
  );

  app.get(
    '/api/v1/documents/:id',
    { schema: { params: Params, response: { 200: ExpiringDocumentSchema } } },
    (req) =>
      scopedRead(pools, req, async (tx, client, scope) => {
        const id = req.params.id.toLowerCase();
        const row = await readDocumentRow(client, id);
        await requireDocumentModule(tx, client, scope, row.location_id, row.thing_id, 'read');
        return documentView(tx, client, files, scope, id);
      }),
  );

  app.post(
    '/api/v1/documents',
    { schema: { body: CreateDocumentBody, response: { 201: ExpiringDocumentSchema } } },
    (req, reply) => {
      const id = req.body.id ? assertClientId(req.body.id) : newId();
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createDocument(tx, client, files, scope, { ...req.body, id }, req.id),
      }));
    },
  );

  app.patch(
    '/api/v1/documents/:id',
    {
      schema: {
        params: Params,
        body: UpdateDocumentBody,
        response: { 200: ExpiringDocumentSchema },
      },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateDocument(
          tx,
          client,
          files,
          scope,
          req.params.id.toLowerCase(),
          expected,
          req.body,
          req.id,
        ),
      }));
    },
  );

  app.delete('/api/v1/documents/:id', { schema: { params: Params } }, (req, reply) => {
    const expected = requireIfMatch(req);
    return scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await deleteDocument(tx, client, scope, req.params.id.toLowerCase(), expected, req.id);
      return { status: 204, body: undefined };
    });
  });

  app.post(
    '/api/v1/documents/:id/renew',
    {
      schema: {
        params: Params,
        body: RenewDocumentBody,
        response: {
          200: z.object({ renewed: ExpiringDocumentSchema, previous: ExpiringDocumentSchema }),
        },
      },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      const body = { ...req.body, ...(req.body.id ? { id: assertClientId(req.body.id) } : {}) };
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await renewDocument(
          tx,
          client,
          files,
          scope,
          req.params.id.toLowerCase(),
          expected,
          body,
          req.id,
        ),
      }));
    },
  );
}
