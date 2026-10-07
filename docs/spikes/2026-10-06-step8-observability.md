# Spike O1: optional tracing and error reporting (D84)

Date: 2026-10-06. Step-8 plan, Task 0b (it feeds T14; D84, Q27). Result: **PASS, keep T14 in step 8**,
with three changes to how it's built.
1. **Tracing:** 9 direct packages (42 installed), **+12.6 MiB** of new files in the image (25.0 MiB
   installed, of which 12.4 MiB is already there). All Apache-2.0/MIT, plus BlueOak `minimatch` and
   ISC `pg-int8`, both already in Kept's lockfile.
2. **Error reporting: `@sentry/core` alone, not `@sentry/node`.** `@sentry/core` is 2 packages,
   +12.7 MiB, MIT. `@sentry/node` 11.4.0 would add 63.8 MiB, including a native `oxc-parser` binary
   and the Sentry CLI (`sentry` 0.45.0), which is licensed **FSL-1.1-Apache-2.0**. That licence is not
   on D187's runtime allowlist. A `ServerRuntimeClient` with a few lines of `fetch` transport sent a
   real envelope to a local stub.
3. **"Lazily" can't mean an import at the top of `main.ts`.** Measured: a static first import whose
   module does a top-level `await import()` of the SDK traced **no** `node:http` server span and
   **no** pg span. Only Fastify's plugin spans appeared. Two ways work: a conditional `--import`
   preload, or a dynamic `import()` of the SDK before the app is imported. With
   `OTEL_EXPORTER_OTLP_ENDPOINT` unset, **zero** OpenTelemetry modules were resolved.

Code: `docs/spikes/code/step8/observability/` (npm, outside the workspace; `node_modules` ignored).
- `install.sh` and `measure.mjs`: the installs (linux/x64/glibc, `--ignore-scripts`, as the image
  installs) and the per-group sizes, compared with Kept's `pnpm-lock.yaml`.
- `lazy/`: the loading experiment. `run.sh` runs variants A–D against Fastify 5.12.5 and pg 8.23.0,
  with a dead collector at `http://127.0.0.1:9` (as ci-local's prod-boot uses, L90) and a dead
  Postgres on port 9. `record.mjs` records every resolved module through `module.registerHooks`.
- `sentry-core/report.mjs`: `@sentry/core` reporting one error to a local stub.

## Versions (`npm view`, 2026-10-06)

| Package | Version | Licence | Engines / peers | Notes |
|---|---|---|---|---|
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 | node ≥8 | already an *optional peer* of `@better-auth/core` 1.7.6 and `drizzle-orm` 0.45.3 in Kept's lockfile |
| `@opentelemetry/sdk-trace-node` | 2.11.0 | Apache-2.0 | node `^18.19.0 \|\| >=20.6.0`; peer api `>=1.0.0 <1.10.0` | deps: core, sdk-trace-base, context-async-hooks |
| `@opentelemetry/resources` | 2.11.0 | Apache-2.0 | same | |
| `@opentelemetry/semantic-conventions` | 1.43.0 | Apache-2.0 | node ≥14 | **already in the image** (a dependency of `@better-auth/core`) |
| `@opentelemetry/exporter-trace-otlp-proto` | 0.222.0 | Apache-2.0 | peer api `^1.3.0` | `-otlp-http` 0.222.0 has the same deps |
| `@opentelemetry/instrumentation` | 0.222.0 | Apache-2.0 | | deps `import-in-the-middle ^3`, `require-in-the-middle ^8` |
| `@opentelemetry/instrumentation-http` | 0.222.0 | Apache-2.0 | | traces `node:http` (the server side; Kept's outbound calls use undici `fetch`, which needs `instrumentation-undici` 0.32.0 and is not in this set) |
| `@opentelemetry/instrumentation-pg` | 0.74.0 | Apache-2.0 | | supports `pg >=8.0.3 <9` (Kept: 8.23.0); runtime deps include `@types/pg`, `@types/pg-pool` |
| `@fastify/otel` | 0.21.1 | MIT | peer api `^1.9.0` | supports `fastify >=4.0.0 <6` (Kept: 5.12.5) |
| `@opentelemetry/instrumentation-fastify` | 0.57.0 | Apache-2.0 | | **deprecated**: "Deprecated in favor of @fastify/otel, maintained by the Fastify authors." |
| `@opentelemetry/sdk-node` | 0.222.0 | Apache-2.0 | | pulls every exporter (gRPC, Zipkin, Prometheus, logs, metrics): not chosen |
| `@sentry/node` | 11.4.0 | MIT (itself) | node `>=20.19.0 <22.0.0 \|\| >=22.12.0 <23.0.0 \|\| >=23.2.0` | deps include `@sentry/bundler-plugins` → `sentry` 0.45.0 (**FSL-1.1-Apache-2.0**), `oxc-parser` (native), `glob`, `dotenv` |
| `@sentry/node` (dist-tag `v10`) | 10.76.0 | MIT | node ≥18 | no FSL dependency, but brings its own OTel copy (`instrumentation` **0.220.0**, not 0.222.0) |
| `@sentry/core` | 11.4.0 | MIT | node as `@sentry/node` 11 | 1 dep: `@sentry/conventions` 0.25.0 (MIT). Exports `createTransport`, `createStackParser`; `@sentry/core/server` exports `ServerRuntimeClient`, `nodeStackLineParser` |

All the engines ranges admit Node 24 (the image runs `node:24.21.0`). The peer ranges match the
chosen `@opentelemetry/api` 1.9.1.

## Install size, measured

Each group was installed by npm into its own folder with `--os=linux --cpu=x64 --libc=glibc
--ignore-scripts` (the image's platform; its prod install also skips scripts). Sizes are apparent
sizes from `du -A`. "Already in the lock" means the same name@version appears in Kept's
`pnpm-lock.yaml`.

| Group | Direct packages | Installed packages | Installed size | Already in Kept's lock | **New** |
|---|---|---|---|---|---|
| `otel-min` (chosen) | api, sdk-trace-node, resources, semantic-conventions, exporter-trace-otlp-proto, instrumentation, instrumentation-http, instrumentation-pg, @fastify/otel | 42 | 25.0 MiB | 12.4 MiB (semantic-conventions 11.5 MiB, pg-types and friends, minimatch, debug) | **12.6 MiB** |
| `otel-sdk-node` | sdk-node + the 3 instrumentations + api | 89 | 36.2 MiB | 13.3 MiB | 22.9 MiB |
| `sentry` (`@sentry/node` 11.4.0) | 1 | 24 | 70.1 MiB | 6.4 MiB | **63.8 MiB** (`@sentry/server-utils` 20.3, `sentry` CLI 14.8, `@sentry/conventions` 7.6, `server-runtime-injection` 6.8, `@sentry/core` 5.1, `oxc-parser` + linux binding 4.8) |
| `sentry-node10` (`@sentry/node` 10.76.0) | 1 | 21 | 49.9 MiB | 11.5 MiB | 38.4 MiB |
| `sentry-core` (chosen) | 1 | 2 | 12.7 MiB | 0 | **12.7 MiB** |
| `both` (`otel-min` + `@sentry/node` 11) | 10 | 62 | 93.4 MiB | 18.1 MiB | 75.2 MiB |

**Added image size for the recommendation (`otel-min` + `@sentry/core`): about 25 MiB of
uncompressed files.** That figure is inferred by adding the two "new" columns; pnpm's store layout
may differ slightly from npm's hoisted one, and the compressed layer is smaller.

Licences of the chosen set: Apache-2.0 (19), MIT (21 + 2), BlueOak-1.0.0 (`minimatch`, already
shipped), ISC (`pg-int8`, already shipped). Nothing new for D187's allowlist. `@sentry/node` 11's
tree adds FSL-1.1-Apache-2.0 (`sentry`), BSD-2-Clause (`dotenv`) and four more BlueOak packages
(`glob`, `lru-cache`, `minipass`, `path-scurry`).

## How the server starts (what "lazy" has to work with)

- `apps/server/package.json`: `"type": "module"`, built by `tsc -p tsconfig.build.json` to
  `dist/`, no bundler. ESM output, so the OTel docs' ESM path applies.
- `Dockerfile`: `ENTRYPOINT ["node", "/app/apps/server/dist/main.js"]`. The `kept` CLI wrapper
  runs `dist/cli/index.js`.
- `src/main.ts` statically imports the whole app (`./http/app.js`, `./db/pools.js`,
  `./jobs/boss.js`, …), so `fastify`, `pg` and `pg-boss` are linked before `main`'s body runs. Line
  237 runs only `if (isEntrypoint(import.meta.url))`, which compares the URL with `process.argv[1]`
  (`cli/index.ts` line 309).
- `fastify` 5 and `pg` 8 are CommonJS packages that Kept imports from ESM.
- `@opentelemetry/instrumentation`'s README says an ESM app needs
  `--experimental-loader=@opentelemetry/instrumentation/hook.mjs`, and its "Limitations" section
  says instrumentations must be registered **before** the module is required.
  `doc/esm-support.md` (https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md,
  read 2026-10-06) recommends
  `node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./telemetry.js app.js`,
  with `module.register(...)` as the future direction.

## The loading experiment (`lazy/run.sh`, Node 24.21.0)

`tracing.mjs` is the stand-in for `src/observability/tracing.ts`:
`export const otel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? await import('./otel-setup.mjs') : null;`.
`otel-setup.mjs` builds a `NodeTracerProvider` with an in-memory exporter (to read the spans back)
and a `BatchSpanProcessor` around the OTLP exporter, then registers the HTTP, pg and `@fastify/otel`
instrumentations. `app.mjs` statically imports `fastify` and `pg`, registers
`otel.fastifyOtel.plugin()` when tracing is on, and serves one route that tries `pg.Client.connect()`
against a dead port.

| Variant | How tracing is loaded | Spans for one request | OTel modules resolved |
|---|---|---|---|
| A, unset | static `import './tracing.mjs'` first in main; endpoint unset | none | **0** |
| **A, set** | the same, endpoint set: **the "one import in main.ts" plan** | `handler - fastify -> @fastify/otel`, `request`; **no `GET /q` (http), no `pg.connect`** (same in a rerun) | 301 |
| B | main does `await import('./tracing.mjs')`, then `await import('./app.mjs')` | `pg.connect`, `handler - fastify -> @fastify/otel`, `request`, `GET /q` | 301 |
| **C** | `node --import ./tracing.mjs main.mjs` (no loader hook) | `pg.connect`, `handler …`, `request`, `GET /q` | 301 |
| D | `--import` a file that calls `module.register('@opentelemetry/instrumentation/hook.mjs')` and then loads tracing | the same four | 307 |
| D, unset | the same flags, endpoint unset | none | **0** |

What this shows:
- `fastify` and `pg` are CommonJS, so `require-in-the-middle` patches them as long as the SDK is
  registered before they're first loaded. The `import-in-the-middle` loader hook (D) added nothing
  for Kept's modules.
- A static sibling import doesn't wait for the tracing module's top-level `await` before `fastify`
  and `pg` are loaded. That is why A misses them.
- With `--import`, `process.argv[1]` is still the main script (checked), so `isEntrypoint` keeps
  working. A separate `boot.js` that dynamic-imports `main.js` (B) would break it.

**A dead collector:**
- Requests weren't held up. Request times ranged 91–395 ms across all runs, including the runs
  without OTel, which is the noise of the dead-Postgres connect.
- **`provider.shutdown()` waited 8.6–10.8 s** (default exporter timeout) and failed with
  `connect ECONNREFUSED 127.0.0.1:9`.
- With `OTEL_EXPORTER_OTLP_TIMEOUT=1000` the shutdown took 16 ms and 842 ms in two runs.

**A side effect that is inferred, not measured:** `@better-auth/core` 1.7.6
(`dist/instrumentation/api.mjs`) does `await import("@opentelemetry/api")` inside a try/catch the
first time it wants a tracer, and falls back to a no-op. Once `@opentelemetry/api` is a dependency
of `@kept/server`, better-auth may load it even with tracing off (it's a no-op without a registered
provider). That depends on pnpm linking the optional peer. T14's module-graph test should assert on
the SDK, exporter and instrumentation packages, and allow `@opentelemetry/api`.

## Error reporting with `@sentry/core` only (`sentry-core/report.mjs`)

`new ServerRuntimeClient({ dsn, integrations: [], stackParser: createStackParser(nodeStackLineParser()),
sendDefaultPii: false, transport: (o) => createTransport(o, fetchExecutor), beforeSend })` with
`client.init()`, `captureException(new Error('boom: synthetic'))` and `flush(2000)`. The local stub
received:

- `POST /api/42/envelope/?sentry_version=7&sentry_key=publickey`, `content-type: text/plain;charset=UTF-8`,
  no `x-sentry-auth` header (the key is in the query string).
- Envelope header: `event_id`, `sent_at`, `trace {environment, public_key, trace_id}`. Item header
  `{"type":"event"}`.
- Event keys: `contexts, environment, event_id, exception, level, sdk, tags, timestamp`. The exception
  value and 2 stack frames, and only the tags `beforeSend` set (`request_id`, `route`).
- No `request`, `user`, `extra` or `breadcrumbs`: `beforeSend` removed them, and with
  `integrations: []` none were collected.

Error reporting patches no modules, so it can be a plain `await import('@sentry/core')` at boot when
`KEPT_ERROR_DSN` is set. Load order doesn't matter for it.

## Recommendation for D84 / Q27

Keep T14 in step 8. Moving D84 to 1.x isn't needed: the cost is about 25 MiB, half a day, and no new
licence. Build it as:

- `src/observability/tracing.ts`: a side-effect module. If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset it
  does nothing. Otherwise it `await import()`s the `otel-min` set, registers the HTTP and pg
  instrumentations and exports a `FastifyOtelInstrumentation`. `buildApp` registers its `plugin()`
  first when present.
- **Start it with `--import`**: `ENTRYPOINT ["node", "--import", "/app/apps/server/dist/observability/tracing.js", "/app/apps/server/dist/main.js"]`.
  Also add it to ci-local's `main=(node --conditions=kept-dist …)` and to Helm's command if it
  overrides the entrypoint. No `--experimental-loader` hook.
- **Shutdown:** race `provider.shutdown()` against a ~2 s timer in Kept's shutdown path, and default
  `OTEL_EXPORTER_OTLP_TIMEOUT` to a small value if unset, so a dead collector can't hold a
  `SIGTERM`.
- `src/observability/errors.ts`: `@sentry/core` + `ServerRuntimeClient`, `integrations: []`,
  `sendDefaultPii: false`, and a `beforeSend` that keeps only exception, stack, request id and route.
  It sends with the global `fetch` and a timeout. The DSN is operator-set, like the OTLP endpoint, so
  not `guardedFetch`. That last point is a judgement call.

## Changes to the plan

- **T14 Files:** "modify `src/main.ts` (one import)" becomes "modify the `Dockerfile` ENTRYPOINT and
  `scripts/ci-local.sh` prod-boot to `--import dist/observability/tracing.js`, and `http/app.ts` to
  register `@fastify/otel`'s plugin when tracing is on". The one-import plan measurably misses HTTP
  and pg (variant A).
- **T14 packages:** `@opentelemetry/api` 1.9.1, `sdk-trace-node` 2.11.0, `resources` 2.11.0,
  `semantic-conventions` 1.43.0 (already present), `exporter-trace-otlp-proto` 0.222.0,
  `instrumentation` 0.222.0, `instrumentation-http` 0.222.0, `instrumentation-pg` 0.74.0,
  `@fastify/otel` 0.21.1, and `@sentry/core` 11.4.0. **Not** `@sentry/node` (FSL-1.1 CLI in its
  tree, +63.8 MiB), **not** `@opentelemetry/sdk-node` (+10 MiB of unused exporters), **not** the
  deprecated `@opentelemetry/instrumentation-fastify`.
- **T14 tests:** the "none of them loads" module-graph test may see `@opentelemetry/api` loaded by
  better-auth (inferred). Assert on the SDK, exporter and instrumentation packages. Add a test that
  shutdown with a dead collector returns within the bound.
- **T15 (image):** no change beyond the ENTRYPOINT flag. **D187 licence scan:** the chosen set needs
  nothing new.
- **Q27:** answered. Build it in step 8.
