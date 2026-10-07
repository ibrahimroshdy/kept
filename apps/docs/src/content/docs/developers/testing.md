---
title: Testing
description: How Kept's tests are organised, how the server's test databases are made, and what each step of the local CI gate runs.
---

Kept's gate is local: **`bash scripts/ci-local.sh` is the CI**. The hosted workflow runs only the
half a runner can do without a database. Tests use [Vitest](https://vitest.dev/) everywhere,
Testing Library in the web app, and Playwright for end to end. The rules are in the engineering
spec
[§7.12](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md)
and in [CONTRIBUTING.md](https://github.com/ibrahimroshdy/kept/blob/main/CONTRIBUTING.md).

## Vitest projects

The root `vitest.config.ts` lists the projects: `packages/*`, `apps/server`, `apps/web` and
`scripts` (`scripts/vitest.config.mjs`, the repo's own check scripts, no database). Each has its
own `vitest.config.ts`.

```sh
pnpm test                                                   # every project
pnpm exec vitest run --project @kept/server apps/server/src/things   # one project, one folder
pnpm exec vitest run --project @kept/web                    # or @kept/shared, @kept/mcp, scripts
```

`KEPT_TEST_WORKERS=<n>` caps the worker processes on a busy machine. Both apps pin
`TZ=Africa/Cairo` and give a test 20 s, so a slow machine doesn't turn into flaky failures.

## Server tests and their databases

Server tests run against real Postgres: the development database from `compose.dev.yaml`, on
port 5452.

```sh
docker compose -f compose.dev.yaml up -d --wait
```

They never touch your development data. `apps/server/test/global-setup.ts` runs once per test run:
it creates a template database named after the run, runs every migration into it as `kept_owner`,
and marks it a template. Each worker then clones its own database from the template
(`testDb()` in `apps/server/test/db.ts`) and connects with the four roles the server uses
(`app`, `auth`, `system`, `owner`). Between tests, `reset()` empties the tables but keeps
reference data and built-in types. The teardown drops every database the run made.

Helpers in `apps/server/test/`: `app.ts` builds the Fastify app for a test, `tenancy.ts` seeds
accounts, locations and members, `things.ts`, `files.ts` and others seed the rest.

### The leak test

`apps/server/test/leak.test.ts` is schema-wide and generated from the catalogue (`pg_class`,
`pg_policies`, `information_schema`). A new table fails it until it has row-level security, its
policies, a scope, and fixture rows in one of the `leak-*.ts` files, which then prove that a member
of one location reads nothing of another's. The explicit lists in the file (such as tables
`kept_system` may read across tenants) are the deliberate exceptions. See
[Row-level security](/developers/rls/).

### The route catalogue

`apps/server/test/route-catalogue.test.ts` builds the app with every route module and collects
each non-GET route. Each must either have a test that asserts its audit row, marked with a
comment directly above the `it(`:

```ts title="apps/server/src/things/things.test.ts"
// catalogue: POST /api/v1/things/:id/seen
it('marks a thing seen now and clears not-here, audited (D40)', async () => {
```

or be on the file's `ALLOWLIST` with the reason no audit row is right (a read-only `preview`, a
test ping). The check reads the case's code: it must read the audit (`audit_events`, or a helper
such as `eventsOf(`) near an `expect(`, and call the route it is marked for.

## Web tests

The web project runs in jsdom with Testing Library and `user-event`. Helpers in
`apps/web/src/test/`:

- `renderApp(path, …)` in `app.tsx` renders the whole app through the real route tree against
  the in-memory mock API (`apps/web/src/api/mock/`), in English or Arabic. `fetch` is stubbed;
  nothing leaves the test.
- `renderUI(ui, {locale})` in `render.tsx` renders one component inside the app's providers,
  with `lang` and `dir` set as the pre-paint script sets them.
- `dexie.ts` and `store-contract.ts` for the offline store, on fake-indexeddb.

Screen tests live in `apps/web/src/test/screens/`, one file per area. Test each screen in Arabic as
well as English.

## The AI mock

No test calls a real AI provider. With `KEPT_AI_MOCK=1` the server answers every model call from
`apps/server/src/ai/mock.ts`: deterministic answers keyed by the image's hash, scripted assistant
turns, and acted-out failures (429, 401, truncation, timeouts). See
[AI providers](/developers/ai-providers/#the-mock-provider).

## End to end

Playwright, against the built server and web bundle, with nothing mocked except the AI (on the
instances that need it) and the camera. `apps/web/e2e/serve.mjs` starts one server per instance,
each on its own scratch database on the development Postgres. Two projects: phone (375 × 780) and
desktop (1280 × 800).

```sh
pnpm --filter '@kept/server...' build && pnpm --filter @kept/web build
pnpm --filter @kept/web e2e        # KEPT_E2E_INSTANCES=capture,vehicles runs only those
```

Chromium runs with a fake camera and fake media devices; tests never open a real microphone or
camera.

## Performance

`pnpm bench:rls` benchmarks row-level security at 10,000 things (`apps/server/bench/`).
`apps/server/test/perf/` holds timed checks (a 50-op sync batch, the inbox at 500 open items,
the vehicle and later screens), run only by `vitest.perf.config.ts`, never by `pnpm test`.
Results are recorded in [`docs/perf/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/perf).
Numbers taken on a busy machine are not evidence.

## The gate: `scripts/ci-local.sh`

```sh
bash scripts/ci-local.sh            # every step in ALL_STEPS
bash scripts/ci-local.sh --fast     # FAST_STEPS: lint catalogues typecheck unit eval
bash scripts/ci-local.sh --from e2e # start at a step and run the rest
bash scripts/ci-local.sh --list     # print the step names
```

It needs Node 24, stops at the first failure, and gates on exit codes, never on a printed
summary. A step that can't run yet reports **SKIPPED** loudly, and the summary says the run is
not the full gate. Each step runs in a subshell that cleans up what it created.

There is no flag for one step alone: `--from` runs that step and everything after it. To repeat
one step, run its command from the table.

| Step | What it runs |
|---|---|
| `install` | `pnpm install --frozen-lockfile` |
| `lint` | `pnpm lint`: Biome, `check-logical-css.mjs`, `check-i18n.mjs`, `check-no-local-paths.mjs` |
| `catalogues` | `node scripts/check-i18n-extract.mjs`: the real `lingui extract` into a scratch copy |
| `typecheck` | `pnpm typecheck` |
| `unit` (fast only) | Every Vitest project except the server's: `pnpm exec vitest run --project '!@kept/server'` |
| `compose` | Starts `compose.dev.yaml` with the `s3` profile (RustFS on 9452) |
| `test` | `pnpm test`, every project, with the S3 tests required |
| `drift` | `drizzle-kit generate` must find nothing to write, and `drizzle-kit check` must pass |
| `licences` | `node scripts/check-licences.mjs`: every dependency's licence on the allowlist |
| `attribution` | `scripts/check-attribution.sh` over the commits not yet on `origin/main` |
| `docs` | The configuration reference matches the env schema, then `pnpm docs:build` with its link check |
| `helm` | `scripts/check-helm.sh`: lint, golden renders, kubeconform (skipped without the pinned tools) |
| `prod-boot` | Builds the server, migrates a scratch database, boots `dist/main.js` with `NODE_ENV=production`; `/readyz` must answer 200 within 20 s |
| `eval` | The extraction, assistant and search evaluations on the mock provider |
| `portability` | The export → import round trip and the hostile-archive tests |
| `backup` | Snapshot → restore round trip, the readable copy, the restic contract (fake restic unless `KEPT_TEST_RESTIC=1`) |
| `perf` | The snapshot bench at 10,000 things, then `apps/server/test/perf`; results in `.tmp/perf/` |
| `e2e` | Builds both apps and runs Playwright |
| `images` | Builds the amd64 and arm64 images and smokes the arm64 one with `scripts/smoke-image.sh` |
| `release-dry-run` | `scripts/release.sh --dry-run`; opt-in with `KEPT_RELEASE_DRY_RUN=1` |

Run `--fast` and the tests you touched before a pull request. Run everything before a release, or
after a change to the database, the image or the release. Run `perf` on a quiet machine.

## GitHub Actions

`.github/workflows/ci.yml` is **inert while the repository is private**: every job is gated on
`github.event.repository.private == false`. Once it is public, on pushes to `main` and on pull
requests:

- **`fast`**: `pnpm install --frozen-lockfile`, `bash scripts/ci-local.sh --fast`, and
  `node scripts/check-licences.mjs`;
- **`attribution`** (pull requests): no AI attribution in any commit or in the description;
- **`dco`** (pull requests): every commit signed off (`scripts/check-dco.sh`).

Everything that needs Docker or a database stays in the local gate. Say in a pull request which
ci-local steps you could not run.
