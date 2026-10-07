import { KEPT_VERSION, RecoveryKitDownloadInput } from '@kept/shared';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { audited } from '../audit/audited.js';
import { requireScope } from '../auth/http.js';
import { requireReauthentication } from '../auth/reauth.js';
import { readBackupForKit } from '../backup/recovery-kit-source.js';
import { type KeyMaterial, readKeyMaterial } from '../config/env.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, notFound } from '../http/errors.js';
import { requireHttps } from '../http/https-only.js';
import type { InventoryDeps } from '../http/routes.js';
import { recordRecoveryKitDownload } from '../setup/recovery-kit.js';
import {
  kitKeysOf,
  RECOVERY_KIT_CONTENT_TYPE,
  type RecoveryKitInput,
  recoveryKitFilename,
  renderRecoveryKit,
} from '../setup/recovery-kit-content.js';

// The recovery kit's download from the web (D66, D165, D182; step-8 plan T9, screens §8):
//
// POST /api/v1/admin/recovery-kit/download {password?, format} → the kit as an attachment
//
// - instance admins only: 404 for anyone else (nothing to see);
// - over https only (D181): 403 `https_required` while KEPT_PUBLIC_URL is http (requireHttps);
// - re-authentication (D176, auth/reauth.ts): the password, or for an account without one a
//   sign-in within the last ten minutes (a passkey counts); else 403 `reauth_required` with
//   `reauth: 'password' | 'sign_in'`, and nothing recorded;
// - `Cache-Control: no-store`; the kit is built in memory for this one response;
// - not through the Idempotency-Key store (the body carries a password, and a replay would keep
//   the kit): its own scoped transaction, as the secret-value routes do;
// - audited `instance.recovery_kit_download` with the format only, never the content; records the
//   download (setup/recovery-kit.ts), which counts as the acknowledgement when none exists.
//
// `GET /api/v1/admin/recovery-kit` (its state, with `downloadedAt` and `stale`) and the
// acknowledgement stay in admin/routes.ts.
//
// The keys are read the way the server read them at boot (config/env.ts readKeyMaterial: the
// environment, else the config volume's secrets.json), as `kept admin recovery-kit` does. The
// backup half comes through backup/recovery-kit-source.ts (T10 fills it in).

export async function recoveryKitRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools, env } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/api/v1/admin/recovery-kit/download',
    {
      preHandler: requireHttps(env.KEPT_PUBLIC_URL),
      schema: { body: RecoveryKitDownloadInput },
    },
    async (req, reply) => {
      const scope = requireScope(req);
      const admin = await withScope(pools.app, scope, async (_tx, client) => {
        const { rows } = await client.query<{ admin: boolean }>(
          'SELECT kept.is_instance_admin() AS admin',
        );
        return rows[0]?.admin === true;
      });
      if (!admin) throw notFound();
      if (!deps.auth) {
        throw new AppError('internal', 503, 'Sign-in is not configured on this server.');
      }
      await requireReauthentication(req, reply, {
        auth: deps.auth,
        pools,
        trustedProxies: env.KEPT_TRUSTED_PROXIES ?? [],
        password: req.body.password,
        hints: { stale: 'Sign in again, then download the recovery kit.' },
      });

      let keys: KeyMaterial;
      try {
        keys = await readKeyMaterial(process.env);
      } catch (err) {
        // EnvError messages name variables and paths, never a key.
        req.log.error({ code: (err as { code?: unknown }).code }, 'recovery kit: no keys to read');
        throw new AppError('internal', 503, "The server's keys could not be read.");
      }

      const format = req.body.format;
      const kit = await withScope(pools.app, scope, async (tx, client) => {
        const backup = await readBackupForKit({
          client,
          env: process.env,
          secretKeys: deps.secretKeys ?? null,
        });
        await recordRecoveryKitDownload(client);
        await audited(tx, {
          locationId: null,
          ownerAccountId: null,
          actor: { type: 'user', id: scope.userId },
          action: 'instance.recovery_kit_download',
          entity: { type: 'instance_settings', id: null },
          after: { format },
          requestId: req.id,
        });
        const input: RecoveryKitInput = {
          generatedAt: new Date(),
          publicUrl: env.KEPT_PUBLIC_URL,
          version: KEPT_VERSION,
          revision: process.env.KEPT_REVISION?.trim() || null,
          keys: kitKeysOf(keys),
          backup,
        };
        return { input, content: renderRecoveryKit(input, format) };
      });

      return reply
        .code(200)
        .header('content-type', RECOVERY_KIT_CONTENT_TYPE[format])
        .header(
          'content-disposition',
          `attachment; filename="${recoveryKitFilename(kit.input.generatedAt, format)}"`,
        )
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .header('x-content-type-options', 'nosniff')
        .send(kit.content);
    },
  );
}
