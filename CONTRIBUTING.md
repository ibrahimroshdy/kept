# Contributing to Kept

Thank you for wanting to help. Kept is a self-hosted inventory that households trust with their
records for years, so most of the rules below are about not losing or leaking anyone's data.

The project is maintainer-led. For anything larger than a fix, open a discussion or an issue first,
so the work fits the design in [`docs/specs/`](docs/specs/) before you write it. The docs site's
Developers section goes deeper than this page; this page is what you need to send a pull request.

On the docs site:

- **Getting going:** [local setup](https://ibrahimroshdy.com/kept/developers/local-setup/),
  [the architecture](https://ibrahimroshdy.com/kept/developers/architecture/),
  [the monorepo](https://ibrahimroshdy.com/kept/developers/monorepo/),
  [testing](https://ibrahimroshdy.com/kept/developers/testing/) and
  [a feature end to end](https://ibrahimroshdy.com/kept/developers/feature-walkthrough/).
- **The parts with rules:**
  [languages and right-to-left](https://ibrahimroshdy.com/kept/developers/i18n-rtl/),
  [the UI kit](https://ibrahimroshdy.com/kept/developers/ui-kit/),
  [row-level security](https://ibrahimroshdy.com/kept/developers/rls/),
  [migrations](https://ibrahimroshdy.com/kept/developers/migrations/),
  [API conventions](https://ibrahimroshdy.com/kept/developers/api/) and
  [the MCP server](https://ibrahimroshdy.com/kept/developers/mcp/).
- **Maintainers:** [the DCO](https://ibrahimroshdy.com/kept/maintainers/dco/) and
  [releasing](https://ibrahimroshdy.com/kept/maintainers/releasing/).

## Prerequisites

- **Node 24** (`.nvmrc`; `package.json` allows `>=24 <25`).
- **pnpm 11**, the exact version pinned in `package.json`'s `packageManager` (`pnpm@11.23.0`):
  `corepack enable` picks it up.
- **Docker** with Compose v2, for the development database and Mailpit.
- For the end-to-end tests: Google Chrome, or Playwright's Chromium
  (`pnpm --filter @kept/web exec playwright install chromium`).

## Set up

```sh
git clone https://github.com/ibrahimroshdy/kept.git && cd kept
pnpm install
git config core.hooksPath .githooks                # the commit-msg hook (no AI attribution)
docker compose -f compose.dev.yaml up -d --wait    # Postgres on 5452, Mailpit on 8025 (UI) and 1025 (SMTP)
cp .env.example .env                               # development values only
set -a; . ./.env; set +a                           # export them into this shell
pnpm --filter @kept/server kept migrate            # runs the migrations as kept_owner
```

`compose.dev.yaml` is the development database only (`compose.yaml` is the self-hoster's stack).
Its Postgres is `pgvector/pgvector` on **localhost:5452** (user and password `postgres`), with the
four Kept logins made by `docker/initdb/`; Mailpit catches every mail at <http://localhost:8025>.
`docker compose -f compose.dev.yaml --profile s3 up -d --wait` adds RustFS, an S3-compatible
store on 9452, for the S3 storage driver.

### Something to look at

Seed the development database with three households: people and their roles, places, things with
photos, purchases and history, warranties, loans and documents, and the Garage's Toyota Corolla
with six months of readings, fills and services. Every password is `kept-seed-password`; sign in
as `ibrahim@kept.test` (the instance admin), `alfred@kept.test` (Arabic) or another of the cast
below.

```sh
pnpm --filter @kept/server kept admin seed --scenario households
```

### Run it

The server serves the built web app; there is no dev proxy between them.

```sh
pnpm --filter @kept/web build                                   # apps/web/dist
KEPT_PUBLIC_URL=http://localhost:8080 pnpm --filter @kept/server dev   # tsx watch, on 8080
```

Open <http://localhost:8080>. Rebuild the web app to see a change in it. For quick work on screens
without a server, `pnpm --filter @kept/web dev` runs Vite with the in-memory demo API: open
`http://localhost:5173/?demo=owner` (scenarios `owner`, `firstrun`, `member`, `setup`,
`signedout`; `&lang=ar`, `&theme=dark` and `&digits=eastern` set the display preferences).

`pnpm --filter @kept/server kept admin --help` lists the operator commands; the docs site's CLI
page explains each.

### On a phone (HTTPS)

The camera, offline capture, installing to the home screen, push and location need a secure
context: `localhost` counts, a LAN address over plain HTTP does not, and Kept falls back to a file
picker. Put HTTPS in front of 8080 and set `KEPT_PUBLIC_URL` to the address the phone opens
(links, QR codes and the same-site check use it):

- **Tailscale:** with HTTPS certificates on for the tailnet, `tailscale serve --bg 8080` serves it
  at `https://<machine>.<tailnet>.ts.net` to any phone on the tailnet.
- **mkcert** on the LAN: `mkcert -install`, then `mkcert <the machine's LAN IP>`, and any TLS
  proxy (Caddy, for example) in front of 8080 with that certificate. The phone must trust mkcert's
  root (`mkcert -CAROOT` shows where `rootCA.pem` is); on iPhone, install it as a profile, then turn
  on full trust in Settings → General → About → Certificate Trust Settings.

Then Settings → Diagnostics → "Run the checks" → "Copy report" says what the device supports.

## The monorepo

| Path | What |
|---|---|
| `apps/server` | Fastify 5, Drizzle and Postgres 18: the HTTP API, `/mcp`, the worker's jobs and the `kept` CLI (`src/cli`). Migrations in `migrations/`, schema in `src/db/schema/`. |
| `apps/web` | React 19, Vite, TanStack Router and Query, React Aria, Lingui, Tailwind v4: the app and its service worker. Routes in `src/routes/`, catalogues in `src/locales/<lang>/messages.po`, Playwright tests in `e2e/`. |
| `apps/docs` | The documentation site (Starlight): install, admin and developer pages, the generated configuration and API references. `pnpm docs:dev` serves it. |
| `packages/shared` | Types, schemas and constants the server and the web app share. |
| `packages/mcp` | The tool contracts the assistant and MCP share (`src/tools.ts`). |
| `charts/kept` | The Helm chart. |
| `docker/` | The image's healthcheck, the Postgres init scripts (development and production), the Caddyfile. |
| `scripts/` | The CI gate (`ci-local.sh`), the repository checks, the release scripts. |
| `docs/` | The specs, build plans, spikes, runbooks and release records. |

## Tests

```sh
pnpm test                                                 # every vitest project
pnpm exec vitest run --project @kept/server apps/server/src/things   # one project, one folder
pnpm exec vitest run --project @kept/web                  # or @kept/shared, @kept/mcp, scripts
```

- **Write the failing test first**, then the code.
- **Tests use their own databases**, never the development one: the server's test setup clones a
  template database per worker on the development Postgres (5452) and drops it afterwards. Never
  point a test at a database you care about. `KEPT_TEST_WORKERS=<n>` caps the workers on a busy
  machine.
- Tests pin `TZ=Africa/Cairo`. AI calls in tests go to the mock provider, never a real one.
- `pnpm eval:extraction`, `pnpm eval:assistant` and `pnpm eval:search` score the AI paths on the
  mock (ci-local's `eval` step); a real provider's run is described in
  [`apps/server/eval/README.md`](apps/server/eval/README.md). `pnpm bench:rls` benchmarks
  row-level security at 10,000 things.
- **End to end:** build the server and the web app, then run Playwright. Each instance gets a
  scratch database of its own, migrated and seeded for the run:

  ```sh
  pnpm --filter '@kept/server...' build && pnpm --filter @kept/web build
  pnpm --filter @kept/web e2e        # KEPT_E2E_INSTANCES=capture,vehicles runs only those
  ```

## The gate: `scripts/ci-local.sh`

**`bash scripts/ci-local.sh` is the gate.** It stops at the first failure and gates on exit codes,
never on a printed summary. `--list` names the steps, `--from <step>` resumes at one.

- **Before a pull request:** `bash scripts/ci-local.sh --fast` (lint, the catalogues, typecheck,
  the unit tests and the mock evaluations; no Docker, no database), plus the tests for what you
  touched.
- **Before a release, or a change to the database, the image or the release:** the full run (the
  database tests, migration drift, licences, attribution, the docs, the Helm chart, a production
  boot, portability, backup, performance, end to end, the images and a release dry run). Run the
  performance step on a quiet machine.

On a pull request, GitHub Actions runs the `--fast` half and the licence allowlist (`ci.yml`'s
`fast` job), the attribution and sign-off checks (`attribution`, `dco`), and the docs build
(`docs.yml`'s `build`). The steps that need Docker and the database run on your machine.

## Rules the codebase enforces

Each of these has a check that fails; the PR template repeats them.

- **Logical CSS only** (`margin-inline-start`, `ps-`, `text-start`), so Arabic lays out right to
  left: `scripts/check-logical-css.mjs`, in `pnpm lint`.
- **React Aria controls.** Never a native `<select>` or an OS picker, never `window.confirm`,
  `alert` or `prompt`.
- **Phones.** Every screen works at 375 px wide and at 1280, and nothing is cut short with "…" on a
  phone.
- **Five catalogues.** Every user-facing string goes through Lingui and into `en`, `ar`, `fr`, `de`
  and `it`; `pnpm lint` and ci-local's `catalogues` step fail on a missing or empty one. Arabic
  follows the house style: written natively (not translated word for word), every plural form,
  Eastern Arabic digits where the reader chose them. Separators come from `fmt.sep`
  (`apps/web/src/lib/format.ts`, "، " in Arabic), names inside sentences are bidi-isolated
  (`<bdi>`, or `lib/bidi.ts` in toasts and titles).
- **Row-level security on every table.** A new table needs its RLS policies, its scope, and fixture
  rows in the leak test (`apps/server/test/leak.test.ts` and its `leak-*.ts` fixtures), which
  finds every table from the catalogue and fails until all three exist.
- **Every write is audited.** Each non-GET route needs a test that asserts its audit row, marked
  `// catalogue: <METHOD> <url>` directly above the `it(` case, or a reasoned entry on the
  allowlist in `apps/server/test/route-catalogue.test.ts`.
- **Migrations are additive.** A release must run on the database the next release leaves behind
  (one-version rollback): add columns and tables; dropping or renaming takes two releases (stop
  reading it, then remove it). Enumerations are `text` with a `CHECK`, never Postgres enums.
  Tables come from drizzle-kit; functions, triggers, roles and policies are custom SQL. ci-local's
  `drift` step fails if the schema and the migrations differ.
- **Secrets never leave through a side door:** not in argv, a log line, an audit diff, job data,
  an error message or a metric label.
- **No telemetry, ever,** and no outbound request an admin didn't turn on.
- **Dependencies** pass the licence allowlist (`scripts/check-licences.mjs`: no GPL, AGPL, SSPL or
  BUSL), at exact versions. Read the package's own types and docs rather than guessing an API.
- **Nothing machine-local or private** in tracked files: no home or temp directory paths, real
  tailnet host names, or private (RFC 1918) and shared (RFC 6598) addresses outside tests and the
  files listed in `scripts/check-no-local-paths.mjs`. Use an RFC 5737 address (`192.0.2.10`) or a
  placeholder (`<machine>.<tailnet>.ts.net`) in an example. `pnpm lint` runs it.
- **No AI attribution** in commits or pull requests (below).
- **The sample cast.** Fixtures, tests, screenshots and docs use the same people: **Ibrahim** (the
  instance admin; owns Home and Garage), **Alfred** / ألفريد (Arabic; owns بيت العائلة), **Bruce**
  (an admin of Home), **Louis** (a member), **Talia** (a viewer), **Peter** (Alfred's son, a
  managed account), and the contact **Murdock**. Please don't invent others.

### Maintainer note: private terms

`scripts/check-no-local-paths.mjs` holds only generic rules, because it is public. Words that are
private to you (your own host names, an internal domain, other private projects) go in
**`.private-terms`** at the repository root, one per line, `#` for comments; git ignores the file.
`KEPT_PRIVATE_TERMS` (comma-separated) adds more for one run. Each term is matched as literal text,
ignoring case, in every tracked file, and reported as `private-term`. A fork or CI without the file
runs the generic rules only.

## Commits

- **Conventional Commits:** `feat(scope): …`, `fix(scope): …`, `docs: …`, `test: …`, `build: …`,
  `ci: …`, `perf: …`, `i18n(web): …`, `chore: …`. The changelog is generated from them
  (`scripts/changelog.mjs`). Keep the subject to about 72 characters and put the detail in the body.
- **No AI attribution, anywhere** (D173). Commit messages, authors, committers, co-author trailers,
  pull-request descriptions and release notes never name an AI tool or assistant: no AI
  `Co-Authored-By` trailers, no "Generated with…" lines. The author is always the person who
  contributes the change. The commit-msg hook (`.githooks/commit-msg`), ci-local's `attribution`
  step and the `attribution` job on pull requests reject such commits. Using tools is fine;
  crediting them in the history is not.
- One logical change per commit, with a message that says why.

## Sign your commits (DCO)

Kept uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) instead of
a contributor licence agreement. By adding a `Signed-off-by:` line to a commit you certify that you
wrote the change, or otherwise have the right to submit it, under the project's licence
(AGPL-3.0). There is nothing to sign once and no bot to answer.

- Sign off every commit: `git commit -s` adds
  `Signed-off-by: Your Name <you@example.org>`, from your `user.name` and `user.email`.
- The line must name the commit's author exactly. The `dco` job in `.github/workflows/ci.yml` runs
  `scripts/check-dco.sh` over a pull request's commits and fails on a missing or different
  sign-off; run it yourself with `bash scripts/check-dco.sh --range origin/main..HEAD`.
- Forgot? `git rebase --signoff origin/main`, then force-push your branch.
- Merge commits are not checked. The history from before Kept was public has no sign-offs; the DCO
  applies from the first public pull request on.

## Branches and pull requests

`main` is protected: nobody pushes to it directly, the maintainer included.

1. Fork, or branch in the repository if you have access: `git switch -c fix/short-name`.
2. Commit with sign-off; run `bash scripts/ci-local.sh --fast` and the tests you touched.
3. Open a pull request against `main`. Its **title is a Conventional Commit subject**: pull
   requests are squash-merged, the title becomes the commit on `main`, and your commits (with their
   sign-offs) become its body. Fill in the template's checks.
4. The required checks (`fast`, `attribution`, `dco`, `build`) must pass and every review thread
   must be resolved. History on `main` stays linear; the branch is deleted on merge.

**Review.** The maintainer reviews every pull request. Expect questions
about data safety first (RLS, the audit, secrets, migrations), then behaviour on a phone and in
Arabic, then the code. Keep a pull request to one change; say which ci-local steps you could not
run. A large change without an issue or discussion first may be closed with a pointer to one.

## Recipes

### A migration

- **A table or column:** change the schema in `apps/server/src/db/schema/`, then generate the
  migration with the owner login exported (from `.env`):

  ```sh
  cd apps/server && pnpm exec drizzle-kit generate --name=<what_it_adds>
  ```

- **Functions, triggers, roles, RLS policies:** a custom migration, written by hand into the file
  drizzle-kit creates:

  ```sh
  cd apps/server && pnpm exec drizzle-kit generate --custom --name=<what_it_does>
  ```

- A new table also needs its RLS policies (a custom migration) and its leak-test fixtures. Then
  `pnpm --filter @kept/server kept migrate`, the server tests, and ci-local's `drift` step.

### A route

Add it to the feature's `routes.ts` in `apps/server/src/<feature>/`, with a schema for what it
accepts and returns. A route that writes leaves an audit row; write
the test that asserts it and put the `// catalogue: <METHOD> <url>` marker above that case. A new
`/api/v1` route appears in the docs' API reference from the OpenAPI document on the next docs
build.

### A screen

A TanStack Router file route in `apps/web/src/routes/_app/` (the router plugin regenerates
`routeTree.gen.ts` on `vite build` or `vite dev`). A screen that only works online loads on demand:
add it to `HOUSEHOLD_ROUTES` (or `COMPONENT_ONLY_ROUTES`) in `apps/web/vite.config.ts`, so the PWA
precache stays under its budget; `pnpm --filter @kept/web build` runs `scripts/check-bundle.mjs`,
which fails when it doesn't. Check it at 375 and 1280, light and dark, and in Arabic. Lists get
search, filter, grouping and pagination, kept in the URL.

### A string

Write it with Lingui (`` t`…` `` or `<Trans>`), then:

```sh
pnpm --filter @kept/web i18n:extract
```

and fill in its `msgstr` in `apps/web/src/locales/{ar,fr,de,it}/messages.po`, with every plural
form. `pnpm lint` and `node scripts/check-i18n-extract.mjs` say what is missing.

### An MCP tool

One registry serves the assistant and MCP. Add the tool's contract (name, `scope`, `module`, input
and output schemas, and a description that is the question it answers) to
`packages/mcp/src/tools.ts`, its handler under `apps/server/src/tools/handlers/`, and register it in
`apps/server/src/tools/registry.ts`. A write tool's change is audited as the person it acts for.
No tool trashes, deletes, merges, transfers ownership, reveals a secret, uploads a file
or runs SQL; `packages/mcp/src/tools.test.ts` checks the names.

## Security issues

Never in a public issue. See [`SECURITY.md`](SECURITY.md).

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
