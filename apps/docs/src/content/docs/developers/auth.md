---
title: Authentication
description: How people sign in, how sessions and second factors work, the same-site check, personal tokens, OAuth for MCP clients, and roles per location.
---

Kept uses Better Auth for sign-in, on its own database login
(`kept_auth`) with its tables in schema `auth`, and adds its own rules around it. The design is
the engineering spec's §7.10 and §7.14
([engineering spec](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md));
the code is in
[`apps/server/src/auth`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/auth),
mounted at `/api/v1/auth/*`.

## Signing in

| Method | How | Notes |
|---|---|---|
| Email and password | Better Auth's `emailAndPassword` | A reset link carries its token in the URL `#fragment`; the web page posts it. Reset revokes every session |
| Magic link | `magicLink` plugin, 15 minutes | Signs in existing accounts only. Consumed by Kept's `POST /api/v1/auth/magic-link/verify`, never by a GET a mail scanner could follow; only a hash of the token is stored |
| Passkey | `@better-auth/passkey`, relying party = the public URL's host | A passkey with user verification counts as two factors |
| Managed account | `username` plugin | A username and password, no real email (below) |
| OIDC | `genericOAuth`, when `KEPT_OIDC_ISSUER` is set and boot-time discovery worked | The account key is `sub`, never the email; linking is explicit only. Spike: [step 6 OIDC](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-09-30-step6-oidc.md) |

Sign-up isn't open by default. People join through Kept's own `POST /api/v1/auth/sign-up`, which
accepts only while sign-up is open (`KEPT_SIGNUP_OPEN`, or the admin setting) or with a live
invite, and answers a taken address the same as a free one. Better Auth's own sign-up endpoint,
its admin endpoints, email OTP, session listing and several others are switched off
(`DISABLED_AUTH_PATHS` in
[`auth/auth.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/auth/auth.ts)).

Creating an account spans two logins: Better Auth creates the user as `kept_auth`, then
`ensureAccount()` creates the owner account, the Personal location, its Unplaced area and the
owner membership in one `kept_app` transaction. It runs from Better Auth's user-created hook,
again on every signed-in request (cached), and from the hourly `repair-orphans` job.

## Sessions and cookies

- **Lifetime.** Over HTTPS, 30 days, sliding (refreshed once a day of use). Over plain HTTP, 12
  hours, never renewed.
- **Cookies** are Better Auth's, HttpOnly, with `Secure` and the `__Secure-` prefix exactly when
  `KEPT_PUBLIC_URL` is `https`. Kept strips any `token` field from Better Auth's JSON bodies, so a
  page script never sees a session token.
- **Your devices** are listed with `GET /api/v1/me/sessions` and signed out with
  `DELETE /api/v1/me/sessions/:id`.
- **Client address.** Kept decides it from the socket, walking `X-Forwarded-For` only through
  `KEPT_TRUSTED_PROXIES` (`auth/client-ip.ts`), and hands Better Auth that one value. Every per-IP
  limit uses it. See [reverse proxies](/install/reverse-proxy/).

## Second factors

TOTP with backup codes (`twoFactor`), or a passkey with user verification. An emailed code is
**not** a second factor: email is the channel a magic link already used.

Better Auth gates only some sign-in paths on two-factor, so Kept keeps its own flag per session
(`auth.session_mfa`) and fails closed (`auth/security.ts`): a session whose user has two-factor on
but hasn't proven it is **pending**, and every route refuses it with 403 `mfa_required` except
the ones that finish or abandon sign-in. Whether the session proved a factor becomes `app.mfa` in
the database scope, which hides locations with "require two-factor" until it is true
([row-level security](/developers/rls/)).

Changing the sign-in email and downloading the recovery kit need **re-authentication**
(`auth/reauth.ts`): the password again, or a sign-in in the last few minutes for an account
without one. The answer is 403 `reauth_required`.

## Limits

| What | Limit | Where |
|---|---|---|
| Sign-in attempts | 5 a minute per IP | Better Auth's limiter, database-backed (`auth.rate_limit`), shared by replicas |
| Sign-in failures | Per account **and** IP, 20 an hour, with growing delays instead of a lockout | `auth/sign-in-limiter.ts`, `auth.sign_in_failures` |
| Mailed-token redemptions | 30 an hour per IP | `auth/http.ts` |
| Anonymous request bodies | 16 KiB | `ANONYMOUS_BODY_LIMIT` |

## The same-site check

A request that carries a cookie and isn't a safe method must come from Kept's own pages
(`csrfHook` in [`auth/http.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/auth/http.ts)):
its `Origin` is the origin of `KEPT_PUBLIC_URL`, or, when the browser sent no usable `Origin`,
`Sec-Fetch-Site: same-origin`. Anything else is 403 `forbidden` before the session is looked up
or the body read. This is why `KEPT_PUBLIC_URL` must be exactly the address the browser shows. A
request with a bearer token carries no cookie authority and skips it.

## How a route declares who may call it

Each route sets `config.auth`: `required` (the default), `optional` or `none` (health, the web
bundle, the OpenAPI document, the Better Auth mount, sign-up, setup, token-holding links). A
handler reads `req.scope` (`{userId, mfa, tokenId?}`) and runs its queries in
`withScope(app.pools.app, req.scope, …)`.

## Personal tokens

For scripts and Shortcuts: `Authorization: Bearer kpt_<lookup>_<secret>`
([`apps/server/src/tokens`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/tokens)).

- Made and revoked from a signed-in session at `/api/v1/tokens`, never by another token. Each
  has a scope (`read` or `write`), a list of locations and an optional expiry. The secret is shown
  once; the database stores an HMAC of it keyed from `KEPT_AUTH_SECRET`, which `kept_app` can't
  even select.
- A token acts as its creator, but row-level security intersects the creator's memberships with
  the token's locations on every statement, and a read token has nothing writable. Losing a
  membership takes that location from the token in the same transaction, as does dropping to
  viewer for a write token; a token whose last location goes is revoked.
- A token reaches only the routes listed in `TOKEN_ROUTES` (`tokens/access.ts`); sign-in, `/me`,
  tokens, the assistant, AI settings, secrets, exports, admin, members, invites and webhooks are
  never open to one.
- 120 reads and 30 writes a minute per token, counted in Postgres (`kept.token_rate_hit()`); a
  429 says when to retry.
- Its writes are audited as actor `token`, and it can undo only its own changes.

## OAuth for MCP clients

With an `https` public URL, Kept is also an OAuth 2.1 authorization server for MCP connectors
([`apps/server/src/oauth`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/oauth)):
authorization code with PKCE, clients identified by a Client ID Metadata Document URL (fetched
through the SSRF guard), no dynamic client registration. Access tokens are JWTs for
`<public URL>/mcp`, an hour long, and are accepted at `/mcp` only; the grant row holds the scopes
(`kept:read`, `kept:write`) and locations the person chose on the consent page, and is checked on
every call. The discovery documents are at `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource`. Spike:
[step 6 OAuth with CIMD](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-09-30-step6-oauth-cimd.md).
The tools themselves are on [MCP](/developers/mcp/).

## Roles in a location

A membership's role is `owner`, `admin`, `member` or `viewer`. The full matrix, transcribed from
the product design's §7.1, is `MATRIX` in
[`packages/shared/src/roles.ts`](https://github.com/ibrahimroshdy/kept/blob/main/packages/shared/src/roles.ts),
and `can(role, action, ctx)` answers it: members add, edit and move things; admins manage
members, registries, webhooks and settings; only the owner sets secret-field policies, requires
two-factor, or transfers and deletes the location. Viewers see money only if the location allows
it. The services check `can()`; the database policies independently keep viewers from writing.
Instance administration is separate: the `instance_admins` table, checked by
`kept.is_instance_admin()`.

## Managed accounts

For someone who signs in with a username instead of an email address. An owner or admin creates one in a location
with a username and a display name (`POST /api/v1/locations/:id/managed-accounts`). Better Auth
needs an email, so the account gets a synthetic `…@managed.invalid` address that is never shown or
mailed. Nobody but the person knows the password: creation and later resets hand the admin a
one-time code, which the person redeems at `POST /api/v1/auth/reset-code` to set their own. A
location holds at most 20. See
[`managed/routes.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/managed/routes.ts)
and [`auth/managed.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/auth/managed.ts).
