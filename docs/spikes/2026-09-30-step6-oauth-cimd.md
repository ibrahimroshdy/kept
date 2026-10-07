# Spike S6.2 (V15): Better Auth as the OAuth server for `/mcp`, with CIMD

Date: 2026-09-30. Step-6 plan, Task 0 (it feeds T2, T7, T11, T12 and T22). Result:

- **Local half: PASS.** The official MCP client (`@modelcontextprotocol/client` 2.2.0) completed
  discovery from a 401, then authorization code + PKCE (S256) with a **CIMD `client_id` URL**
  served by a local self-signed HTTPS fixture. It got a consent page with the client's name,
  exchanged the code, and called a tool on a `createMcpHandler` endpoint. DCR was off (`POST
  /oauth2/register` → 403). Every metadata fetch went through **Kept's own `guardedFetch`**
  (`apps/server/src/net/ssrf.ts`, imported unchanged). It worked on both the 2025-11-25 and the
  2026-07-28 protocol, and with both token-verification paths.
  - **One caveat, stated exactly.** The successful fetch ran with `guardedFetch({allowPrivate:
    true})`. A fixture on this laptop can only be reached at a loopback address, and the guard's
    whole job is to refuse loopback. With `allowPrivate: false`, the same code path refused the
    same fixture (`PrivateAddressError(127.0.0.1)`), refused a name that the injected resolver
    mapped to `10.0.0.5`, and refused a 302. So each property is proven on the same transport,
    but no single run shows "guard on" and "success" together. That needs a fixture on a public
    address, which is what the maintainer check provides.
- **V15 (claude.ai, ChatGPT, Claude Desktop): maintainer check pending.** It needs a public
  HTTPS URL. `serve.ts` and the steps are below.
  - The installed packages' docs and types say nothing about which real clients use CIMD or
    DCR (searched for claude.ai, ChatGPT and Claude Desktop: no hits).
- **Three findings that change T12:**
  1. The discovery documents **must be mounted at the root**. The official client never looks
     under `/api/v1/auth/`.
  2. A client that sends **no `resource` gets an opaque token that `/mcp` refuses**.
  3. `jwt()` exposes a **session JWT** (`GET /api/v1/auth/token` and a `set-auth-jwt` header on
     `get-session`) that Kept must switch off.

Verdict: **local half PASS** (with the `allowPrivate` caveat above); **V15: maintainer check
pending**.

Code: `docs/spikes/code/step6/oauth/` (own `package.json` and lockfile, npm, exact pins;
`node_modules` deleted after the run):
- `auth.ts`: a copy of `apps/server/src/auth/auth.ts`'s `createAuth` with `jwt()`, `mcp()` and
  `cimd()` added. It leaves out keptSecurity, passkey and the mailers (see "Not covered").
- `cimd-fetch.ts`: the `ClientMetadataResourceFetch` on Kept's `guardedFetch`. This is T12's
  `cimd-fetch.ts` in outline.
- `lib.ts`: the scratch database and the stand-in server. Better Auth runs at `/api/v1/auth/*`;
  there are root `/.well-known/*` mounts; `POST /mcp` sits behind either verifier.
- `run.ts`: the local flow and every check below. It writes `results.json`, the last full run
  (no tokens in it: lengths, claims and 12-character prefixes only).
- `serve.ts`: the maintainer's real-client run.
- `auth-cli.config.ts` and `generated/auth-schema.cli.ts`: the Better Auth CLI's raw output.
- `schema/kept-auth-base.ts`: a copy of Kept's `db/schema/auth.ts`.
- `schema/oauth-tables.ts`: the new tables, adjusted for Kept.
- `generated/oauth-tables.sql`: the drizzle-kit delta that creates them.

## Versions (`npm view` on 2026-09-30; lockfile resolution)

| Package | Version | Licence |
|---|---|---|
| `better-auth` | 1.7.6 (`@better-auth/core` 1.7.6) | MIT |
| `@better-auth/oauth-provider` | 1.7.6 | MIT |
| `@better-auth/mcp` | 1.7.6 (deps `jose ^6.1.3`, `@better-auth/oauth-provider ^1.7.6`) | MIT |
| `@better-auth/cimd` | 1.7.6 (exports `.` and `./node`) | MIT |
| `@modelcontextprotocol/server` | 2.2.0 (`@modelcontextprotocol/core` 2.2.0) | MIT |
| `@modelcontextprotocol/client` | 2.2.0 | MIT |
| `auth` (the Better Auth CLI, dev only) | 1.7.6 | MIT |
| `jose` (transitive) | 6.2.12 | MIT |

Also Node 24.21.0; `drizzle-orm` 0.45.3 and `pg` 8.23.0, as in `apps/server`; and `drizzle-kit`
0.31.11 from `apps/server` to emit the SQL.

## What was proven

### 1. Configuration (names read from the `.d.mts` files)

```ts
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { jwt } from 'better-auth/plugins/jwt';

plugins: [
  …Kept's existing plugins,
  jwt(),
  mcp({                                    // McpOptions extends OAuthOptions<Scope[]>
    loginPage: '/signin',
    consentPage: '/oauth/consent',
    resource: `${KEPT_PUBLIC_URL}/mcp`,    // https, or http on a loopback host only
    scopes: ['kept:read', 'kept:write'],   // Scope = LiteralString | 'openid'|'profile'|'email'|'offline_access'
    allowDynamicClientRegistration: false, // the default; so is allowUnauthenticatedClientRegistration
    accessTokenExpiresIn: 3600,
  }),
  cimd({ fetchClientMetadataResource: cimdFetch, metadataProfile: 'mcp-2026-07-28' }),
]
```

- `mcp()` **is** `oauthProvider()`: it cannot be combined with a separate `oauthProvider`.
- `mcp()` sets `refreshTokenReuseInterval: 30`.
- At startup, oauth-provider's `init` **writes** an `oauth_resource` row for the resource
  (`seedResources`). That is a runtime write as kept_auth, which is fine. It also means S1's
  `drizzleAdapter({}, …)` stub for the CLI crashes (see §4).
- The AS metadata advertises `client_id_metadata_document_supported: true`,
  `code_challenge_methods_supported: ['S256']` and `scopes_supported: ['kept:read',
  'kept:write']`. With DCR off it has **no `registration_endpoint`**. With no `openid` scope,
  `/.well-known/openid-configuration` is 404 everywhere.

### 2. Where the discovery documents are served (read from the running server)

With **only** `/api/v1/auth/*` routed to `auth.handler` (Kept's mount today):

| GET | Status |
|---|---|
| `/api/v1/auth/.well-known/oauth-authorization-server` | **200** (issuer `<base>/api/v1/auth`) |
| `/api/v1/auth/.well-known/oauth-protected-resource[/mcp]` | 404 |
| `/api/v1/auth/.well-known/openid-configuration` | 404 |
| `/api/v1/auth/jwks` | 200 |
| any root `/.well-known/*` | not routed |

The official client's own requests during the flow were:

```
POST /mcp -> 401   (WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp")
GET  /.well-known/oauth-protected-resource/mcp -> 200
GET  /.well-known/oauth-authorization-server/api/v1/auth -> 200     (RFC 8414 path insertion)
```

`buildDiscoveryUrls('<base>/api/v1/auth')` in client 2.2.0 tries these, in order:
1. `oauth /.well-known/oauth-authorization-server/api/v1/auth`
2. `oidc /.well-known/openid-configuration/api/v1/auth`
3. `oidc /api/v1/auth/.well-known/openid-configuration`

With the protected-resource document mounted but **not** the AS metadata at the root, discovery
returned `undefined`: all three answered 404. **It never tries
`/api/v1/auth/.well-known/oauth-authorization-server`, which is the one Better Auth serves.**

**So both must be re-mounted at the root.** What worked:
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-authorization-server/api/v1/auth`
  → `oauthProviderAuthServerMetadata(auth)` (exported by `@better-auth/oauth-provider`: "Useful
  when basePath prevents the endpoint from being located at the root"). It answers both paths
  with the same document.
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`
  → `auth.handler(request)` **unchanged**. The mcp plugin's `onRequest` matches the **full
  pathname** against `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/<resource path>`, so it only answers when a root request
  is forwarded to the handler. Under the base path it is 404. The document is `{resource:
  '<base>/mcp', authorization_servers: ['<base>/api/v1/auth'], bearer_methods_supported:
  ['header'], dpop_signing_alg_values_supported, scopes_supported: ['kept:read','kept:write']}`.

### 3. Access tokens: JWTs, and both verifiers work

With `resource` sent (the SDK sends it), the token is `token_type: 'Bearer'`, `expires_in: 3600`.
There is **no refresh token**: `offline_access` wasn't requested. It is a **JWT**:
- header `{typ: 'at+jwt', alg: 'EdDSA', kid}`;
- claims `{sub: <user id>, aud: '<base>/mcp', client_id: <the CIMD URL>, azp: <same>, scope:
  'kept:read kept:write', sid: <session id>, iss: '<base>/api/v1/auth', iat, exp, jti}`;
- no `cnf` (not DPoP-bound).

**JWT access tokens are not stored**: `auth.oauth_access_token` had 0 rows after the flow. The
consent is stored (`oauth_consent`, 1 row), and so is the client (`oauth_client`, see §5).

| Path | How | Result |
|---|---|---|
| A: `requireMcpAuth(auth, handler, {resource})` from `@better-auth/mcp` | verifies signature, `iss` (default `baseURL` = `<base>/api/v1/auth`), `aud` = resource, `exp`. Supports DPoP (replay store on the auth adapter) | tool call OK. **It fetched `<baseURL>/jwks` over HTTP** (`GET /api/v1/auth/jwks` in the server log), because `jwksUrl` defaults to `${baseURL}/jwks` and `verifyAccessTokenRequest` takes only a URL string (`VerifyAccessTokenOptions.jwksUrl?: string`). In production that is Kept calling its own **public** URL (a hairpin through the proxy or tunnel) |
| B: `verifyBearerToken(header, {verifier, resourceMetadataUrl})` from `@modelcontextprotocol/server`, with a custom `OAuthTokenVerifier` | `verifyAccessToken(token)` calls `verifyJwsAccessToken(token, {jwksFetch: () => auth.api.getJwks(), jwksCacheKey, verifyOptions: {issuer, audience: resource}})` from `better-auth/oauth2`. That is **in-process, no HTTP**, and returns `AuthInfo {token, clientId: azp, scopes, expiresAt: exp, resource, extra: {sub}}` | tool call OK. Failures go through `bearerAuthChallengeResponse` (401, `Bearer error="invalid_token", …, resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"`) |

Both refused the jwt plugin's session JWT (§6). Path B also refused `not-a-token` with 401.

**`McpRequestContext.authInfo` reaches the factory.** The `whoami` tool returned `era`,
`clientId` (the CIMD URL), `scopes`, `resource` and `sub` on both paths, for:

| Client setting | Negotiated | `era` |
|---|---|---|
| default (`versionNegotiation` `'legacy'`) | `protocolVersion` 2025-11-25 | `'legacy'` |
| `new Client(info, {versionNegotiation: {mode: 'auto'}})` | 2026-07-28 | `'modern'` |

The handler ran with `createMcpHandler(factory, {legacy: 'stateless', responseMode: 'json'})`.
The SDK logs once: `responseMode: 'json' drops mid-call notifications`.

### 4. The tables (Better Auth CLI → schema `auth`, run as kept_auth)

- **CLI command.** `auth@1.7.6 generate --config auth-cli.config.ts --adapter drizzle --dialect
  postgresql --output generated/auth-schema.cli.ts`.
  - S1's form (`database: drizzleAdapter({}, {provider: 'pg', schemaName: 'auth'})`) **crashes**
    here: `TypeError: Cannot read properties of undefined (reading 'fullSchema')`. The cause is
    oauth-provider's `init` → `seedResources` → `findOne` on the stub.
  - With the flags (no `database` in the config), the CLI emits `pgTable(...)` with `uuid` ids.
    `pgSchema('auth')`, `timestamptz` and `uuidv7()` defaults are applied by hand, as S1 did.
- **New tables** (`cimd()` adds none of its own): `jwks`, `oauth_client`, `oauth_resource`,
  `oauth_client_resource`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`,
  `oauth_client_assertion`. **No columns are added** to `user`, `session`, `account` or
  `verification`.
- **A trap like S2's `verification.id`.** **`oauth_client_assertion.id` must be `text`.**
  oauth-provider writes it with `forceAllowId: true` as a base64url digest of the assertion's
  `jti` (the private_key_jwt replay guard, `authorize-*.mjs`). No other table in these plugins
  forces an id: grepped for `forceAllowId: true`, where the only other hits are the organization
  plugin and test utils.
- **Applying and checking the tables.** `generated/oauth-tables.sql` is drizzle-kit's delta:
  `schema/kept-auth-base.ts` first, then plus `schema/oauth-tables.ts`. It was applied as
  kept_owner after Kept's migrations. Every new table is:
  - owned by `kept_owner`;
  - SELECT/INSERT/UPDATE/DELETE for `kept_auth` (migration 0000's default privileges, with no
    new grant needed);
  - **no SELECT for `kept_app` or `kept_system`**.

  The whole flow ran on a `kept_auth` pool (`current_user` = kept_auth). Better Auth's runtime
  schema check logged no mismatch.

### 5. CIMD and the consent page

- **The client row.** The authorize request triggered exactly one metadata fetch through the
  transport. `auth.oauth_client` got `{client_id: <URL>, client_discovery_id: 'cimd', name:
  <client_name>, token_endpoint_auth_method: 'none', redirect_uris: […], scopes:
  ['kept:read','kept:write'], user_id: null}`.
- **The client's name on the consent page.** Authorize sends the browser to
  `/oauth/consent?response_type&redirect_uri&scope&client_id&code_challenge&code_challenge_method&resource&exp&ba_iat&ba_param…&sig`
  (a signed query). The page gets the name from `GET /api/v1/auth/oauth2/public-client?client_id=…`
  (needs the session), which returned `{client_id, client_name: 'Murdock’s notebook (spike
  client)', client_uri, redirect_uris: []}`. The name is attacker-chosen text (D179).
- **Accepting.** `POST /api/v1/auth/oauth2/consent {accept: true, oauth_query: <the page's query
  without '?'>}` → `{redirect: true, url: '<redirect_uri>?code=…&iss=…'}`. The body schema also
  takes `scope` (a narrower set) and `claims`. The client's `finishAuth` checked `iss` (RFC 9207)
  and redeemed the code with PKCE.
- **Not signed in yet (check L1).** Authorize → `/signin?<signed query>`.
  `POST /sign-in/email {email, password, oauth_query: <that query>}` → `{redirect: true, url:
  '/oauth/consent?…'}`. **T22's sign-in page must post `oauth_query`.** That is what
  `oauthProviderClient()` (`@better-auth/oauth-provider/client`) adds from `window.location.search`.
- **Script fetches get JSON, not a 302.** A request without `sec-fetch-mode: navigate` (or with
  `Accept` other than HTML) gets `200 {redirect: true, url}` from authorize instead of a 302.
  Node's fetch always sends its own `sec-fetch-mode: cors`, so the spike read the URL from the
  body. A real browser navigation gets the 302 (from reading the code, not observed here).

### 6. `jwt()` exposes a session JWT

- **What was observed.** `GET /api/v1/auth/token` (with the session cookie) returned `{token:
  <JWT>}`, and `get-session` answered with a **`set-auth-jwt` header**. That JWT carries the
  user's `email`, `name`, `role`, `twoFactorEnabled` and more, with `iss` = `aud` = `<base>`
  (not `/api/v1/auth`), and lasts 15 minutes.
- **`/mcp` refuses it.** Both verifiers refused it at `/mcp` (401). Path B's reason was
  `unexpected "iss" claim value`.
- **Kept's mount doesn't cover it.** It strips `token` from JSON bodies but forwards response
  headers, so the header would reach the page.

**T12 adds `'/token'` to `DISABLED_AUTH_PATHS` and passes `jwt({disableSettingJwtHeader:
true})`.** Both names are in `better-auth/dist/plugins/jwt/types.d.mts`, and `/token` is the
jwt plugin's `getToken` endpoint path. OAuth's own token endpoint is `/oauth2/token` and is
unaffected. This was not re-run with those options.

### 7. Can `guardedFetch` replace `@better-auth/cimd/node`? Yes, with one fix

The plugin's requirement (`CimdOptions.fetchClientMetadataResource`) is: "resolve the hostname
exactly once, reject RFC 6890 special-use addresses, pin the approved address for the connection,
and refuse redirects".

| Requirement | `guardedFetch({allowPrivate: false})` | Evidence |
|---|---|---|
| Resolve once, connection pinned | the check runs **inside** the undici `Agent`'s `connect.lookup`, and the socket uses exactly the answers it checked. No separate pre-resolve, so no TOCTOU | N1: a public name (`127.0.0.1.nip.io`, real DNS) → `PrivateAddressError(127.0.0.1)` at connect. N2: injected `resolve` → `10.0.0.5` → `PrivateAddressError(10.0.0.5)` |
| Redirects refused | `redirect: 'error'`, always | N3: fixture 302 → `TypeError: fetch failed <- Error: unexpected redirect` |
| Special-use addresses refused | **partly**: see the gaps below | — |

For comparison, N4: Better Auth's own `@better-auth/cimd/node` transport on the loopback-resolving
name threw `metadata hostname must resolve only to public-routable addresses`. It uses
`node:https` with a pinned `lookup` and returns redirects unfollowed.

**The gaps.** `isPrivateAddress()` returns **false** for addresses that Better Auth's
`isPublicRoutableHost()` (`@better-auth/core/utils/host`, `classifyIPv4`/`classifyIPv6`) refuses.
All were run through `isPrivateAddress` on 2026-09-30:
- `192.88.99.0/24` (6to4 relay);
- `2002::/16` embedding a private IPv4 (e.g. `2002:7f00:1::`);
- Teredo `2001::/32`;
- `2001:2::/48` (benchmarking);
- IPv4-compatible `::a.b.c.d` (e.g. `::7f00:1`);
- IPv4-translated `::ffff:0:a.b.c.d`;
- `fec0::/10` (site-local);
- `3fff::/20` (documentation);
- `5f00::/16`;
- `64:ff9b:1::/48`.

Whether any of them reaches a local service from a Kept host is **not tested** (inferred:
unlikely on Linux, but not zero for 6to4/NAT64 setups). **T12 fix.** Add these ranges to
`PRIVATE_RANGES` in `net/ssrf.ts`, which is better for every guarded fetch. Or, in
`cimd-fetch.ts`, refuse too when `!isPublicRoutableHost(address)`, but only inside the lookup:
a pre-check would reintroduce the TOCTOU the plugin warns about.

**What the plugin already does, so T12's `cimd-fetch.ts` doesn't have to.** From
`fetchClientMetadataDocument` in `@better-auth/cimd` `dist/index.mjs`:
- `validateClientIdUrl`: https, an explicit path, no fragment, credentials or dot segments, and a
  host that is not special-use **syntactically**;
- `isMetadataDocumentUrlAllowed` if set;
- a **5 s** timeout (an `AbortSignal` in `init.signal`, which `guardedFetch` passes through);
- `redirect: 'error'` plus a `response.redirected` check;
- status 200 (or 304 with validators);
- a JSON `Content-Type`;
- a **5 KB** body cap (not the 64 KB in T12's text);
- the draft-02 / `mcp-2026-07-28` validation (`client_name` and `redirect_uris` required);
- origin binding of `client_uri` and `post_logout_redirect_uris`.

**The transport's own error never reaches the caller.** Any error it throws becomes
`invalid_client: Failed to fetch metadata document (network error or redirect blocked)`. Only
the transport's own log shows the guard's verdict, so T12 logs it (without the URL's query) for
the audit.

## The numbers (laptop, local fixture, `results.json`)

| Step | ms |
|---|---|
| first connect → 401 → both discovery documents → authorization URL | 18–74 |
| GET authorize (includes the CIMD fetch) | 60–90 |
| the CIMD fetch itself (`guardedFetch`, TLS to the fixture) | 27–38; **860** on the first run (cold DNS for the fixture's name) |
| POST consent | 17–23 |
| `finishAuth` (the SDK re-reads both discovery documents, then POSTs `/oauth2/token`) | 23–39 |
| connect + tools/list + tools/call, `requireMcpAuth` (first includes the JWKS HTTP fetch) | 26–69 |
| connect + tools/list + tools/call, `verifyBearerToken` (in-process JWKS) | 7–32 |
| refused fetches (N1–N4) | 1–28 |

## Negative checks (all as expected)

| # | Case | Result |
|---|---|---|
| N1 | client id on a public name that resolves to 127.0.0.1, guard on | 400 `invalid_client`; transport: `PrivateAddressError(127.0.0.1)` |
| N2 | client id resolving to 10.0.0.5 (injected resolver) | 400; `PrivateAddressError(10.0.0.5)` |
| N3 | metadata URL answers 302 | 400; `unexpected redirect` |
| N4 | `@better-auth/cimd/node` on N1's name | 400; `must resolve only to public-routable addresses` |
| N5 | `POST /oauth2/register` with DCR off | 403 `access_denied: Client registration is disabled` |
| N6 | `Bearer not-a-token` (path B) | 401 with `resource_metadata` |
| N7 | the jwt plugin's session JWT at `/mcp` | 401 on both paths |
| N8 | the same flow **without `resource`** | token 200, `Bearer`, **opaque** (32 chars), stored in `oauth_access_token`; `/mcp` → **401 on both paths** |

N8 matters for V15. The mcp plugin links the resource to CIMD clients (an
`oauth_client_resource` row was written for the flow's client), but a token request without
`resource` still gets an opaque token with no audience.

## What changes in the plan

**T2 (well-known stubs).** Reserve four root paths, not two:
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-authorization-server/api/v1/auth` (the path-insertion form the SDK requests)
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

All four are outside the SPA fallback.

**T7 (tables).**
- Use the CLI with `--adapter drizzle --dialect postgresql` and no `database`. S1's stub adapter
  crashes on oauth-provider's startup seeding.
- Take `docs/spikes/code/step6/oauth/schema/oauth-tables.ts` (8 tables) into `db/schema/auth.ts`,
  and add them to `betterAuthTables` keyed by model name (`jwks`, `oauthClient`,
  `oauthResource`, `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`,
  `oauthConsent`, `oauthClientAssertion`).
- **`oauth_client_assertion.id` is text.**
- The migration is `generated/oauth-tables.sql`. It has no `CREATE SCHEMA` line, so S1's
  `IF NOT EXISTS` edit isn't needed.
- No grant is needed: 0000's default privileges give kept_auth DML and kept_app nothing.
- The leak list gains these 8 tables.
- The plugin writes `oauth_resource` at every boot (insert-only by default,
  `resourceSeedMode: 'insertOnly'`).

**T11 (`mcp/auth.ts`).**
- Build the verifier on **path B**: `verifyBearerToken` with an `OAuthTokenVerifier` that uses
  `verifyJwsAccessToken` from `better-auth/oauth2` with `jwksFetch: () => auth.api.getJwks()`
  and a stable `jwksCacheKey`, and `verifyOptions: {issuer: KEPT_PUBLIC_URL + '/api/v1/auth',
  audience: KEPT_PUBLIC_URL + '/mcp'}`. Map `azp` → `clientId`, `scope` → `scopes`,
  `exp` → `expiresAt`.
- It fits the plan's single verifier for `kpt_` and OAuth tokens, and avoids `requireMcpAuth`'s
  HTTP fetch of Kept's own public `/jwks`.
- **Refuse any token with a `cnf` claim** (DPoP-bound). `verifyJwsAccessToken` does not check
  DPoP, and `requireMcpAuth` is the only helper that does, at the cost of the self-fetch.
  Clients got `Bearer` tokens here.
- The issuer includes `/api/v1/auth`. The session JWT's issuer doesn't, which is one of the
  reasons it is refused.

**T12.**
- `plugin.ts` as written, plus: `jwt({disableSettingJwtHeader: true})` and `'/token'` in
  `DISABLED_AUTH_PATHS` (§6).
- **Kept's `/api/v1/auth/*` mount answers 415 to `POST /oauth2/token`.** Fastify 5.12.5 parses only
  `application/json` and `text/plain` by default (`lib/content-type-parser.js`). The same
  mount, re-created with `app.inject`, gave `415 FST_ERR_CTP_INVALID_MEDIA_TYPE` for an
  `application/x-www-form-urlencoded` POST. OAuth's token, revoke and introspect endpoints are
  form-encoded. The mount needs a form parser that hands Better Auth the raw body (not
  `JSON.stringify(req.body)`).
- **Mount the root documents** as T2 lists: AS metadata via `oauthProviderAuthServerMetadata(auth)`,
  and protected-resource metadata by forwarding the request to `auth.handler` unchanged.
- **`cimd-fetch.ts`**: `guardedFetch({allowPrivate: false})` always, plus the `PRIVATE_RANGES`
  fix in §7.
  - Drop the 64 KB/5 s/JSON items from T12's text: the plugin enforces 5 KB/5 s/JSON itself.
  - Log the transport's own error, which the plugin swallows.
  - Tests:
    - the redirect and `10.0.0.5` cases work as T12 describes (the injected `resolve`);
    - **a success case can't pass the guard on a laptop**, so T12's full-flow test uses
      `allowPrivate: true` for the fixture, or `isMetadataDocumentUrlAllowed` plus a
      test-only transport, and says so;
    - an extra test pins the guard-on refusal of the same fixture.
- **The consent step.** `GET /oauth2/public-client` gives `client_name`/`client_uri` to the page.
  `POST /oauth2/consent {accept, scope, oauth_query}` accepts a narrower `scope`, so read-only
  consent works. Kept's `POST /api/v1/oauth/consent` calls it and then
  `kept.token_oauth_grant` (T12, unchanged).
- **T22's sign-in page** must post `oauth_query` when it was reached from authorize (check L1).
- **Revocation (Q7).** JWT access tokens are not stored and can't be revoked in Better Auth
  before `exp`. Kept's grant row, checked on every call, is the only revocation path. This
  confirms Q7's proposal.
- **Clients that don't send `resource` (N8).** If V15 shows one, `/mcp` refuses its opaque
  token. T12 then needs either a default audience for tokens without `resource`, or opaque-token
  verification through in-process introspection. Neither was tried here. Decide after V15.
- **Q8 (DCR).** Nothing in the installed packages says which real clients use DCR; the
  maintainer check records it. **Q9.** The official client defaults to the 2025-11-25
  handshake (`versionNegotiation` `'legacy'`) and only negotiates 2026-07-28 with `mode:
  'auto'`. That supports `legacy: 'stateless'` until V15 shows what real clients send.

## Not covered (T12 must re-check inside the real server)

- **Kept's keptSecurity plugin wasn't in the copy.** It would load a second copy of better-auth
  from `apps/server/node_modules`. Its MFA gate matches every path except an allow-list, so
  authorize and consent would be refused with `MFA_REQUIRED` (JSON 403) for a pending-MFA
  session. That is inferred from `security.ts`, not run. The consent page must handle it.
- **passkey, the mailers and Better Auth's rate limiter were left out** (`rateLimit.enabled:
  false` in the copy).
- **Refresh tokens** (`offline_access`) and **DPoP** were not exercised.
- **The `jwt()` options in §6** were not re-run.
- **The key is encrypted at rest.** `jwks.private_key` is stored encrypted by default
  (`disablePrivateKeyEncryption` default `false`, read from the types, not inspected in the
  table).
- **`serve.ts` never ran to completion.** Its smoke test was cut off: the dev container's Docker
  daemon started failing with `input/output error` when the host disk fell to ~800 MB free
  during the run. `run.ts` itself completed before that: the last full run is `results.json`,
  with the database dropped. `serve.ts` shares `lib.ts` and `auth.ts` with it. After the last
  full run, `run.ts` had one display-only edit (a local JWT decoder replacing an undeclared
  `jose` import) that has not run since.
- **A scratch database may be left over.** The aborted `serve.ts` smoke test may have left
  `kept_spike6_oauth` behind; Docker's API still returned 500 when this report was written, so
  it couldn't be checked. Once the container is back: `DROP DATABASE IF EXISTS
  kept_spike6_oauth;` as the dev superuser on 5452.

## Maintainer check (V15): steps

Needs:
- a **public HTTPS URL that forwards to a local port**: Tailscale Funnel on the maintainer's
  tailnet, or a tunnel he runs;
- the dev database container on 5452.

Nothing else is exposed: the server binds 127.0.0.1.

1. **Install and start the server.** In `docs/spikes/code/step6/oauth/`, run `npm ci`, then:

   ```sh
   SPIKE_PG=<the dev superuser URL, no database> \
   SPIKE_PUBLIC_URL=https://<public host> \
   SPIKE_PORT=<local port> \
   npx tsx serve.ts
   ```

   Point the tunnel at `127.0.0.1:<local port>`. The server prints the MCP URL
   (`<public URL>/mcp`), the sign-in email (`louis@kept.test`) and a one-time password
   (printed, never written).
2. **Check the root discovery documents** from outside:
   - `curl <public URL>/.well-known/oauth-protected-resource/mcp` (200, `resource` =
     `<public URL>/mcp`);
   - `curl <public URL>/.well-known/oauth-authorization-server/api/v1/auth` (200,
     `client_id_metadata_document_supported: true`, no `registration_endpoint`).
3. **Connect each client.** For each of **claude.ai** (a custom connector), **ChatGPT** (its
   connector/app setting) and **Claude Desktop** (its connector setting): add `<public URL>/mcp`,
   sign in on Kept's page, allow, then ask it to call `whoami`.
4. **Record per client,** from `serve-log.jsonl` (git-ignored; values are presence flags, never
   tokens):

   | What | Where in the log |
   |---|---|
   | CIMD or DCR | `authorize.clientKind`: `cimd-url` (its `clientId` is the metadata URL; there's also a `cimd-fetch` line) or `registered-id`. A `DCR register` line (403 while off) means it tried DCR |
   | Protocol | `mcp.protocolVersionHeader` and `mcp.initializeVersion`: 2026-07-28 or a 2025 version |
   | Sends `resource` | `authorize.sendsResource` and `token.sendsResource` |
   | Also | `ua`; `token.contentType`, `basicAuth` and `dpop`; the discovery paths it requested (`kind: 'discovery'`) |

5. **If a client stops at registration** (a `DCR register` line, and no `authorize`): that is Q8's
   stop.
   - Optionally re-run with `SPIKE_ALLOW_DCR=1` only to observe whether it would then connect.
     This opens unauthenticated registration: do it on a throwaway URL and stop right after.
   - The decision stays with the maintainer.
6. **If `/mcp` answers 401 after a successful token** and `sendsResource` is false, that is N8:
   note it for T12.
7. **Ctrl+C** stops the server and drops `kept_spike6_oauth`.

**V15 passes** when claude.ai and ChatGPT each show `clientKind: cimd-url` and a 200 `whoami`.

Device-checklist row (for `2026-xx-step6-devices.md`): **V15**: maintainer check pending (steps
above). Record per client: CIMD/DCR, protocol, `resource`.
