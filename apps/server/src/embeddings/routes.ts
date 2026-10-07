import { EMBEDDINGS_SOURCES } from '@kept/shared';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { requireScope } from '../auth/http.js';
import { localEmbeddingsInstalled } from '../config/env.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, forbidden } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedWrite } from '../http/write.js';
import { EMBED_BACKFILL_JOB } from './backfill.js';
import { writeSource } from './provider.js';
import { EmbeddingsStatusSchema, embeddingsStatus } from './status.js';

// The embeddings source switch (D207; step-6 plan T14), for instance admins, registered by
// ai/routes.ts (AI's routes are added there, never in http/routes.ts):
//
// GET /api/v1/admin/embeddings → EmbeddingsStatus (status.ts; also in GET /admin/status)
// PUT /api/v1/admin/embeddings {source} → EmbeddingsStatus. Audited `instance.embeddings_source`
//   (D180's provider-change notice doesn't apply: the source isn't a provider). `local` is refused
//   (409 `conflict`) unless its runtime is installed, as KEPT_EMBEDDINGS=local is at
//   boot. Switching to `provider` sends the backfill now instead of at the next :30.
//
// Closed to tokens (admin, D180): the route catalogue has no `tokens` entry for it.

const Body = z.object({ source: z.enum(EMBEDDINGS_SOURCES) });

export async function embeddingsRoutes(
  app: KeptApp,
  deps: Pick<InventoryDeps, 'pools' | 'jobs'> & { localInstalled?: () => boolean },
): Promise<void> {
  const { pools } = deps;
  const installed = deps.localInstalled ?? localEmbeddingsInstalled;

  await app.register(async (scope) => {
    scope.addHook('preHandler', async (req) => {
      const admin = await withScope(pools.app, requireScope(req), async (_tx, client) => {
        const { rows } = await client.query<{ admin: boolean }>(
          'SELECT kept.is_instance_admin() AS admin',
        );
        return rows[0]?.admin === true;
      });
      if (!admin) throw forbidden('Only instance admins can do this.');
    });

    scope.get(
      '/api/v1/admin/embeddings',
      { schema: { response: { 200: EmbeddingsStatusSchema } } },
      (req) =>
        withScope(pools.app, requireScope(req), (_tx, client) =>
          embeddingsStatus(client, pools, installed),
        ),
    );

    scope.put(
      '/api/v1/admin/embeddings',
      { schema: { body: Body, response: { 200: EmbeddingsStatusSchema } } },
      (req, reply) =>
        scopedWrite(pools, req, reply, async (tx, client, me) => {
          const { source } = req.body as z.infer<typeof Body>;
          if (source === 'local' && !installed()) {
            throw new AppError(
              'conflict',
              409,
              'the local model’s runtime isn’t installed on this server; use provider or off',
            );
          }
          const before = await writeSource(client, source);
          if (before !== source) {
            await audited(tx, {
              locationId: null,
              ownerAccountId: null,
              actor: { type: 'user', id: me.userId },
              action: 'instance.embeddings_source',
              entity: { type: 'instance_settings', id: null },
              before: { embeddings_source: before },
              after: { embeddings_source: source },
              requestId: req.id,
            });
            if (source === 'provider') await deps.jobs?.send(client, EMBED_BACKFILL_JOB, {});
          }
          return { status: 200, body: await embeddingsStatus(client, pools, installed, source) };
        }),
    );
  });
}
