import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { rateLimited, requireScope } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import type { SecretKeys } from '../crypto/keyring.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError } from '../http/errors.js';
import { requireHttps } from '../http/https-only.js';
import { locationOfPlace, locationOfThing } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead } from '../http/write.js';
import {
  type Ctx,
  clearSecret,
  getPolicy,
  MAX_SECRET_CHARS,
  putPolicy,
  revealSecret,
  SecretPolicySchema,
  type Subject,
  type SubjectKind,
  secretCopied,
  setSecret,
  subjectOf,
} from './service.js';

// Secret values, reveal and policies (plan T19), in the shapes of the web contract
// (apps/web/src/api/inventory/{types,paths}.ts, mock/things.ts and mock/registries.ts):
//
// PUT    /api/v1/{things|places}/:id/secrets/:fieldKey {value}       → 204  (things.edit;
//                                                     409 recovery_kit_required, D193)
// DELETE /api/v1/{things|places}/:id/secrets/:fieldKey               → 204  (things.edit)
// POST   /api/v1/{things|places}/:id/secrets/:fieldKey/reveal        → {value, revealedUntil}
//                                                     (the field's policy; 404 otherwise;
//                                                     30 an hour per person, then 429)
// POST   /api/v1/{things|places}/:id/secrets/:fieldKey/copied        → 204  (the same policy)
// GET    /api/v1/locations/:locationId/secret-policies/:typeFieldId → SecretPolicy (owner)
// PUT    /api/v1/locations/:locationId/secret-policies/:typeFieldId → SecretPolicy (owner)
//
// All of them belong to the `secrets` module (§7.6): off in the location, a read is 404 and a
// write 409 `module_off`.
//
// The value routes run in their own scoped transaction, not scopedWrite(): an Idempotency-Key
// would store the reveal's body (the value) in idempotency_keys, and a hash of a PUT's body (a
// short PIN's hash is a brute-force away from the PIN). Setting a value twice is harmless, and
// a reveal is not a change to repeat or not. Nothing here logs a body; the request log carries
// the method and the URL only (http/logger.ts).

/** Reveals per person per hour, across every value (security review #17). Enough for a busy
 * day at home; not enough to walk every secret of a large location. */
export const REVEALS_PER_HOUR = 30;

const SubjectParams = z.object({ id: z.uuid(), fieldKey: z.string().min(1).max(64) });
const PolicyParams = z.object({ locationId: z.uuid(), typeFieldId: z.uuid() });
const SetBody = z.strictObject({ value: z.string().min(1).max(MAX_SECRET_CHARS) });
const RevealSchema = z.object({ value: z.string(), revealedUntil: z.string() });
const PutPolicyBody = z.strictObject({
  revealRoles: SecretPolicySchema.shape.revealRoles.max(4),
  revealUserIds: SecretPolicySchema.shape.revealUserIds.max(200),
  aiAllowed: z.boolean(),
});

type SubjectReq = FastifyRequest<{ Params: z.infer<typeof SubjectParams> }>;

export async function secretRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  /** The keys, or 503 on an app started without them (tests that don't need secrets). */
  const keys = (): SecretKeys => {
    if (!deps.secretKeys) {
      throw new AppError('internal', 503, 'Secret values are not configured on this server.');
    }
    return deps.secretKeys;
  };

  /** One scoped transaction for the request's user, with the subject found first. */
  const inScope = <T>(
    req: SubjectReq,
    kind: SubjectKind,
    fn: (ctx: Ctx, subject: Subject) => Promise<T>,
  ): Promise<T> =>
    withScope(pools.app, requireScope(req), async (tx, client) => {
      const scope = requireScope(req);
      const subject = await subjectOf(
        client,
        kind,
        req.params.id.toLowerCase(),
        req.params.fieldKey,
      );
      return fn({ tx, client, scope, requestId: req.id }, subject);
    });

  const httpsOnly = requireHttps(deps.env.KEPT_PUBLIC_URL);

  const noStore = (reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    reply.header('pragma', 'no-cache');
  };

  for (const kind of ['thing', 'place'] as const) {
    const base = `/api/v1/${kind}s/:id/secrets/:fieldKey`;
    const config = {
      module: 'secrets' as const,
      moduleLocation: kind === 'thing' ? locationOfThing(pools) : locationOfPlace(pools),
    };

    app.put(
      base,
      { config, schema: { params: SubjectParams, body: SetBody } },
      async (req, reply) => {
        const k = keys();
        await inScope(req, kind, (ctx, s) => setSecret(ctx, k, s, req.body.value));
        noStore(reply);
        return reply.code(204).send();
      },
    );

    app.delete(base, { config, schema: { params: SubjectParams } }, async (req, reply) => {
      await inScope(req, kind, (ctx, s) => clearSecret(ctx, s));
      return reply.code(204).send();
    });

    app.post(
      `${base}/reveal`,
      {
        config,
        // Never over plain HTTP (D181; step-8 T24): 403 `https_required`.
        preHandler: httpsOnly,
        schema: { params: SubjectParams, response: { 200: RevealSchema } },
      },
      async (req, reply) => {
        const k = keys();
        // Every attempt counts, a 404 too, so the limit also bounds probing (review #17).
        const limit = await reserveInWindow(
          pools.auth,
          limiterKey('secret-reveal', requireScope(req).userId),
          REVEALS_PER_HOUR,
          3600,
        );
        if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);
        const result = await inScope(req, kind, (ctx, s) => revealSecret(ctx, k, s));
        noStore(reply);
        return result;
      },
    );

    app.post(
      `${base}/copied`,
      { config, schema: { params: SubjectParams } },
      async (req, reply) => {
        await inScope(req, kind, (ctx, s) => secretCopied(ctx, s));
        return reply.code(204).send();
      },
    );
  }

  const policyPath = '/api/v1/locations/:locationId/secret-policies/:typeFieldId';

  app.get(
    policyPath,
    {
      config: { module: 'secrets' },
      schema: { params: PolicyParams, response: { 200: SecretPolicySchema } },
    },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        getPolicy(
          client,
          req.params.locationId.toLowerCase(),
          req.params.typeFieldId.toLowerCase(),
        ),
      ),
  );

  app.put(
    policyPath,
    {
      config: { module: 'secrets' },
      schema: { params: PolicyParams, body: PutPolicyBody, response: { 200: SecretPolicySchema } },
    },
    (req) =>
      withScope(pools.app, requireScope(req), (tx, client) =>
        putPolicy(
          { tx, client, scope: requireScope(req), requestId: req.id },
          req.params.locationId.toLowerCase(),
          req.params.typeFieldId.toLowerCase(),
          req.body,
        ),
      ),
  );
}
