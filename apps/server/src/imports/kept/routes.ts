import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { rateLimited, requireScope } from '../../auth/http.js';
import { limiterKey, reserveInWindow } from '../../auth/sign-in-limiter.js';
import { withScope } from '../../db/scope.js';
import type { KeptApp } from '../../http/app.js';
import { AppError, notFound } from '../../http/errors.js';
import type { InventoryDeps } from '../../http/routes.js';
import { ArchiveImportRunView, archiveRunView, readArchiveRun } from '../archive.js';
import { PASSPHRASE_TRIES_PER_HOUR, PassphraseBody, unlockSecrets } from './secrets.js';

// The Kept import's own route (step-7 plan T14, Q7), registered by imports/archive.ts:
//
// POST /api/v1/imports/:id/passphrase {passphrase} → ImportRun (`secrets.unlocked`)
//   400 `passphrase_wrong` (checked by decrypting the export's secrets.json); 429 past 10 tries an
//   hour per run, right or wrong; 409 before the archive is uploaded or once the run started.
//
// Its own scoped transactions, not scopedWrite(): an Idempotency-Key would store a hash of the
// body (the passphrase). Nothing logs a body; the request log carries the method and the URL.

const Params = z.object({ id: z.uuid() });

const noStore = (reply: FastifyReply) => {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
};

export async function keptImportRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  // catalogue: POST /api/v1/imports/:id/passphrase
  app.post(
    '/api/v1/imports/:id/passphrase',
    {
      schema: {
        params: Params,
        body: PassphraseBody,
        response: { 200: ArchiveImportRunView },
      },
    },
    async (req, reply) => {
      const scope = requireScope(req);
      const id = req.params.id.toLowerCase();
      const files = deps.files;
      const keys = deps.secretKeys;
      if (!files || !keys) {
        throw new AppError('internal', 503, 'Imports with secrets are not configured here.');
      }
      // An invisible run is a 404 before anything counts against the run.
      const visible = await withScope(pools.app, scope, (_tx, c) => readArchiveRun(c, id));
      if (visible?.source !== 'kept_zip') throw notFound();
      const limit = await reserveInWindow(
        pools.auth,
        limiterKey('import-passphrase', id),
        PASSPHRASE_TRIES_PER_HOUR,
        3600,
      );
      if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);
      await unlockSecrets({ pools, files, keys }, scope, id, req.body.passphrase, req.id);
      noStore(reply);
      return withScope(pools.app, scope, async (_tx, c) => {
        const run = await readArchiveRun(c, id);
        if (!run) throw notFound();
        return archiveRunView(run, false);
      });
    },
  );
}
