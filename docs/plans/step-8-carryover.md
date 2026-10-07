# Step 8 carry-over

Written on 2026-10-07 in the finishing pass for steps 6–8. It lists the work left open in build
step 8 and where each piece goes. An item marked "proposed" has no plan that takes it yet, and the
maintainer decides. The combined review ([ui-steps6-8-2026-10-07.md](../audits/ui-steps6-8-2026-10-07.md))
keeps its own list of lows; step 8's are repeated below.

## The gate (the combined final check)

- [ ] Run `bash scripts/ci-local.sh` once in a clean worktree, with few other jobs on the machine
  (or a Postgres of its own), and record the numbers: the e2e specs of steps 3–5, perf, images.
- [ ] Re-run `KEPT_RELEASE_DRY_RUN=1 bash scripts/ci-local.sh --from release-dry-run` **without**
  `KEPT_RELEASE_SMOKE_SCRIPT`, now that the image's own smoke script is in (fdc6d15).
- [x] **Add a `backup` step** to `ci-local.sh`: the round trip, the nightly snapshot, the readable
  copy and the restic contract, on the fake restic, or the real binary under `KEPT_TEST_RESTIC=1`
  (f53e964; run once on 2026-10-07 on the fake: 36 tests, 30 s). **Still open:** a run against the
  real restic 0.19.1; this machine has no restic binary, and the step fails, as it should, when
  `KEPT_TEST_RESTIC=1` finds none.
- [ ] **Compose end to end:** upgrading the image makes the `migrate` service take its
  `pre_upgrade` snapshot (09059dc wired `kept migrate`; T15's note said the CLI read only the owner
  login). Run it with `compose.yaml` and a directory target mounted on `migrate`.
- [ ] Perf after the agenda fix (0100): Home, the agenda and the Vehicles list within their limits,
  on a quiet machine.
- [x] A broken-link check for the docs site: `starlight-links-validator` is wired into the build
  (`apps/docs/astro.config.mjs`, since 90215eb), so `docs` fails on a broken link. The earlier
  "none runs" was wrong (read from the config, not re-run here).

## The maintainer's (credentials, machines, devices)

- [ ] Release M1–M4 in [docs/runbooks/release.md](../runbooks/release.md): the cosign key pair,
  the GHCR login, `gh auth switch --user ibrahimroshdy`, the package's visibility. Then the first
  real release, and `cosign.pub` and the registry path into the docs' "Verifying a release" page.
- [ ] The device checklist, [2026-10-06-step8-devices.md](../spikes/2026-10-06-step8-devices.md):
  V5 and V5b on the 2 GB VM (amd64 and arm64), H1 a real cluster, H1b the kind smoke, SFTP to a real
  server (untested), B2 and R2 through their S3 endpoints (inferred to work), Face ID and
  fingerprint through WebAuthn with PRF on iPhone and Android (tab and installed app), the PIN's
  unlock time at 2.85M iterations, the iOS lock keypad, Blob URL documents in the iOS app, the
  250 MB keep-offline eviction (V11).
- [ ] Placeholders the 1.0 checklist refuses: Pages from Actions. *(2026-10-07: the Code of Conduct
  and SECURITY contacts are written (GitHub private reporting); the CLA, its bot logins and the
  `cla-signatures` branch are gone, replaced by the DCO.)*
- [ ] Naming: the update check's switch lives on Admin's "Sign-up" tab (UI review L9).

## Not built

- [x] **The 1.0 checklist** (`docs/release/1.0-checklist.md`, T27), with every row owned.
  **Done 2026-10-07 (T27):** every row done, deferred or the maintainer's; the release-candidate
  dry run is the maintainer's (12 GB free, under the 15 it needs).
- [x] **§19:** V4 (not measured; maintainer check) and V31 (the managed-Postgres spike's
  findings; a real provider is device row M1) are updated (ca898be).
- [x] **`docs/runbooks/backup-restore.md`** is rewritten for restic as built, with the
  pre-upgrade rollback the downgrade refusal points to (c8d6274). `verify --read-data` takes `5%`,
  not `5`: fixed in the docs site's Restore page and `restore-drill.md` (eb2e388).
- [ ] **The storage-switch runbook** lives in `src/cli/storage.ts`'s header; the docs site's
  "Switching file storage" page covers the steps. Move or drop.
- [ ] **A failed backup with unreadable files** (restic's exit 3, `files_unreadable`) raises no
  admin alert kind of its own. **Proposed:** a migration adding the kind, if wanted.
- [ ] **An upgrade check's `not_github` and `bad_response`** wording: confirm on the status page.
- [ ] **`admin/cli.test.ts`**: re-run on a quiet machine (spawn timeouts and one deadlock in the
  disable/enable case under load).
- [ ] **dexie-store's 10,000-row test** is slow under load (before step 8).

## Lows from the combined review (kept)

- [ ] L8: Keep offline says "About 0 byte to download" for a location without files.
- [ ] L12: in Arabic, the version "0.0.0-dev", the migration number, "USD" in AI estimates and the
  key name "Enter" stay Latin.
- [ ] L13: in centred mode Settings' tabs still change width between tabs (D215 leaves it to the
  maintainer).
- [ ] L14: setting (not revealing) a secret value over plain HTTP is allowed (D217 keeps it open).
- [ ] L15: location names in the sidebar and admin pages aren't isolated.
- [ ] L18: over plain HTTP, Export and New token say they need HTTPS only after they're pressed.

## Done in the finishing pass

- The third-party notices at `/notices.txt`, named by `/version` and linked from the version
  footer as "Third-party notices" (857a026, 8af9f1e).
- The nightly schedule follows the time saved in Admin → Backups with no restart, and a worker
  starts at it; a second Run now while the first waits is refused with 409 (d951be6, D219).
- Bare `kept admin backup` makes a backup (a test that it gets to "Backing up to directory …",
  a9b459f).
- The docs site's "Lands with step 7/8" pages, the Ollama base URL (`http://ollama:11434/v1`), the
  simpler Backups override (the owner login and the mounts), and the README's status (4eb1079,
  0d13472).
