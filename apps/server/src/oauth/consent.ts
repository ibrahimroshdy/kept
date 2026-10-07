import { OAUTH_SCOPES, TOKEN_SCOPES, type TokenScope } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { AUTH_BASE_PATH, type Auth } from '../auth/auth.js';
import type { Scope, Tx } from '../db/scope.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import { withoutBidiControls } from '../http/untrusted.js';
import { requireMembership } from '../locations/access.js';
import { ownAccount } from '../tokens/service.js';

// The consent step (step-6 plan T12; D179, D180; spike S6.2 §5). Better Auth's authorize sends
// the browser to Kept's `/oauth/consent?<signed query>`; that page (T22) asks for the scope
// (read, or read and change) and the locations (one by default), then posts here. One request:
// kept.token_oauth_grant() writes the `oauth` grant row (as the consenting user, no token), and
// Better Auth's own consent endpoint, given the same signed query and the narrowed scope,
// answers the redirect back to the client with its code. Either failing undoes both: the grant
// is written in this transaction, which rolls back if Better Auth refuses.
//
// The client's name and URI are as it calls itself (its metadata document): untrusted text the
// page bidi-isolates and marks (D179). Its logo is never fetched or shown.

export const ConsentQuery = z.looseObject({
  client_id: z.string().min(1).max(400),
  scope: z.string().max(400).optional(),
});

export const ConsentViewSchema = z.object({
  client: z.object({ name: z.string(), uri: z.string().nullable() }),
  requestedScopes: z.array(z.string()),
  locations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      /** So the page names the Personal location in the reader's language. */
      kind: z.string(),
      role: z.enum(['owner', 'admin', 'member', 'viewer']),
      canWrite: z.boolean(),
    }),
  ),
});

export const ConsentBody = z.object({
  accept: z.boolean(),
  scope: z.enum(TOKEN_SCOPES),
  locationIds: z.array(z.uuid()).max(100).default([]),
});
export type ConsentBody = z.infer<typeof ConsentBody>;

export const ConsentResultSchema = z.object({ redirectTo: z.string() });

/** The OAuth scopes a Kept scope grants. */
export const oauthScopesOf = (scope: TokenScope): string =>
  scope === 'write' ? `${OAUTH_SCOPES.read} ${OAUTH_SCOPES.write}` : OAUTH_SCOPES.read;

type Client = { name: string; uri: string | null };

/** The client as Better Auth stored it from its metadata (auth.oauth_client, kept_auth). */
export async function clientOf(authPool: pg.Pool, clientId: string): Promise<Client> {
  const { rows } = await authPool.query<{ name: string | null; uri: string | null }>(
    `SELECT name, uri FROM auth.oauth_client
      WHERE client_id = $1 AND coalesce(disabled, false) = false`,
    [clientId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  const name = withoutBidiControls(row.name ?? '').trim();
  return {
    name: name || withoutBidiControls(clientId),
    uri: row.uri === null ? null : withoutBidiControls(row.uri),
  };
}

/** GET /api/v1/oauth/consent: what the page shows. */
export async function consentView(
  client: pg.ClientBase,
  app: Client,
  requestedScope: string | undefined,
): Promise<z.infer<typeof ConsentViewSchema>> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    kind: string;
    role: 'owner' | 'admin' | 'member' | 'viewer';
  }>(
    `SELECT l.id, l.name, l.kind, m.role FROM public.memberships m
       JOIN public.locations l ON l.id = m.location_id
      WHERE m.user_id = kept.current_user_id()
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND l.id IN (SELECT kept.visible_location_ids())
      ORDER BY lower(l.name), l.id`,
  );
  return {
    client: app,
    requestedScopes: (requestedScope ?? '').split(' ').filter(Boolean),
    locations: rows.map((r) => ({ ...r, canWrite: r.role !== 'viewer' })),
  };
}

/** Better Auth's consent endpoint, called as the signed-in user with the page's signed query. */
async function betterAuthConsent(
  auth: Auth,
  publicUrl: string,
  headers: Headers,
  body: { accept: boolean; scope?: string; oauth_query: string },
): Promise<string> {
  const h = new Headers(headers);
  h.set('content-type', 'application/json');
  h.set('accept', 'application/json');
  const res = await auth.handler(
    new Request(new URL(`${AUTH_BASE_PATH}/oauth2/consent`, publicUrl), {
      method: 'POST',
      headers: h,
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json().catch(() => null)) as {
    url?: string;
    redirect_uri?: string;
  } | null;
  const to = json?.url ?? json?.redirect_uri;
  if (!res.ok || !to) {
    throw new AppError('validation', 400, 'This request expired or is not valid; start again.');
  }
  return to;
}

export type ConsentCtx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  auth: Auth;
  authPool: pg.Pool;
  publicUrl: string;
  headers: Headers;
};

/** POST /api/v1/oauth/consent?<the signed query>. */
export async function decide(
  ctx: ConsentCtx,
  oauthQuery: string,
  clientId: string,
  body: ConsentBody,
): Promise<{ redirectTo: string }> {
  const app = await clientOf(ctx.authPool, clientId);
  const account = await ownAccount(ctx.tx);
  if (!body.accept) {
    await audited(ctx.tx, {
      locationId: null,
      ownerAccountId: account,
      actor: actorOf(ctx.scope),
      action: 'oauth.deny',
      entity: { type: 'oauth_client', id: null },
      after: { clientName: app.name },
      requestId: ctx.requestId,
    });
    const redirectTo = await betterAuthConsent(ctx.auth, ctx.publicUrl, ctx.headers, {
      accept: false,
      oauth_query: oauthQuery,
    });
    return { redirectTo };
  }
  const locationIds = [...new Set(body.locationIds.map((id) => id.toLowerCase()))];
  if (locationIds.length === 0) throw invalid('Pick at least one location.');
  for (const id of locationIds) await requireMembership(ctx.client, id);
  const { rows } = await ctx.client.query<{ id: string }>(
    'SELECT kept.token_oauth_grant(kept.current_user_id(), $1, $2, $3::uuid[], $4) AS id',
    [clientId, body.scope, locationIds, app.name.slice(0, 80)],
  );
  const tokenId = rows[0]?.id as string;
  await audited(ctx.tx, {
    locationId: null,
    ownerAccountId: account,
    actor: actorOf(ctx.scope),
    action: 'oauth.grant',
    entity: { type: 'api_token', id: tokenId },
    after: { clientName: app.name, scope: body.scope, locationIds },
    requestId: ctx.requestId,
  });
  const redirectTo = await betterAuthConsent(ctx.auth, ctx.publicUrl, ctx.headers, {
    accept: true,
    scope: oauthScopesOf(body.scope),
    oauth_query: oauthQuery,
  });
  return { redirectTo };
}
