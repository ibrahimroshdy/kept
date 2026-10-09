---
title: Runbooks and scripts
description: The maintainer's runbooks, how they relate to the admin pages, the scripts a maintainer runs, and every step of the local CI gate.
---

## The runbooks

Four runbooks live in [`docs/runbooks/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/runbooks).
Each is a procedure against a live system with copy-pasteable commands and a **Verify** step, and
each starts with a dated status line saying what is built and what has actually been run.

| Runbook | Use it when |
|---|---|
| [`backup-restore.md`](https://github.com/ibrahimroshdy/kept/blob/main/docs/runbooks/backup-restore.md) | Turning backups on, backing up by hand and reading its warnings, checking the repository, rolling back past one release (`downgrade_refused`), restoring after losing the server, the alpha's pre-restic backups, reading a backup without Kept, and `pg_dump`'s version. The reference for anything restic. |
| [`restore-drill.md`](https://github.com/ibrahimroshdy/kept/blob/main/docs/runbooks/restore-drill.md) | The monthly drill (Admin → Status raises `restore_drill_due` after 30 days without one), and a real restore with the database swap. A failed drill is treated as an incident: the backups can't be trusted until one passes. |
| [`upgrade.md`](https://github.com/ibrahimroshdy/kept/blob/main/docs/runbooks/upgrade.md) | Upgrading under Compose, rolling back one version, and a Postgres major upgrade, which is a dump and restore through Kept's own backup, never an image tag change on the old volume. |
| [`release.md`](https://github.com/ibrahimroshdy/kept/blob/main/docs/runbooks/release.md) | Cutting a release: the one-time setup (W1–W4), each release, the laptop fallback (M1–M3), the dry run, and what to do when a stage fails. See [releasing](/maintainers/releasing/). |

### Runbooks and the admin pages

The first three have public versions on this site, written for the person running a server:
[backups](/admin/backups/), [restore and the drill](/admin/restore/),
[read your inventory with restic alone](/admin/read-with-restic/) and
[upgrades and rollback](/admin/upgrades/). Each runbook names its public page and asks that the two
be kept in step. The difference is the reader: a runbook carries the build's references (decision
and task numbers, which code it was read from, what hasn't been run yet), and the admin page
carries only what an operator needs.

`release.md` has no admin page: releasing is the maintainer's job. Its user-facing side is
[verifying a release](/admin/verify-release/).

## Scripts a maintainer runs

All in [`scripts/`](https://github.com/ibrahimroshdy/kept/tree/main/scripts):

| Script | What it does |
|---|---|
| `ci-local.sh` | The CI gate: every step below. `--fast` runs lint, catalogues, typecheck, unit and eval only (no Docker, no database); `--from <step>` starts at a step; `--list` prints the step names. |
| `release.sh` | The release: `--run-gate`, `--dry-run`, the laptop release, and `--ci` for the workflow ([releasing](/maintainers/releasing/)). Its stages are in `scripts/release/`. |
| `changelog.mjs` | The changelog section for a release ([the changelog](/maintainers/changelog/)). |
| `check-dco.sh` | Sign-offs over a range of commits ([the DCO](/maintainers/dco/)). |
| `check-attribution.sh` | No AI attribution in a commit message, a range of commits, or a release's notes (D173). |
| `tools.sh` | The laptop tools the chart check and the release need (cosign, helm, kubeconform), each at a pinned version: `path`, `fetch` (download and verify its SHA-256 into `.tmp/tools/`) and `check`. |
| `smoke-image.sh <image>` | Runs a built image as `compose.yaml` does, against a throwaway Postgres, and checks it migrates, serves `/readyz` and `/version`, runs as uid 10001 on a read-only root, generates its keys and setup code once, and backs up and drills with restic. The release runs a shorter scope (`SMOKE_SCOPE=release`). |
| `check-helm.sh` | The chart: `helm lint`, golden renders, kubeconform, image pins and the chart's refusals; `--update` rewrites the golden renders. |
| `check-licences.mjs` | Every dependency's licence is on the allowlist, runtime and dev separately (D151, D187). |
| `check-no-local-paths.mjs` | No home directories, temp paths, private addresses or the developer's own private terms (from a git-ignored `.private-terms`) in any tracked file. Part of `pnpm lint`. |
| `third-party-notices.mjs` | Writes `THIRD-PARTY-NOTICES.txt` from an image's own `node_modules`; run by the Dockerfile, not by hand. |
| `render-icons.mjs` | Every logo file from one geometry (the pierced mark and the KEPT lockup): the web app's and docs site's favicons, the docs logo, the app icons and the README lockups. Run it after changing `apps/web/src/components/brand.tsx`, and commit the outputs ([the brand](/developers/ui-kit/#the-brand-and-the-tape)). |
| `render-social-preview.mjs` | Draws `docs/assets/social-preview.png` (1280×640) from the lockup in headless Chromium; the maintainer uploads it in the repository's settings (Settings → General → Social preview). |
| `capture-screens.mjs` | Builds the web app's demo bundle, serves it locally and captures every app screenshot on the docs site (English and Arabic, light and dark, desktop and phone) and the README hero in headless Chromium; `--skip-build` reuses `apps/web/dist-demo`. Run it after a visible change to the app's shell, and commit the outputs. |

## ci-local, step by step

`bash scripts/ci-local.sh` runs these in order and stops at the first failure. Each step gates on
its exit code, never on printed output. A step that can't run yet says **SKIPPED** with the
reason, and the summary warns that the run isn't the full gate. From the script:

| Step | What it runs |
|---|---|
| `install` | `pnpm install --frozen-lockfile` |
| `lint` | `pnpm lint`: Biome, logical CSS, the message catalogues, no local paths |
| `catalogues` | `lingui extract` into a scratch copy; fails on a new message or an empty translation (`check-i18n-extract.mjs`) |
| `typecheck` | `pnpm typecheck` |
| `compose` | starts the dev database (and RustFS for S3) from `compose.dev.yaml` |
| `test` | `pnpm test`, the whole vitest suite, with the S3 tests required to run |
| `drift` | `drizzle-kit generate` into a copy of the migrations must find no schema change, and `drizzle-kit check` must pass |
| `licences` | `check-licences.mjs` |
| `attribution` | `check-attribution.sh` over `origin/main..HEAD` |
| `docs` | the configuration reference matches the code, then the docs site builds in every locale with its link check |
| `helm` | `check-helm.sh`; skipped without the pinned helm and kubeconform |
| `prod-boot` | builds the server, migrates a scratch database, boots it as production and requires `/readyz` 200 within 20 s; checks the mock AI provider is refused in production and the web push key pair is made once and never logged |
| `eval` | the extraction, assistant and search evaluations on the mock provider |
| `portability` | the export → import round trip, the export's search for another tenant's values, and hostile archives |
| `backup` | snapshot → restore round trip, the drill and verify, the readable copy, and the restic contract (an in-memory fake restic unless `KEPT_TEST_RESTIC=1`) |
| `perf` | the 10,000-thing snapshot benchmark and the server's perf tests; meaningless under load |
| `e2e` | builds the server and web, then the Playwright suite against real servers, with a fake camera |
| `images` | builds both platforms and smokes the arm64 image with `smoke-image.sh` |
| `release-dry-run` | `release.sh --dry-run`; opt-in with `KEPT_RELEASE_DRY_RUN=1`, otherwise skipped |

The `--fast` run adds one step the full list doesn't name, `unit`: every vitest project except the
server's, which needs the database. The hosted `ci` workflow runs every step except `perf`, as
parallel jobs that each run an `--only` slice
([triage](/maintainers/triage/#checks-that-run-on-a-pull-request)); `perf` runs nightly. That is
the gate (D222). `release.sh --run-gate` still records a local run for a release cut from the
laptop.

Useful settings: `KEPT_TEST_WORKERS=<n>` caps vitest's workers on a busy machine;
`DOCKER_CONFIG` overrides the Docker config copy the script makes in `/tmp/kept-docker-config`.
