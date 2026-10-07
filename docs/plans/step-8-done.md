# Step 8: the definition of done, item by item

Written on 2026-10-07 in the finishing pass for steps 6–8, from the coordinator's notes, the
agents' commits, the spikes and the combined review ([ui-steps6-8-2026-10-07.md](../audits/ui-steps6-8-2026-10-07.md),
whose operations pass stood in for T24). It takes each item of "Definition of done for step 8"
([2026-10-06-step-8-operations.md](2026-10-06-step-8-operations.md)) and marks it **met**, **met
with a note**, **not met**, **pending final check** or **maintainer check pending**. A separate
final-check agent runs the combined gate for steps 5–8 next; nothing here claims that gate
passed. What is still open is in [step-8-carryover.md](step-8-carryover.md).

**Summary:** the operations work is built: restic snapshots with data digests and the readable
copy, restore, the drill and verify, the full recovery kit, the pre-upgrade snapshot and the
one-version rollback guard, Admin → Backups and the full status page, the update check, the app
lock and keep-offline, the image with restic and third-party notices, the Helm chart, the laptop
release with its dry run, and the docs site. Not built: the `backup` step in `ci-local.sh` and
the 1.0 checklist (T27). The gate, the release dry run without a smoke override and the Compose
upgrade path are pending the final check; installs, real devices and real credentials are the
maintainer's.

## 1. `bash scripts/ci-local.sh` exits 0 in a clean worktree, with `backup`, `helm` and `docs`, `images` smoking restic, and `release-dry-run` once with `KEPT_RELEASE_DRY_RUN=1`: **met except the release dry run, stopped for disk**

- **Final check (2026-10-07).** The gate at 825c4c5, as `KEPT_TEST_RESTIC=1 KEPT_RELEASE_DRY_RUN=1 bash scripts/ci-local.sh`
(restic 0.19.1 darwin, checked against the spike's SHA-256; no smoke override), run from the top
and re-run `--from` the step that failed after each fix, in the main tree with no other agent on
the machine: install 1 s, lint 6 s, catalogues 3 s, typecheck 11 s, compose 1 s, test 511 s
(5,868 tests), drift 3 s, licences 2 s, attribution 1 s, docs 13 s, helm 1 s, prod-boot 17 s,
eval 36 s, portability 22 s, backup 135 s (the real restic), perf 554 s, e2e 633 s (76 passed,
42 one-project skips, the update spec 1), images 252 s: **all ok**. `release-dry-run`: built,
pushed by digest and smoked arm64 (PASS), then **stopped by hand at 3.3 GB free** (the agent
rules' 5 GB floor; it needs 15 GB, `KEPT_RELEASE_MIN_FREE_GB`); not completed. What failed on the
way and was fixed: 7a1c6a4, 900f425, 3062671, 9c1a70a, 95ad483, f6a925e, a7faf33, 825c4c5.
- **Not a separate worktree:** the main tree, clean at HEAD, with no other agent running. A worktree's
  `compose` step would have recreated the shared dev Postgres container (its `./docker/initdb`
  bind is a different path there), restarting another running Kept instance's database.
- **`backup`** ran on the real restic 0.19.1 (50 tests, 135 s). **`release-dry-run` without the smoke
  override:** steps 1–3 and the arm64 smoke passed; stopped before the amd64 smoke and signing when
  the disk fell to 3.3 GB. It needs 15 GB free; Docker's build cache holds 18.5 GB, left alone
  because another project's laptop releases depend on it. **Maintainer:** free the room, then
  `KEPT_RELEASE_DRY_RUN=1 bash scripts/ci-local.sh --from release-dry-run`.
- `e2e/step8.spec.ts` (18c8dd0): Admin → Backups with a directory target saved over HTTPS, Run now,
  the run listed and finished (on this laptop Failed, `pg_version_mismatch`: its pg_dump is 14, the
  image ships 18); the app lock with a PIN, Face ID through a stubbed WebAuthn PRF, a wrong PIN
  refused, the right one and Face ID unlocking after reloads; axe on each page. It found the runs
  list not refreshing after Run now (fixed in 7a1c6a4).

As written before the final check:
- **Not met: there is no `backup` step** (`ci-local.sh --list`: install, lint, catalogues,
  typecheck, compose, test, drift, licences, attribution, docs, helm, prod-boot, eval, perf, e2e,
  images, release-dry-run). The backup's tests run in `test` with the fake restic; the real
  binary's contract (`src/backup/restic/restic.contract.test.ts`, `test/backup/round-trip.test.ts`)
  runs only under `KEPT_TEST_RESTIC=1`, and the notes don't record a full run of it.
- **`docs`:** this pass ran its parts: `check:config` ("matches the env schema") and the site's
  build (469 pages).
- **`release-dry-run`:** ran end to end with `KEPT_RELEASE_SMOKE_SCRIPT` set (e5f3b82; the runbook's
  status line). It is to run again **without** that override now that the image's own smoke
  landed (fdc6d15): pending final check.
- **Fixed in this pass** for the suites the gate runs: the web suite's 7 stale tests (799c256), the
  job registry's 2 (a9b459f) and the route catalogue's 2 (7420241).

## 2. The leak test covers `backup_runs`, `release_history` and the extras route; no restic password, storage credential or kit content in argv, a log line, an audit row, job data, `backup_runs`, a metric or a response other than the kit download: **met with a note**

- `backup_runs` and `release_history` are in the leak test's instance tables (0090–0091, 2e0751c).
- restic gets its password and storage credentials through its environment, never argv
  (`src/backup/restic/`; spike R1).
- `src/admin/backup-routes.test.ts` checks the password and the S3 secret are absent from every
  response, log line, audit row and the idempotency store; `src/admin/recovery-kit.test.ts`
  checks the kit's secrets reach no audit row or log line.
- **Note:** the plan's "T24 record" (one table of every channel) wasn't written: T24 was folded
  into the combined screens and operations review, which checked the plain-HTTP refusals (O1)
  and the start against a slow Postgres (O2) instead.

## 3. The fresh-install walkthrough (`households`): **maintainer check pending; parts pending final check**

- **A directory backup with a password, run and shown on the status page; 7/4/6 retention:**
  `src/backup/backup.test.ts` and `src/admin/backup-routes.test.ts` on the fake restic; the screens
  review set up a backup on a real server. The next night's run adding only new files is restic's
  own deduplication (spike R1's 5 s second backup). Not seen across two nights.
- **The readable copy opened with only restic:** the copy is in every snapshot (a5a5cf8); the docs
  page "Read your inventory with restic alone" is the procedure. Not walked with the real binary in
  this pass.
- **`kept admin backup drill`** restores with equal data digests: `c997575`'s tests on the fake;
  the real-binary run is `KEPT_TEST_RESTIC=1` (above).
- **Upgrade, rollback, refusal:** `kept migrate` takes the `pre_upgrade` snapshot (09059dc), the
  boot's downgrade guard allows one release back and refuses two (dd66524). **Compose end to end:
  met in the final check.** `compose.yaml` with the gate's arm64 image, a directory target on both
  services (`KEPT_BACKUP_DIR`, `KEPT_BACKUP_PASSWORD`) and the owner login on `kept` by an override;
  the database set one migration back (0105's row and function removed) to stand for an upgrade;
  `docker compose up migrate` printed "Pre-upgrade snapshot taken.", wrote a `backup_runs` row
  `pre_upgrade`/`ok` (to version `0.0.0-dev`), restic listed the snapshot (tags `pre_upgrade`), 0105
  was applied again and `kept` answered /readyz 200. Torn down with its volumes.
- **The recovery kit after re-authentication, over HTTPS only:** `src/admin/recovery-kit.test.ts`
  and the web's download (e34fa2c); seen in the screens review behind a TLS proxy.
- **The update check:** `src/updates/*.test.ts` with a stubbed GitHub; off, no request. Official
  images get `not_found` until the repository is public (notes).
- **Alfred keeps بيت العائلة offline behind a PIN:** the web's tests with a stubbed WebAuthn; real
  Face ID, fingerprint, the iOS keypad and the PIN's unlock time are device rows.
- **Also wired in this pass:** a time saved in Admin → Backups moves the nightly schedule at once
  and a worker starts at it; a second Run now while the first waits is refused with 409
  (d951be6, D219); bare `kept admin backup` makes a backup, not the help (a9b459f).

## 4. `helm template` of every values set passes kubeconform; the kind smoke installs, upgrades and tests the chart (or is recorded as skipped): **met with a note**

- `scripts/check-helm.sh`: `helm lint`, `helm template` for four value sets and `kubeconform
  -strict` at Kubernetes 1.37 (the chart's README; ci-local's `helm` step).
- The kind smoke is skipped for want of a cluster: device row H1b, maintainer check pending. The
  chart has never been installed on a cluster.

## 5. `release.sh --dry-run` publishes a signed multi-arch image, its SBOM and a signed chart to a local registry, with `/version` verified before any tag: **met with a note**

- Ran end to end against a throwaway local registry with a throwaway key
  ([docs/runbooks/release.md](../runbooks/release.md), status 2026-10-07; af2088d, e5f3b82), with
  the smoke override noted in §1. No real release: M1–M4 (cosign key, GHCR login, `gh` account,
  package visibility) are the maintainer's.

## 6. `pnpm docs:build` builds the site in five locales with no broken link; the configuration and API references match the code: **met with a note**

- The build passes (469 pages) with English and Arabic content and French, German and Italian on
  Starlight's fallback; the configuration reference matches the env schema (`check:config`); the
  API reference is generated from the OpenAPI document at build time.
- **No broken-link check runs** (Starlight doesn't check links by itself).
- This pass rewrote every page marked "Lands with step 7/8" to what is built (4eb1079): the Helm
  and release-verification pages now say what waits for the first release.

## 7. The device checklist filled in or each row naming its fallback; §19 has V4 and V31; carry-over written; `docs/release/1.0-checklist.md` exists with every row owned: **not met**

- [docs/spikes/2026-10-06-step8-devices.md](../spikes/2026-10-06-step8-devices.md): every row is a
  maintainer check pending with what is built meanwhile. **Met.**
- **§19's V4 and V31 not updated** in this pass (the managed-Postgres spike has the facts:
  [2026-10-06-step8-managed-postgres.md](../spikes/2026-10-06-step8-managed-postgres.md)).
- **`docs/release/1.0-checklist.md` doesn't exist:** T27 wasn't built.
- [step-8-carryover.md](step-8-carryover.md) is written.
