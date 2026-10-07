# Step 7 carry-over

Written on 2026-10-07 in the finishing pass for steps 6–8. It lists the work left open in build
step 7 and where each piece goes. An item marked "proposed" has no plan that takes it yet, and the
maintainer decides. The screens review ([ui-steps6-8-2026-10-07.md](../audits/ui-steps6-8-2026-10-07.md))
keeps its own list of lows; step 7's are repeated below so they aren't lost.

## The gate

- [x] **No `portability` step in `ci-local.sh`.** Added: the round trip, the export's byte
  search, and the hostile archives through the zip reader, the archive import and the Kept import
  (f53e964; run once on 2026-10-07 with RustFS up: 84 tests, 23 s).
- [ ] **No step-7 e2e spec** (export with secrets and the readable copy offline, a Kept import on a
  second instance, a Homebox import with old labels, the re-run, a hostile archive, the CSV export,
  low stock and Adjust, a field converted and back). **Proposed:** the combined final check, or
  1.0's checklist.
- [ ] **No step-7 perf record:** importing 10,000 entities within the 2 GB floor's memory, and the
  2 GB archive write test (not run). **Proposed:** with V5 on the 2 GB VM.
- [x] **A byte search of an export for another tenant's values:** Alfred's household, which
  Ibrahim can see, leaves no value, id, secret or file in Home's ZIP, its readable copy or its
  secrets file (`src/exports/exports.test.ts`, fd3f68b).

## Maintainer checks (device rows, [2026-09-30-step7-devices.md](../spikes/2026-09-30-step7-devices.md))

- [ ] H1: a real Homebox export, its dry run and import on a test location, and printed Homebox
  labels scanned in Kept. H1b: the Homebox version and database driver.
- [ ] The rest of the checklist's rows, each with what is built meanwhile.
- [x] §19's V25 row records the 2026-09-30 re-check; a real export and the release before 1.0
  stay maintainer checks (ca898be).

## Built partly, or not built

- [ ] **Alias enrichment's pause isn't shown:** the import's enrich offer doesn't say "AI paused
  until …" when a cap pauses it (found by a search of `components/import/`).
- [x] **History labels** for `thing.enrich`, `import.enrich` and `import.homebox_connect`
  (ef18b65, c9e4b30).
- [ ] **Account deletion (D49) doesn't exist**, so its "Export first" has nothing to wire to; a
  location's deletion has it.
- [ ] **No Export on Search:** the CSV export needs a server route taking thing ids or the search's
  parameters. Optional.
- [ ] **ExportRun's `expired` status:** `@kept/shared` leaves it out and the web derives it from
  `expiresAt`, while step 4's `export_runs` has the state. Reconcile when either changes.
- [ ] **A location in its deletion grace period gets no readable copy** in the nightly snapshot
  (the owner's scope can't read it under row-level security). **Proposed:** decide whether it
  should, which needs a door (migration).

## Lows from the screens review (kept)

- [ ] L5: the import's drop zone has React Aria's English accessible name "DropZone" in every
  language.
- [ ] L6: a Homebox import's new-location name starts empty (the real inspect carries no collection
  name) and shows as an error before anything is typed.
- [ ] L7: a Kept import's "People to invite" lists the person importing.
- [ ] L16: a Kept import of "Garage" makes a second location called "Garage".
