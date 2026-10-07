---
title: MCP server
description: The tools Kept exposes over MCP, how clients authenticate with tokens or OAuth, and how to add a tool.
---

Kept runs an [MCP](https://modelcontextprotocol.io/) server at `POST /mcp` on the same process as
the API. One tool set serves both MCP clients and Kept's own assistant: the contracts live in
`packages/mcp`, the handlers in `apps/server/src/tools/`. The design is in the engineering spec
[§2.5 MCP tools and §2.6 webhooks](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md)
and decisions D63, D124 and D180 in the
[product design](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md).

## Where the code is

| Path | What it holds |
|---|---|
| `packages/mcp/src/tools.ts` | `TOOL_DEFS`: each tool's name, title, description, scope, module and zod input and output |
| `packages/mcp/src/output.ts` | The answer envelope and its size fit |
| `packages/mcp/src/vocabulary.ts` | The server instructions and the `kept://vocabulary` resource |
| `apps/server/src/mcp/routes.ts` | Mounts `POST /mcp`: Host and Origin checks, then the bearer token |
| `apps/server/src/mcp/server.ts` | Builds one `McpServer` per request with the tools the token may call |
| `apps/server/src/mcp/auth.ts` | Verifies a personal token or an OAuth access token |
| `apps/server/src/tools/registry.ts`, `tools/handlers/` | One handler per tool |
| `apps/server/src/oauth/` | The OAuth authorization server, consent and CIMD fetches |
| `apps/server/src/tokens/` | Personal tokens and the per-token rate limiter |

## The tools

Every tool takes an optional `location_id` (optional when the principal has one location) and
answers `{data, as_of, next_cursor?}` or `{error, hint}`. Ids are UUIDs or 6-character short IDs.
User-written strings in outputs sit under an `untrusted` key. Lists default to 20 items.

| Tool | Scope | Module |
|---|---|---|
| `capabilities` | read | core |
| `list_locations` | read | core |
| `search_things` | read | core |
| `where_is` | read | core |
| `get_thing` | read | core |
| `list_contents` | read | core |
| `thing_history` | read | core |
| `find_documents` | read | core |
| `upcoming` | read | schedules |
| `add_thing` | write | core |
| `update_thing` | write | core |
| `move_thing` | write | core |
| `mark_seen` | write | core |
| `create_place` | write | core |
| `attach_link` | write | core |
| `log_reading` | write | core |
| `log_service` | write | core |
| `lend_thing`, `return_thing`, `borrow_thing` | write | lending |
| `complete_schedule`, `snooze_schedule` | write | schedules |
| `add_warranty`, `open_claim`, `update_claim` | write | warranties |
| `log_fuel` | write | fuel |
| `adjust_stock` | write | consumables |

**No tool trashes, deletes, merges, transfers ownership, reveals a secret, uploads a file or runs
SQL** (D58, D63, D124). `packages/mcp/src/tools.test.ts` walks the names and fails on one that
does. A tool that needs a file, such as a receipt, returns a short link from `attach_link` that
opens the capture sheet in the web app.

A tool is offered only in locations where its module is on and, for a write tool, where the
principal may write. `capabilities` lists what each location allows. Roles are checked on every
call, never cached in a token (D180).

## Transport

Streamable HTTP, **stateless** (D63), with `@modelcontextprotocol/server`. `mcp/server.ts` calls
`createMcpHandler` with a factory that builds a fresh `McpServer` for each HTTP request and
registers only the tools that token may call. `GET /mcp` and `DELETE /mcp` answer 405. The route
is mounted by hand on Fastify, as the
[MCP SDK spike](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-09-30-step6-mcp-sdk.md)
decided, so the security headers, the request log and `x-request-id` still apply.

Before the handler: the `Host` must be the public URL's host (or a former one), and the `Origin`
must be absent or Kept's own. Both refusals are 403. Each answer carries the envelope once, as
text, with no `structuredContent`, so a reply isn't sent twice.

## Authentication

The bearer token is the only credential: `/mcp` takes no session cookie and needs no CSRF token.
A failure is 401 with `WWW-Authenticate: Bearer`.

**Personal tokens** start `kpt_` and are made in Settings → Connections (`POST /api/v1/tokens`).
Each has a scope, `read` or `write`, and a list of locations. A token never goes above its
creator's role: a viewer's token only reads. The same token works on the [REST API](/api/).

**OAuth** is on only when the public URL is HTTPS (D125); `http` is allowed on a loopback host for
development. Kept is the authorization server, through Better Auth's `jwt()`, `mcp()` and `cimd()`
plugins (`apps/server/src/oauth/plugin.ts`):

- clients identify with a **Client ID Metadata Document** (CIMD): their `client_id` is a URL Kept
  fetches through its SSRF guard. Dynamic Client Registration is off;
- authorization code with PKCE, and a consent screen where the person picks the scope
  (`kept:read`, `kept:write`) and the locations;
- access tokens are JWTs for `<public URL>/mcp`, an hour long. The grant row holds the scope and
  locations and is read on every call, so revoking it in Connections works at once;
- discovery documents are served at `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`).

The [OAuth and CIMD spike](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-09-30-step6-oauth-cimd.md)
proved the flow with the official MCP client against a local fixture. Connecting hosted clients
(claude.ai, ChatGPT) needs a public HTTPS URL and is still a pending check by the maintainer.

**Limits and audit.** One per-token limiter counts both API requests and MCP tool calls (reads
120 a minute, writes 30 a minute; `tokens/rate.ts`). Every write a tool makes is audited as the
token.

## Connecting a client

When you create a token, the response includes ready-made client settings: the endpoint and the
bearer header, nothing client-specific.

```json
{
  "url": "https://kept.example.org/mcp",
  "headers": { "Authorization": "Bearer kpt_…" }
}
```

Put those two values wherever your MCP client takes a remote server's URL and headers. The token
is shown once.

## Adding a tool

1. **The contract.** Add an entry to `TOOL_DEFS` in `packages/mcp/src/tools.ts` with `tool({…})`:
   a snake_case `name`, a `title`, a `description` written as the question it answers (English;
   the model reads it, the UI never shows it), `scope`, `module` (`null` for the core), `since`,
   and zod `input` and `output`. User-written strings in the output go under `untrusted`.
2. **The handler.** Write it in `apps/server/src/tools/handlers/` as a `Handler<'your_tool'>` with
   the `action` it needs (a role permission from `packages/shared`), `subjectLocation`, and `run`,
   which calls the same service function the REST route calls. Register it in `HANDLERS` in
   `apps/server/src/tools/registry.ts`. A contract without a handler is never offered.
3. **Tests.** `packages/mcp/src/tools.test.ts` pins the table of names, scopes and modules, so
   update it. Add handler tests beside the others (`apps/server/src/tools/tools.test.ts`) and an
   end-to-end call in `apps/server/src/mcp/mcp.test.ts` if the tool needs one.
4. **The assistant** gets the tool too. If it is a write tool, it shows as a proposal card there,
   which the web draws from the arguments (`apps/web/src/assistant/confirm-rows.ts`).

## Webhooks

Location webhooks are built (`apps/server/src/webhooks/`). Owners and admins manage them on a
location (`/api/v1/locations/:id/webhooks`); tokens can't. Events are `WEBHOOK_EVENTS`:
`thing.created`, `thing.updated`, `thing.moved`, `thing.trashed`, `thing.restored`,
`thing.lifecycle_changed`, `reading.logged`, `reminder.due`.

**Payloads never carry values**: only ids, the event, the time, the actor and the names of the
changed fields. A receiver fetches the entity with its own token. Each POST is signed:
`Kept-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. A failed delivery is
retried 10 times over about 24 hours, then marked `gave_up` and the hook marked failing. A hook
is disabled when its creator loses the role (D180).
