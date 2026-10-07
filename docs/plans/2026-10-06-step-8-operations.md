# Step 8: Operations. Implementation plan

**Goal:** a household can trust Kept with its records for years. The server backs itself up off the
machine, the backup can be read without Kept, a burned server comes back from the recovery kit, an
upgrade can be undone, and the maintainer can ship a signed release from his laptop. Build step 8 in
the product design's build order (§17) is "the readable export inside every nightly snapshot
(D159); restic backups, restore and recovery kit, status page, update check, Helm chart, multi-arch
signed releases, docs site". The master plan estimates 4–6 weeks for one developer; this plan is
sized for about 8 parallel agents over 2–3 days (about 26 agent-days, below).

**In scope:**
- **Backups through the bundled restic** (D64, D66, D144, D159, §14):
  - a nightly, encrypted, deduplicated restic snapshot to a directory (a NAS path or another disk),
    an S3-compatible bucket (AWS, and B2's and R2's S3 endpoints) or SFTP, chosen in Admin →
    Backups with a passphrase, or locked by the environment (D186);
  - the snapshot holds the database dump, the checksum manifest, the files when they are stored
    locally (D144), and **the readable export of every location** (D159);
  - retention 7 daily / 4 weekly / 6 monthly; a size check that refuses to let a suspiciously small
    dump push good snapshots out (L79); stale-backup, disk-space and bucket-versioning alerts
    (D66, D144, D166);
  - the alpha's own backup format (T31c, D207) stays restorable for one release and is never
    written again.
- **Restore** (D66, D144): from a restic snapshot into a new, empty database, verified by data
  digests, not row counts (L78); the **monthly restore drill** and its nudge; a repository check
  that, with S3 storage, checks every manifest hash against the bucket (D144).
- **Upgrades** (D66, L97–L99): an automatic snapshot before `kept migrate` changes a database; a
  release history in the database; **one-version rollback** allowed, deeper downgrades refused
  unless forced.
- **The recovery kit, complete** (D66, D165, D182, D193): the keys, the old key versions, the
  restic repository, its password and its storage credentials, with the restore steps. From the CLI,
  or from the web after re-authentication. The backups half of the kit gate (step-1 carry-over).
- **The admin status page, complete** (D66, D166, §14): backups and their age, the last drill,
  bucket versioning, disk space, the recovery kit, the release and its migration level, failed jobs,
  the update check; Prometheus gauges for the backup's age and the disk.
- **The opt-in update check** (D65).
- **Packaging** (D16, D85, D186, D187):
  - the Helm chart (D85, D186);
  - multi-arch images built, smoked, **signed with key-based cosign** and released from the laptop
    (D87, D187, L100, L101, L103, L104), with an SBOM and a third-party notices file (D151);
  - the Compose file's Ollama profile (D85) and the migrate service's pre-upgrade snapshot;
  - switching file storage between local and S3 as a CLI migration (D186);
  - a liveness signal for `KEPT_ROLE=worker` (step-1 carry-over).
- **Optional tracing and error reporting** (D84), off by default (Q27 proposes moving it to 1.x if
  the coordinator needs the time).
- **The docs site** (Starlight, D102, D199) in `apps/docs/`: install, admin guide, "read your
  inventory with restic alone" (D159), the configuration reference and the API reference generated
  from the code; English complete, Arabic for the key pages.
- **Project files before the repository goes public** (D88, D105, D187): CONTRIBUTING,
  CODE_OF_CONDUCT, SECURITY, templates, the CLA text, Renovate, and workflows that stay inert until
  Actions run.
- **"Keep this location available offline" and the app lock** (D159, D181), moved here by step 3's
  Q21 and step 7's scope.
- **The 1.0 release checklist** (D130: 1.0 = steps 1–8), the second UI audit (master plan, "before
  1.0"), and the §19 rows due in step 8 or before 1.0: **V4**, **V5**, **V31**.
- **Carry-over assigned to step 8** (below, "Carry-over folded in").

**Out of scope, and where it goes:**
- Docker Hub mirror, store listings, demo instance (D87, D88, D107, D130): 1.x.
- Publishing the docs site and running the inert workflows: when the repository goes public (D199);
  the 1.0 checklist has the step.
- release-please (D187): when CI runs again (Q12). Step 8 generates the changelog on the laptop.
- The cloud phase (D71, D91).
- A restic UI for browsing or restoring single files: the CLI and the docs cover it (Q4).

**Carry-over folded in** (from `docs/plans/step-{1,2,3,4}-carryover.md`, open items that are
operations or release work):

| Item | From | Task |
|---|---|---|
| Recovery-kit gate at backup setup; downloading the kit from the web with re-authentication | step 1 | T9, T10, T22 |
| Third-party notices file shipped with every release (D151); licence scan against the image's pruned `node_modules` | step 1 | T15 |
| The image ships better-auth's optional peers (~425 MB image): trim | step 1 | T0a (R3), T15 |
| `KEPT_ROLE=worker` and the HEALTHCHECK: a worker liveness signal | step 1 | T13 |
| No published image yet; tags `1`, `1.2`, `1.2.3`; cosign | step 1 | T17 |
| `kept_app` timeouts in the managed-Postgres SQL the docs promise | step 1 | T19 |
| A sibling subdomain can overwrite the session cookie: the deployment docs | step 1 | T19 |
| Setup lockout behind a misconfigured proxy: the docs | step 1 | T19 |
| Operator CLI in Compose (`run --rm migrate admin …`, `exec kept kept admin recovery-kit`): the docs | step 1 | T19 |
| Admin alerts: backup failed exists; disk over 85 %, stale backup | step 1 | T4, T10 |
| A server port setting (`KEPT_PORT`) | step 1 | T13 |
| `LICENSE` done; CLA text, README licence line, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY | step 1 | T20 |
| The web build reports version `0.0.0-dev` (inject the real version with a Vite `define`, D148) | step 3 | T15 |
| `PROVIDER_TERMS` is empty, "before 1.0" | step 3 | T27 |
| Profile a 200-thing move, the snapshot at 10,000 things, export/import, on the 2 GB floor (V5) | steps 2, 3, 7 | T27 (maintainer VM) |
| `prod-boot` and `images` not run in steps 3–4's gates (an orphaned port-8080 server) | steps 3, 4 | T25 (the full gate), T13 (`KEPT_PORT` lets prod-boot use a spare port) |
| The device checklists of steps 3–7 | steps 3–7 | T27 (the 1.0 checklist lists every open row) |

T25 re-reads `docs/plans/step-{5,6,7}-carryover.md` when it runs (they don't exist on 2026-10-06)
and folds in any open operations or release item, each with its task or "1.x".

**Architecture.** The same as steps 1–7. What's new:
- **restic is a child process, never a library.** One wrapper (`src/backup/restic/`) runs the
  pinned binary with `--json`, passes the repository password and storage credentials **only in the
  child's environment** (never argv, never a log line), parses each JSON message with zod, and maps
  exit codes to named errors. Everything else (the nightly job, restore, the drill, verify, the
  pre-upgrade snapshot, the recovery kit's repository line) calls the wrapper.
- **One stable backup directory.** `KEPT_DATA_DIR/backup/` holds what a snapshot adds beside the
  files: `db/db.dump`, `db/manifest.json` and `readable/`. Its paths never change, so restic's
  retention groups snapshots correctly and an unchanged location's readable copy is not rewritten.
  The local blob store's `KEPT_DATA_DIR/blobs/` (`storage/local.ts`) is backed up in place; with S3
  storage it is not (D144).
- **The readable copy is step 7's, written to a directory.** T6 drives step 7's readable builder
  (`src/exports/readable/`, step-7 T13) through a directory sink, per location, **as that location's
  owner** under row-level security, so the rules (money gates, never a secret) are the export's own.
- **The backup stays the owner's job.** The dump runs as `kept_owner` (T31c, §7.1); the readable copy
  runs on the `kept_app` pool in each owner's scope; `backup_runs` is written by `kept_owner` and read
  by instance admins.
- **Settings that hold secrets live sealed in `instance_settings`**, like the VAPID key (step 4,
  `secrets/rotate.ts`): the restic password, the S3 secret and the SFTP key. Environment variables
  beat them and show as locked (D186).
- **Releases are a script, not a pipeline service.** `scripts/release.sh` runs on the maintainer's
  laptop, mirrors D87's order (checks → multi-arch push → verify `/version` → tag → chart), and has a
  `--dry-run` against a throwaway local registry so agents can build and test it **without his
  credentials**. Every step that needs them is a **maintainer step**.

**Before you start (status on 2026-10-06).**
- `git log` ends at `edbd02c` when this was written. Steps 5, 6 and 7 are being built by other
  agents in this tree; the last committed migration is `0083_import_history_doors.sql`, and it moves
  daily. Phase A starts at **the next free number at build time**: read
  `apps/server/migrations/meta/_journal.json` at HEAD.
- **Step 8 depends on step 7 in one place:** T6 needs step 7's readable builder (step-7 T13,
  `src/exports/readable/`). On 2026-10-06 `src/exports/` holds only `job.ts` and `routes.ts`.
  **If step-7 T13 isn't committed when T6 starts, T6 waits for it**; it never writes a second
  readable builder.
- Built in steps 1–7 that step 8 **uses and does not rebuild**:

  | Built | Where | Step 8 uses it for |
  |---|---|---|
  | The alpha backup (T31c, D207): pg_dump in one exported snapshot, the manifest (counts, blob SHA-256s), the directory and S3 targets, restore into an empty DB, `kept admin backup/export/restore` | `src/backup/{nightly,manifest,pg-tools,target,restore,config,export}.ts`, `src/cli/{backup,restore,export}.ts` | T5 keeps steps 1–2 (snapshot, dump, counts) and replaces the copy to `runs/`+`blobs/` with restic; T7 keeps the restore's checks and adds the restic source; `kept admin export` (the raw dump) stays |
  | `pg_dump`/`pg_restore` 18 from PGDG in the image | `Dockerfile` (runtime stage) | the dump; T15 adds restic and an SSH client beside them |
  | The status page and its API | `src/admin/routes.ts` (`GET /api/v1/admin/status`, `AdminStatus`), `apps/web/src/routes/_app/admin.status.tsx` | T10 and T21 extend both |
  | The recovery-kit acknowledgement and gate | `src/setup/recovery-kit.ts` (`requireRecoveryKitAck`), `secrets/service.ts` `requireRecoveryKit`, `GET/POST /api/v1/admin/recovery-kit[/acknowledge]`, `kept admin recovery-kit` (prints the keys only) | T9 completes the kit; T10 gates backup setup |
  | Re-authentication for a sensitive change | `auth/email-change.ts` (`reauth_required`, password check, `FRESH_SIGN_IN_SECONDS` 600) | T9's kit download |
  | Admin alerts (`backup_failed`, `reminders_not_scanned`, …) mailed and pushed | `src/alerts/alerts.ts` `raiseAlert`/`resolveAlert`, `db/schema/alerts.ts` `ADMIN_ALERT_KINDS` | the new alert kinds (T4, T10) |
  | Sealed values inside `instance_settings` and their rotation | `secrets/rotate.ts` (the VAPID entry), `crypto/envelope.ts` | the restic password and target credentials (T4, T10) |
  | `/healthz`, `/readyz`, `/version`, `/metrics` (token) | `src/http/health.ts` | T10's gauges; T13's worker liveness; T17's `/version` check |
  | The env schema and its generated reference | `config/env.ts`, `config/reference.ts` (`kept admin config`) | T2's new variables; T18's configuration page |
  | OpenAPI 3.1 at `/api/v1/openapi.json` | `http/app.ts` (`@fastify/swagger`) | T18's API reference |
  | The image, Compose and smoke | `Dockerfile`, `compose.yaml`, `docker/`, `scripts/smoke-image.sh`, ci-local `images` | T15, T16, T17 |
  | The licence and attribution checks | `scripts/check-licences.mjs`, `scripts/check-attribution.sh` | T15's notices; T17's release notes |
  | The offline snapshot, the store, wipe on 401 (D181, D210) | `src/sync/snapshot.ts`, `packages/shared/src/sync.ts`, `apps/web/src/offline/*` | T12 and T23 add the per-device extras beside it |
  | The step-7 export: the readable copy, safe CSVs, `writeArchive` | `src/exports/readable/` (step-7 T13), `@kept/shared` `safeCsvCell` | T6 |

**Tech stack.** The pins from steps 1–7 hold. **No version is written in this plan for a tool or
image step 8 adds**: T0a and T0b look each one up from its own release page or registry on the day,
record the version, the per-architecture SHA-256 and the licence in their spike note, and T1/T15
pin them. The candidates, each to be confirmed or replaced by the spike:

| Tool | Why | Where it runs | Looked up by |
|---|---|---|---|
| restic (BSD-2-Clause, inferred until read) | the backup engine (D64) | in the image, both architectures, checksum-pinned | T0a R1 |
| an OpenSSH client from Debian bookworm | restic's SFTP backend runs `ssh` (inferred from restic's docs; R1 confirms) | in the image | T0a R1 |
| cosign | key-based signatures (D187) | maintainer's laptop | T0a R2 |
| an SBOM generator: BuildKit's `--sbom` attestation or syft | D87 | laptop | T0a R2 decides one |
| a local OCI registry image | `release.sh --dry-run` and its tests | Docker, throwaway | T0a R2 |
| Helm, kubeconform (+ the Kubernetes schema version), kind (+ its node image) | the chart's lint, schema check and optional install smoke | laptop, ci-local `helm` step | T0a H1 |
| an Ollama image | the Compose profile (D85) | Compose profile `ollama` | T0a R3 |
| Astro + `@astrojs/starlight`, a link checker for Starlight, an OpenAPI renderer for Starlight | the docs site (D102) | `apps/docs` devDependencies | T0b D1 (`npm view`) |
| OpenTelemetry Node SDK packages; a Sentry-compatible client | D84 | server, lazily imported | T0b O1 |
| actionlint (optional) and the pinned commit SHAs of every GitHub Action the inert workflows use | T20 | laptop | T0b W1 (`git ls-remote`) |

Deliberately **not** added:
- a restic library or a Go toolchain: the binary is enough;
- rclone: restic's own S3 and SFTP backends cover D64's targets (Q3);
- a Kubernetes operator or CronJob for backups: the worker runs them (D186);
- a changelog service: a script (Q12).

**Ground rules for every task** (steps 1–7, repeated):
- **Spec order:** the specs in `docs/specs/` are the contract. Engineering spec §7 beats §1–§6. The
  product design's decision log beats the screens spec.
- **Library and tool APIs:** read the installed package's `.d.ts`, the tool's `--help` and its
  documentation. Never guess a flag, a JSON field or an exit code: R1 records restic's; follow it.
- **TDD:** a failing test, then the minimal code, then green, then commit.
- **Commits:** conventional messages, the repo's git identity, **no attribution lines** (D173; the
  commit-msg hook rejects them). Commit by path: `git commit -m "…" -- <paths>`. Never push.
- **Node 24:** `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`. Tests pin `TZ=Africa/Cairo`.
- **Ports:** Postgres 5452, Mailpit 8025/1025, RustFS 9452. Never 5432, 5433, 5442 or 6379 (other
  work on the same machine), nor another running Kept instance's port or database.
- **Docker:** `DOCKER_CONFIG=/tmp/kept-docker-config`. `df -h /` before any image build or large
  fixture; stop under 5 GB free. Remove every container, volume, network, registry, kind cluster and
  scratch database you create.
- **No GitHub Actions.** CI is `scripts/ci-local.sh`, gating on exit codes only.
- **Sample cast** in fixtures, docs and copy: Ibrahim (instance admin; owns Home and Garage), Alfred
  (Arabic; owns بيت العائلة), Bruce (admin), Louis (member), Talia (viewer), Peter (Alfred's son,
  managed), and the contact Murdock.

**Step-8 additions:**
- **One migration owner.** Phase A (T4) is done by one agent from the next free number. Phases B–D
  never add a migration; if one is needed, stop and hand it to the owner.
- **Every new table** gets the usual block in its custom migration: `ENABLE` + `FORCE ROW LEVEL
  SECURITY`; `owner_all` for `kept_owner`; `kept_app`/`kept_system` policies or none with a comment;
  `REVOKE UPDATE` then column grants; a fixture row in `fillTenant()` (a new
  `apps/server/test/leak-operations.ts`, imported by `test/leak.test.ts`), in the same commit.
  Instance-scope tables go on the leak test's instance list with their reason.
- **Every new sealed value** is registered in `secrets/rotate.ts` (the `instance_settings` list the
  VAPID key uses), with its AAD.
- **Secrets never leave through a side door.** The restic password, the S3 secret, the SFTP private
  key and the recovery kit never appear in argv (`ps`), a log line, an audit diff, `idempotency_keys`,
  pg-boss job data, an error message, a metric label, `backup_runs`, or a test snapshot file. A test
  per surface (T24 walks them).
- **Hot spots** (agent rules): `http/routes.ts`, the route catalogue, `http/errors.ts`,
  `vite.config.ts`, `routeTree.gen.ts`, `packages/shared/src/index.ts`, `Dockerfile`, `compose.yaml`,
  `scripts/ci-local.sh`, the `.po` catalogues. Surgical edits, `git status --short` right before,
  commit promptly by path. **Only T15 edits `Dockerfile` and `compose.yaml`**; only T25 edits the
  `.po` files; ci-local steps are added by their task, one function each.
- **API conventions** as in steps 2–7: camelCase JSON; `If-Match` on every PATCH/PUT of a versioned
  setting; 404 for anything invisible; every non-GET route calls `audited()` or has an `ALLOWLIST`
  entry with a reason; instance-admin routes require `kept.is_instance_admin()`.
- **Plain HTTP (D181).** Downloading the recovery kit, changing backup settings and the restic test
  are refused when `KEPT_PUBLIC_URL` isn't `https:` (403 `https_required`), as D181 lists "no secret
  reveal, export, token creation, admin screens". On 2026-10-06 a grep found **no shared guard** for
  this; T2 adds `requireHttps()` in `src/http/`, and T24 checks that secret reveal, export and token
  creation use it too (a finding to fix if not).
- **Web:** React Aria primitives; no native `select`, no `window.confirm/alert/prompt`; logical CSS;
  nothing truncated with … on a phone; RTL; 375 and 1280; every list is a `ListSurface` (search,
  filter, group, pagination, URL-backed); new admin screens load on demand from
  `assets/household/` (vite.config.ts `HOUSEHOLD_ROUTES`), "Needs a connection" offline. **No new
  route files after T3.** Parallel web tasks never run `i18n:extract` or edit `.po` files.

**Parallel execution (waves, with days for ~8 agents).** Tasks within a wave touch disjoint files.

| Wave | When | Tasks | Notes |
|---|---|---|---|
| 0 | day 1, morning | T0a ∥ T0b ∥ T1 ∥ T2 ∥ T3 ∥ T20 | T20 (project files) depends on nothing but T0b's W1 SHAs, which it can fill last |
| 1 | day 1, afternoon | T4 (one owner); T15 (after R1, R3); T16 (after H1); T18 (after D1); T11 ∥ T14 (after T1, T2) | T15 puts restic in the image early, so T5's tests can run it in the image too |
| 2 | day 2 | T5 ∥ T7 ∥ T8 ∥ T9 ∥ T10 ∥ T12 ∥ T13 (after T4); T6 (after T5's wrapper and step-7 T13); T17 (after R2, T15); T19 | T6, T7, T8 code against T2's `Restic` interface and its fake, so they don't wait for T5's real wrapper |
| 3 | day 2 afternoon – day 3 morning | T21 ∥ T22 ∥ T23 | on T3's mocks from day 1; each switches to the real server when its wave-2 task lands |
| 4 | day 3 | T24 → T25; T26 ∥ T25; then T27 | review, then i18n/e2e/CI/perf/docs; the UI audit beside it; the 1.0 checklist and the release dry run last |

**Sizes** (agent-days, each including its tests): T0a 1 · T0b 0.5 · T1 0.5 · T2 0.5 · T3 1 · T4 0.5 ·
T5 1.5 · T6 1 · T7 1 · T8 1 · T9 0.5 · T10 1 · T11 0.5 · T12 0.5 · T13 1 · T14 0.5 · T15 1 · T16 1.5 ·
T17 1.5 · T18 0.5 · T19 1 · T20 0.5 · T21 1.5 · T22 0.5 · T23 1.5 · T24 1 · T25 1.5 · T26 1 · T27 1.
**Total about 27 agent-days.** The critical path is T0a (R1) → T4 → T5 → T6 → T25 → T27, about 2.5
days. If the coordinator needs a day back, Q27 (move T14 to 1.x) and Q19 (Arabic docs pages after
1.0) are the proposed cuts.

---

## File structure (created or changed across the tasks)

```
packages/shared/src/
  ops.ts                backup settings schema, targets, retention, run kinds and states, the status
                        response, update-check state, semver helpers, app-lock and keep-offline limits
  errors.ts             + backup_not_configured, backup_running, backup_target_unreachable,
                          backup_password_weak, setting_locked, restic_failed, https_required,
                          downgrade_refused, keep_offline_too_large
apps/server/
  migrations/<next…>    Phase A (T4)
  src/db/schema/        operations.ts (backup_runs, release_history) (+ alerts.ts kinds)
  src/backup/restic/    run.ts (spawn, env, exit codes) json.ts (zod per message, from R1) repo.ts
                        (target → repository location + env) restic.ts (the Restic interface) fake.ts
  src/backup/           nightly.ts (rewritten on restic) snapshot-dir.ts digests.ts (per-table data
                        digests) size-check.ts legacy.ts (read the alpha runs/ format) drill.ts
                        verify.ts settings.ts (sealed settings, env locks) watch.ts (stale, disk,
                        versioning, drill-due) readable/{run.ts,sink.ts,cache.ts}
                        (+ restore.ts, manifest.ts, config.ts)
  src/db/               release-guard.ts (+ migrate.ts: pre-upgrade snapshot, release history)
  src/setup/            recovery-kit-content.ts (+ recovery-kit.ts)
  src/admin/            backup-routes.ts (+ routes.ts status, settings)
  src/updates/          check.ts job.ts
  src/sync/             extras.ts (+ routes.ts)
  src/storage/          copy.ts (local ⇄ S3)
  src/observability/    tracing.ts errors.ts (D84, lazy)
  src/http/             https-only.ts (requireHttps) (+ health.ts gauges, worker liveness)
  src/cli/              backup.ts restore.ts recovery-kit.ts storage.ts readable.ts (+ index.ts)
  test/leak-operations.ts  test/backup/round-trip.test.ts  test/perf/backup.perf.test.ts
apps/web/src/
  api/ops/              paths.ts types.ts queries.ts mock/{backup,status,kit,updates,device}.ts
  routes/_app/          admin.backups.tsx settings.device.tsx (+ admin.status.tsx, admin.settings.tsx)
  components/ops/       backup-target-form.tsx backup-runs.tsx snapshots-list.tsx status-tiles.tsx
                        kit-download.tsx reauth-sheet.tsx update-line.tsx
  components/device/    app-lock-settings.tsx lock-screen.tsx keep-offline.tsx
  offline/              lock.ts (PIN/WebAuthn, key wrapping) extras.ts (fetch, encrypt, store)
                        (+ wipe.ts, provider.tsx)
apps/docs/              Starlight site: astro.config.mjs, src/content/docs/{en,ar,fr,de,it}/…,
                        scripts/{env-reference.ts,openapi.ts}
charts/kept/            Chart.yaml values.yaml values.schema.json templates/ tests/ README.md
                        ci/{bundled-local,external-s3-split,external-no-roles,backup-dir}.values.yaml
scripts/                release.sh release/{build,verify,sign,chart,notes}.sh changelog.mjs
                        third-party-notices.mjs check-helm.sh (+ ci-local.sh, smoke-image.sh)
Dockerfile compose.yaml compose.env.example docker/healthcheck.mjs    (T15, T13)
CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md CLA.md renovate.json cosign.pub (maintainer)
.github/{ISSUE_TEMPLATE/,pull_request_template.md,workflows/{ci,docs,cla}.yml}   inert (T20)
docs/spikes/2026-xx-step8-*.md   docs/runbooks/{backup-restore,release,upgrade,restore-drill}.md
docs/release/1.0-checklist.md    docs/audits/ui-<date>.md
```

---

## Phase 0: spikes, shared contracts and scaffolding (T0a, T0b, T1–T3, parallel)

### Task 0a: Spikes: restic, the release pipeline, the image, Helm (Docker-heavy)

**Size:** 1 d. **Files:** `docs/spikes/2026-xx-step8-restic.md`, `…-release.md`, `…-image.md`,
`…-helm.md`; throwaway code under `docs/spikes/code/step8/`. `df -h /` first; stop under 5 GB.

- [ ] **R1, restic.**
  - **Version and binaries:** read restic's latest stable release from its GitHub releases page;
    record the version, each Linux binary's file name for amd64 and arm64, its SHA-256 (from the
    release's own checksum file, verified against its signature if one is published) and the
    licence file's text. Record how the Dockerfile installs it with a per-architecture checksum
    (`ADD --checksum` per `TARGETARCH`, or a `RUN` that checks `sha256sum`); the runtime image has no
    `curl` (it is `node:…-bookworm-slim`).
  - **JSON and exit codes:** from restic's docs **and** a real run, record the `--json` message
    types and fields of `backup` (status and summary), `snapshots`, `forget`, `ls`, `stats`,
    `check` and `restore`, and every documented exit code (no repository, wrong password, locked,
    "some files could not be read"). T5's zod schemas are written from this note.
  - **Environment:** the variables for the password, the repository, S3 credentials and the cache
    directory; prove a password given only in the environment works and never shows in `ps`.
  - **Repository location:** init a repository in a **subdirectory** of a directory that already
    holds the alpha's `runs/` and `blobs/` (Q2), in an S3 prefix on RustFS (compose profile `s3`),
    and over SFTP against a throwaway SSH server container (image and tag read from its registry on
    the day): the location string syntax for each, how a host key is pinned (known_hosts file through
    restic's SFTP options), and that a private key file at mode 0600 under a read-only root works.
  - **Grouping and retention:** two backups of the same paths with a fixed `--host`; `forget
    --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune` with tags; confirm what `--group-by`
    must be so a snapshot of a changing tmp path doesn't escape retention. **Pass:** the policy
    removes what it should over 40 faked days (`--time` on backup, if restic has it; R1 records the
    flag or the alternative).
  - **Restore and listing:** `restore --include` of one subtree; `ls --json` of a snapshot; `restic
    mount` noted as Linux/macOS-only for the docs (not used by Kept).
  - **Memory and time** on the 2 GB floor's proxy (a container with `--memory 2g --cpus 2`): a first
    backup of a 10,000-thing dump plus 2 GB of JPEGs, then a second with 50 new files; peak RSS of
    restic and wall time. **Pass:** peak RSS recorded; if over 600 MB, record the restic setting that
    lowers it (or the finding).
  - **Cache:** where the cache goes when `$HOME` is `/tmp` on a read-only root; its size after the
    10,000-thing backup. Proposed: `KEPT_DATA_DIR/.cache/restic`, excluded from the backup (Q5).
- [ ] **R2, the release pipeline on the laptop, against a throwaway local registry.**
  - The local registry's image and tag, read from its registry on the day; run it on a spare port.
  - `docker buildx build --platform linux/amd64,linux/arm64` with `VERSION`/`REVISION`, **pushed by
    digest without a tag**; then the tags created from the index digest (`buildx imagetools create`
    or the alternative R2 finds). Confirm a tag never exists before its image (L101).
  - **SBOM:** BuildKit's `--sbom=true` attestation (and `--provenance`) against syft + `cosign attest`;
    record which one survives push-by-digest and imagetools tagging, its format (SPDX or CycloneDX),
    and how a user reads it. Pick one.
  - **cosign:** the version and its macOS binary's checksum (Homebrew or the release page);
    `generate-key-pair` into the scratch directory; `sign --key` the index digest; `verify --key`;
    with and without uploading to the public transparency log (Q14); signing a Helm chart pushed as
    an OCI artifact.
  - **amd64 smoke under emulation:** `scripts/smoke-image.sh` on the amd64 image on Apple Silicon;
    record the time (L103: test both).
  - **Pass:** a dry-run release of `0.0.0-r2.1` lands in the local registry with three tags, a
    verified signature, an SBOM a user can read, and a signed chart; the notes record each command.
- [ ] **R3, the image.**
  - Measure today's image size per architecture and the `node_modules` breakdown; try the step-1
    carry-over's fix (`resolvePeersFromWorkspaceRoot: false` and/or `peerDependencyRules` for
    better-auth's optional peers) against the lockfile in a scratch worktree; record the saving and
    whether `pnpm licenses list --prod` then matches what the image ships.
  - Record what the third-party notices file must list beyond npm: Node, restic, the SSH client,
    `postgresql-client-18`, the Typst compiler package, the IBM Plex fonts (OFL), and how each one's
    licence text is obtained (the Debian copyright files in the image, the restic release's LICENSE).
  - The Ollama image for the Compose profile (D85): name and tag read from its registry, pinned by
    multi-arch index digest, as `compose.yaml` pins pgvector and Caddy.
  - **Pass:** a size table and the trim decision; the notices sources; the Ollama pin.
- [ ] **H1, Helm.** Look up Helm, kubeconform (and the Kubernetes version its schemas follow), kind
  and kind's node image on their release pages; record versions and checksums. Render a trivial chart
  with `helm template | kubeconform -strict`. Create and delete a kind cluster once to time it.
  **Pass:** the four pins and a timing for an optional `helm` smoke in ci-local.
- [ ] **Commit:** `docs(spikes): step-8 restic, release pipeline, image and Helm`.

### Task 0b: Spikes: the update check, the docs site, the app lock, managed Postgres, observability, devices

**Size:** 0.5 d. **Files:** `docs/spikes/2026-xx-step8-{updates,docs-site,app-lock,managed-postgres,observability,workflows,devices}.md`

- [ ] **U1, the update check.** From GitHub's REST API documentation (not from memory): the endpoint
  for a repository's latest release, the headers it requires (a User-Agent), its unauthenticated rate
  limit, the fields that matter (tag name, release page URL, prerelease, draft, published date), and
  the answers for a private repository and a repository with no release. Record whether
  `guardedFetch` (`net/ssrf.ts`) passes it unchanged. **Pass:** a recorded request and response
  against a public repository that has releases (synthetic data only; no token).
- [ ] **D1, the docs site.** `npm view` Astro, `@astrojs/starlight`, a Starlight link-validation
  plugin and an OpenAPI plugin for Starlight: versions, licences (on the devDependency list, D187),
  and their peer ranges against Node 24 and the workspace. A scratch Starlight site with five
  locales (`en` default; `ar` right to left; `fr`, `de`, `it` falling back to English), Pagefind
  search, one page rendered from Kept's own OpenAPI JSON (dumped from the dev server), and a link
  check that fails on a broken link. Record the build time and output size. **Pass:** the scratch
  site builds offline and the Arabic page renders RTL with Arabic UI strings.
- [ ] **L1, the app lock.** In Chromium with a CDP virtual authenticator (the agent rules: headless,
  no real devices): a platform credential created and asserted with `userVerification: 'required'`;
  whether the PRF extension returns a secret (Q22); a PIN path: PBKDF2-SHA-256 in WebCrypto wrapping
  an AES-GCM key, the iteration count that takes about 300 ms on the laptop and its time under the
  slower-core proxy. Never a real authenticator, camera or microphone. **Pass:** the iteration count,
  the PRF answer in Chromium, and the device rows for iPhone and Android.
- [ ] **V31, managed Postgres.** From each provider's own documentation (AWS RDS, Google Cloud SQL,
  Azure Database for PostgreSQL flexible server, DigitalOcean, Supabase, Neon): whether PostgreSQL 18
  is offered, and whether a non-superuser can create `pg_trgm`, `unaccent` and `vector`; each row with
  the page it came from and the date read. **Pass:** the table T19 publishes, and §19 V31's result.
- [ ] **O1, observability (D84).** `npm view` the OpenTelemetry Node SDK packages Kept would need
  (an OTLP exporter, the HTTP and pg instrumentations) and a Sentry-compatible Node client: versions,
  licences, install size; whether they can be imported lazily so a server without
  `OTEL_EXPORTER_OTLP_ENDPOINT` loads none of them. **Pass:** the package list and its added image
  size, or the recommendation to move D84 to 1.x (Q27).
- [ ] **W1, inert workflows.** For each GitHub Action T20's workflows would use (checkout, setup-node,
  pnpm, Pages upload and deploy, the StepSecurity CLA fork, D105): read the release tag on its
  repository and resolve it to a commit SHA with `git ls-remote` (public data, no token). **Pass:** a
  table of action → tag → SHA.
- [ ] **The device checklist** `docs/spikes/2026-xx-step8-devices.md`, from "Needs the maintainer's
  devices" below, with an empty result column.
- [ ] **Commit:** `docs(spikes): step-8 update check, docs site, app lock, managed Postgres, observability, workflows`.

### Task 1: Shared contracts

**Size:** 0.5 d. **Files:** create `packages/shared/src/ops.ts` (+ `ops.test.ts`); modify
`errors.ts`, `index.ts`

- [ ] **Step 1: `ops.ts`.**
  - `BACKUP_TARGET_KINDS = ['dir', 's3', 'sftp']`.
  - `BackupTargetInput` (zod, strict): `{kind: 'dir', path}` (absolute) · `{kind: 's3', endpoint?,
    region, bucket, prefix, forcePathStyle, accessKeyId, secretAccessKey?}` · `{kind: 'sftp', host,
    port, user, path, privateKey?, hostKey}`. Write-only fields (`secretAccessKey`, `privateKey`, the
    password) are **absent on read** and replaced by `{secretAccessKeySet: boolean}` and the like.
  - `BackupSettingsInput = {target, password?, time: 'HH:MM', keep: {daily, weekly, monthly}}`,
    `BACKUP_KEEP_DEFAULT = {daily: 7, weekly: 4, monthly: 6}` (D66), `BACKUP_PASSWORD_MIN = 12` (Q6),
    `BackupSettingsView` with each field `{value, locked}` (D186).
  - `BACKUP_RUN_KINDS = ['nightly', 'manual', 'pre_upgrade', 'drill', 'verify']`,
    `BACKUP_RUN_STATES = ['running', 'ok', 'warning', 'failed']`, `BackupRun` (the T4 row in camelCase,
    no credential).
  - `BACKUP_STALE_HOURS = 36`, `DRILL_DUE_DAYS = 30`, `DISK_WARN_RATIO = 0.85` (D66, D166).
  - `AdminStatus` (the full T10 response), `UpdateCheckState = {enabled, locked, lastCheckedAt,
    latest: {version, url, publishedAt} | null, error: 'unreachable' | 'not_found' | 'rate_limited' |
    null}`.
  - `parseSemver()`, `compareSemver()` (prerelease ordering per semver 2.0), with tests.
  - `APP_LOCK = {idleMinutes: 5, pinMin: 6, maxPinTries: 10, pbkdf2Iterations: <from L1>}`,
    `KEEP_OFFLINE = {deviceBytes: 250 * 1024 ** 2, fileBytes: 25 * 1024 ** 2}` (Q21).
  - `SyncExtrasPage` (T12's response).
- [ ] **Step 2: `errors.ts`.** The codes in the file structure, each with its English message.
- [ ] **Step 3:** `pnpm test --project @kept/shared` passes. Commit:
  `feat(shared): operations contracts: backups, status, updates, app lock and keep-offline limits`.

### Task 2: Server scaffolding: env, stubs, the restic seam, job policies, the HTTPS guard

**Size:** 0.5 d. **Files:** modify `config/env.ts` (+ test), `jobs/policies.ts`, `jobs/system.ts`,
`http/errors.ts`, `http/routes.ts`; create `src/backup/restic/{restic.ts,fake.ts}`,
`src/http/https-only.ts`, stub `src/admin/backup-routes.ts`, `src/updates/job.ts`,
`src/sync/extras.ts`

- [ ] **Step 1: Environment** (§7.11; T25 writes them into the spec):
  - `KEPT_BACKUP_PASSWORD` (locks the restic password; never logged);
  - `KEPT_BACKUP_SFTP` (the repository location in restic's SFTP syntax, as R1 records it),
    `KEPT_BACKUP_SFTP_KEY_FILE`, `KEPT_BACKUP_SFTP_KNOWN_HOSTS`;
  - `KEPT_BACKUP_KEEP_DAILY|WEEKLY|MONTHLY` (7/4/6); `KEPT_BACKUP_KEEP` (the alpha's count) is read
    as the daily count for one release with one deprecation log line (Q7);
  - `KEPT_RESTIC_CACHE_DIR` (default `KEPT_DATA_DIR/.cache/restic`, Q5);
  - `KEPT_UPDATE_CHECK` (`true`/`false`, locks the admin toggle, D65);
  - `KEPT_PORT` (default 8080; step-1 carry-over);
  - `KEPT_ALLOW_DOWNGRADE` (`1` forces past the release guard, Q9);
  - `KEPT_UPGRADE_SNAPSHOT` (`auto` default · `off`, Q8).
  The existing `KEPT_BACKUP_DIR` / `KEPT_BACKUP_S3_*` / `KEPT_BACKUP_TIME` keep their meaning: they
  name the restic target now. **One target**: the boot refuses two (as it does today).
- [ ] **Step 2: The restic seam.** `restic.ts` declares the `Restic` interface (`version`, `init`,
  `backup`, `forget`, `snapshots`, `ls`, `restore`, `check`, `unlock`, `stats`), its argument and
  result types, and `ResticError` with a `reason` (`no_repository`, `wrong_password`, `locked`,
  `partial`, `unreachable`, `failed`). `fake.ts` is an in-memory implementation over a temp directory
  that T5's real wrapper must also pass (a shared contract test, `restic.contract.test.ts`, run on
  both). T6, T7 and T8 code against it from day 2 morning.
- [ ] **Step 3: Job policies** (§3.1b: backup 2 attempts, 4 h): `backup` keeps its schedule;
  new system jobs `ops-watch` (hourly), `update-check` (daily), `backup-verify` (weekly).
- [ ] **Step 4: `requireHttps()`**: 403 `https_required` unless `KEPT_PUBLIC_URL` is `https:`;
  `KEPT_E2E`-style test override only through the existing test config, never an env a production
  operator can set by accident.
- [ ] **Step 5: Stubs** answering 501 with route-catalogue markers, listed in `http/routes.ts`.
  **Commit:** `feat(server): step-8 env, the restic seam and its fake, job policies, the HTTPS guard and route stubs`.

### Task 3: Web scaffolding: route stubs, the operations contract, design frames

**Size:** 1 d. **Files:** stubs `routes/_app/admin.backups.tsx`, `settings.device.tsx`;
`api/ops/{paths,types,queries}.ts`, `api/ops/mock/*.ts` composed in `api/mock/server.ts`;
`docs/design/kept-screens.html` (new frames); `vite.config.ts` (`HOUSEHOLD_ROUTES` gains the two)

- [ ] **Step 1: The contract.** `api/ops/types.ts` from the Phase B route tables, verbatim. Mocks:
  a configured S3 backup with 9 runs (one `warning` "suspiciously small", one failed), a dir target
  on the data's disk, an unconfigured instance, a drill 41 days old, bucket versioning off, disk at
  88 %, an update available, a stale kit, and a device with an app lock and Home kept offline.
- [ ] **Step 2: Design frames** (phone and desktop, light and dark, one Arabic), from the board's
  components: Admin → Backups (target form per kind, password, schedule, retention, Test, Run now,
  the runs list, snapshots); the status page's tiles; the recovery-kit download with the
  re-authentication sheet; the update line; Settings → Me → This device (app lock, keep offline with
  the warning and the size); the lock screen (PIN pad and the passkey button).
- [ ] **Step 3:** Commit: `feat(web): step-8 route stubs, operations contract and design frames`.

---

## Phase A: schema (T4, one owner)

### Task 4: Backup runs, release history, alert kinds, sealed settings (`<N>` generated, `<N+1>` custom)

**Size:** 0.5 d. **Files:** create `src/db/schema/operations.ts`; modify `db/schema/alerts.ts`,
`secrets/rotate.ts`; migrations `<N>_operations.sql`, `<N+1>_operations_rls.sql`; tests
`src/db/operations.test.ts`; update `leak-operations.ts`, `leak.test.ts`, `migrate.test.ts`

- [ ] **Step 1: `backup_runs`** (engineering spec §1.10, extended; instance scope).

  ```sql
  CREATE TABLE backup_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    kind text NOT NULL CHECK (kind IN ('nightly','manual','pre_upgrade','drill','verify')),
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','warning','failed')),
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    storage_mode text NOT NULL CHECK (storage_mode IN ('local','s3')),
    target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 300),  -- a description, never a credential
    snapshot_id text CHECK (snapshot_id ~ '^[0-9a-f]{8,64}$'),
    db_bytes bigint, bytes_added bigint, bytes_total bigint,
    files_total int, files_new int, missing int NOT NULL DEFAULT 0,
    readable_locations int, readable_bytes bigint,
    same_volume boolean, bucket_versioning_ok boolean,
    from_version text, to_version text,                                   -- pre_upgrade
    verified_at timestamptz,
    error text CHECK (error ~ '^[a-z_]{1,48}$'),
    detail jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object'),  -- counts and digests summary only
    CHECK ((status = 'running') = (finished_at IS NULL)));
  CREATE INDEX backup_runs_started_idx ON backup_runs (started_at DESC);
  CREATE INDEX backup_runs_kind_idx ON backup_runs (kind, started_at DESC);
  ```

  - Written only by `kept_owner` (the worker's backup login, the CLI, `kept migrate`); `kept_app`
    SELECT where `kept.is_instance_admin()`; no `kept_system` policy. On the leak test's instance list.
  - **Data move:** the alpha's `instance_settings.backup_status` (`last`, `lastOk`) becomes one or two
    `nightly` rows (status from the summary, `target` from its description), then the key is deleted.
- [ ] **Step 2: `release_history`** (Q9).

  ```sql
  CREATE TABLE release_history (
    version text PRIMARY KEY CHECK (version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
    revision text CHECK (revision ~ '^[0-9a-f]{7,40}$'),
    last_migration text NOT NULL,           -- the journal tag this release's image ends at
    first_migrated_at timestamptz NOT NULL DEFAULT now(),
    last_booted_at timestamptz);
  ```

  Written by `kept_owner` in `kept migrate`; `kept_system` SELECT (the boot guard) and `UPDATE
  (last_booted_at)` only; nothing for `kept_app`. `0.0.0-dev` builds are not recorded (T8).
- [ ] **Step 3: Alert kinds.** `admin_alerts_kind_chk` and `ADMIN_ALERT_KINDS` gain `backup_stale`,
  `disk_space_low`, `bucket_versioning_off`, `restore_drill_due`, `backup_suspicious_size` (each with
  its comment, as the file's others).
- [ ] **Step 4: Sealed settings.** `secrets/rotate.ts`'s `instance_settings` list gains the `backup`
  row's `password`, `s3SecretAccessKey` and `sftpPrivateKey`, AAD `instance_settings|backup|<field>`;
  the rotate test lists them.
- [ ] **Step 5: Tests.** kept_app as a non-admin sees no `backup_runs` row; an instance admin sees
  them and can't insert or update; kept_system can't read `backup_runs` and can update only
  `release_history.last_booted_at`; the alpha status moves into rows. **Leak:** `fillTenant()` adds a
  backup run and a release row. Commit: `feat(db): backup runs, release history, operations alert kinds and sealed backup settings`.

---

## Phase B: services, packaging and docs (T5–T20, parallel; each owns its files)

All routes follow step 2's rules: `scopedRead`/`scopedWrite`, instance-admin routes behind
`kept.is_instance_admin()`, every write through `audited()` with `requestId: req.id`, a
route-catalogue marker, lists as `{items, next_cursor}`.

### Task 5: The restic engine and the nightly snapshot

**Size:** 1.5 d. **Files:** `src/backup/restic/{run.ts,json.ts,repo.ts}` (+ `restic.contract.test.ts`
from T2), `src/backup/{nightly.ts,snapshot-dir.ts,digests.ts,size-check.ts,legacy.ts,settings.ts}`,
modify `backup/{manifest.ts,config.ts}`, `jobs/system.ts`; tests `backup/*.test.ts`

- [ ] **`run.ts`**: spawns the binary at a fixed path (`KEPT_RESTIC_BIN`, default the image's,
  `restic` on `PATH` in development), `--json`, a fixed `--host kept`, the repository location and
  credentials **in the child's environment only**, the cache at `KEPT_RESTIC_CACHE_DIR`, a timeout per
  command, stderr kept to a bounded buffer and **scrubbed** of the password, keys and the repository's
  credentials before it reaches an error or a log. Exit codes map to `ResticError.reason` per R1.
- [ ] **`json.ts`**: one zod schema per message type **as R1 recorded them**; an unknown message
  type is ignored, a malformed one fails the command with `failed`.
- [ ] **`repo.ts`**: settings → repository: a directory target → `<dir>/restic` (Q2); S3 →
  `<prefix>restic/`; SFTP → the configured location, with the key written to a 0600 file under
  `KEPT_DATA_DIR/tmp/` for the command's lifetime and deleted after, and the known-hosts file holding
  only the pinned host key. `description` for logs and `backup_runs.target` never holds a credential.
- [ ] **`settings.ts`**: reads the `backup` settings from `instance_settings` (sealed fields opened
  with the keyring) and overlays the environment, which wins and marks each field `locked` (D186).
  **No password, no backup:** a target without a password is "not configured" (Q6).
- [ ] **`nightly.ts`**, rewritten, one run under a `pg_try_advisory_lock` (no overlap with a
  manual or pre-upgrade run; `409 backup_running` for a manual one):
  1. A `backup_runs` row (`running`).
  2. **Unchanged from T31c:** a REPEATABLE READ snapshot as `kept_owner`, every table's row count,
     every referenced blob key, `pg_dump` (custom format) on that snapshot, into
     `KEPT_DATA_DIR/backup/db/db.dump`.
  3. **New: per-table data digests** in the same snapshot (`digests.ts`): for each table, a SHA-256
     over its rows in primary-key order, computed in keyset pages so memory stays flat (L78). Stored
     in the manifest; the drill compares them (T7).
  4. **New: the size check** (`size-check.ts`, L79): against the last `ok` run, a dump under half its
     size or any of `things`, `places`, `attachments`, `files` with under half its rows marks the run
     `warning` with `backup_suspicious_size`; the snapshot is still taken, but **`forget` is skipped**
     for this run, so retention never pushes good snapshots out behind a bad one.
  5. The manifest (`db/manifest.json`: format version 2, Kept version, storage mode, counts, digests,
     every referenced blob's key, bytes and SHA-256) written last in the directory.
  6. T6's readable copy (`readable/`), when T6 has landed; until then the step is a no-op.
  7. `restic init` if the repository is new; `restic backup` of `KEPT_DATA_DIR/backup` and, **with
     local storage**, `KEPT_DATA_DIR/blobs` (never `tmp/` or `.cache/`), tags `kept`, the kind, and
     `v<version>`.
  8. **Missing files:** with local storage, `restic ls` of the new snapshot's `blobs/` against the
     manifest's keys; each missing key counts in `missing` (a purge that raced the run; the next run
     carries a new manifest).
  9. `restic forget` with the 7/4/6 policy on the `nightly` and `manual` tags, grouped as R1 says;
     `pre_upgrade` snapshots keep their last 3; then prune.
  10. The row finishes (`ok` / `warning` / `failed`, bytes added, total, files new), `instance.backup`
      is audited as system with counts only, `backup_failed` raised or resolved (as today), and
      `backup_suspicious_size` raised on a warning.
  - **S3 storage (D144):** step 7 backs up only `KEPT_DATA_DIR/backup`; each run checks the file
    bucket's versioning (`GetBucketVersioning` through the existing S3 client) into
    `bucket_versioning_ok`, and T10's watch raises `bucket_versioning_off`.
  - **Same disk (D66):** a directory target on the data's filesystem sets `same_volume` (the
    existing check).
- [ ] **`legacy.ts`**: lists and reads the alpha's `runs/<id>/` from the same target for
  `kept admin restore --legacy` (T7); nothing writes that layout any more (Q2).
- [ ] **Tests** (the fake and, under `KEPT_TEST_RESTIC=1`, the real binary; RustFS for S3 under
  `KEPT_TEST_S3_URL`, as `s3.test.ts` does):
  - a run makes one snapshot holding the dump, the manifest and every local blob; a second run adds
    only new files (`files_new`);
  - the password never appears in a spawned command's argv (a spawn spy), a log line (a log capture),
    `backup_runs`, the audit diff, or an error's message, **even when restic fails** with the password
    in its own stderr (a fake that echoes it);
  - retention over 40 faked days keeps 7/4/6; a `warning` run skips `forget`;
  - a manual run during a nightly one → 409 `backup_running`;
  - a target without a password is "not configured" and does nothing;
  - S3 storage: no `blobs/` in the snapshot; versioning off → `bucket_versioning_ok = false`.
- [ ] **Commit:** `feat(backup): nightly restic snapshots with data digests, a size check and 7/4/6 retention`.

### Task 6: The readable export in every snapshot (D159; depends on step-7 T13 and T5's interface)

**Size:** 1 d. **Files:** `src/backup/readable/{run.ts,sink.ts,cache.ts}`, `src/cli/readable.ts`;
modify `src/exports/readable/` **only** to add a sink seam (below); tests `backup/readable/*.test.ts`

- [ ] **The sink seam.** If step-7 T13's builder writes only into a ZIP (`writeArchive`), add a
  `ReadableSink` with two implementations, ZIP (the export, unchanged) and directory, the way step 7
  extracted `ingestFile()`: **no behaviour change for the export**; every step-7 readable test passes
  untouched.
- [ ] **`run.ts`**: for each location (Personal locations included; locations in their deletion
  grace included), in the scope of **its owner's user** on the `kept_app` pool (Q10), write the
  readable copy to `KEPT_DATA_DIR/backup/readable/<locationId>/`: `index.html`, the CSVs, `thumbs/`,
  `inventory.pdf` when under the report's cap, and the files the pages link to. Then a top-level
  `readable/index.html` listing every location (name, kind, owner's display name, counts, the
  generation time), and a `README.txt` saying how to open it.
  - **Files** (Q11): with local storage, each linked original is a **hard link** to its blob
    (`fs.link`; same filesystem, no extra space; restic stores the content once). With S3 storage,
    receipts and documents (originals) and photos (the display derivative only) are downloaded into
    the tree; a file already present by id is not fetched again.
  - **Unchanged locations are not rewritten** (`cache.ts`): a marker per location (the latest
    `audit_events` id for it plus the owner's money gate and the Kept version) is compared with last
    night's; the same marker leaves the tree as it is, so restic sees unchanged files.
  - A location whose copy fails is listed in the top index as "not included tonight" with the error
    code; the run becomes `warning`, never `failed`, for that alone.
  - **Never a secret** (the builder's own rule): a byte search of the tree for every fixture secret
    finds nothing. Never contact details the owner can't see.
- [ ] **`kept admin readable --out <dir> [--location <id>]`**: the same tree on demand, for an
  operator who wants to look before a backup exists.
- [ ] **Tests:** the tree for Home opens from disk with no network (Playwright `file://` in T25); an
  Arabic location is RTL; a second run with nothing changed rewrites no file (mtimes); a renamed
  thing rewrites only its location; hard links share the blob's inode (local); the S3 path fetches a
  receipt once over two runs; Peter's and Talia's views never apply (the owner's scope is used).
- [ ] **Commit:** `feat(backup): the readable export of every location in every snapshot`.

### Task 7: Restore, the drill and verify

**Size:** 1 d. **Files:** `src/backup/{restore.ts,drill.ts,verify.ts}`, `src/cli/{restore.ts,backup.ts}`,
modify `src/cli/index.ts` (the `admin backup …` and `admin restore` commands only); tests

- [ ] **`kept admin backup`** gains subcommands: `--list` (now `restic snapshots`, newest first, with
  kind, version, size; legacy runs listed separately), `verify [--read-data <percent>]`, `drill
  --into <database URL>`, `unlock` (a stale lock after a crash; refuses while a run holds the
  advisory lock).
- [ ] **`kept admin restore <snapshot>`** (D66: into a new, empty database, verify, then swap):
  `restic restore --include` the snapshot's `backup/db` (and `blobs/` with local storage) into
  `KEPT_DATA_DIR/tmp/restore-<id>/`, then **the existing T31c restore** (dump size and SHA-256 against
  the manifest, pg_restore major version, extensions, one transaction, counts) **plus the data
  digests** (T5): any table whose digest differs is a mismatch. Files are put back into the store
  `KEPT_STORAGE` names, each SHA-256 checked. `--legacy <runId>` restores an alpha run as today. The
  command ends by printing the swap steps (the runbook's), never performing them: renaming databases
  needs the superuser (D66, Q13).
- [ ] **`drill.ts`** (D66's monthly nudge, L78): `kept admin backup drill --into <empty database>`
  runs the restore of the latest `ok` snapshot into the given empty database (made by the runbook's
  one superuser command), compares counts and digests, checks a sample of 50 files' SHA-256 (all of
  them with `--all-files`), records a `drill` run in the **live** database's `backup_runs` (owner
  login), resolves `restore_drill_due`, and prints the command to drop the scratch database.
- [ ] **`verify.ts`** (the weekly `backup-verify` job and the CLI): `restic check` (with
  `--read-data-subset` when asked); with **S3 storage**, every manifest hash checked against the
  bucket (D144: a HEAD for size and, for 1 in 20, a GET and SHA-256; all with `--all-files`); records
  a `verify` run.
- [ ] **Tests:** a backup → restore round trip into a scratch database with identical digests
  (`test/backup/round-trip.test.ts`, run by ci-local's `backup` step); a dump with one changed row in
  `things` (same count) fails on its digest; a missing extension fails before any data; a restore into
  a non-empty database is refused; the drill writes its row to the live database, not the scratch
  one; verify on S3 reports a deleted object by key.
- [ ] **Commit:** `feat(backup): restore from restic with data digests, the restore drill and repository verification`.

### Task 8: Upgrade safety: the pre-upgrade snapshot, release history, the downgrade guard

**Size:** 1 d. **Files:** `src/db/release-guard.ts`, modify `src/db/migrate.ts`, `src/main.ts` (the
boot check only), `src/cli/index.ts` (`migrate` options only); tests `db/release-guard.test.ts`,
`db/migrate.test.ts`

- [ ] **The pre-upgrade snapshot** (D66, Q8). `kept migrate`, under its advisory lock, when the
  database already has Kept's migrations **and** some are pending:
  - with a backup target configured (env, or `instance_settings` opened with the keyring when the
    migrate container has the keys: T15 mounts the config volume read-only and passes the key
    variables to it): a database-only snapshot (dump, manifest, digests; no readable copy, no files:
    a migration doesn't touch them) tagged `pre_upgrade`, `from_version`/`to_version` recorded in a
    `backup_runs` row. **If it fails, nothing is migrated** and the command exits non-zero with the
    reason, unless `--skip-snapshot` or `KEPT_UPGRADE_SNAPSHOT=off`;
  - without a target: one loud log line, and the status page shows "Upgraded from X to Y without a
    snapshot" until the next good backup.
  - A fresh database (no Kept migrations applied) never takes one.
- [ ] **Release history** (Q9). After migrating, `kept migrate` upserts `release_history` with the
  image's `KEPT_VERSION`, `KEPT_REVISION` and the journal's last tag. Development builds
  (`0.0.0-dev`) are not recorded.
- [ ] **The guard** (`release-guard.ts`), run by `kept migrate` and by the server at boot (as
  kept_system): read the applied migrations; any tag the image's journal doesn't know means the
  database is **ahead**. Look up which recorded releases introduced them:
  - all of them belong to **exactly one** release, the next one after this image's version in
    `release_history` → allowed: a **one-version rollback** (migrations are additive, D82). The boot
    logs one line, `/version` and the status page say "rolled back from X".
  - more than one release ahead, or unknown to `release_history` → refused: `kept migrate` and the
    server exit non-zero with `downgrade_refused`, naming both versions and the restore runbook.
    `KEPT_ALLOW_DOWNGRADE=1` (or `kept migrate --allow-downgrade`) proceeds with an audited
    `instance.downgrade_forced`.
  - `last_booted_at` is updated at each boot.
- [ ] **Tests:** a pending migration on a populated database takes a `pre_upgrade` snapshot before
  any DDL (a fake restic records the order); a failing snapshot migrates nothing; a fresh database
  takes none; a database one release ahead boots with the rollback line; two releases ahead refuses;
  the force path audits.
- [ ] **Commit:** `feat(ops): a snapshot before every upgrade, release history and one-version rollback`.

### Task 9: The recovery kit, complete

**Size:** 0.5 d. **Files:** `src/setup/recovery-kit-content.ts`, `src/cli/recovery-kit.ts`, modify
`src/setup/recovery-kit.ts`, `src/admin/routes.ts` (the kit routes only), `src/cli/index.ts` (the
`recovery-kit` command only); tests

- [ ] **Contents** (D182; Q15): the instance's public URL, Kept version and revision, the generation
  time; `KEPT_SECRET_KEY`, its version and every retired key; `KEPT_AUTH_SECRET`; the backup
  target's restic repository location, **its password and its storage credentials** (S3 key id and
  secret, the SFTP private key and pinned host key), or "No backup configured"; and the restore steps
  in plain words: install Kept, set the keys, `kept admin restore`, and "read your inventory with
  restic alone" (the commands, with the repository and password filled in). Plain text, UTF-8, under
  200 lines; a print-styled HTML variant from the same content (`--format html`), no script, no remote
  resource.
- [ ] **CLI:** `kept admin recovery-kit [--format text|html] [--out <file>]` (the file 0600); without
  `--out`, standard output, as today.
- [ ] **Web** (D182, screens §8):
  `POST /api/v1/admin/recovery-kit/download` `{password?, format}` → the kit as an attachment with
  `Cache-Control: no-store`. Instance admin; `requireHttps()`; **re-authentication**: the password
  checked as `auth/email-change.ts` does, or, for an account without one, a session signed in within
  `FRESH_SIGN_IN_SECONDS` (a passkey sign-in counts); otherwise 403 `reauth_required`. Not through the
  Idempotency-Key store (the body carries a password; the secrets routes' reason). Audited
  `instance.recovery_kit_download` (no content). Records `recovery_kit_downloaded_at`, and counts as
  the acknowledgement when none exists.
- [ ] **Staleness** (screens §10, "when backups are configured, the status page asks again"):
  `GET /api/v1/admin/recovery-kit` gains `downloadedAt` and `stale` (the backup settings or the key
  version changed after the last download).
- [ ] **Tests:** the kit holds the restic password set in T10's settings; a rotate-key makes it
  stale; over plain HTTP → 403 `https_required`; a wrong password → 403 and no audit row; nothing of
  the kit in the audit diff or logs; the response is `no-store`.
- [ ] **Commit:** `feat(ops): the full recovery kit: keys, the backup repository and its credentials, and the restore steps`.

### Task 10: Backup settings, the status page server, the operations watch

**Size:** 1 d. **Files:** `src/admin/backup-routes.ts`, `src/backup/watch.ts`; modify
`src/admin/routes.ts` (`AdminStatus` and its handler only), `src/http/health.ts` (gauges);
tests `admin/backup-routes.test.ts`, `backup/watch.test.ts`

- [ ] **Routes** (instance admins; `requireHttps()` on writes):

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/admin/backup` | → `BackupSettingsView` (write-only fields as `…Set` booleans, each field `{value, locked}`), `version` for `If-Match` |
  | `PUT /api/v1/admin/backup` | `BackupSettingsInput` + `If-Match` → the view. **409 `recovery_kit_required`** until the kit is acknowledged (step-1 carry-over, D193). A locked field changed → 400 `setting_locked`. A password under 12 characters → 400 `backup_password_weak`. Sealed fields through the envelope. Audited `instance.backup_settings` with the target kind and a `{changed: true}` for each secret, never a value. Marks the kit stale |
  | `POST /api/v1/admin/backup/test` | → `{ok, initialised, error?}`: `restic snapshots` (or `init` with `{init: true}`) against the saved settings. Audited `instance.backup_test` |
  | `POST /api/v1/admin/backup/run` | → 202 `BackupRun` (a `manual` run enqueued); 409 `backup_running`; 409 `backup_not_configured`. Audited |
  | `GET /api/v1/admin/backup/runs?kind&status&q&cursor` | → `{items: BackupRun[], next_cursor}` (the list surface's filters; `q` matches the error code or target) |
  | `GET /api/v1/admin/backup/snapshots` | → `{items: [{id, time, kind, version, tags}], cachedAt}`, from `restic snapshots`, cached 5 minutes |

- [ ] **`GET /api/v1/admin/status`** gains (the T1 `AdminStatus`): `release {version, revision,
  sourceUrl, lastMigration, rolledBackFrom?}`; `backup {configured, locked, target, storageMode, last,
  lastOk, stale, snapshots, repositoryBytes, readableBytes, sameVolume, bucketVersioning: 'on' |
  'off' | 'unknown' | 'not_applicable', lastDrillAt, drillDue, lastVerifyAt, upgradeWithoutSnapshot?}`;
  `recoveryKit {acknowledgedAt, downloadedAt, stale}`; `disk {data: {usedRatio, freeBytes} | null,
  backup: … | null}`; `updates` (T11's state); `jobs {failedLastDay}`; `https` (the public URL's
  scheme). Every field computed from rows already kept, never a restic call in the request.
- [ ] **`watch.ts`**, the hourly `ops-watch` system job: `statfs` of `KEPT_DATA_DIR` (local storage)
  and of a directory target → `disk_space_low` at ≥ 85 % (D166); no good backup for 36 hours with a
  target set → `backup_stale`; S3 storage with versioning off (daily) → `bucket_versioning_off`; no
  `drill` run for 30 days with a target set → `restore_drill_due` (D66's monthly nudge); each
  resolved when its condition clears. Writes `disk_status` into `instance_settings`.
- [ ] **Metrics** (`/metrics`, token): `kept_backup_last_success_timestamp_seconds`,
  `kept_backup_last_run_status`, `kept_disk_used_ratio{volume="data"|"backup"}`,
  `kept_update_available`. No label holds a path or target.
- [ ] **Tests:** the kit gate's 409; a locked field; the password never in a response, a log line or
  the audit diff; Louis (not an instance admin) gets 404 on every route; the watch raises and resolves
  each alert once; the status response for an unconfigured instance.
- [ ] **Commit:** `feat(ops): backup settings, the full status page, the operations watch and its gauges`.

### Task 11: The update check (D65)

**Size:** 0.5 d. **Files:** `src/updates/{check.ts,job.ts}`; modify `src/admin/routes.ts`
(`AdminSettings.updateCheck` only); tests `updates/*.test.ts`

- [ ] **Off by default.** Admin → Settings gains "Check for new versions" (`updateCheck`), locked by
  `KEPT_UPDATE_CHECK`. Turning it on is audited `instance.settings` like the others.
- [ ] **What it asks** (Q16): only when the source URL (`KEPT_SOURCE_URL`, from the image's OCI
  labels, D147/D186) is a GitHub repository, GitHub's "latest release" endpoint **for that
  repository** as U1 recorded it, through `guardedFetch`, with only the headers U1 says are required
  (a `User-Agent` of `Kept`, no version, no instance identifier: "nothing sent but the request").
  Drafts are ignored; prereleases only when the running version is one.
- [ ] **When:** the daily `update-check` job at a minute derived from the instance's id (so instances
  don't ask together), and `POST /api/v1/admin/updates/check` (audited) for "Check now".
- [ ] **Stored** in `instance_settings.update_check`: `lastCheckedAt`, `latest {version, url,
  publishedAt}`, `error`. Nothing is installed or downloaded; the status page and the Admin index
  say "Kept X is available · What's new" linking to the release page the API returned.
- [ ] **Tests** against a local stub server (`guardedFetch`'s test allowance): off → no request;
  newer → available; same or older → none; a 404 (private repository) → `not_found`; a 403 rate limit
  → `rate_limited` and no retry until the next day; a source URL that isn't GitHub → no request.
- [ ] **Commit:** `feat(ops): the opt-in update check`.

### Task 12: Snapshot extras for "keep this location available offline" (D159)

**Size:** 0.5 d. **Files:** `src/sync/extras.ts`; modify `src/sync/routes.ts` (one route); tests
`sync/extras.test.ts`, `sync/extras.leak.test.ts`

- [ ] **Route** (members of the location; the module and money gates of `serialize/gates.ts`):

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/sync/extras?locationId&cursor&estimate` | → `SyncExtrasPage = {items: [{thingId, purchase: {date, price, currency} \| null, currentValue: {amount, currency} \| null, moneyHidden?, documents: [{attachmentId, fileId, kind, title, mime, bytes, sha256}]}], next_cursor, totalBytes}`; pages of 500; `estimate=1` answers only `{things, documents, totalBytes}` |

  Documents are the location's receipts, manuals, warranty documents, invoices and paperwork, not
  photos (the snapshot already has thumbnails); each fetched through the existing signed file URL
  path. **Never a secret value, never a person's contact details** (D36, D159). Money only where the
  reader's role sees it.
- [ ] **Tests:** Talia (viewer) gets `moneyHidden` where Home hides money from viewers; a module off
  hides its documents; B's location → 404 (leak); the response holds no secret marker (byte search).
- [ ] **Commit:** `feat(sync): money and documents for a location kept offline`.

### Task 13: Switching storage, the worker's liveness, `KEPT_PORT`

**Size:** 1 d. **Files:** `src/storage/copy.ts`, `src/cli/storage.ts`, modify `src/main.ts` (the
port and the worker heartbeat), `docker/healthcheck.mjs`; tests

- [ ] **`kept admin storage copy --to s3|local [--dry-run]`** (D186): reads the source store from
  the current `KEPT_STORAGE` settings and the destination from the other's variables; copies every
  blob the database references (and its derivatives), each SHA-256 checked after the copy; resumable
  (a blob already present with the right hash is skipped); safe while Kept runs, because blobs are
  immutable and id-keyed. `kept admin storage verify --store s3|local` checks every referenced blob.
  The runbook (T19): copy while running, stop Kept, copy again (new files only), flip `KEPT_STORAGE`,
  start, verify; the old store is left for the operator to delete.
- [ ] **Worker liveness** (step-1 carry-over): with `KEPT_ROLE=worker`, the worker touches
  `/tmp/kept-worker-alive` after each successful pg-boss poll; `healthcheck.mjs --worker` passes when
  the file is under 120 s old. The image's default HEALTHCHECK picks the mode from `KEPT_ROLE`.
- [ ] **`KEPT_PORT`**, default 8080; `prod-boot` then runs the entrypoint itself on a spare port
  (T25 updates the step).
- [ ] **Tests:** a local → S3 copy on RustFS and back, byte-identical; a corrupted destination
  object is re-copied; the worker healthcheck fails when the heartbeat is stale; `KEPT_PORT=8091`
  listens there.
- [ ] **Commit:** `feat(ops): switch file storage with a verified copy, a worker liveness check and KEPT_PORT`.

### Task 14: Optional tracing and error reporting (D84; Q27)

**Size:** 0.5 d. **Files:** `src/observability/{tracing.ts,errors.ts}`, modify `src/main.ts` (one
import); tests

- [ ] With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the packages O1 chose are imported **lazily** and
  trace HTTP and Postgres; unset, none of them loads (a test asserts the module graph). A dead
  collector never delays a request (ci-local's `prod-boot` already points at one, L90).
- [ ] With `KEPT_ERROR_DSN` (a Sentry-compatible DSN), unhandled errors are reported with the
  request id and route, **never** a body, a header, a query string, a user's name or a location's
  content; a test sends one to a local stub and reads it.
- [ ] **No telemetry of any kind** without these variables (D84): a test boots with neither and
  records no outbound connection.
- [ ] **Commit:** `feat(server): optional OpenTelemetry tracing and error reporting, off by default`.

### Task 15: The image, Compose and supply chain

**Size:** 1 d. **Files:** `Dockerfile`, `compose.yaml`, `compose.env.example`,
`scripts/third-party-notices.mjs` (+ test), `scripts/smoke-image.sh`, `apps/web/vite.config.ts`
(the version `define` only), `pnpm-workspace.yaml` (the trim, if R3 adopts it)

- [ ] **restic and an SSH client in the runtime image**, from R1: restic per `TARGETARCH`, checksum
  pinned, at a fixed path; the Debian SSH client package pinned to the version in bookworm's index for
  both architectures. `KEPT_RESTIC_BIN` points at it.
- [ ] **The image trim** (step-1 carry-over), as R3 decided; the licence scan then runs against the
  image's pruned `node_modules`.
- [ ] **Third-party notices** (D151): `scripts/third-party-notices.mjs` writes
  `THIRD-PARTY-NOTICES.txt` from `pnpm licenses list --json --prod` plus R3's non-npm list, with each
  licence's full text; the build copies it to `/app/THIRD-PARTY-NOTICES.txt`; About links it.
- [ ] **The web's real version** (step-3 carry-over, D148): the build passes `VERSION` to the web
  build, and `vite.config.ts` `define`s it, so `clientVersion` and the sidebar stop saying
  `0.0.0-dev` in a release image.
- [ ] **Compose:**
  - the `migrate` service mounts `kept-config` read-only, receives `KEPT_SECRET_KEY`,
    `KEPT_AUTH_SECRET` and the `KEPT_BACKUP_*` variables, so T8's pre-upgrade snapshot can open the
    sealed settings;
  - the `kept` service receives the new backup and update variables (empty values fall back);
  - a profile `ollama` (D85) with R3's pinned image, a volume, and the documented
    `openai_compatible` base URL that reaches it on the Compose network;
  - comments for a split `web` + `worker` deployment with the worker's healthcheck.
- [ ] **`smoke-image.sh`** gains: `restic version` runs; the notices file exists; a backup with
  `KEPT_BACKUP_DIR` and `KEPT_BACKUP_PASSWORD` makes a restic snapshot; `kept admin backup drill`
  restores it into a second database the throwaway Postgres's superuser creates, with equal digests.
- [ ] **Gate:** ci-local `images` builds both platforms and smokes arm64 natively (unchanged rule);
  `licences` passes. **Commit:** `build: restic and an SSH client in the image, third-party notices, the web's real version, the Ollama profile and pre-upgrade snapshots in Compose`.

### Task 16: The Helm chart (D16, D85, D186)

**Size:** 1.5 d. **Files:** `charts/kept/**`, `scripts/check-helm.sh`; one `step_helm` function in
`scripts/ci-local.sh`

- [ ] **Values** (`values.schema.json` validates them; defaults fit the 2 GB floor):
  `image {repository, tag (defaults to appVersion), digest}`, `publicUrl` (required), `postgres
  {bundled: true | false, image (compose.yaml's pgvector pin, by digest), storage, superuserSecret,
  external: {host, port, database, sslMode}}`, `roles {create: true, existingSecret}`, `keys
  {existingSecret}` (or the config PVC, D193), `storage {mode: local | s3, persistence {size,
  storageClass}, s3 {existingSecret, …}}`, `backup {existingSecret, env}`, `split {enabled, web
  {replicas}}`, `smtp`, `metrics {tokenSecret}`, `ingress`, `service`, `resources`,
  `extraEnv`. Never `:latest`.
- [ ] **Templates:**
  - the Deployment, **`Recreate` when files are local** on a ReadWriteOnce volume, `RollingUpdate`
    (maxSurge 1, maxUnavailable 0) only with S3 (D186); startup and readiness probes on `/readyz`,
    liveness on `/healthz`, a `preStop` sleep (L97); `runAsUser: 10001`, `readOnlyRootFilesystem`,
    `drop: [ALL]`, `/tmp` an emptyDir;
  - with `split.enabled`: a web Deployment and a single-replica worker Deployment (the exec probe
    from T13); backups run **in the worker** (D186), never a CronJob;
  - a `pre-install,pre-upgrade` hook Job running `kept migrate` with the owner login, the keys and
    the backup settings (T8's snapshot); a `pre-install` Job creating the roles and extensions with
    the superuser secret (bundled Postgres, or external with `roles.create`); with `roles.create:
    false`, NOTES.txt points at the managed-Postgres SQL (T19);
  - the bundled Postgres StatefulSet on the pinned pgvector image;
  - PVCs for data and config; Secrets only by reference; NOTES.txt with the setup-code command and the
    recovery-kit command; a `helm test` Pod asking `/readyz` and `/version`.
- [ ] **Chart version** independent of the app (D187): starts at `0.1.0`, `appVersion` set by the
  release (Q17).
- [ ] **`check-helm.sh`** (the `helm` ci-local step): `helm lint`; `helm template` for the four
  `ci/*.values.yaml` sets compared with committed golden files; `kubeconform -strict` at H1's
  Kubernetes version; a grep that no rendered image is untagged or `:latest`; with
  `KEPT_HELM_KIND=1`, a kind cluster installs the chart with bundled Postgres and the locally built
  image, waits for `/readyz`, runs `helm test`, upgrades once (the hook runs), and deletes the cluster.
  Skips with a reason when the tools are missing, as ci-local's other optional steps do.
- [ ] **Commit:** `feat(deploy): the Helm chart: Recreate with local files, the migrate hook, backups in the worker`.

### Task 17: The laptop release (D87, D187, L100–L104)

**Size:** 1.5 d. **Files:** `scripts/release.sh`, `scripts/release/{build,verify,sign,chart,notes}.sh`,
`scripts/changelog.mjs` (+ test), `docs/runbooks/release.md`; one `step_release_dry_run` in
`scripts/ci-local.sh` (runs only with `KEPT_RELEASE_DRY_RUN=1`)

- [ ] **`scripts/release.sh <version> [--registry <path>] [--dry-run]`**, each stage stopping the run
  on a non-zero exit:
  1. **Preconditions:** a clean tree at a commit on `main`; `<version>` is semver and newer than the
     last `v*` tag; `df -h /` has room; `bash scripts/ci-local.sh` has passed **for this exact commit**
     in a clean worktree (the release records the commit and exit code in
     `.tmp/release/<version>/gate.txt`, and refuses without it).
  2. **Changelog** (Q12): `scripts/changelog.mjs` groups conventional commits since the last tag
     into the new `CHANGELOG.md` section; `scripts/check-attribution.sh` runs over it (D173).
  3. **Build** both platforms with `VERSION`, `REVISION` and `SOURCE`, the SBOM as R2 chose, **pushed
     by digest, no tag**.
  4. **Verify** (L100, L101, L103): pull each architecture by digest; `smoke-image.sh` on arm64
     natively and on amd64 under emulation; `/version` answers the version and the revision.
  5. **Sign** (D187): `cosign sign --key` the index digest (the key file and its password from the
     maintainer's environment, never echoed); verify with `cosign.pub`.
  6. **Tag the image** `X.Y.Z`, and `X.Y` and `X` only when this is the newest release of that line
     (D186), all from the verified digest. No `latest` (Q14).
  7. **Chart:** `helm package charts/kept --app-version X.Y.Z`, push as OCI beside the image, sign.
  8. **Record** `docs/releases/X.Y.Z.md`: the digests, the verify commands, the chart reference.
  9. **Maintainer steps, printed, never run by the script:** the release commit, `git tag -a
     vX.Y.Z`, `git push` of both, the GitHub release with the changelog section and the notices file
     attached (`gh release create`, as `ibrahimroshdy`).
  `--dry-run` runs stages 1 (with the gate optional), 2–8 against a throwaway local registry (R2's
  image) with a throwaway cosign key in `.tmp/`, and removes both.
- [ ] **What needs the maintainer's credentials** (`docs/runbooks/release.md`, each a numbered
  maintainer step with the exact command): the registry login for GHCR with a token that can write
  packages (the image path is **inferred** as `ghcr.io/ibrahimroshdy/kept` from the Dockerfile's
  `SOURCE` default, and confirmed by him, Q14); generating the cosign key pair, keeping the private
  key and its password in his password manager and **off the repository**, and committing
  `cosign.pub`; `gh auth` as `ibrahimroshdy`; the package's visibility when the repository goes
  public; pushing the tag.
- [ ] **Tests:** `changelog.mjs` over a fixture history (feat, fix, breaking, a non-conventional
  commit listed under "Other"); the script refuses a dirty tree, an older version, and a missing gate
  record; the dry run (with `KEPT_RELEASE_DRY_RUN=1`) ends with a verified signature in the local
  registry and leaves no container behind.
- [ ] **Commit:** `build: the laptop release: multi-arch by digest, smoke both, verify /version, cosign, tags, the chart`.

### Task 18: The docs site: scaffold and generated references (D102, D199)

**Size:** 0.5 d. **Files:** `apps/docs/**` (scaffold, config, scripts), root `package.json`
(`docs:dev`, `docs:build`), one `step_docs` in `scripts/ci-local.sh`

- [ ] Starlight at D1's pins in `apps/docs` (`@kept/docs`, private): five locales, `en` default, `ar`
  right to left with Arabic UI strings, `fr`, `de`, `it` falling back to English with Starlight's
  notice (Q19); Pagefind; the Label-tape brand and IBM Plex from the web's design tokens; no remote
  fonts or scripts.
- [ ] **Generated pages, committed, with a drift check:** `scripts/env-reference.ts` renders
  `config/reference.ts`'s reference into `reference/configuration.md`; `scripts/openapi.ts` writes the
  OpenAPI JSON from `buildApp()` **without a database** if D1 found that possible (else from the dev
  server in the `docs` step) and the API reference renders from it. The `docs` step fails when a
  regenerated page differs from the committed one, or a link is broken.
- [ ] `.github/workflows/docs.yml` is T20's; this task only makes `pnpm docs:build` produce the
  static site in `apps/docs/dist`.
- [ ] **Commit:** `feat(docs): the Starlight site with generated configuration and API references`.

### Task 19: The docs content

**Size:** 1 d. **Files:** `apps/docs/src/content/docs/{en,ar}/**`; `docs/runbooks/{backup-restore,upgrade,restore-drill}.md`
(rewritten or new; the site links them)

- [ ] **English pages**, each written from the code and the plan's contracts, checked against the
  built behaviour in T25: the landing page (D89); install with Compose; HTTPS (the Caddy profile, a
  Tailscale route, D193); install on Kubernetes with Helm; **managed Postgres** (the roles and
  extensions SQL, `kept_app`'s timeouts from the step-1 carry-over, and V31's provider table from
  T0b); reverse proxies (the import upload's body limit, `KEPT_TRUSTED_PROXIES`, the setup lockout
  behind a proxy, the sibling-subdomain cookie risk: step-1 carry-overs); **backups** (targets,
  passphrase, retention, S3 storage and bucket versioning, D144); **restore and the drill**; **"Read
  your inventory with restic alone"** (D159: install restic, `restore --include` the readable tree,
  open `readable/index.html`); the recovery kit; upgrades and rollback (Q8, Q9); Postgres major
  upgrades by dump and restore (D186); switching storage (T13); the operator CLI in Compose (`docker
  compose run --rm migrate admin …`, `docker compose exec kept kept admin recovery-kit`); moving to a
  new server (step 7's runbook); uninstall (volumes, bucket, restic repository, export first, D186);
  Ollama (D85, with V4's status); the hardware floor (D209); verifying a release's signature (T17);
  observability (T14).
- [ ] **Arabic pages** (Q19): the landing page, install with Compose, backups, the recovery kit, and
  "read your inventory with restic alone"; written natively, Eastern digits only where the house style
  puts them in prose, code blocks unchanged.
- [ ] **Commit:** `docs(site): install, admin guide, backups, restore and the recovery kit, in English with the key pages in Arabic`.

### Task 20: Project files and inert workflows (D88, D105, D187)

**Size:** 0.5 d. **Files:** `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CLA.md`,
`README.md`, `renovate.json`, `.github/ISSUE_TEMPLATE/*`, `.github/pull_request_template.md`,
`.github/workflows/{ci,docs,cla}.yml`

- [ ] **CONTRIBUTING:** additive migrations (D82), tests on their own database, conventional
  commits, **no AI attribution** (D173), the CLA, the local CI (`scripts/ci-local.sh`), the sample
  cast.
- [ ] **CODE_OF_CONDUCT:** the Contributor Covenant, its text taken **verbatim from its official
  source** (the version read on the day), the contact a maintainer step (below).
- [ ] **SECURITY.md** (D187): the latest minor supported, the previous one for 90 days, critical
  fixes within 7 days; how to report (GitHub's private vulnerability reporting once public; the
  contact address is a **maintainer step**, never invented); signature verification with
  `cosign.pub`.
- [ ] **CLA.md** (D105): the Harmony individual CLA with the outbound option, generated from
  Harmony's own site **by the maintainer** (a maintainer step, the generator needs his choices); the
  file holds a placeholder that the 1.0 checklist refuses.
- [ ] **README:** the licence line, the docs pointer, the release verification line.
- [ ] **Renovate** (D187): pin digests, group Better Auth, block Postgres major bumps (and pgvector's
  `pg18` suffix), Renovate's own config validator if T0b found a light way to run it.
- [ ] **Workflows, inert until Actions run** (D87, D199, D105): `ci.yml` runs `scripts/ci-local.sh
  --fast` and the steps a hosted runner can; `docs.yml` builds `apps/docs` and deploys to GitHub
  Pages on `main` once public; `cla.yml` uses the StepSecurity fork **pinned to the commit SHA W1
  read**, never checking out PR code under `pull_request_target` (D187). Every `uses:` pinned by
  SHA with the tag in a comment.
- [ ] **Commit:** `docs: contributing, conduct, security, CLA placeholder, Renovate and workflows for when the repository is public`.

---

## Phase C: web (T21–T23, parallel; each starts on T3's mock)

Shared rules: the screens spec §8 (Admin), §10, and the T3 frames. Hidden for the wrong role;
"Needs a connection" offline; user text bidi-isolated; numbers and dates through `useFormat`
(Eastern digits in Arabic when chosen); Vitest and Testing Library against the mock (keyboard, RTL,
a non-admin, offline). 375, 768 and 1280 px, both themes.

### Task 21: Admin → Backups, the status page, the update line

**Size:** 1.5 d. **Files:** `routes/_app/admin.backups.tsx`, `routes/_app/admin.status.tsx`,
`routes/_app/admin.settings.tsx` (the toggle), `components/ops/{backup-target-form,backup-runs,snapshots-list,status-tiles,update-line}.tsx`; tests

- [ ] **Admin → Backups:** the target form per kind (a segmented choice of Directory · S3-compatible
  · SFTP; write-only fields as "Replace"; locked fields read-only with "Set by the server's
  environment"); the password with its rule; time and retention; **Test** (its result inline);
  **Run now**; the runs list as a `ListSurface` (kind and status filters, search, grouped by day,
  paginated, URL-backed); the snapshots list. The 409 `recovery_kit_required` opens the kit step
  (T22). Over plain HTTP the page says why it can't be changed (D181).
- [ ] **The status page:** tiles for Backups (last good, age, size, stale), the drill (last, due), the
  repository check, bucket versioning, disk (data and backup), the recovery kit (acknowledged,
  downloaded, stale), the release (version, revision, the source link, a rollback line), failed jobs,
  updates. Each warning tile links to its fix. Loud, plain wording: "No backup configured", "Last
  good backup 3 days ago", "Backups are on the same disk as your data".
- [ ] **Admin → Settings:** "Check for new versions" (locked by env); **the update line** on the
  status page and the Admin index ("Kept 1.3.0 is available · What's new", an external link).
- [ ] **Tests:** each status tile's warning state from the mock; the target form's locked and
  write-only fields; Louis sees no Admin; RTL.
- [ ] **Commit:** `feat(web): Admin → Backups, the full status page and the update line`.

### Task 22: The recovery kit download with re-authentication

**Size:** 0.5 d. **Files:** `components/ops/{kit-download,reauth-sheet}.tsx`, modify
`admin.status.tsx`'s kit tile only (coordinate with T21: T22 owns the two components, T21 places
them); tests

- [ ] "Download recovery kit" opens the re-authentication sheet (password, or "Sign in again" for a
  passkey-only account), then downloads text or the printable page; the sheet explains what the kit
  holds and "keep it off this server". After a download, the acknowledgement is shown as given.
  Stale kits ask again. Nothing of the kit is kept in memory after the download or in any store.
- [ ] **Tests:** a wrong password keeps the sheet open with the message; the download's Blob URL is
  revoked; RTL.
- [ ] **Commit:** `feat(web): download the recovery kit after re-authentication`.

### Task 23: This device: the app lock and "keep this location available offline" (D159, D181)

**Size:** 1.5 d. **Files:** `routes/_app/settings.device.tsx`,
`components/device/{app-lock-settings,lock-screen,keep-offline}.tsx`, `offline/{lock.ts,extras.ts}`,
modify `offline/{wipe.ts,provider.tsx}`; tests

- [ ] **The app lock** (D181, Q22): off by default; a PIN of 6+ digits, plus "Use Face ID or
  fingerprint" where WebAuthn user verification works (L1). Locks on cold start and after 5 minutes
  hidden or idle; the lock screen covers everything offline and online until unlocked. Ten wrong PINs
  wipe the device's copy (D181) **but keep the person's own unsynced captures locked** (D210).
  Forgotten PIN: sign out and in again (the wipe rule applies).
- [ ] **Keep this location available offline** (D159): per location on This device, only with the
  app lock on; the warning ("If this phone is lost, whoever unlocks Kept sees prices and documents
  for this location"); the size from `estimate=1` before it downloads; progress; documents over
  `KEEP_OFFLINE.fileBytes` listed as "too large to keep offline"; the device total capped at
  `KEEP_OFFLINE.deviceBytes` (`keep_offline_too_large` names what to turn off).
- [ ] **Storage:** extras and documents in IndexedDB, **never the Cache API** (D181), encrypted
  with AES-GCM under a random data key wrapped by the PIN's PBKDF2 key, and also by the WebAuthn PRF
  output where L1 found it available; with no PRF, the passkey unlocks the app and the PIN still
  opens the extras (Q22).
- [ ] **Offline pages:** a kept location's thing page shows its money (as gated) and opens its
  documents from the device; others behave as today. Removed when the toggle goes off, on sign-out,
  on any 401 (D181, D210), and for a location in `revokedLocationIds`.
- [ ] **Tests:** the lock after idle (fake timers); the wipe after ten wrong PINs keeps the queue;
  extras are ciphertext at rest (read the IndexedDB value raw); a 401 wipes extras; nothing goes into
  the Cache API (a test over `caches.keys()`); RTL; a viewer's kept location has no money where
  hidden.
- [ ] **Commit:** `feat(web): an app lock, and keep a location available offline with its prices and documents`.

---

## Phase D: finish

### Task 24: Review pass: security and operations

**Size:** 1 d. **Files:** `docs/audits/security-step8-<date>.md`, plus the fixes (each with a test)

- [ ] **Secrets on every surface:** the restic password, S3 secret and SFTP key in argv (`ps` during a
  real run), environment dumps (`/proc/<pid>/environ` of anything but restic itself), logs at debug,
  error messages, `backup_runs`, audit diffs, pg-boss job data, `idempotency_keys`, metrics, the
  status response, the snapshot list, the readable tree, test fixtures; the recovery kit in caches,
  service-worker storage, the browser's download history name only.
- [ ] **D181 over plain HTTP:** the kit, backup settings and test, secret reveal, export and token
  creation each refused (and if the last three don't use `requireHttps()`, fixed here).
- [ ] **The readable copy:** no secret, no hidden contact detail, no script, no remote resource,
  every user string escaped and bidi-isolated; the owner's scope applied per location (never a
  previous location's in a pooled connection: `app.user_id` reset checked).
- [ ] **Restore safety:** refuses a non-empty or the live database; a tampered dump (hash) and a
  tampered manifest (digest) both fail; `--legacy` reads only names the alpha layout builds.
- [ ] **The release script:** never prints the cosign password; a failed stage leaves no tag; the
  dry run never touches a remote registry (the registry argument's host checked).
- [ ] **The app lock:** the PIN never stored; brute force bounded; the wrapped key unusable without
  the PIN; the lock screen not bypassed by a deep link or the back button.
- [ ] **The Helm chart:** no plaintext secret in a rendered template; the hook Job's role; no
  privileged container.
- [ ] **Commit:** `fix(security): step-8 review` and `docs(audits): security-step8-<date>`.

### Task 25: i18n, e2e, CI, leak, perf, docs, devices, carry-over

**Size:** 1.5 d. **Files:** `apps/web/src/locales/{en,ar,fr,de,it}/messages.po`;
`apps/web/e2e/step8.spec.ts`; `apps/server/test/perf/backup.perf.test.ts`; `scripts/ci-local.sh`;
`README.md`; `docs/plans/step-8-carryover.md`; engineering spec §1.10 (`backup_runs`,
`release_history`), §3.1b (the backup policy), §7.11 (the new variables), §7.3 (the sealed backup
fields); product design §19 (V4, V31)

- [ ] **i18n:** extract once (a temporary worktree at HEAD plus the step-8 files, per the agent
  rules); every new string in all five catalogues, Arabic in the house style; the catalogue gate
  passes. Mail for the new alert kinds in five languages (`src/mail/messages*.ts`).
- [ ] **Playwright** (Chromium, the `households` seed, `KEPT_AI_MOCK=1`, 375×780 and 1280×800):
  1. Ibrahim configures a directory target with a password (after the kit step), tests it, runs a
     backup, and sees it on the status page;
  2. the readable copy restored with the restic binary from that repository opens over `file://`
     with the network blocked: locations, places, things, thumbnails, a receipt; بيت العائلة is RTL;
  3. the recovery kit downloads after re-authentication and holds the repository password;
  4. the update line appears against the stub server;
  5. Alfred turns on the app lock (a CDP virtual authenticator, never a real one), keeps بيت العائلة
     offline, goes offline, unlocks with the PIN, opens a receipt; ten wrong PINs wipe the copy;
  6. Talia sees no Admin; axe on every page visited.
- [ ] **CI** (`scripts/ci-local.sh`): new steps `backup` (the T7 round trip with the real restic
  binary, a hostile-repository case, the S3 verify on RustFS), `helm` (T16), `docs` (T18), and
  `release-dry-run` (T17, opt-in); `prod-boot` runs the entrypoint on a spare `KEPT_PORT` and checks
  that no observability package loads without its variable; `licences` passes with the docs site's
  devDependencies; `images` smokes restic in the image.
- [ ] **Leak:** `leak-operations.ts` fixtures; `backup_runs` and `release_history` unreadable by
  kept_app non-admins and by B; T12's extras for B's location → 404; a byte search of the readable
  tree of A's locations for B's names finds nothing.
- [ ] **Perf** (`test/perf`, full mode, under `--memory 2g --cpus 2` as the floor's proxy): a nightly
  backup at 10,000 things and 2 GB of files, first and second run (time, restic and Node RSS); the
  readable copy for 10,000 things (time, RSS); the digests' time; the drill's time. Record in
  `docs/perf/<date>-step8.md`. The real 2 GB VM run stays due before 1.0 (V5, D209).
- [ ] **Docs:** `docs/runbooks/backup-restore.md` rewritten for restic (and the alpha layout's
  one-release restore); `upgrade.md`; `restore-drill.md`; README's operations paragraph; §7.11 and
  §1.10 as above; §19 V4 ("measured on the VM", or "maintainer check pending" with the fallback), V31
  (T0b's table).
- [ ] **Carry-over:** fold in any open operations or release item from `step-{5,6,7}-carryover.md`;
  write `docs/plans/step-8-carryover.md`; tick the step-1/3/4 items this step closed, each with its
  commit.
- [ ] **Gate:** `bash scripts/ci-local.sh` exits 0 in a clean worktree of HEAD. **Commit:**
  `chore: step-8 i18n, e2e, backup round trip in CI, leak and perf checks, docs`.

### Task 26: The second UI audit (master plan, "before 1.0")

**Size:** 1 d. **Files:** `docs/audits/ui-<date>.md`, plus fixes the audit marks high

- [ ] The master plan's audit (consistency, navigation, states, wording, "Off in this location", RTL,
  phone widths, both themes) across every screen of steps 1–8, against the design board. Each finding
  with a severity; highs fixed with a test; mediums and lows into the 1.0 checklist as items with
  owners.
- [ ] **Commit:** `docs(audit): the second UI audit, before 1.0` (and `fix(web): …` per fix).

### Task 27: The 1.0 release checklist and the release-candidate dry run

**Size:** 1 d. **Files:** `docs/release/1.0-checklist.md`; `apps/web/src/components/ai/data-use-note.tsx`
(`PROVIDER_TERMS`); product design §19 (V5 row note)

- [x] **`PROVIDER_TERMS`** (step-3 carry-over, "before 1.0"): each provider's data-use summary read
  from its own published policy on the day, quoted with the page and date in a code comment; the
  sentence in five languages (through T25's catalogue pass if it lands first, else a small i18n
  commit).
- [x] **The checklist** (`docs/release/1.0-checklist.md`), each row with its owner (agent or
  maintainer), its evidence and its state:
  - **Gate:** `bash scripts/ci-local.sh` exits 0 in a clean worktree for the release commit, every
    step, `release-dry-run` included; the leak, route-catalogue and drift tests; `licences` and
    `attribution`.
  - **Every step's definition of done** (steps 1–8: the `step-N-done.md` records), with each "not
    met" resolved or explicitly deferred to 1.x by the maintainer.
  - **Every carry-over file** with no open item left unassigned (1.x or fixed).
  - **§19:** V5 (amd64 **and** arm64, 2 GB, 2 vCPU: the perf suite and the step-2/3/7 profiles) and V4
    measured on a VM, **maintainer steps**; V31 published; every "device check pending" row of steps
    3–8 run on his phones or kept with its fallback, by his decision.
  - **Strings frozen** (D187); zero untranslated messages in all five catalogues; Arabic in the house
    style.
  - **The second UI audit's** highs fixed (T26).
  - **Repository going public:** `LICENSE` (done), `CLA.md` real text (maintainer), CONTRIBUTING,
    CODE_OF_CONDUCT contact, SECURITY contact, the inert workflows' SHAs re-read, Renovate enabled,
    GitHub Discussions and the public roadmap (D88), the docs published to Pages (D199).
  - **The release itself:** the maintainer steps of `docs/runbooks/release.md` (registry login,
    cosign key, `gh auth`), `release.sh 1.0.0`, the signature verified from a second machine with
    `cosign.pub`, the chart installed from the registry on the maintainer's own Kubernetes (his
    choice of cluster), Compose upgraded from the household alpha to 1.0.0 with the pre-upgrade
    snapshot taken and a restore drill afterwards.
  - **After 1.0** (D107, D130): Docker Hub mirror, store listings, demo instance; awesome-selfhosted
    once the first tag is over 4 months old.
- [ ] **The release-candidate dry run:** `KEPT_RELEASE_DRY_RUN=1 scripts/release.sh 1.0.0-rc.1
  --dry-run` end to end on the laptop; its record attached to the checklist. **No real push.**
  **Not run (2026-10-07):** 12 GB free, under the 15 GB it needs; the maintainer's, row 1.4 of the
  checklist.
- [ ] **Commit:** `docs(release): the 1.0 checklist, the release-candidate dry run and provider data-use notes`.

---

## Needs the maintainer's devices, machines and credentials, and how the build proceeds without them

Each row has a fallback that ships anyway. The checklist is `docs/spikes/2026-xx-step8-devices.md`
(T0b). The build **never waits** for a row.

| # | Check | Built meanwhile | If it fails |
|---|---|---|---|
| V5 | The performance targets, the backup and the readable copy at 10,000 things on a **2 GB, 2-vCPU VM, amd64 and arm64** (D209) | The laptop under `--memory 2g --cpus 2` (T25) | Lower the readable copy's concurrency, the digest page size, restic's settings from R1; record it |
| V4 | The Ollama profile on the 2 GB floor (a small model, one extraction) | The profile ships documented as "needs more than the floor" until measured | The docs keep that line; Ollama stays for bigger machines |
| — | **Registry login, cosign key, `gh auth`** for the real 1.0.0 release (maintainer steps) | `release.sh --dry-run` against a local registry with a throwaway key | — |
| — | The Helm chart installed on a real cluster of his choosing | `helm template` + kubeconform + the optional kind smoke | Fixes from his install become golden-file cases |
| — | A real off-site target: his B2 or R2 bucket over S3, or his NAS over SFTP | RustFS (S3) and a throwaway SSH server (SFTP) | The provider's quirk becomes a documented setting or a repo-location fix |
| L1 | The app lock on his iPhone and Android: Face ID / fingerprint through WebAuthn in the **installed** app; whether PRF works there | Chromium's virtual authenticator; the PIN always works | Biometrics hidden where WebAuthn UV fails; the PIN stays |
| — | Keep offline on the iPhone: 250 MB of documents survive a week without opening Kept (iOS storage eviction, V11) | The sync line's warning; the PIN-wrapped store | Help says the phone may drop the copy; the cap drops |
| — | The readable copy opened from a restic restore on Windows (paths, `index.html` in a browser) | macOS and Linux in T25 | Path or encoding fix in the builder |
| — | `CLA.md` from Harmony's generator, the SECURITY and conduct contacts | Placeholders the checklist refuses | — |

---

## Definition of done for step 8

- `bash scripts/ci-local.sh` exits 0 in a clean worktree, including the new `backup`, `helm` and
  `docs` steps, `images` with restic smoked in the image, and `release-dry-run` once with
  `KEPT_RELEASE_DRY_RUN=1`.
- The leak test covers `backup_runs`, `release_history` and the extras route; no restic password,
  storage credential or recovery-kit content appears in argv, a log line, an audit row, job data,
  `backup_runs`, a metric or a response other than the kit download (T24's record).
- On a fresh `docker compose up`, seeded with `households`:
  - Ibrahim acknowledges the kit, configures a directory backup with a password, runs it, and the
    status page shows it; the next night's run adds only new files; retention keeps 7/4/6;
  - with only the restic binary, the repository and the password, the readable copy of Home and
    بيت العائلة opens in a browser with no network and no Kept;
  - `kept admin backup drill` restores the latest snapshot into an empty database with equal data
    digests, and the status page's drill tile clears;
  - upgrading the image runs `kept migrate`, which takes a `pre_upgrade` snapshot first; running the
    previous image again boots with the rollback line; an image two releases older refuses;
  - the recovery kit downloads after re-authentication, over HTTPS only, and holds the keys, the
    repository and its password;
  - with the update check on, a newer stub release shows "available"; off, Kept makes no request;
  - Alfred keeps بيت العائلة offline behind a PIN; offline, a receipt opens; a 401 removes it.
- `helm template` of every values set passes kubeconform; the kind smoke installs, upgrades and
  tests the chart (or is recorded as skipped for want of the tools, with the maintainer row open).
- `release.sh --dry-run` publishes a signed multi-arch image, its SBOM and a signed chart to a local
  registry, with `/version` verified before any tag.
- `pnpm docs:build` builds the site in five locales with no broken link; the configuration and API
  references match the code.
- The device checklist is filled in or each open row names its fallback; §19 has V4 and V31;
  `docs/plans/step-8-carryover.md` lists anything deferred; `docs/release/1.0-checklist.md` exists
  with every row owned.

---

## Spec questions that are genuinely ambiguous, with proposed answers (adopt these)

1. **The alpha backup and restic.** D207 made the alpha backup "until steps 7–8"; D64 says restic.
   **Proposal:** restic replaces it. The nightly job, the env variables and the targets keep their
   names; the alpha's `runs/`+`blobs/` layout is never written again and stays restorable with
   `kept admin restore --legacy` for one release.
2. **Where the restic repository lives in an existing target.** **Proposal:** a `restic/`
   subdirectory (or `restic/` under the S3 prefix), so an alpha target keeps its old runs beside the
   new repository until the operator deletes them; the status page says when the old runs can go.
3. **Which targets in 1.0.** D64 names S3/B2/R2, SFTP, a NAS path or local disk. **Proposal:**
   directory (a NAS mount or another disk), S3-compatible (B2 and R2 through their S3 endpoints:
   inferred to work, confirmed only by a maintainer row), and SFTP with a pinned host key. No rclone,
   no native B2, Azure or GCS backends.
4. **A file-level restore UI.** **Proposal:** none in 1.0; `kept admin restore` and the restic docs
   cover it. The admin UI lists snapshots read-only.
5. **restic's cache on a read-only root.** **Proposal:** `KEPT_DATA_DIR/.cache/restic`, excluded from
   backups; R1 records its size.
6. **The backup password.** D64: "chosen in the admin UI with a passphrase". **Proposal:** set in
   Admin → Backups (sealed under the keyring, re-wrapped by rotate-key, in the recovery kit) or locked
   by `KEPT_BACKUP_PASSWORD`; at least 12 characters, no composition rules (step 7's rule); **no
   password, no backup**: Kept never writes an unencrypted backup again.
7. **Retention variables.** The alpha has `KEPT_BACKUP_KEEP` (a count); D66 says 7/4/6. **Proposal:**
   `KEPT_BACKUP_KEEP_DAILY|WEEKLY|MONTHLY` (7/4/6); `KEPT_BACKUP_KEEP` read as the daily count for one
   release with a deprecation line. `pre_upgrade` snapshots keep their last 3.
8. **The pre-upgrade snapshot in Compose and Helm.** `kept migrate` holds only the owner login today.
   **Proposal:** the migrate service and the Helm hook also get the keys (config volume read-only, or
   the env) and the backup settings; the snapshot is database-only; a failure stops the migration
   unless skipped explicitly; with no target, a loud line and a status-page note, never a refusal (a
   first install has no backup yet).
9. **One-version rollback** (D66). **Proposal:** `release_history` records each release's last
   migration; the image refuses a database more than one recorded release ahead
   (`downgrade_refused`), allows exactly one (migrations are additive, D82), and `KEPT_ALLOW_DOWNGRADE=1`
   forces it with an audit row. Rollback means running the previous image; there are no down
   migrations.
10. **Whose view the readable copy shows** (D159 says "the readable export" and nothing more).
    **Proposal:** each location's **owner's** view, generated in the owner's scope under row-level
    security, so money appears as the owner sees it and secrets never do. A backup is the instance
    admin's, who already holds the full dump.
11. **Files in the readable copy.** **Proposal:** with local storage, every linked original as a hard
    link (no extra space; restic stores it once); with S3 storage, receipts and documents as
    originals and photos as the display derivative, cached locally so each is fetched once.
12. **The changelog without CI.** D187 says release-please, which runs on GitHub. **Proposal:** the
    laptop release generates `CHANGELOG.md` from conventional commits with `scripts/changelog.mjs`
    (no new tool); release-please is adopted when Actions run, starting from that file.
13. **"Restore into a new database, verify, then swap"** (D66). Renaming databases needs the
    superuser, which Kept's logins never have (§7.1). **Proposal:** Kept restores and verifies; the
    swap is the runbook's two superuser commands, which the restore prints.
14. **Registry, tags and the transparency log.** **Proposal:** GHCR under the maintainer's account
    (path inferred as `ghcr.io/ibrahimroshdy/kept`, confirmed by him); tags `X.Y.Z`, `X.Y`, `X` and
    the digest (D186), **no `latest`**; the chart as an OCI artifact beside the image (D87). While the
    repository is private, cosign signs **without** uploading to the public transparency log (it would
    publish the image's name and digest); from the first public release, with it. `cosign.pub` is
    committed and published in the docs.
15. **What the recovery kit holds.** **Proposal:** D182's list (the key, its version, the retired keys,
    the auth secret, the restic repository, its password, its storage credentials) plus the instance
    URL, the version and the restore steps, as text or a printable page; every download needs fresh
    re-authentication and is audited; "shown once" means nothing is stored anywhere a later visitor
    could open it.
16. **The update check's target** (D65: "GitHub releases"). **Proposal:** the repository the
    image's source label names (`KEPT_SOURCE_URL`), only when it is on GitHub, so a fork checks its
    own releases; a `User-Agent` of `Kept` with no version (D65: "nothing sent but the request").
17. **The chart's version** (D187: independent of the app's). **Proposal:** `0.1.0` now, `1.0.0`
    when the chart's values are declared stable alongside the app's 1.0.0, then semver on its own.
    **Decided 2026-10-07 (after 1.0.0):** the published chart's version is the release's own
    (X.Y.Z, appVersion X.Y.Z), set at package time; the committed Chart.yaml stays `0.0.0-dev`.
    Every published chart pins one image digest, so a chart can't ship apart from a release and a
    separate number only needed a hand bump each time (1.0.0-rc.1 failed on it). Refines D187.
18. **Postgres in the chart** (D186). **Proposal:** a bundled StatefulSet on the pinned pgvector image
    by default for a quick start, or external; the roles and extensions by a pre-install Job when a
    superuser secret is given, else the documented SQL.
19. **Docs languages** (D88 English and Arabic at launch; D204 "later the docs site ships all five").
    **Proposal:** five locales configured; English complete; Arabic for the landing page, install,
    backups, the recovery kit and "restic alone"; French, German and Italian fall back to English
    until Weblate (D106). If time is short, the Arabic pages move to 1.0.1.
20. **Inert workflows.** **Proposal:** committed now with SHA-pinned actions, running only once the
    repository is public (D199); the local CI stays the gate.
21. **Keep-offline limits.** **Proposal:** documents only (receipts, manuals, warranty documents,
    invoices, paperwork), not photos; 25 MB a file and 250 MB a device; the estimate shown before
    download.
22. **The app lock's strength** (D181 says "WebAuthn user verification or a PIN"). **Proposal:** a
    PIN is always set; the kept-offline extras are encrypted under a key the PIN (PBKDF2) wraps, and
    also the WebAuthn PRF output where available; without PRF, Face ID or fingerprint unlocks the app
    but not the extras, which ask for the PIN. Ten wrong PINs wipe the copy and keep the person's own
    queued captures (D210). App lock is available without keep-offline.
23. **Alert kinds.** **Proposal:** `backup_stale` (36 hours), `disk_space_low` (85 %),
    `bucket_versioning_off`, `restore_drill_due` (30 days) and `backup_suspicious_size`, through the
    existing admin channels (D166); the update check is a status line, not an alert.
24. **S3 storage without versioning** (D144: "requires bucket versioning, checked at setup and on the
    status page"). **Proposal:** never a boot refusal (it would lock a household out of its data); a red
    tile and the `bucket_versioning_off` alert until it is on.
25. **The size check** (L79: "refuse suspiciously small dumps"). **Proposal:** the snapshot is still
    taken (it may be right), but retention is skipped and the run is a `warning` with an alert, so a
    bad dump can never push out the good ones.
26. **`backup_runs` against `instance_settings.backup_status`.** **Proposal:** the table
    (engineering spec §1.10) replaces the key; the alpha's last runs are moved into it.
27. **Optional tracing and error reporting** (D84) are unbuilt and in no step. **Proposal:** build
    them in step 8 (T14) since they are operations; if the coordinator needs the half day, move them to
    1.x: CI's dead-collector run (L90) already proves nothing depends on them.
28. **The 1.0 release and its checklist.** **Proposal:** 1.0.0 is cut only when every checklist row
    is done or deferred to 1.x by the maintainer; V5 on both architectures is a blocking row (D209
    promises it), V4 is not (Ollama is optional).

---

### Critical files for implementation
- `apps/server/src/backup/` (`nightly.ts` steps 1–2 and 6, `manifest.ts`, `restore.ts`'s checks,
  `target.ts`'s name rules, `config.ts`'s env loading, `pg-tools.ts`), `src/cli/{index,backup,restore}.ts`
  and `docs/runbooks/backup-restore.md`: what T5 and T7 keep and replace
- `apps/server/src/setup/recovery-kit.ts`, `src/secrets/{service,rotate}.ts` (the VAPID entry in the
  `instance_settings` list), `src/crypto/{envelope,keyring}.ts`, `src/auth/email-change.ts` (the
  re-authentication pattern), `src/config/{env,reference}.ts`
- `apps/server/src/admin/routes.ts` (`AdminStatus`, the status handler, the kit routes),
  `src/alerts/alerts.ts`, `src/db/schema/alerts.ts`, `src/http/health.ts`, `src/jobs/{system,policies}.ts`
- `apps/server/src/db/migrate.ts` (the advisory lock), `src/main.ts` (boot, `PORT`), migrations'
  `meta/_journal.json`
- `apps/server/src/exports/readable/` (step-7 T13), `src/reports/` (the PDF cap), `src/sync/snapshot.ts`,
  `packages/shared/src/sync.ts`, `apps/web/src/offline/{wipe,store,provider}.ts`
- `Dockerfile` (the PGDG pattern for pinned, checksummed additions), `compose.yaml`, `docker/`,
  `scripts/{ci-local,smoke-image,check-licences,check-attribution}.sh|mjs`
- `docs/specs/2026-09-25-kept-product-design.md` D16, D64–D66, D84–D88, D102, D105, D144, D147, D151,
  D159, D165, D166, D181, D182, D186, D187, D193, D199, D209; engineering spec §1.10, §3.1b, §7.1,
  §7.3, §7.11; `docs/research/2026-09-25-lessons-from-our-apps.md` L78–L81, L97–L104
