import { KEPT_VERSION, type UpdateCheckState } from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { requireScope } from '../auth/http.js';
import type { KeptApp } from '../http/app.js';
import { conflict, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { checkForUpdate, readUpdateCheck, storeUpdateCheck, updateCheckEnabled } from './check.js';

// "Check now" for the opt-in update check (D65; step-8 plan T11): `POST /api/v1/admin/updates/
// check`, instance admins only (404 for anyone else, as Admin → Backups). One request to GitHub,
// exactly as the daily job makes it (updates/check.ts), and only while "Check for new versions"
// is on: an admin who hasn't turned it on has not agreed to Kept asking anything (409
// `conflict`). The request runs outside any transaction; its answer is stored and audited
// (`instance.update_check`, with the outcome, never a header or a body) in one afterwards.
// The switch itself is `updateCheck` in GET/PUT /api/v1/admin/settings (admin/routes.ts).

const UpdateCheckStateSchema = z.object({
  enabled: z.boolean(),
  locked: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  latest: z.object({ version: z.string(), url: z.string(), publishedAt: z.string() }).nullable(),
  error: z.string().nullable(),
});

async function isInstanceAdmin(deps: InventoryDeps, req: FastifyRequest): Promise<boolean> {
  return scopedRead(deps.pools, req, async (_tx, client) => {
    const { rows } = await client.query<{ admin: boolean }>(
      'SELECT kept.is_instance_admin() AS admin',
    );
    return rows[0]?.admin === true;
  });
}

export async function updateRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const env = { KEPT_UPDATE_CHECK: deps.env.KEPT_UPDATE_CHECK };

  r.post(
    '/api/v1/admin/updates/check',
    { schema: { response: { 200: UpdateCheckStateSchema } } },
    async (req, reply): Promise<UpdateCheckState> => {
      if (!(await isInstanceAdmin(deps, req))) throw notFound();
      const enabled = await scopedRead(deps.pools, req, (_tx, client) =>
        updateCheckEnabled(client, env),
      );
      if (!enabled) {
        throw conflict('Turn on "Check for new versions" first: Kept asks nothing until then.');
      }
      const result = await checkForUpdate({
        sourceUrl: deps.env.KEPT_SOURCE_URL,
        version: KEPT_VERSION,
      });
      const at = new Date();
      return scopedWrite(deps.pools, req, reply, async (tx, client) => {
        await storeUpdateCheck(client, result, at);
        await audited(tx, {
          locationId: null,
          ownerAccountId: null,
          actor: { type: 'user', id: requireScope(req).userId },
          action: 'instance.update_check',
          entity: { type: 'instance_settings', id: null },
          after: { latest: result.latest?.version ?? null, error: result.error },
          requestId: req.id,
        });
        return { status: 200, body: await readUpdateCheck(client, env) };
      });
    },
  );
}
