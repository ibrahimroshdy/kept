import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import { requireHttps } from '../http/https-only.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { ChangesQuery, ConnectionChangesPageSchema, connectionChanges } from './recent-changes.js';
import {
  CreatedTokenSchema,
  type CreateResult,
  CreateTokenBody,
  CrossLocationWarningSchema,
  clientNamesFrom,
  createToken,
  forgetOAuthClient,
  listTokens,
  redactCreated,
  renameToken,
  revokeToken,
  TokenRowSchema,
  TokensPageSchema,
  TokensQuery,
  UpdateTokenBody,
} from './service.js';

// Personal tokens, connected apps and "Recent changes by connections" (step-6 plan T10; screens
// §5; D58, D63, D179, D180). The web contract is apps/web/src/api/connections/types.ts.
//
// GET    /api/v1/tokens?cursor&limit&kind      → {items: [TokenRow], next_cursor}
// POST   /api/v1/tokens                        {name, scope, locationIds, expiresAt?,
//                                               confirmCrossLocation?}
//                                              → 201 {token, secret, clientConfigs}
//                                              | 200 {warning: 'cross_location_write'} (D179)
// PATCH  /api/v1/tokens/:id (If-Match)         {name} → TokenRow
// DELETE /api/v1/tokens/:id                    → 204 (revoked_reason 'user'); an OAuth app's
//                                                consent and refresh tokens go too (T12)
// GET    /api/v1/connections/changes?cursor&tokenId → {items: [ConnectionChange], next_cursor}
//
// None is open to a token (tokens/access.ts): a token never manages tokens (D180), and RLS
// refuses it anyway (0070). Audited: token.create, token.update, token.revoke (account-level
// events of the person's own account; the secret is never in one).

const Params = z.object({ id: z.uuid() });

export async function tokenRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const key = deps.tokenKey ?? randomBytes(32);
  const names = clientNamesFrom(pools.auth ?? null);
  const publicUrl = deps.env.KEPT_PUBLIC_URL;

  app.get(
    '/api/v1/tokens',
    { schema: { querystring: TokensQuery, response: { 200: TokensPageSchema } } },
    (req) => scopedRead(pools, req, (_tx, client) => listTokens(client, req.query, names)),
  );

  app.post(
    '/api/v1/tokens',
    {
      // Never over plain HTTP (D181; step-8 T24): 403 `https_required`.
      preHandler: requireHttps(publicUrl),
      schema: {
        body: CreateTokenBody,
        response: { 200: CrossLocationWarningSchema, 201: CreatedTokenSchema },
      },
    },
    (req, reply) =>
      scopedWrite<CreateResult['body']>(
        pools,
        req,
        reply,
        async (tx, client, scope) => {
          const result = await createToken({ tx, client, scope, requestId: req.id }, req.body, {
            key,
            publicUrl,
            names,
          });
          return result.kind === 'warning'
            ? { status: 200, body: result.body }
            : { status: 201, body: result.body };
        },
        { redact: redactCreated },
      ),
  );

  app.patch(
    '/api/v1/tokens/:id',
    { schema: { params: Params, body: UpdateTokenBody, response: { 200: TokenRowSchema } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await renameToken(
          { tx, client, scope, requestId: req.id },
          req.params.id.toLowerCase(),
          req.body.name,
          expected,
          names,
        ),
      }));
    },
  );

  app.delete('/api/v1/tokens/:id', { schema: { params: Params } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      const revoked = await revokeToken(
        { tx, client, scope, requestId: req.id },
        req.params.id.toLowerCase(),
      );
      const clientId = revoked.oauthClientId;
      return {
        status: 204,
        body: undefined,
        // The grant row already refuses the app's next call (mcp/auth.ts reads it every time);
        // this clears Better Auth's side so the app must ask for consent again.
        ...(clientId && pools.auth
          ? { afterCommit: () => forgetOAuthClient(pools.auth, scope.userId, clientId) }
          : {}),
      };
    }),
  );

  app.get(
    '/api/v1/connections/changes',
    { schema: { querystring: ChangesQuery, response: { 200: ConnectionChangesPageSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        connectionChanges(tx, client, scope, req.query),
      ),
  );
}
