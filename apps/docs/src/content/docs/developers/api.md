---
title: API conventions
description: The rules every Kept HTTP route follows, from URLs and errors to pagination, concurrency, idempotency, rate limits and the OpenAPI document.
---

The web app, the phone's offline queue, scripts and MCP tools all use the same HTTP API. Its
conventions are the engineering spec's §7.7
([engineering spec](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md)),
built in [`apps/server/src/http/conventions.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/http/conventions.ts),
[`write.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/http/write.ts) and
[`errors.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/http/errors.ts).
Every route is listed in the [API reference](/api/).

## URLs

Everything is under **`/api/v1`**. A collection that belongs to a location hangs off it
(`/api/v1/locations/{locationId}/places`); a single resource is addressed directly
(`/api/v1/places/{id}`, `/api/v1/things/{id}`). Bodies and responses are JSON with camelCase
field names; a few envelope fields, such as `next_cursor`, are snake_case. Ids are UUIDs, and ids a client creates must be UUIDv7 within ± 7 days of the server's clock
(400 `id_out_of_window`).

Outside `/api/v1`: `/mcp` (MCP), `/f/<token>` (signed file downloads on local storage),
`/healthz`, `/readyz`, `/version`, `/metrics` (when `KEPT_METRICS_TOKEN` is set), and the OAuth discovery documents under
`/.well-known/`.

## Authentication

A browser session (cookie), or a personal token as `Authorization: Bearer kpt_…` on the routes
open to tokens. Writes that carry a cookie must pass the same-site check. See
[authentication](/developers/auth/).

## Errors

Every error, from any route, has one shape:

```json
{ "error": "Not found.", "code": "not_found", "hint": "optional, a next step" }
```

`code` is from the `ErrorCode` enum in
[`packages/shared/src/errors.ts`](https://github.com/ibrahimroshdy/kept/blob/main/packages/shared/src/errors.ts);
clients branch on it, never on `error`, which is English text. Some errors add fields (a 412's
`conflicts`, a 429's `retryAfter`). A 500 never carries a stack trace or the underlying message,
and the log gets a copy with values withheld.

| Status | Codes, mostly | When |
|---|---|---|
| 400 | `validation`, `id_out_of_window` | The body, query or params failed their zod schema; the hint names the paths, never the values |
| 401 | `unauthenticated` | No session or token on a route that needs one |
| 403 | `forbidden`, `mfa_required`, `reauth_required` | A resource you can see but may not change; a cross-site write; a pending second factor |
| 404 | `not_found`, `module_off` | Missing, **or invisible to you under row-level security**: the two are indistinguishable. A read of a module that is off |
| 409 | `conflict`, `module_off`, `idempotency_mismatch`, … | A state conflict, often from a database constraint, with a hint |
| 412 | `precondition_failed` | The row changed since you read it |
| 428 | `precondition_failed` | A write that needs `If-Match` came without one |
| 429 | `rate_limited` | Too many; `Retry-After` says when |
| 503 | `database_unavailable` | Postgres is unreachable |

A client-supplied id that already exists anywhere, in your tenant or another, answers the same 404
as an id that exists nowhere, so ids can't be probed across tenants.

## Concurrency: `If-Match`

Mutable rows carry `rowVersion`. A write sends the version it started from as `If-Match` (`3`,
`"3"` and `W/"3"` are all accepted). If the row moved on, the answer is 412 with the fields you
tried to change, the current version, and who changed it when the route knows. Re-read the row
and decide. Offline queue ops skip this check and resolve "latest wins, visibly"; see
[offline and sync](/developers/offline-sync/).

## Idempotency

A write may send `Idempotency-Key` (1 to 255 visible ASCII characters). The key is stored per
user, in the same transaction as the write: a repeat returns the stored response with
`Idempotent-Replayed: true`, a repeat with a different method, path or body is 409
`idempotency_mismatch`, and a write that rolled back took its key with it, so a retry runs afresh.
A response holding a one-time secret is stored redacted.

## Undo

A write that recorded an undoable change answers `X-Kept-Audit-Event: <event id>` (several ids,
comma-separated, for a bulk move). `POST /api/v1/audit/{eventId}/undo` reverts it.

## Pagination and filtering

Lists are cursor-based: `?limit=` (1 to 200, default 20) and `?cursor=`. The answer is
`{ "items": [...], "next_cursor": "…" }`, with `next_cursor` null on the last page. Cursors are
opaque; don't build them. A filter parameter may repeat (`?typeId=a&typeId=b`, "any of"), and
`?not=typeId` turns it into "none of"
([`http/list-filters.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/http/list-filters.ts)).
Each list's own parameters are in the reference.

## Money

Amounts travel as strings in one canonical form (`"150"`, `"1250.5"`), with a three-letter
currency code beside them, through `canonicalAmount()` and `canonicalMoney()` in
`packages/shared/src/money.ts`. Money and secret fields are left out of a response for people who
may not see them.

## Rate limits

| What | Limit |
|---|---|
| A personal token | 120 reads and 30 writes a minute, shared across replicas |
| Sign-in | 5 a minute per IP; per account and IP 20 an hour, with growing delays |
| Other limits | Per route where they matter (a channel's test send, a webhook ping); the full table is spec §3.2 |

## Example

A script renames a place with a write token, after reading `rowVersion` 3:

```http
PATCH /api/v1/places/0199b0a2-6c1e-7a4b-9f00-2b6d8e1c4a10 HTTP/1.1
Authorization: Bearer kpt_…
If-Match: 3
Idempotency-Key: rename-shed-1
Content-Type: application/json

{ "name": "Garden shed" }
```

`200` returns the place view (`id`, `locationId`, `parentId`, `name`, `kindKey`, `path`,
`rowVersion` and the rest). If Bruce renamed it in the meantime, the answer is
(`checkVersion()` in `conventions.ts`):

```json
{
  "conflicts": ["name"],
  "row_version": 4,
  "changedBy": { "displayName": "Bruce" },
  "error": "This changed since you opened it.",
  "code": "precondition_failed",
  "hint": "Reload to see the latest version."
}
```

## The OpenAPI document

Routes declare zod schemas for params, query, body and responses; `@fastify/swagger` turns them
into an OpenAPI 3.1 document, served by the running server at **`/api/v1/openapi.json`**
(`OPENAPI_PATH` in `http/app.ts`). Routes open to personal tokens carry the `bearerAuth` security
scheme. Routes marked `schema: { hide: true }` are left out, for example health, `/mcp`, the OAuth
discovery documents and the OpenAPI document itself.

This site's [API reference](/api/) is rendered from the same document.
[`apps/docs/scripts/openapi.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/docs/scripts/openapi.ts)
builds the app in-process with every database pool pointed at a closed port, asks it for
`/api/v1/openapi.json`, fails if anything touched the database, and writes the git-ignored
`apps/docs/openapi/kept.json`:

```sh
pnpm --filter @kept/docs gen:openapi
```

`docs:dev` and `docs:build` run it first.

## The route catalogue

[`apps/server/test/route-catalogue.test.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/test/route-catalogue.test.ts)
builds the app with every route module and fails any non-GET route that has neither a test proving
its audit row (a `// catalogue: <METHOD> <url>` marker above the case) nor an allowlist entry with
its reason. Which routes a token may call is a separate, single table: `TOKEN_ROUTES` in
[`tokens/access.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/tokens/access.ts).
Adding a route means both; see [migrations](/developers/migrations/#what-a-new-route-needs).

## Versioning

The `v1` in the path is the only version there is.
The web app and the server ship in one image, so they always match. The phone's offline queue
ops are versioned on their own (`PAYLOAD_VERSION` in `packages/shared/src/sync.ts`).
