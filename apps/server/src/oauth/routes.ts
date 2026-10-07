import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import type { FastifyRequest } from 'fastify';
import { authHeaders } from '../auth/http.js';
import type { KeptApp } from '../http/app.js';
import { notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  ConsentBody,
  ConsentQuery,
  ConsentResultSchema,
  ConsentViewSchema,
  clientOf,
  consentView,
  decide,
} from './consent.js';
import { hasOAuthProvider } from './verify.js';

// OAuth connectors (step-6 plan T12; D93, D125, V15; spike S6.2).
//
// The discovery documents, at the root, where MCP clients look for them (the official client
// never looks under `/api/v1/auth/`, S6.2 §2): RFC 8414's authorization-server metadata, bare and
// with Better Auth's base path inserted (oauthProviderAuthServerMetadata, which answers both),
// and RFC 9728's protected-resource metadata, bare and for `/mcp` (the mcp plugin answers those
// itself when the root request is forwarded to Better Auth unchanged). The AS metadata
// advertises `client_id_metadata_document_supported` and no registration endpoint (DCR off,
// Q8). With OAuth off (no https public URL, D125) they stay JSON 404s, and http/web.ts keeps
// `/.well-known/` out of the SPA fallback.
//
// GET  /api/v1/oauth/consent?<the plugin's query> → {client: {name, uri}, requestedScopes,
//                                                   locations: [{id, name, role, canWrite}]}
// POST /api/v1/oauth/consent?<the plugin's query>  {accept, scope, locationIds} → {redirectTo}
//      audited oauth.grant / oauth.deny (oauth/consent.ts)

export const WELL_KNOWN_PATHS = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/api/v1/auth',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
] as const;

const OFF_HINT = 'Connecting apps needs Kept at an https address.';

/** The request as Better Auth would see it at our public origin (never the client's Host). */
function webRequest(req: FastifyRequest, publicUrl: string): Request {
  const headers = new Headers();
  for (const name of ['accept', 'accept-language', 'user-agent']) {
    const v = req.headers[name];
    if (typeof v === 'string') headers.set(name, v);
  }
  return new Request(new URL(req.url, new URL(publicUrl).origin), { method: 'GET', headers });
}

/** The raw query string of a request, without the `?`. */
const queryOf = (req: FastifyRequest) => {
  const i = req.url.indexOf('?');
  return i < 0 ? '' : req.url.slice(i + 1);
};

export async function oauthRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const auth = hasOAuthProvider(deps.auth) ? deps.auth : null;
  const publicUrl = deps.env.KEPT_PUBLIC_URL;
  const trustedProxies = deps.env.KEPT_TRUSTED_PROXIES ?? [];
  const asMetadata = auth ? oauthProviderAuthServerMetadata(auth as never) : null;

  for (const url of WELL_KNOWN_PATHS) {
    app.get(url, { config: { auth: 'none' }, schema: { hide: true } }, async (req, reply) => {
      if (!auth || !asMetadata) throw notFound();
      const request = webRequest(req, publicUrl);
      const res = url.startsWith('/.well-known/oauth-authorization-server')
        ? await asMetadata(request)
        : await auth.handler(request);
      return reply.send(res);
    });
  }

  app.get(
    '/api/v1/oauth/consent',
    { schema: { querystring: ConsentQuery, response: { 200: ConsentViewSchema } } },
    async (req) => {
      if (!auth) throw notFound(OFF_HINT);
      const client = await clientOf(pools.auth, req.query.client_id);
      return scopedRead(pools, req, (_tx, c) => consentView(c, client, req.query.scope));
    },
  );

  app.post(
    '/api/v1/oauth/consent',
    {
      schema: {
        querystring: ConsentQuery,
        body: ConsentBody,
        response: { 200: ConsentResultSchema },
      },
    },
    (req, reply) => {
      if (!auth) throw notFound(OFF_HINT);
      const headers = authHeaders(req, trustedProxies);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await decide(
          {
            tx,
            client,
            scope,
            requestId: req.id,
            auth,
            authPool: pools.auth,
            publicUrl,
            headers,
          },
          queryOf(req),
          req.query.client_id,
          req.body,
        ),
      }));
    },
  );
}
