# Spike S6.1: MCP SDK v2 on Fastify

Date: 2026-09-30. Step-6 plan, Task 0 (it feeds T11 and T26). Result: **PASS.**
- `createMcpHandler(factory)` from `@modelcontextprotocol/server` 2.2.0 serves `POST /mcp` in Fastify
  5.12.5 **both ways**, under `legacy: 'stateless'` and `'reject'`: `tools/list` and `tools/call` work,
  the factory sees the `authInfo` Kept passes in, and it runs **exactly once per HTTP request**.
- With `responseMode: 'json'`, every 2026-07-28 exchange is one `application/json` body, never SSE,
  including a tool answer of 6,971 bytes of text.
- `hostHeaderValidationResponse` and `originValidationResponse` refuse a foreign `Host` and a foreign
  `Origin` with 403 before the handler runs.
- **The mounting that wins is (b), by hand:** build a web `Request`, call
  `handler.fetch(request, {authInfo, parsedBody})`, and hand the `Response` to `reply.send()`. It
  needs no `@modelcontextprotocol/node`, so **no `hono` in the image**, and Fastify's own lifecycle
  (hooks, helmet, request log) still runs. T11 uses it.

Code: `docs/spikes/code/step6/mcp/`:
- `mcp-fastify.spike.ts`: both mountings × both `legacy` settings, a pinned 2026-07-28 client and a
  default (2025-handshake) client, the guards. Its header says how to run it.
- `factory-cost.spike.ts`: what a per-request factory costs with 25 tools.
- `results-2026-09-30.json`: the full run, every HTTP exchange with its status, content type and size.
- `package.json` + `package-lock.json` (npm, outside the workspace). Both scripts typecheck
  (`tsc --noEmit --strict`, the repo's TypeScript 7.0.2, exit 0).

## Versions (checked with `npm view` on 2026-09-30)

| Package | Version | Licence | Notes |
|---|---|---|---|
| `@modelcontextprotocol/server` | 2.2.0 | MIT | deps: `@modelcontextprotocol/core` 2.2.0 and `zod ^4.2.0` only. 6.4 MB unpacked (+ core 1.3 MB) |
| `@modelcontextprotocol/node` | 2.1.0 | MIT | dep `@hono/node-server` 1.19.17 (MIT), peer `hono ^4.11.4` (4.13.11, MIT, 2.8 MB). **Not needed** (below) |
| `@modelcontextprotocol/client` | 2.2.0 | MIT | dev only (T26's contract tests). Deps: `cross-spawn`, `eventsource`, `eventsource-parser`, `jose`, `pkce-challenge` |
| `fastify` | 5.12.5 | MIT | Kept's pin |

## What was run

One Fastify app per case: POST `/mcp` (plus Kept's own GET and DELETE answering 405, D63). The
factory registers `whoami` (reads `ctx.authInfo`, has an `outputSchema`), `search_things` (a ~7 KB
answer, 50 `thingRef`s) and, **only when `authInfo.scopes` holds `kept:write`**, `mark_seen`: the
per-principal filtering T11's factory does (D113). The route passes a fixed read-only `AuthInfo`
where Kept's verifier will sit.

| Mounting × `legacy` | 2026-07-28 client (pinned) | 2025 client (the default) | foreign Host | foreign Origin | Kept's Origin | no Origin | `text/plain` |
|---|---|---|---|---|---|---|---|
| (a) `toNodeHandler`, stateless | ok: 5 requests, 5 factory runs | ok: 6 handler requests, 6 factory runs | 403 | 403 | 200 | 200 | 415 |
| (a) `toNodeHandler`, reject | ok: 5 / 5 | **400** `-32022` "Unsupported protocol version: 2025-11-25", 0 factory runs | 403 | 403 | 400 | 400 | 415 |
| (b) by hand, stateless | ok: 5 / 5 | ok: 6 / 6 | 403 | 403 | 200 | 200 | 415 |
| (b) by hand, reject | ok: 5 / 5 | 400 `-32022`, 0 factory runs | 403 | 403 | 400 | 400 | 415 |

In all: 36 factory runs for 36 requests that reached the handler (60 requests to `/mcp`, of which
20 were refused by the guards or the 415 and 4 were Kept's own GETs). The factory saw
`authInfo.clientId` on every run. The write tool never appeared for the read-only `AuthInfo`.

**The wire (the pinned 2026-07-28 client; the same for (a) and (b)):**

| Exchange | Status | Content type | Bytes |
|---|---|---|---|
| `server/discover` (connect) | 200 | `application/json` | 284 |
| `tools/list` (2 tools) | 200 | `application/json` | 1,024 |
| `tools/call whoami` (content + `structuredContent`) | 200 | `application/json` | 327 |
| `tools/call search_things` (6,971 bytes of text) | 200 | `application/json` | 8,261 |
| `tools/call` of an unknown tool | 200 | `application/json` | 90: the client throws `ProtocolError` "Tool whoami_missing not found" |

The 2025 client in `stateless` sends `initialize` (answered as `text/event-stream`: `responseMode`
shapes only 2026-07-28 exchanges, as its `.d.mts` says), `notifications/initialized` (202), a GET
for a stream (405, Kept's own route), then `tools/list` and the calls, each also as a one-message
SSE body.

## Findings for the plan

1. **Mount by hand (b).** `createMcpHandler` returns `{fetch, close, notify, bus}`; Fastify 5 sends a
   web `Response` itself (`lib/reply.js`: status, headers, and the body streamed), so the route is:

   ```ts
   const handler = createMcpHandler(factory, { legacy, responseMode: 'json', maxRequestBodySize, onerror });
   app.post('/mcp', async (req, reply) => {
     const request = toRequest(req);                 // new Request(url, {method, headers, body: JSON.stringify(req.body)})
     const refused = hostHeaderValidationResponse(request, hosts) ?? originValidationResponse(request, origins);
     if (refused) return reply.send(refused);
     const authInfo = await verify(req);             // T10/T12; 401 via bearerAuthChallengeResponse
     return reply.send(await handler.fetch(request, { authInfo, parsedBody: req.body }));
   });
   ```

   (a) works too (`reply.hijack()`, then `req.raw.auth = authInfo` and
   `toNodeHandler(handler)(req.raw, reply.raw, req.body)`), but hijacking skips Fastify's `onSend`
   and `onResponse` hooks (helmet's headers, the request log, `X-Request-Id`), and it pulls in
   `@hono/node-server` and `hono` (MIT, ~3.2 MB). Drop `@modelcontextprotocol/node` from the plan's
   table; the licence check then needs no `hono` entry (T26).
2. **The factory is cheap:** registering 25 tools with zod input and output schemas costs p50 1.06 ms,
   p95 1.37 ms (500 builds, M-series laptop). One fresh `McpServer` per request is fine.
3. **Per-request filtering works** exactly as T11 plans: the factory reads `ctx.authInfo` (and
   `ctx.era`, `ctx.requestInfo`) and registers only what the principal may call.
4. **The 8 KB output limit is on the tool's own JSON, not the wire.** A tool answer of 6,971 bytes
   became an 8,261-byte HTTP body: JSON-in-JSON escaping adds ~18%, and a tool with an
   `outputSchema` carries its result twice (`content` text and `structuredContent`). T1's `fit()`
   measures the envelope's JSON, as planned; T26's contract test should assert the tool text
   ≤ 8,192 bytes, not the response body. **A choice for T11:** registering tools without
   `outputSchema` (keeping the zod output schema for the contract test) sends each answer once;
   registering it lets clients validate `structuredContent` but doubles the bytes. The spike
   doesn't settle which clients use `structuredContent`; S6.2's real-client check can record it.
5. **The 2025 era answers over SSE** even under `responseMode: 'json'`, one message per response. It
   works with the SDK client; nothing in Kept depends on it.
6. **`legacy: 'reject'` refuses the SDK client's default mode.** `@modelcontextprotocol/client` 2.2.0
   defaults to `versionNegotiation: {mode: 'legacy'}` (the 2025 handshake); only `'auto'` or
   `{pin: '2026-07-28'}` speak the new protocol. So, today, a client built on this SDK with default
   options can't talk to a `'reject'` endpoint. **This supports Q9's `legacy: 'stateless'`** until
   S6.2's real clients are recorded. T26's contract test pins `2026-07-28` and adds one default-mode
   case.
7. **Host and Origin checks:** `hostHeaderValidationResponse(request, hostnames)` and
   `originValidationResponse(request, hostnames)` take hostnames only (no scheme, no port). A missing
   `Origin` passes (non-browser clients send none); the literal `null` origin is refused. Kept's
   lists: the host of `KEPT_PUBLIC_URL` plus `former_hostnames` for both. Refusals are 403 with a
   JSON-RPC error body.
8. **The SDK answers 415 itself** for a non-JSON `Content-Type` (seen under both `legacy` settings),
   before any factory run. Fastify's body limit applies first; set `maxRequestBodySize` to the same
   value.
9. **Unknown tools** come back as a JSON-RPC error that the SDK client throws (`ProtocolError`), not as
   an `isError` tool result. T9's `tool_unavailable` for a tool the factory didn't register is
   therefore this protocol error; for a registered tool that fails a check per call (module off,
   location gone), return `{isError: true}` with Kept's `{error, hint}` so the model can read it.
10. **Well-known path (for T2 and T12):** the server package's `getOAuthProtectedResourceMetadataUrl`
    builds the RFC 9728 URL by inserting the well-known segment before the path:
    `https://host/.well-known/oauth-protected-resource/mcp` for a server at `/mcp`. T2 reserves
    `/.well-known/oauth-protected-resource`; it should reserve the `/mcp` suffix too (S6.2 records
    what real clients request).

## What changes in the plan

- **T11:** mount by hand (finding 1); no `@modelcontextprotocol/node`, no `hono`; decide
  `outputSchema` on the wire (finding 4); unknown tool = protocol error, per-call refusal = `isError`
  (finding 9); `maxRequestBodySize` equal to Fastify's body limit.
- **Tech-stack table:** drop the `@modelcontextprotocol/node` row.
- **T26:** the contract suite pins `2026-07-28`, plus one default-mode (2025) client case under
  `legacy: 'stateless'`; the size assertion is on the tool text.
- **T2:** also reserve `/.well-known/oauth-protected-resource/mcp` (finding 10).
- **Q9:** unchanged (`stateless`), now with a reason: the SDK's own client defaults to the 2025 handshake.
