# Step 7: the definition of done, item by item

Written on 2026-10-07 in the finishing pass for steps 6–8, from the coordinator's notes, the
agents' commits and the screens review ([ui-steps6-8-2026-10-07.md](../audits/ui-steps6-8-2026-10-07.md),
which stood in for step 7's own review). It takes each item of "Definition of done for step 7"
([2026-09-30-step-7-portability.md](2026-09-30-step-7-portability.md)) and marks it **met**, **met
with a note**, **not met**, **pending final check** or **maintainer check pending**. A separate
final-check agent runs the combined gate for steps 5–8 next; nothing here claims that gate
passed. What is still open is in [step-7-carryover.md](step-7-carryover.md).

**Summary:** the build is in (the Kept export and its readable copy, the Kept and Homebox imports
with old labels, alias enrichment, consumables with low-stock reminders, field conversion). The
one-run gate is pending the final check, and it has no `portability` step yet; the fresh-install
walkthrough is a maintainer check.

## 1. `bash scripts/ci-local.sh` exits 0, with `drift`, `licences`, `perf`, `e2e` and a new `portability` step: **met in the final check, except the release dry run (disk)**

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
- **Since closed:** the `portability` step exists (f53e964) and passed (22 s), with the byte search
  for another tenant (fd3f68b). `e2e/step7.spec.ts` (18c8dd0), on an HTTPS instance: the Homebox
  v0.26.2 `home` ZIP imported into a new location, its things listed and `/a/000-005` opening the
  Espresso machine; Home exported with its secrets, downloaded and imported into a new location with
  the passphrase, the Wi-Fi router's password revealed there; Consumables on, a minimum of 5 on the
  HDMI cable low on Home and in Consumables, Adjust to 6 fixing it; axe on each page. Perf: the
  export of Home at 10,000 things 1.7 s (RSS 429 → 463 MB), the Homebox fixture's import 0.7 s
  ([docs/perf/2026-10-07-final.md](../perf/2026-10-07-final.md)); the plan's 10,000-entity import
  and 2 GB of files are not measured.

As written before the final check:
 Drift was run alone in this pass after
  0105: "No schema changes", and `drizzle-kit check` passes.
- **Not met: there is no `portability` step.** Its two halves exist as tests that the `test` step
  runs: the export → import round trip (`test/portability/round-trip.test.ts`, 5342959) and the
  hostile archives (`src/portability/zip/zip.test.ts`: the size ratio, the upload cap, nested
  archives, encrypted and oversized entries).
- **No step-7 e2e spec** in `apps/web/e2e/`. The screens review drove the CSV, Homebox ZIP and Kept
  export imports, the export with secrets and its download, labels, consumables and field
  conversion by hand on a real server.
- **No step-7 perf record** (the plan's 10,000-entity import under the 2 GB floor's budget).
- The web test `portability-shell.test.tsx` "Consumables hidden", which broke when the fixture
  turned Consumables on, passes at HEAD.

## 2. The leak test covers every new table and function; `export_runs` and `import_runs` expose nothing across tenants or to a demoted creator; a byte search of an export finds nothing of another tenant: **met, except the byte search**

- Step 7's tables and doors (0079–0087, 0097, 0101, 0103–0104) are in the leak test's lists and
  probes; `kept.export_running` (0101) answers only a location's owners and admins.
- D180: losing the admin role fails a creator's exports and cancels their imports (Phase A).
- `src/exports/exports.test.ts` searches every entry of an export's bytes for a secret value that
  wasn't chosen. A byte search for **another tenant's** values isn't there as its own case (found
  by reading the test, not run): **not met as written**, carried.

## 3. Every non-GET route is audited or allowlisted; no passphrase, key, password or secret value in an audit row, a log line, `idempotency_keys` or job data: **met**

- The route catalogue passes at HEAD after this pass's fix to two markers (7420241): the recovery
  kit's case read its audit through a helper the catalogue couldn't see, and the Homebox connect
  case called its route through a helper.
- The export's passphrase route runs in its own scoped transaction, never the Idempotency-Key
  store; the sealed run keys are cleared when a run ends (`src/portability/passphrase.test.ts`,
  `src/exports/exports.test.ts`, `src/imports/kept/kept-import.test.ts`).

## 4. The export registry names every location-scoped table, exported or left out with a reason: **met**

- `src/exports/registry.ts` with `src/exports/registry.test.ts` (d8222c4); step 4–6 entities were
  added before history (t12 notes), and `import_source_ids` remembers them (0097, fc39bcf).

## 5. The fresh-install walkthrough (`households`): **maintainer check pending**

- Ibrahim exports Home with secrets and reads the readable copy offline: the export and its
  download were walked in the screens review; the readable copy is `src/exports/readable/`
  (d39cefa) and, in every snapshot, step 8's a5a5cf8.
- Alfred imports that ZIP on another instance: `test/portability/round-trip.test.ts` imports "on
  the same server" (labels re-issued, old codes kept) and "on another server" (every entity, file,
  label, secret and event); the screens review imported a Kept export back with its passphrase. Not
  done across two fresh installs.
- A Homebox v0.26 export with a dry run, old labels opening the imported things: the importer's
  tests on the H1 fixtures (synthetic data from a local Homebox); a real Homebox export is device
  row H1.
- Re-runs create nothing; hostile archives are refused with nothing stored: the importer and zip
  tests.
- Louis's CSV export and printing; a consumable below its minimum on Home and in Consumables, fixed
  by Adjust (low-stock reminders since 340410d); Alfred converting a field to secret and back
  (9dde91a): component and server tests, and the screens review.
- **Not run on two fresh `docker compose up` instances.** That is the maintainer's walkthrough.

## 6. The device checklist filled in or each row naming its fallback; §19 updated for V25; carry-over written: **met with a note**

- [docs/spikes/2026-09-30-step7-devices.md](../spikes/2026-09-30-step7-devices.md): every row is a
  maintainer check pending with what is built meanwhile.
- **§19's V25 not updated** in this pass (it still reads "Re-check against the latest release
  before build step 7").
- [step-7-carryover.md](step-7-carryover.md) is written.
