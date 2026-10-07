---
title: The monorepo
description: Every workspace package, what lives in each directory of the server and the web app, the root scripts, and the checks that gate a change.
---

Kept is one pnpm workspace (`pnpm-workspace.yaml`: `apps/*` and `packages/*`). Node 24 and pnpm 11
are required (`engines` and `packageManager` in the root `package.json`). Dependencies are pinned
to exact versions. TypeScript is shared through `tsconfig.base.json`.

## Packages

| Package | Path | What it is |
|---|---|---|
| `@kept/server` | [`apps/server`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server) | The Fastify server, the job worker and the `kept` CLI (`bin: dist/cli/index.js`) |
| `@kept/web` | [`apps/web`](https://github.com/ibrahimroshdy/kept/tree/main/apps/web) | The React web app and PWA, built by Vite into `apps/web/dist`, which the server serves |
| `@kept/docs` | [`apps/docs`](https://github.com/ibrahimroshdy/kept/tree/main/apps/docs) | This site: Starlight, built to static files |
| `@kept/shared` | [`packages/shared`](https://github.com/ibrahimroshdy/kept/tree/main/packages/shared) | Code both sides import: error codes, the role matrix (`roles.ts`), ids, money, modules, the sync contract, normalisation |
| `@kept/mcp` | [`packages/mcp`](https://github.com/ibrahimroshdy/kept/tree/main/packages/mcp) | MCP tool definitions, their output shapes and vocabulary |

Inside the workspace `@kept/shared` and `@kept/mcp` resolve to their TypeScript sources; Node's
`--conditions=kept-dist` selects their compiled `dist/` instead (the end-to-end server runs that
way).

Outside the packages: `charts/kept` (the Helm chart), `docker/` (database bootstrap scripts, the
Caddyfile, the image's health check), `compose.yaml` and `compose.dev.yaml`, `Dockerfile`,
`docs/` (specs, plans, spikes, runbooks, performance reports) and `scripts/`.

## `apps/server/src`

One directory per feature. Most hold `routes.ts` (Fastify routes), `service.ts` (the rules, on a
scoped transaction), `view.ts` (response shapes) and `undo.ts` (in-app undo handlers).

| Directory | What it holds |
|---|---|
| `accounts` | `ensureAccount()`, sign-up, `/me` |
| `admin` | Instance-admin routes and the account operations the CLI shares |
| `agenda` | Every reminder source as one list |
| `ai` | Providers, the call door, budgets and caps, the ledger, the mock |
| `alerts` | Conditions an instance admin must hear about |
| `assistant` | The in-app assistant: threads, turns, proposals |
| `audit` | `audited()`, field classes, rendering and undo |
| `auth` | Better Auth setup, the session and CSRF hooks, two-factor gate, OIDC, managed accounts, rate limiting |
| `backup` | restic snapshots, the readable copy, verify, drill, restore |
| `boxcheck` | Box checks |
| `calendar` | The private iCal feed |
| `capture` | Capture batches and their undo |
| `cli` | The `kept` command: `migrate` and `admin …` |
| `codes` | A location's own codes and their format rule |
| `config` | The environment schema (`env.ts`) and its generated reference |
| `consumables` | Stock rules for consumables |
| `crypto` | Envelope encryption, the keyring, Crockford base32 |
| `currencies` | The currency list and its settings |
| `db` | Pools, `withScope()`/`withSystem()`, migrations, the release guard, the Drizzle schema (`db/schema/`) |
| `embeddings` | Semantic search's embeddings and their backfill |
| `enrich` | AI alias enrichment |
| `exports` | Location exports |
| `extraction` | AI extraction jobs, checks, duplicates, prompts |
| `files` | Uploads, attachments, signed file serving, PDF text |
| `fuel` | Fuel and charging entries |
| `history` | History and the activity feed |
| `home` | The home screen's checklist, attention panel and hints |
| `http` | `buildApp()`, conventions, errors, module gating, health, the web bundle |
| `imports` | CSV, Homebox and Kept archive imports |
| `inbox` | The review inbox and bulk actions |
| `incidents` | Incidents and claim packs |
| `invites` | Invites to a location |
| `jobs` | pg-boss setup, the job registry and policies |
| `labels` | Label batches and claiming blank labels |
| `lending` | Loans |
| `lists` | CSV export of the things list |
| `locations` | Locations, members, membership jobs |
| `mail` | Outgoing mail and its messages |
| `managed` | Managed accounts |
| `mcp` | `/mcp`: its bearer verification and server |
| `meters` | Meters, readings and their checks |
| `money` | Exchange rates, valuations, conversions |
| `net` | The SSRF guard for outbound requests |
| `notices` | Configuration-change notices to every user |
| `notify` | The notification centre, channels, web push |
| `oauth` | Kept as an OAuth server for MCP connectors (CIMD, consent) |
| `observability` | Optional tracing and error reporting |
| `paperwork` | Expiring documents |
| `places` | The place tree |
| `portability` | Export passphrases and ZIP handling |
| `purchases` | Purchases and their lines |
| `registries` | Types, place kinds, brands, vendors, people, tags |
| `reminders` | The reminder scan, deliveries, digests |
| `reports` | Inventory, insurance and vehicle reports |
| `scan` | Resolving a scanned code; barcode lookup |
| `schedules` | Schedules and service records |
| `search` | Search, document search, saved views, semantic search |
| `secrets` | Secret field values and key rotation |
| `seed` | `kept admin seed` scenarios |
| `serialize` | Response gates for money and secret values |
| `services` | Service drafts from an invoice |
| `setup` | The setup code and the recovery kit |
| `storage` | The blob store: local and S3 drivers, derivatives, signed URLs |
| `sync` | The phone's snapshot, cursor and offline ops |
| `templates` | Templates and quick add |
| `things` | Things, moves, custom fields |
| `tokens` | Personal tokens: routes, verification, rate limit, which routes they may call |
| `tools` | `runTool()` and the tool handlers the assistant and MCP share |
| `trash` | The trash and the daily purge |
| `types` | Type changes and field conversion |
| `undo` | The undo registry and route |
| `updates` | The opt-in update check |
| `vehicles` | Vehicle costs, lists and series |
| `warranties` | Warranties and claims |
| `webhooks` | Location webhooks and their delivery |

Next to `src/`: `migrations/` (SQL and drizzle-kit's snapshots), `test/` (the leak test, the
route catalogue, shared fixtures), `bench/` (the RLS benchmark), `eval/` (extraction, assistant
and search evaluations) and `assets/` (report fonts).

## `apps/web/src`

| Directory | What it holds |
|---|---|
| `api` | The fetch client, query hooks, and the request and response types per area |
| `assistant` | The assistant panel, composer and confirm cards |
| `camera` | The camera, barcode and QR scanner (zxing wasm) |
| `components` | Screens' building blocks, by feature, and the shared UI kit |
| `i18n` | Lingui setup |
| `lib` | Formatting, bidi isolation, preferences, small helpers |
| `locales` | The `en`, `ar`, `fr`, `de` and `it` catalogues (`messages.po`) |
| `offline` | The Dexie database, the queue, the sync engine, app lock |
| `pwa` | Service-worker registration, install, push, share target, diagnostics |
| `routes` | TanStack Router file routes (`routeTree.gen.ts` is generated) |
| `styles` | Design tokens and the global stylesheet |
| `test` | Test setup and helpers |

`sw.ts` is the service worker's source and `demo.ts` the fixture mode (`?demo=…`). End-to-end
tests are in `apps/web/e2e` (Playwright).

## Root scripts

| Script | What it runs |
|---|---|
| `pnpm lint` | `biome check .`, then `check-logical-css`, `check-i18n` and `check-no-local-paths` |
| `pnpm format` | `biome format --write .` |
| `pnpm typecheck` | `tsc` on the root project, then every package's `typecheck` |
| `pnpm test` | `vitest run` over the projects `packages/*`, `apps/server`, `apps/web` and `scripts` |
| `pnpm ci` | `bash scripts/ci-local.sh`, the full gate |
| `pnpm bench:rls` | The RLS benchmark: the server's `bench`, then `bench:pi` with a 512 MB heap |
| `pnpm eval:extraction`, `eval:assistant`, `eval:search` | The AI evaluations (mock provider unless told otherwise) |
| `pnpm docs:dev`, `docs:build` | This site |

Package scripts worth knowing: `pnpm --filter @kept/server dev` (`tsx watch src/main.ts`),
`pnpm --filter @kept/server kept <command>` (the CLI from source), `pnpm --filter @kept/web dev`
(Vite), `pnpm --filter @kept/web build` (the bundle, then its size check), `pnpm --filter @kept/web e2e`,
and `pnpm --filter @kept/docs gen:config` (regenerates the
[configuration reference](/reference/configuration/) from `config/env.ts`).

## Checks

| Tool | What it checks |
|---|---|
| Biome (`biome.json`) | Lint and format |
| `tsc` | Types, per package |
| Vitest | Unit and integration tests; server tests clone a database per worker. See [testing](/developers/testing/) |
| Lingui | `scripts/check-i18n.mjs`: every source message is in all five catalogues; `check-i18n-extract.mjs`: a real `lingui extract` finds nothing new |
| `scripts/check-logical-css.mjs` | No physical-side CSS in `apps/web/src`, so Arabic mirrors |
| `scripts/check-no-local-paths.mjs` | No home directories, private addresses or tailnet names in tracked files |
| `scripts/check-licences.mjs` | Every dependency's licence is on the allowlist |
| `scripts/check-attribution.sh` | No AI attribution in commits (also the commit-msg hook in `.githooks/`) |
| `scripts/check-dco.sh` | Every commit is signed off by its author |
| `scripts/check-helm.sh` | The chart: lint, golden renders, kubeconform, image pins |
| `apps/web/scripts/check-bundle.mjs` | The web bundle and precache size budget |

`bash scripts/ci-local.sh --list` prints the gate's steps: install, lint, catalogues, typecheck,
compose, test, drift, licences, attribution, docs, helm, prod-boot, eval, portability, backup,
perf, e2e, images, release-dry-run. `--fast` runs lint, catalogues, typecheck, the unit tests
and the evaluations, with no Docker. On a pull request GitHub Actions (`.github/workflows/ci.yml`)
runs the fast half and the licence, attribution and sign-off checks; the steps that need Docker
and the database run locally.
