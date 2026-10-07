import { z } from 'zod';
import { requireScope } from '../auth/http.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError } from '../http/errors.js';
import { requireHttps } from '../http/https-only.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  CreateExportBody,
  cancelExport,
  createExport,
  ExportRunView,
  ExportsQuery,
  exportView,
  listExports,
} from './service.js';

// Step 7: the Kept export (D68, D69, D159, D180; plan T12). Shapes:
// apps/web/src/api/portability/types.ts (ExportRun, CreateExportBody, ExportsPage).
//
// POST /api/v1/exports              {id?, scope: {locationId} | {me: true}, options?,
//                                    includeSecrets?, passphrase?, passphraseAgain?}
//   → 202 ExportRun. 403 for a member, or "Include secrets" from anyone but the owner; 409
//   `recovery_kit_required`; 400 `passphrase_weak`; 429 past five an hour (Retry-After); 409
//   `export_running` while one runs for that location. It may carry a passphrase, so it runs in
//   its own scoped transaction, never the Idempotency-Key store (secrets/routes.ts says why); a
//   retry sends the same `id` instead, and gets the run that id made. Audited `export.create`.
// GET  /api/v1/exports/:id          → ExportRun, with a five-minute `fileUrl` while done and
//                                    unexpired (audited `export.download`); 404 once the caller
//                                    no longer owns or administers the location (D180)
// GET  /api/v1/exports?locationId&cursor → {items: ExportRun[], next_cursor}: the caller's own
// POST /api/v1/exports/:id/cancel   → ExportRun (`cancelled`); audited `export.cancel`

const Params = z.object({ id: z.uuid() });
const Page = z.object({ items: z.array(ExportRunView), next_cursor: z.string().nullable() });

export async function exportRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const needs = () => {
    if (!deps.files || !deps.jobs) {
      throw new AppError('internal', 503, 'Exports need file storage and the job queue.');
    }
    return { files: deps.files, jobs: deps.jobs };
  };

  app.post(
    '/api/v1/exports',
    {
      // Never over plain HTTP (D181; step-8 T24): 403 `https_required`.
      preHandler: requireHttps(deps.env.KEPT_PUBLIC_URL),
      schema: { body: CreateExportBody, response: { 202: ExportRunView } },
    },
    async (req, reply) => {
      const { files, jobs } = needs();
      const scope = requireScope(req);
      try {
        const view = await withScope(pools.app, scope, (tx, client) =>
          createExport(
            tx,
            client,
            scope,
            { jobs, files, secretKeys: deps.secretKeys ?? null },
            req.body,
            req.id,
          ),
        );
        reply.code(202);
        return view;
      } catch (err) {
        const retryAfter = err instanceof AppError ? err.extra?.retryAfter : undefined;
        if (typeof retryAfter === 'number') reply.header('retry-after', String(retryAfter));
        throw err;
      }
    },
  );

  app.get(
    '/api/v1/exports',
    { schema: { querystring: ExportsQuery, response: { 200: Page } } },
    (req) => scopedRead(pools, req, (_tx, client) => listExports(client, req.query)),
  );

  app.get(
    '/api/v1/exports/:id',
    { schema: { params: Params, response: { 200: ExportRunView } } },
    (req, reply) => {
      const { files } = needs();
      reply.header('cache-control', 'no-store');
      return scopedRead(pools, req, (tx, client, scope) =>
        exportView(tx, client, scope, files, req.params.id, req.id),
      );
    },
  );

  app.post(
    '/api/v1/exports/:id/cancel',
    { schema: { params: Params, response: { 200: ExportRunView } } },
    (req, reply) => {
      const { files } = needs();
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await cancelExport(tx, client, scope, files, req.params.id, req.id),
      }));
    },
  );
}
