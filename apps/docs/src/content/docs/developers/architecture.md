---
title: Architecture
description: The processes Kept runs, what each one talks to, and the path one request takes from the browser to the database and back.
---

Kept is one Node.js image and one Postgres database. The same image serves the web app and the
API, runs the background jobs, and carries the `kept` command line. What a process does is set by
`KEPT_ROLE`. Everything a person owns lives in Postgres, except file bytes, which live on the
server's disk or in an S3 bucket.

The design this page summarises is the engineering spec's §7 Foundations
([engineering spec](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md)).
Where this page and the code disagree, the code is right; please open an issue.

## The processes and what they talk to

<figure class="kd-diagram">
<svg viewBox="0 0 760 350" role="img" aria-labelledby="d-run-t" dir="ltr">
<title id="d-run-t">Kept's processes, the database and the services around them</title>
<defs><marker id="d-run-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="kd-head" d="M0 0L10 5L0 10z"/></marker></defs>
<rect class="kd-box" x="20" y="40" width="160" height="70" rx="6"/>
<text class="kd-t" x="100" y="66" text-anchor="middle">Browser or PWA</text>
<text class="kd-t2" x="100" y="84" text-anchor="middle">service worker</text>
<text class="kd-t2" x="100" y="100" text-anchor="middle">offline queue (Dexie)</text>
<rect class="kd-box" x="20" y="150" width="160" height="60" rx="6"/>
<text class="kd-t" x="100" y="176" text-anchor="middle">MCP clients</text>
<text class="kd-t2" x="100" y="194" text-anchor="middle">token or OAuth</text>
<rect class="kd-zone" x="205" y="14" width="270" height="300" rx="8"/>
<text class="kd-zone-t" x="220" y="34">Kept image · KEPT_ROLE=all runs both</text>
<rect class="kd-box" x="225" y="50" width="230" height="70" rx="6"/>
<text class="kd-t" x="340" y="78" text-anchor="middle">Web: Fastify</text>
<text class="kd-t2 kd-mono" x="340" y="98" text-anchor="middle">KEPT_ROLE=web</text>
<text class="kd-t2" x="340" y="113" text-anchor="middle">/api/v1 · /mcp · the web bundle</text>
<rect class="kd-box" x="225" y="145" width="230" height="70" rx="6"/>
<text class="kd-t" x="340" y="173" text-anchor="middle">Worker: pg-boss jobs</text>
<text class="kd-t2 kd-mono" x="340" y="193" text-anchor="middle">KEPT_ROLE=worker</text>
<text class="kd-t2" x="340" y="208" text-anchor="middle">reminders, AI, purge, backup</text>
<rect class="kd-box kd-sunken" x="225" y="245" width="230" height="52" rx="6"/>
<text class="kd-t" x="340" y="267" text-anchor="middle">kept migrate · kept admin</text>
<text class="kd-t2" x="340" y="285" text-anchor="middle">one-shot, as kept_owner</text>
<rect class="kd-box kd-accent" x="520" y="20" width="220" height="64" rx="6"/>
<text class="kd-t kd-on-accent" x="630" y="46" text-anchor="middle">Postgres 18 + pgvector</text>
<text class="kd-t2 kd-on-accent" x="630" y="66" text-anchor="middle">data, jobs, sessions</text>
<rect class="kd-box" x="520" y="100" width="220" height="46" rx="6"/>
<text class="kd-t" x="630" y="120" text-anchor="middle">File storage</text>
<text class="kd-t2" x="630" y="137" text-anchor="middle">local disk or S3</text>
<rect class="kd-box" x="520" y="160" width="220" height="46" rx="6"/>
<text class="kd-t" x="630" y="180" text-anchor="middle">SMTP (optional)</text>
<text class="kd-t2" x="630" y="197" text-anchor="middle">Mailpit in development</text>
<rect class="kd-box" x="520" y="220" width="220" height="46" rx="6"/>
<text class="kd-t" x="630" y="240" text-anchor="middle">AI provider (optional)</text>
<text class="kd-t2" x="630" y="257" text-anchor="middle">or the mock, in tests</text>
<rect class="kd-box" x="520" y="280" width="220" height="46" rx="6"/>
<text class="kd-t" x="630" y="300" text-anchor="middle">restic repository</text>
<text class="kd-t2" x="630" y="317" text-anchor="middle">a directory, S3 or SFTP</text>
<path class="kd-edge" d="M180 75H225" marker-end="url(#d-run-a)"/>
<path class="kd-edge" d="M180 180L225 108" marker-end="url(#d-run-a)"/>
<path class="kd-edge" d="M455 70L520 55" marker-end="url(#d-run-a)"/>
<path class="kd-edge" d="M455 100L520 122" marker-end="url(#d-run-a)"/>
<path class="kd-edge" d="M455 165L520 75" marker-end="url(#d-run-a)"/>
<path class="kd-edge" d="M455 185L520 183" marker-end="url(#d-run-a)"/>
<path class="kd-edge" d="M455 198L520 243" marker-end="url(#d-run-a)"/>
<path class="kd-edge" d="M455 208L520 300" marker-end="url(#d-run-a)"/>
<path class="kd-edge kd-dashed" d="M455 262L520 80" marker-end="url(#d-run-a)"/>
</svg>
<figcaption>One image in three roles: the web serves people and MCP clients, the worker runs jobs, and the one-shot commands migrate and administer the database as its owner.</figcaption>
</figure>

| Role | What runs | Started by |
|---|---|---|
| `web` | Fastify: the API under `/api/v1`, MCP at `/mcp`, the built web bundle, `/healthz`, `/readyz`, `/version` (and `/metrics` when `KEPT_METRICS_TOKEN` is set) | `node dist/main.js` with `KEPT_ROLE=web` |
| `worker` | pg-boss's supervisor, cron and every job handler; no HTTP | `KEPT_ROLE=worker` |
| `all` (the default) | both, in one process | `KEPT_ROLE=all` |
| `kept migrate` | the migrations, the pg-boss schema and the reference rows, under an advisory lock | the `migrate` service in Compose, a hook Job in the Helm chart |

A web-only process still starts pg-boss, without its supervisor or schedule, because a request
enqueues jobs inside its own transaction. A worker-only process serves no `/readyz`; it writes a
heartbeat file the image's health check reads
([`jobs/liveness.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/jobs/liveness.ts)).
The startup order is in
[`apps/server/src/main.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/main.ts):
the release guard, pg-boss, file storage, the AI layer, then either the job registry, the HTTP
app, or both.

## One request, start to finish

<figure class="kd-diagram">
<svg viewBox="0 0 760 260" role="img" aria-labelledby="d-req-t" dir="ltr">
<title id="d-req-t">The path of one API request</title>
<defs><marker id="d-req-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="kd-head" d="M0 0L10 5L0 10z"/></marker></defs>
<rect class="kd-box" x="20" y="30" width="160" height="58" rx="6"/>
<text class="kd-t" x="100" y="55" text-anchor="middle">HTTP request</text>
<text class="kd-t2" x="100" y="74" text-anchor="middle">our own request id</text>
<rect class="kd-box" x="210" y="30" width="160" height="58" rx="6"/>
<text class="kd-t" x="290" y="55" text-anchor="middle">onRequest hooks</text>
<text class="kd-t2" x="290" y="74" text-anchor="middle">CSRF · token · session</text>
<rect class="kd-box" x="400" y="30" width="160" height="58" rx="6"/>
<text class="kd-t" x="480" y="55" text-anchor="middle">Validation</text>
<text class="kd-t2" x="480" y="74" text-anchor="middle">zod · module gate</text>
<rect class="kd-box" x="590" y="30" width="150" height="58" rx="6"/>
<text class="kd-t kd-mono" x="665" y="55" text-anchor="middle">scopedWrite()</text>
<text class="kd-t2" x="665" y="74" text-anchor="middle">Idempotency-Key</text>
<rect class="kd-zone" x="10" y="122" width="740" height="122" rx="8"/>
<text class="kd-zone-t" x="24" y="142">one transaction on kept_app: withScope()</text>
<rect class="kd-box kd-accent" x="30" y="160" width="160" height="62" rx="6"/>
<text class="kd-t kd-on-accent" x="110" y="186" text-anchor="middle">BEGIN, set_config</text>
<text class="kd-t2 kd-on-accent kd-mono" x="110" y="206" text-anchor="middle">app.user_id · app.mfa</text>
<rect class="kd-box" x="215" y="160" width="160" height="62" rx="6"/>
<text class="kd-t" x="295" y="186" text-anchor="middle">Route handler</text>
<text class="kd-t2" x="295" y="206" text-anchor="middle">RLS filters every row</text>
<rect class="kd-box" x="400" y="160" width="160" height="62" rx="6"/>
<text class="kd-t kd-mono" x="480" y="186" text-anchor="middle">audited()</text>
<text class="kd-t2" x="480" y="206" text-anchor="middle">audit_events row</text>
<rect class="kd-box" x="585" y="160" width="150" height="62" rx="6"/>
<text class="kd-t" x="660" y="186" text-anchor="middle">COMMIT, reply</text>
<text class="kd-t2" x="660" y="206" text-anchor="middle">then afterCommit()</text>
<path class="kd-edge" d="M180 59H210" marker-end="url(#d-req-a)"/>
<path class="kd-edge" d="M370 59H400" marker-end="url(#d-req-a)"/>
<path class="kd-edge" d="M560 59H590" marker-end="url(#d-req-a)"/>
<path class="kd-edge" d="M665 88V106H110V160" marker-end="url(#d-req-a)"/>
<path class="kd-edge" d="M190 191H215" marker-end="url(#d-req-a)"/>
<path class="kd-edge" d="M375 191H400" marker-end="url(#d-req-a)"/>
<path class="kd-edge" d="M560 191H585" marker-end="url(#d-req-a)"/>
</svg>
<figcaption>The hooks decide who is calling; the write, its audit row, any job it enqueues and its idempotency record commit or roll back together.</figcaption>
</figure>

1. **Hooks** ([`http/app.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/http/app.ts)).
   Fastify gives the request a fresh UUIDv7 as its id and answers it in `x-request-id`. Then, in
   order: a cookie-bearing write from another site is refused (`csrfHook`), a
   `Authorization: Bearer kpt_…` token becomes the scope (`bearerHook`), and otherwise the
   Better Auth session does (`sessionHook`). A route is `required` unless it says `optional` or
   `none`, so an anonymous call to a protected route stops here with 401. See
   [authentication](/developers/auth/).
2. **Validation.** zod schemas on params, query and body (`fastify-type-provider-zod`), then
   the module gate: a route with `config.module` answers 404 `module_off` for a read and 409 for
   a write when that module is off in the target location
   ([`http/modules.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/http/modules.ts)).
3. **The scope.** `scopedRead()` and `scopedWrite()`
   ([`http/write.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/http/write.ts))
   run the handler inside `withScope()`
   ([`db/scope.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/db/scope.ts)):
   one transaction on a `kept_app` connection that first sets `app.user_id`, `app.mfa` and
   `app.token_id` transaction-locally. Row-level security reads them. See
   [row-level security](/developers/rls/).
4. **The handler** queries through Drizzle. It sees only what the policies let that person see;
   anything else is a 404, the same as a missing row.
5. **Audit.** Every write calls `audited(tx, event)`
   ([`audit/audited.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/audit/audited.ts))
   in the same transaction, and the route catalogue test fails any non-GET route that can finish
   without an audit row.
6. **Commit and reply.** An undoable write answers `x-kept-audit-event`. Work that needs another
   login or its own transaction runs in `afterCommit`, and its failure is logged, not answered.
   Any error becomes the one error shape (see [API conventions](/developers/api/)).

## The components

**Web app** ([`apps/web`](https://github.com/ibrahimroshdy/kept/tree/main/apps/web)). React 19,
TanStack Router and Query, React Aria, Lingui, Tailwind v4, built by Vite into static files the
server serves with a strict CSP (`default-src 'self'`, no inline scripts but the pre-paint one by
hash). A Serwist service worker precaches the shell, the fonts and the scanner's wasm, and never
caches `/api` or `/f`. The phone keeps a read-only snapshot and a queue of offline changes in
IndexedDB: [offline and sync](/developers/offline-sync/).

**Server** ([`apps/server/src`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src)).
Fastify 5 with zod, Drizzle over `pg`, Better Auth for sign-in. One directory per feature; the
[monorepo page](/developers/monorepo/) lists them.

**Postgres 18 with pgvector** (spec §7.1, §7.2). Four login roles, one pool each for the three
runtime ones, row-level security forced on every table. pg-boss keeps its queue in the same
database, in schema `pgboss`; Better Auth keeps its tables in schema `auth`; Kept's functions live
in schema `kept`. The `vector`, `pg_trgm` and `unaccent` extensions are created at database
bootstrap ([`docker/initdb`](https://github.com/ibrahimroshdy/kept/tree/main/docker/initdb)).

**Jobs** ([`apps/server/src/jobs`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/jobs)).
Every job is declared with `defineJob()` as `system` (cross-tenant, on `kept_system`, the only
kind that may be scheduled) or `tenant` (re-assumes the sending request's user inside
`withScope()`). A request enqueues with `sendInTx()` on its own connection, so a job exists only
if the write commits. Retry and timeout policies are in `jobs/policies.ts`.

**File storage** ([`apps/server/src/storage`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/storage)).
One blob-store interface, two drivers: `local.ts` under `KEPT_DATA_DIR` and `s3.ts`
(`KEPT_STORAGE=s3`). Originals stay byte-identical; display and thumbnail derivatives are made in
the upload request. Every file is fetched through a five-minute signed URL: `/f/<token>` on local
storage, a presigned URL on S3 (spec §7.11). See [file storage](/admin/storage/).

**Mail** ([`apps/server/src/mail`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/mail)).
Nodemailer over `KEPT_SMTP_URL`. Without it, mail is logged as due and reminders reach people in
the app only.

**AI** ([`apps/server/src/ai`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/ai)).
The Vercel AI SDK behind one call door with budgets, caps and a call ledger (`llm_calls`). Provider
kinds: `openai`, `anthropic`, `google`, `openai_compatible`, `openrouter`, `groq`. Outbound
requests go through the SSRF guard in `net/ssrf.ts`. `KEPT_AI_MOCK=1` answers every call from
`ai/mock.ts` and is refused in production. See [AI providers](/developers/ai-providers/).

**Backups** ([`apps/server/src/backup`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/backup)).
The worker runs restic nightly (`KEPT_BACKUP_TIME`, default 02:30 UTC), dumping as `kept_owner`
on its own connection: the one time a long-running process uses the owner login. See
[backups](/admin/backups/).

**MCP** ([`apps/server/src/mcp`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/mcp),
[`packages/mcp`](https://github.com/ibrahimroshdy/kept/tree/main/packages/mcp)). `POST /mcp`
takes a personal token or an OAuth access token bound to the `/mcp` resource. Tools run through
the same `runTool()` the in-app assistant uses (`tools/`). See [MCP](/developers/mcp/).

**Observability.** Pino logs (`KEPT_LOG_FORMAT`), Prometheus-format gauges at `/metrics` (served
only when `KEPT_METRICS_TOKEN` is set, behind that bearer token), and optional OpenTelemetry tracing and error reporting, both off by
default. See [observability](/admin/observability/).
