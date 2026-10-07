# Step 7: Portability. Implementation plan

**Goal:** your data leaves with you, and arrives from where it was (product design principle 6,
D69, D72). Build step 7 in the product design's build order is "export/import with round-trip
tests, the Homebox importer (ZIP-first, legacy labels, D146), consumables, secret-field UI". The
master plan estimates 4–6 weeks.

**In scope:**
- **The Kept export (D68, D69, D159):**
  - a background job that writes one ZIP per location: full-fidelity JSON, the original files, and a
    **readable copy** (an HTML index, CSVs, thumbnails, and the inventory PDF from the report
    engine), readable with nothing but an unzip tool and a browser;
  - secrets left out unless the owner ticks "Include secrets" and gives a passphrase; then they
    travel encrypted inside the ZIP (D68). The readable copy never holds a secret;
  - the location's AI call ledger as `ai-calls.csv` (engineering spec §7.15), and its history;
  - an expiring download link (7 days, §3.3) that re-checks the role on every download (D180);
  - "Export my data" under Settings → Me;
  - "Export first" when a location is deleted (D149).
- **The Kept import:** a Kept ZIP restores into a new location, on this server or another, with
  files, history, printed labels (short IDs adopted where free), and secrets when the passphrase
  is given. An **export → import round trip** runs in CI (D69).
- **The Homebox importer (D146, which supersedes D67 and D69's mapping):**
  - the Homebox export ZIP (v0.26+) is the primary path;
  - an optional connection to the old Homebox server reads its version, each collection's
    currency and its members (the ZIP holds none of these);
  - a dry run before anything is written; the import is a resumable background job, re-runnable
    without duplicates;
  - old Homebox labels keep working (legacy codes, the `/a/`, `/item/` and `/location/` paths).
- **Hostile archives (D157):** storage keys from IDs only, never from archive paths; symlinks
  rejected; caps on total size, compression ratio and entry count (§3.1b); every file through the
  same sniffing, image and PDF limits as an upload.
- **Safe CSVs and exporting a list (D169):** one shared cell neutraliser (including tab and
  carriage return), a CSV export and a "Print" of the things list you're looking at, within your
  permissions.
- **Alias enrichment after an import** (D69): opt-in, with the token cost shown first.
- **Consumables** (D14): "Keep at least N", the low-stock list with Adjust, and the Home
  attention row.
- **The secret-field UI** (step-2 Q3, D172, D177): converting a field to or from secret, and
  changing a field's kind, each through a preview.
- **Carry-over assigned to step 7** (`docs/plans/step-3-carryover.md`): the `importRunId` filter
  on the things list; design-board frames for import (and templates); pruning abandoned import
  runs.

**Out of scope, and where it goes:**
- **Share links** (D39, D116): 1.x (D130). The export download link is not a share link; it needs
  a signed-in owner or admin (D158's claim-pack link is the one exception, and belongs to step 4).
- **The readable export inside every nightly snapshot** (D159) and restic: step 8. Step 7 builds
  the readable copy; step 8 puts it in the snapshot.
- **The Homebox API as a full import path for servers older than v0.26:** proposed for 1.x (Q1),
  following the master plan's scope advice. Decided 2026-09-30 (Q1).
- **LubeLogger CSV** (D170): 1.x. **The "Split household" assistant** (D161): 1.x. Cross-account
  moves of things already work (step 2, `kept.move_things`, D161).
- **A service line using stock from a consumable** (D170): with service lines (steps 4–5).
- **Low-stock reminders:** only if step 4's reminder engine exists (T17 says how).
- **App lock and "keep this location available offline"** (D159, D181): step 8, with the readable
  export (step-3 Q21).

**Architecture.** It stays the same as step 3. What's new:
- **Imports and exports are tenant jobs** in the requester's scope (jobs/boss.ts), like `report`
  and `import-csv`. One attempt, 2 hours, resumable (§3.1b). A job re-reads its run under the
  requester's row-level security, and re-checks the role (D180) before each chunk.
- **Archives live in the BlobStore**, never on a path taken from a request or an archive:
  `i/<runId>.zip` (an uploaded import archive) and `x/<runId>.zip` (a finished export). The
  import job reads the archive **by byte range** (`BlobStore.stream(key, range)`) through yauzl's
  `RandomAccessReader`, so an S3 deployment never copies a 5 GB archive to local disk. The export
  job writes to `KEPT_DATA_DIR/tmp` and then `put()`s, because `BlobStore.put()` takes a local
  file (`src/storage/blob-store.ts`).
- **One way in for files.** `ingestFile()`, extracted from `files/upload.ts` without a change in
  behaviour, is used by the upload route and by both importers: sniffing (D157), derivatives under
  the image limiter, per-location dedupe (D177), blobs stored before the transaction, the
  `pdf-text` job for a PDF (step-3 T21).
- **One row mapper per source, the CSV pattern.** Like `imports/dry-run.ts` `planRow()`, each
  source has a pure planner over `Lookups`, run by the dry run (writing nothing) and by the job
  (writing through the step-2 services, `created_via = 'import'`). Re-runs skip what
  `import_source_ids` already holds.
- **Passphrases never reach the job queue.** The route derives the key (scrypt) during the
  request and stores it **sealed under the keyring** (envelope crypto, `crypto/envelope.ts`) on
  the run row. The job opens it, and the column is cleared when the run ends. Neither a
  passphrase nor a derived key is ever in pg-boss's `data`, a log line, or `idempotency_keys`.
- **Exports are defined by a registry** (`exports/registry.ts`): every location-scoped table is
  either exported (with its columns) or listed as left out with a reason. A test walks the
  catalogue and fails on a table the registry doesn't name, so steps 4–6 tables can't be
  forgotten.

**Before you start (status on 2026-09-30).**
- `git log` ends at `7701f31`. The last committed migration is `0047_thing_meter_version.sql`.
- Step 3's gate passes every step but `prod-boot`, which a stray server on port 8080 kept from
  starting (`docs/plans/step-3-done.md`).
- **Steps 4, 5 and 6 have no plan and are not built.** None of these tables exists in
  `apps/server/src/db/schema/`: `warranties`, `schedules`, `service_records`, `loans`,
  `valuations`, `fx_rates`, `expiring_documents`, `incidents`, `notifications`, `export_runs`,
  `stock_rules`, `share_links`. The build order puts step 7 after them.

Step 7 depends on steps 4–6 in these places:

| Step-7 task | Needs from steps 4–6 | If it isn't there yet |
|---|---|---|
| T4 (`export_runs`) | Step 4's claim pack (D158) shares its ZIP "by an expiring export download link (`export_runs`)", so step 4 may create the table first | **Read the schema first.** If `export_runs` exists, T4 alters it to the shape below; otherwise T4 creates it |
| T9, T10 (Homebox warranty, sold, maintenance) | `warranties` (step 4), `service_records` and `schedules` (one-off, `due_on`, D146) from whichever step builds them | **Hard dependency** for those three mappings only. Until they exist, the dry run reports them as `hb_needs_module` and keeps their text in the thing's notes, so nothing is lost; a re-run after they land adds the records (source ids make it safe) |
| T12 (export registry) | every table steps 4–6 add | The registry test forces a decision per table; nothing to wait for |
| T17 (low-stock reminders) | step 4's reminder engine (`reminder_occurrences.source_type = 'stock'`) | The list and the attention row ship; the reminder source is added by whichever step comes later |
| T21 (export ready) | step 4's notification centre (D39) | The export list in Settings → Import / export shows the state; email when ready (step 3's mailer) |
| T15 (alias enrichment) | step 3's AI layer (built) | — |

**Tech stack.** The pins from steps 1–3 still hold. New packages, each looked up with `npm view`
on 2026-09-30. Pin them exactly, and read the installed `.d.ts` before relying on an API.

| Package | Version | Licence | Used by |
|---|---|---|---|
| `yauzl` | 3.4.0 | MIT (brings `pend` ~1.2.0) | server: reading archives. Its README documents `fromRandomAccessReader(reader, totalSize, options)` / `fromRandomAccessReaderPromise()`, the `RandomAccessReader` class (`_readStreamForRange`), `readEntry()`, `openReadStream()` / `openReadStreamPromise()`, `validateFileName()`, and the options `lazyEntries`, `decodeStrings`, `validateEntrySizes` (default true), `strictFileNames` |
| `yazl` | 3.3.1 | MIT (brings `buffer-crc32` ^1.0.0) | server: writing exports. README: `new ZipFile()`, `addReadStreamLazy()`, `addReadStream()`, `addBuffer()`, `addEmptyDirectory()`, `end()`, `outputStream`, per-entry `compress`, `mtime`, `mode`, `forceZip64Format` |
| `@types/yauzl` | 3.4.0 | MIT | server, dev |
| `@types/yazl` | 3.3.1 | MIT | server, dev |

These are deliberately **not** added:
- `archiver` (8.0.0): one reader and one writer are enough;
- a password-strength library: the passphrase rule is a length (Q7);
- anything on the web for ZIPs: the browser uploads the archive as it is and the server reads it.

**Ground rules for every task** (steps 1–3, repeated):
- **Spec order:** the specs in `docs/specs/` are the contract. Engineering spec §7 beats §1–§6
  (§7.2 beats §1.10's `export_runs.file_id`, Q6). The screens spec §8–§9 beats older frames.
- **Library APIs:** read the installed package's `.d.ts` or README. Never guess. If an API differs
  from this plan, follow the library and note it in the commit body.
- **TDD:** a failing test, then the minimal code, then green, then commit.
- **Commits** use conventional messages and the repo's local git identity. **Never add
  attribution lines**; the commit-msg hook rejects them (D173). Commit by path
  (`git commit -m "…" -- <paths>`), never `git add -A`.
- **Node 24:** `export PATH=/opt/homebrew/opt/node@24/bin:$PATH` first. Tests pin
  `TZ=Africa/Cairo`.
- **Ports:** Postgres 5452, Mailpit 8025 and 1025, RustFS 9452. Never touch 5432, 5433 or 5442.
- **No GitHub Actions.** CI is `scripts/ci-local.sh`, and it gates on exit codes only.
- **Sample cast** in fixtures, tests and docs: Ibrahim (owns Home and Garage), Alfred (owns
  بيت العائلة), Bruce (admin), Louis (member), Talia (viewer), Peter (Alfred's son, managed), and the
  contact Murdock.

**Step-7 additions:**
- **One migration owner.** Phase A (T4–T6) is done in order by one agent. It starts at the
  **next free migration number at build time**: read `migrations/meta/_journal.json` for the last
  committed entry. Phases B and C never add a migration; if one is needed, stop and hand it to the
  owner. Drizzle for tables, checks, uniques, indexes and composite FKs; custom SQL for policies,
  grants, triggers and functions. After each task, `drizzle-kit generate` produces nothing.
- **Every new table** gets, in its task's custom migration: `ENABLE` + `FORCE ROW LEVEL SECURITY`;
  `owner_all` for `kept_owner`; `kept_app` policies on USING and WITH CHECK (or none, with a
  comment, when only definers touch it); `REVOKE UPDATE` then column grants, never on `id`,
  `location_id`, `owner_account_id` or a `user_id`; `touch_row` when it has `row_version`; a
  fixture row in `fillTenant()` (a new `apps/server/test/leak-portability.ts`, imported by
  `leak.test.ts`) in the same commit.
- **Every new `kept.*` function:** revoke `EXECUTE` from `PUBLIC, kept_app, kept_system`, grant
  to exactly the right role; add it to `FUNCTIONS` in `test/leak.test.ts` and to the map in
  `src/db/migrate.test.ts`; definers are owned by `kept_owner` with
  `SET search_path = pg_catalog, public`, check the caller from `app.user_id`, and raise `42501`
  for anything invisible.
- **Every new sealed column** is registered in `secrets/rotate.ts` `CIPHERTEXTS` (§7.3: a test
  fails on an unregistered `ciphertext`/`key_version` column).
- **Archive rules** (D157, §3.1b), enforced in one module (`src/portability/zip/`), never
  re-implemented:
  - entries are read **only by exact expected names** (`manifest.json`, `data/things.ndjson`,
    `attachments/<uuid>`, …); anything else is counted and ignored;
  - a name that `yauzl.validateFileName()` refuses, an absolute path, `..`, a backslash, a
    duplicate name, or a symlink (the entry's Unix mode in `externalFileAttributes`) fails the
    archive;
  - at most 200,000 entries, 5 GB uncompressed in total, 100 : 1 per entry, **counted on the bytes
    actually inflated**, not on the headers;
  - nothing from an archive becomes a storage key or a path on disk. New files get new UUIDv7
    ids, and keys come from `originalKey()`.
- **Passphrases:** only in the request body of the route that takes them. Those routes use a
  scoped transaction **without** the Idempotency-Key store, like `secrets/routes.ts` (its comment
  explains why). Nothing logs a body.
- **API conventions**, as in steps 2 and 3: camelCase JSON; money as a decimal string plus
  `currency`, omitted with `moneyHidden: true` when gated; `If-Match` on every PATCH and every
  POST that changes a versioned row; 404 for anything invisible, 403 for a visible row the role
  can't change; every non-GET route calls `audited()` and has a route-catalogue marker or an
  `ALLOWLIST` entry with a reason.
- **CSV everywhere** goes through `@kept/shared` `safeCsvCell()` (T1): UTF-8 with a BOM, CRLF line
  ends, cells beginning with `=`, `+`, `-`, `@`, tab or carriage return prefixed with `'` (D169).
- **Web:**
  - Every list uses `ListSurface`. React Aria primitives; no native `select`, no
    `window.confirm/alert/prompt`; logical CSS only; nothing truncated with … on a phone; RTL
    correct; works at 375 and 1280.
  - Exports and imports need a connection (screens §4): offline, their actions are disabled with
    "Needs a connection".
  - **No new route files after T3.**
  - **Parallel web tasks never run `i18n:extract` or edit `.po` files.** T25 does that once.

**Parallel execution (waves).** Tasks within a wave touch disjoint files.

| Wave | Tasks | Notes |
|---|---|---|
| 0 | T0 ∥ T1 ∥ T2 ∥ T3 | T0's outcomes can change T7 (the reader), T9 (the Homebox schemas) and T11 (the members endpoint); T1–T3 don't depend on them |
| 1 | T4 → T5 → T6 | one owner, sequential |
| 2 | T7 ∥ T8 ∥ T11 ∥ T12 ∥ T16 ∥ T17 ∥ T18; then T9 (after T7, T8); T10 (after T9); T13 (after T12); T14 (after T7, T8, T12); T15 (after T10) | each owns its own `src/<area>/` |
| 3 | T19 ∥ T20 ∥ T21 ∥ T22 ∥ T23 ∥ T24 | on the mock from T3; each switches to the real server when its wave-2 task is done |
| 4 | T25 | i18n, e2e, the round trip in CI, leak, perf, docs, carry-over |

---

## File structure (created or changed across the tasks)

```
packages/shared/src/
  portability.ts        ZIP_LIMITS, EXPORT_FORMAT/VERSION, export entity names, EXPORT_LIMITS,
                        passphrase rule, import sources and run states, archive issue codes
  csv-safe.ts           safeCsvCell(), csvLine(), CSV_BOM (D169)
  homebox.ts            Homebox choices schema, field-kind map, collection/asset-id helpers
                        (re-exports scan.ts's canonical asset-id form), hb_* issue codes
  consumables.ts        stock rule limits, low-stock rule
  field-convert.ts      conversion kinds allowed per field kind, preview shapes
  csv-import.ts         + ImportIssue gains an optional `ref` (entity) for archive imports
  errors.ts             + archive_invalid, archive_too_large, passphrase_wrong, passphrase_weak,
                          export_expired, export_running, import_target_needed, field_convert_blocked
apps/server/
  migrations/<next…>    Phase A (T4–T6)
  src/db/schema/        exports.ts, consumables.ts (+ imports.ts, sync.ts legacy_codes, ai.ts task)
  src/portability/zip/  read.ts (limits, names, RandomAccessReader over BlobStore) write.ts
                        blob-reader.ts limits.ts
  src/portability/      passphrase.ts (scrypt + AES-256-GCM, sealed derived keys) csv.ts
  src/files/ingest.ts   extracted from upload.ts (T8)
  src/imports/          archive.ts (upload, inspect, target) prune.ts
    homebox/            format.ts (zod per table) read.ts plan.ts lookups.ts apply.ts job.ts
                        api.ts (optional connection) icons.ts
    kept/               read.ts plan.ts apply.ts job.ts history.ts codes.ts secrets.ts
  src/exports/          routes.ts service.ts job.ts registry.ts data.ts files.ts secrets.ts
                        history.ts purge.ts readable/{index.ts,html.ts,csvs.ts,thumbs.ts}
  src/enrich/           routes.ts estimate.ts job.ts prompt.ts
  src/lists/            things-csv.ts (+ reports/service.ts `thingIds` filter)
  src/consumables/      routes.ts service.ts
  src/types/convert.ts  (+ types/routes.ts routes)
  test/leak-portability.ts  test/fixtures/homebox/  test/fixtures/kept-export/
  test/portability/round-trip.test.ts  test/perf/portability.perf.test.ts
apps/web/src/
  api/portability/      paths.ts types.ts queries.ts mock/{imports,exports,consumables,fields}.ts
  routes/_app/          settings.export.tsx consumables.tsx a.$assetId.tsx item.$uuid.tsx
                        location.$uuid.tsx   (+ settings.import.tsx, settings.location.$id.general.tsx)
  components/import/    source-step.tsx archive-step.tsx homebox-choices.tsx kept-choices.tsx
                        target-step.tsx entity-report.tsx enrich-offer.tsx (+ stepper.tsx)
  components/export/    export-sheet.tsx export-list.tsx passphrase-field.tsx export-first.tsx
                        delete-location-sheet.tsx
  components/legacy/    legacy-resolve.tsx collection-picker.tsx
  components/filters/   list-export.tsx (+ registry.tsx: "Imported by")
  components/consumables/  stock-list.tsx adjust-sheet.tsx keep-at-least.tsx
  components/registries/   convert-field-sheet.tsx (+ type-editor.tsx)
docs/design/kept-screens.html   new frames (T3)
docs/spikes/2026-xx-step7-*.md  T0
docs/runbooks/move-to-a-new-server.md  docs/runbooks/read-an-export.md  (T25)
```

---

## Phase 0: spikes, shared contracts and scaffolding (T0–T3, parallel)

### Task 0: Spikes: Homebox re-check and fixture, the archive reader, the passphrase KDF, alias batches

**Files:**
- Create: `docs/spikes/2026-xx-step7-homebox.md`, `…-archive.md`, `…-passphrase.md`,
  `…-enrich.md`, and `docs/spikes/2026-xx-step7-devices.md` (the device checklist, filled in later)
- Create: `apps/server/test/fixtures/homebox/` (the fixture ZIPs and their README), committed
- Throwaway code lives under `docs/spikes/code/`, not in `apps/`.

- [ ] **V25, re-read Homebox before building** (product design §19: "Re-check against the latest
  release before build step 7").
  - On 2026-09-30 the GitHub releases API gives **v0.26.2** (2026-06-14) as the latest stable
    release and **v0.27.0-rc.1** (2026-09-28) as a pre-release. Re-query at build time; don't
    rely on these.
  - Diff the latest stable tag, and the newest release candidate, against v0.26.2 for the paths
    the research cites: `backend/internal/data/ent/schema/`, the export code behind
    `POST /group/exports`, `backend/app/api/routes.go`, `middleware.go` and
    `handlers/v1/controller.go`.
  - **Pass:** a dated table of changes to anything D146 or
    `docs/research/2026-09-26-homebox-import-research.md` states. Each change is either "none",
    or an amendment to this plan and to the research note **before T9 starts**.
- [ ] **H1, a real export ZIP and its exact format.** The research states the tables and the
  manifest's fields but not the byte-level format, and marks link attachments as inferred.
  - Run Homebox locally in Docker. **Read the image name and tag from Homebox's own release notes
    or README at build time**; never assume one.
  - Make two collections with sample-cast data: nested locations; an item inside an item; a
    location-type entity inside an item; an archived item; a fractional quantity; one custom field
    of each kind (`text`, `number`, `boolean`, `time`); tags with parents and colours; one
    attachment of each type (`photo` with a primary, `manual`, `warranty`, `receipt`, `attachment`,
    a thumbnail) **and a link attachment**; maintenance done (with a cost) and scheduled; a
    lifetime warranty and a dated one; a sold item; a template with fields; asset IDs that repeat
    across the two collections; a collection currency outside USD, CAD, GBP, EUR and EGP.
  - Export each collection (`POST /group/exports`, poll, download, per the research).
  - Record: every entry name; whether each table is a JSON array or NDJSON; each row's field names
    and types; the date and time formats; how `quantity`, `number_value` and `cost` are written;
    whether rows carry the group's id; whether one ZIP holds exactly one collection; what a link
    attachment looks like (a row with no file?); the manifest's fields.
  - **Pass:**
    - both fixture ZIPs are committed under `test/fixtures/homebox/` with a README (synthetic data
      only, the sample cast, Homebox version recorded);
    - a zod schema per table (`imports/homebox/format.ts`, written in T9 from this note) parses
      every row of both fixtures;
    - the note says, for each "(inferred)" line in the research, **observed** or **still
      unknown**. An unknown stays a dry-run issue, never a guess.
- [ ] **H2, entity-type icons.** D146 matches type icons by name "where possible"; the research
  marks Homebox's icon naming as not verified. Record the icon values the fixture rows carry and
  where Homebox defines them. **Pass:** a table from Homebox icon values to Kept's icon names
  (`packages/shared` icon registry), or the decision "icons dropped, the Kept type's own icon
  used", which T9 then applies with the issue `hb_icon_dropped`.
- [ ] **H3, the connection.** Against the local Homebox, with an `hb_` API key (v0.26.0+):
  - `GET /api/v1/status` → `build.version`;
  - `GET /api/v1/groups/all` and `GET /api/v1/groups` with `X-Tenant` → `{id, name, currency}`;
  - **the members endpoint:** D146 says the dry run "lists members to invite", but the research
    names no members route and says it returns no roles. Find it in the source.
  - **Pass:** each response shape recorded (keys redacted, never committed). If no members route
    exists, the dry run says "Homebox's export doesn't list members; invite them from Location
    settings" (T11 follows whichever holds).
- [ ] **Z1, the archive reader and writer.**
  - A `RandomAccessReader` whose `_readStreamForRange(start, end)` calls
    `BlobStore.stream(key, {start, end: end - 1})` (our range's `end` is inclusive, yauzl's is
    exclusive: check both), opened with `fromRandomAccessReaderPromise(reader, bytes, {lazyEntries:
    true, validateEntrySizes: true, strictFileNames: true})`, on **both drivers** (local, and S3 on
    RustFS behind the `s3` compose profile).
  - Hostile fixtures, made by a script in `docs/spikes/code/` (committed later by T7 under
    `test/fixtures/zip/`): a 1 GB-of-zeros entry (ratio), 200,001 empty entries, a symlink, `../x`,
    `/etc/x`, `a\\b`, two entries with one name, an entry whose header understates its size, a
    truncated archive, a ZIP64 archive.
  - yazl writing a 2 GB archive of stored (not deflated) JPEG entries through `addReadStreamLazy`
    to a temp file.
  - **Pass:** every hostile fixture is refused with a named reason before more than its cap is
    inflated; the S3 reader reads the central directory and one entry with ranged GETs only; the
    writer's RSS stays under 150 MB with `--max-old-space-size=256`; the 2 GB archive opens in
    macOS Archive Utility and `unzip -t`.
- [ ] **P1, the passphrase KDF.** `crypto.scrypt` (node:crypto) with `N = 2^16, r = 8, p = 1`
  (64 MiB) and `maxmem` set: time it on the laptop and under the step-3 slower-core proxy
  (`docs/perf/2026-09-30-step3.md`). **Pass:** under 1 s on the proxy, or the parameters lowered
  to the largest that passes, recorded in the note and in `portability.ts`.
- [ ] **E1, alias batches on Groq.** With the maintainer's development key, locally and never
  committed: the enrichment prompt (T15) over 20 English and 20 Arabic thing names, in
  `qwen/qwen3.8-27b`, `reasoning: 'low'`. Record input, output and reasoning tokens per call
  against the 1,000-output-tokens-a-minute limit measured in V36. **Pass:** a batch size whose
  output stays under 900 tokens, with aliases a person would search by for 18 of 20 names.
- [ ] **The device checklist.** Write the list from "Needs the maintainer's devices" below, with
  an empty result column.
- [ ] **Commit:** `docs(spikes): step-7 Homebox re-check and fixtures, archive reader, passphrase KDF, alias batches`.

**T0 results (2026-09-30).** In `docs/spikes/2026-09-30-step7-{homebox,archive,passphrase,enrich,devices}.md`.
The amendments they made are marked *(T0)* in T1, T7, T9, T11, T12 and T15 below.

### Task 1: Shared contracts

**Files:**
- Create in `packages/shared/src/`: `portability.ts`, `csv-safe.ts`, `homebox.ts`,
  `consumables.ts`, `field-convert.ts`
- Modify: `csv-import.ts`, `errors.ts`, `ai.ts`, `index.ts`
- Tests, one per file: `*.test.ts`

- [ ] **Step 1: `csv-safe.ts`** (D169). `safeCsvCell(value)`: `null`/`undefined` → empty; a string
  beginning with `=`, `+`, `-`, `@`, `\t` or `\r` gets a leading `'`; quoted when it holds `"`,
  `,`, `\n` or `\r`. `csvLine(cells)`, `CSV_BOM = '﻿'`, rows joined with `\r\n`. The table test
  covers each trigger, Arabic text, and a number that starts with `-` (neutralised: a spreadsheet
  would read `-1+1` as a formula).
- [ ] **Step 2: `portability.ts`.**
  - `ZIP_LIMITS = {entries: 200_000, uncompressedBytes: 5 * 1024 ** 3, ratio: 100, ratioFloorBytes: 1024 ** 2, archiveBytes: 5 * 1024 ** 3}`
    (`ratioFloorBytes` from T0's Z1)
    (§3.1b; `archiveBytes` is the upload cap, Q18).
  - `EXPORT_FORMAT = 'kept-export'`, `EXPORT_VERSION = 1`, and `EXPORT_ENTITIES`: the data file
    names in write order (`location`, `places`, `things`, `codes`, `legacy-codes`, `types`,
    `place-kinds`, `brands`, `vendors`, `people`, `tags`, `purchases`, `purchase-lines`, `files`,
    `attachments`, `meters`, `readings`, `meter-events`, `templates`, `box-checks`,
    `stock-rules`, `own-code-settings`, `history`, …). Steps 4–6 entities are appended by T12's
    registry, never renamed.
  - `EXPORT_LIMITS = {perHour: 5, runningPerLocation: 1, keepDays: 7}` (§3.3, Q17).
  - `PASSPHRASE_MIN = 12` (Q7), and `KDF = {name: 'scrypt', N: 65536, r: 8, p: 1, keyBytes: 32, saltBytes: 16}`
    *(T0, P1)*: N = 2^16 stays; the V5 run on the 2-vCPU VM decides, with N = 2^15 as the fallback.
    Because every export records its own `kdf` (T12), changing the default never breaks an old one.
  - `IMPORT_SOURCES` (the `import_runs.source` values), `ARCHIVE_ISSUE_CODES`:
    `file_type_refused`, `file_missing`, `file_too_large`, `entry_ignored`.
- [ ] **Step 3: `homebox.ts`** (D146).
  - `HomeboxChoices = z.strictObject({archived: z.enum(['skip','tag']), currency: z.string().length(3), quantityRounding: z.enum(['keep_note']), fields: z.record(z.string(), z.enum(['add_to_type','notes'])), types: z.record(z.string(), z.object({typeId: z.uuid()}).or(z.object({create: z.string()}))), insured: z.enum(['field','skip'])})`.
    `quantityRounding` has one value today: D10 rounding keeps the original in notes (D146).
  - `HB_FIELD_KIND = {text: 'text', number: 'number', boolean: 'boolean', time: 'date'}`.
  - `homeboxAssetCode(n: number)`: the canonical `000-001` form. **It must equal what
    `scan.ts`'s `homeboxAssetId()` makes**, so export that function from `scan.ts` and call it; the
    test round-trips `1`, `42` and `123456`.
  - `HB_ISSUE_CODES`: `hb_archived_skipped`, `hb_quantity_rounded`, `hb_number_integer` (Homebox
    stores numbers as integers, so decimals were already lost there), `hb_icon_dropped`,
    `hb_template_partial`, `hb_currency_unsupported`, `hb_needs_module`, `hb_location_in_item`
    (became a container), `hb_notifier_skipped`.
- [ ] **Step 4: `csv-import.ts`.** `ImportIssue` gains an optional
  `ref?: {kind: 'entity'|'attachment'|'maintenance'|'template'|'file', id: string, name?: string}`, and
  `IMPORT_ISSUE_CODES` gains the archive and `hb_*` codes (one list, so the web translates them
  in one place). `DryRunReport.rows[]` gains the optional `ref`.
- [ ] **Step 5: `consumables.ts`.** `STOCK_MIN_MAX = 1_000_000`; `isLow(quantity, min)` is
  `quantity < min` (Q19).
- [ ] **Step 6: `field-convert.ts`.** `CONVERSIONS`: which `type_fields.kind` may become which
  (`text` → `number`, `date`, `url`, `select`; `number` → `text`; `select` → `text`,
  `multi_select`; `boolean` → `text`; `date` → `text`; and `text` ⇄ secret). `money`, `person`,
  `vendor` and `file` convert to nothing (400 `field_convert_blocked`). `ConvertPreview =
  {locations: [{id, name|null, values, convertible, toNotes}], total}`.
- [ ] **Step 7: `ai.ts`.** `LEDGER_TASKS` gains `enrich_aliases`, and `budgetTaskOf('enrich_aliases')
  = 'extraction'` (Q21).
- [ ] **Step 8: `errors.ts`.** Add the codes in the file structure, each with its English message.
- [ ] **Step 9:** `pnpm test --project @kept/shared` passes. Commit:
  `feat(shared): portability, safe CSV, Homebox, consumables and field-conversion contracts`.

### Task 2: Server scaffolding: route stubs, jobs, blob keys, the ingest seam

**Files:**
- Create stub `routes.ts` in `src/{exports,enrich,consumables}/`, and `src/imports/archive.ts`,
  each listed in `http/routes.ts`'s route modules. Job stubs: `exports/job.ts`,
  `imports/homebox/job.ts`, `imports/kept/job.ts`, `enrich/job.ts`, aggregated by a new
  `jobs/portability.ts`.
- Modify: `storage/blob-store.ts`, `jobs/policies.ts`, `jobs/queue.ts`, `jobs/system.ts`,
  `http/errors.ts`
- Create: `src/files/ingest.ts`; modify `src/files/upload.ts`
- Test: `storage/blob-store.test.ts` (or the contract test), `jobs/registry.test.ts`,
  `files/upload.test.ts` (unchanged, must stay green)

- [ ] **Step 1: Blob keys.** Add two id-built shapes to `isBlobKey()`, with builders:
  `importArchiveKey(runId)` → `i/<runId>.zip`, `exportKey(runId)` → `x/<runId>.zip`. Update the
  `BlobKeyError` message and the header comment. The contract test refuses `i/../x.zip` and an
  upper-case id.
- [ ] **Step 2: Job policies** (§3.1b "import/export: 1 attempt, 2 h, resumable"):
  `export`, `import-homebox`, `import-kept`: `{retryLimit: 0, retryDelay: 0, retryBackoff: false,
  expireInSeconds: 7200}`; `enrich-aliases`: as `extract`. `TENANT_REQUEST_QUEUES` gains the four.
  System jobs: `purge-exports` (hourly, beside the reports purge) and `prune-imports` (daily).
- [ ] **Step 3: `ingestFile()`.** Move steps 4–8 of `upload()` (sniff, dedupe answer, derivatives
  under the limiter, blobs first, the short transaction with the file row, derivative rows,
  `file.upload` audit and the `pdf-text` job) into
  `ingestFile(deps, scope, {file, sha256, bytes, fileId, locationId, class}, {auditAction?})`.
  `upload()` keeps the request parts (headers, Content-Length, the upload slots) and calls it.
  **No behaviour change:** every existing upload test passes untouched. The importers call it
  with `auditAction: 'file.import'`.
- [ ] **Step 4: Errors.** `MESSAGES` for the new codes; `CONFLICT_HINTS` for the constraint names
  T4–T6 add.
- [ ] **Step 5:** Commit: `feat(server): step-7 route stubs, job policies, archive blob keys and the ingest seam`.

### Task 3: Web scaffolding: route stubs, the portability contract, design frames

**Files:**
- Create the route stubs in the file structure (`<Page title>` + `ComingLater`), so
  `routeTree.gen.ts` changes once, here.
- Create: `apps/web/src/api/portability/{paths.ts,types.ts,queries.ts}` and
  `mock/{imports,exports,consumables,fields}.ts`; compose them in `api/mock/server.ts`.
- Modify: `docs/design/kept-screens.html` (new frames), `components/app-shell.tsx` (More gains
  Consumables when the module is on)
- Test: `api/portability/mock/*.test.ts` (the mock answers each route's shape)

- [ ] **Step 1: The contract.** Write `api/portability/types.ts` from the route tables in Phase B,
  verbatim. Mocks answer from fixtures with an Arabic household (بيت العائلة), a Homebox run with
  every issue kind, an export in each state (queued, running, done, expired), a low-stock list,
  and a conversion preview across Home and Garage.
- [ ] **Step 2: Design frames** (carry-over: "no design-board frames for import and templates").
  Add frames, phone and desktop, light and dark, one in Arabic, built from the existing board's
  components:
  - Import: the source step (CSV · Homebox export · Kept export), the archive upload, the target
    step (new or existing location), Homebox choices, the entity report, the enrichment offer;
  - Export: the export sheet (with the owner's "Include secrets" and passphrase), the export list,
    "Export first" in the delete-location sheet;
  - a legacy label opening (`/a/000-001`) with the collection picker;
  - Consumables: the low-stock list, Adjust, "Keep at least";
  - the field conversion sheet with its preview;
  - Templates: the list and sheet frames the carry-over names.
- [ ] **Step 3:** Commit: `feat(web): step-7 route stubs, portability contract and design frames`.

---

## Phase A: schema, RLS and the definer paths (T4–T6, sequential, one owner)

Each task ends with `pnpm test` green, **including `test/leak.test.ts`**, and `drizzle-kit generate`
producing nothing. Migration numbers are **the next free numbers at build time**; below they are
written `<N>`, `<N+1>`, ….

### Task 4: Export runs, archive imports, source ids, abandoned runs (`<N>` generated, `<N+1>` custom)

**Files:**
- Create: `src/db/schema/exports.ts`
- Modify: `src/db/schema/imports.ts`, `src/db/schema/ai.ts` (the ledger task)
- Migrations: `<N>_portability.sql`, `<N+1>_portability_rls.sql`
- Test: `src/db/portability.test.ts`; update `leak-portability.ts`, `leak.test.ts`, `migrate.test.ts`,
  `secrets/rotate.test.ts`

- [ ] **Step 1: `export_runs`** (§1.10, shaped by §7.2: an export ZIP is a blob, not a `files` row,
  Q6). If step 4 created the table, `ALTER` it to this shape instead.

  ```sql
  CREATE TABLE export_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id uuid REFERENCES auth."user"(id) ON DELETE SET NULL,     -- the creator (D180)
    scope text NOT NULL CHECK (scope IN ('location','me')),
    location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
    include_secrets boolean NOT NULL DEFAULT false,
    secrets_key_ciphertext jsonb, secrets_key_version int,         -- the passphrase-derived key, sealed; cleared at the end
    options jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(options) = 'object'),  -- {history, aiCalls, readable, pdf, ended, locale, digits}
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
    progress_done int NOT NULL DEFAULT 0, progress_total int NOT NULL DEFAULT 0,
    bytes bigint, sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    error text CHECK (error ~ '^[a-z_]{1,32}$'),
    created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
    expires_at timestamptz,                                          -- finished_at + 7 days (§3.3)
    CHECK ((scope = 'location') = (location_id IS NOT NULL)),
    CHECK ((secrets_key_ciphertext IS NULL) = (secrets_key_version IS NULL)),
    CHECK (secrets_key_ciphertext IS NULL OR include_secrets),
    CHECK (progress_done BETWEEN 0 AND progress_total));
  CREATE INDEX export_runs_user_idx ON export_runs (user_id, created_at);
  CREATE INDEX export_runs_expires_idx ON export_runs (expires_at);
  ```

  - Policies (SELECT and UPDATE; INSERT adds `status = 'queued'`):
    `user_id = (SELECT kept.current_user_id()) AND (scope = 'me' OR location_id IN (SELECT kept.admin_location_ids()))`.
    A creator who loses owner or admin loses the export at once (D180). INSERT also requires
    `NOT include_secrets OR kept.owns_location(location_id)` for a location export (D68: the
    owner), and for `me`, the Personal location (always the user's own).
  - No DELETE for kept_app. `GRANT UPDATE (status, progress_done, progress_total, bytes, sha256, error, started_at, finished_at, expires_at, secrets_key_ciphertext, secrets_key_version)`.
  - Register `export_runs.secrets_key_ciphertext` in `CIPHERTEXTS` (AAD
    `export_runs|<id>|secrets_key`).
  - `kept.purge_expired_exports(p_limit int) RETURNS SETOF uuid` (SYS), modelled on
    `kept.purge_expired_reports`: deletes runs past `expires_at`, and `failed`/`cancelled` runs
    older than 1 day, returning their ids so the job deletes `x/<id>.zip`.
- [ ] **Step 2: `import_runs` for archives.**
  - `location_id` becomes nullable, with `CHECK (location_id IS NOT NULL OR status = 'draft')`:
    an archive is uploaded and read before the person picks the target (new or existing
    location, screens §6).
  - New columns: `archive_bytes bigint`, `archive_sha256 text` (`^[0-9a-f]{64}$`),
    `archive_ready_at timestamptz`, `secrets_key_ciphertext jsonb`, `secrets_key_version int`
    (Kept ZIPs with secrets), `inspect jsonb` (the manifest summary T8 reads), with the same
    pair CHECK as above. Register the ciphertext in `CIPHERTEXTS` (AAD `import_runs|<id>|secrets_key`).
  - Policies: `(location_id IS NULL AND created_by = me) OR location_id IN (SELECT kept.admin_location_ids())`,
    on SELECT, INSERT and UPDATE. Column grants gain the new columns and `location_id` **only
    while it is null** (a trigger `kept.guard_import_target()` refuses changing a set target:
    23514 `import_runs_target_fixed`).
- [ ] **Step 3: `import_source_ids`** (Q2).
  - `source` CHECK adds `homebox` (both Homebox paths write it; `import_runs.source` keeps the
    path).
  - `entity_type` CHECK widens to `('thing','place','purchase','attachment','file','tag','type','type_field','brand','vendor','person','template','meter','reading','box_check','stock_rule','warranty','service_record','schedule')`,
    the last three used only once their tables exist.
- [ ] **Step 4: The ledger task.** `llm_calls`' task CHECK (and its generated `budget_task`) gains
  `enrich_aliases` → `extraction`. Read how migration 0039 wrote them before editing; on a
  partitioned table the constraint is changed on the parent.
- [ ] **Step 5: Abandoned runs** (carry-over "Abandoned import rows aren't pruned").
  `kept.stale_import_runs(p_before timestamptz, p_limit int) RETURNS TABLE (id uuid, has_archive boolean)`
  (SYS): runs in `draft`, `checked`, `failed` or `cancelled` whose `updated_at < p_before`, and
  `done` runs still holding `rows` or an archive. `kept.clear_import_run(p_id uuid)` (SYS): sets
  `rows`, the `archive_*` columns, `inspect` and the sealed key to NULL, and a non-final status to
  `cancelled`. The `prune-imports` job (T8) deletes each archive blob, then calls the door.
  7 days (Q18).
- [ ] **Step 6: Tests.**
  - A member can't insert an export (42501); an admin can, but not with `include_secrets` (42501);
    the owner can.
  - Bruce, demoted from admin to member, no longer sees his export.
  - A draft import run with no target is visible to its creator only; a second admin of the
    location doesn't see it.
  - Setting a run's target twice → 23514.
  - kept_app can't execute `purge_expired_exports`, `stale_import_runs` or `clear_import_run`.
  - The rotate test lists both new sealed columns.
- [ ] **Step 7: Leak.** `fillTenant()` adds an export run with a sealed key, a draft archive run
  with no target, and a Homebox source id. Commit:
  `feat(db): export runs, archive imports, wider source ids and pruning of abandoned runs`.

### Task 5: Carried history, adopted short IDs, `kept` legacy codes (`<N+2>` generated, `<N+3>` custom)

**Files:**
- Modify: `src/db/schema/sync.ts` (`legacy_codes` source)
- Migrations: `<N+2>_import_history.sql`, `<N+3>_import_history_doors.sql`
- Test: `src/db/import-history.test.ts`, `src/db/adopt-codes.test.ts`; update the leak and migrate lists

- [ ] **Step 1: `legacy_codes.source`** adds `kept` (Q9): the old short ID of a thing whose code
  was taken on this server. Stored like any legacy code (`upper(btrim())`).
- [ ] **Step 2: `kept.import_history(p_run uuid, p_events jsonb) RETURNS int`**, a definer, APP
  (Q10).
  1. The caller is the run's `created_by`, an admin of its location, and the run is a `running`
     `kept_zip` run. Otherwise 42501.
  2. Each event is `{at, action, entityType, entityId, rootThingId?, subjects?: uuid[], diff, actorName}`,
     with ids **already remapped** by the job. `diff` must match the audit diff shape
     (`{field: {before, after, class}}`, `class` ∈ plain · money · secret, a secret only
     `{changed: true}`): anything else → 22023.
  3. Events older than the audit retention (2 years, §3.3) are dropped and counted.
  4. **Before inserting, each month present gets its partition** through
     `kept.create_audit_partition(month)` (owner-only; callable here because the definer runs as
     kept_owner). **A past-dated row must never land in `audit_events_default`**:
     `kept.ensure_audit_partitions()` refuses to create a month whose rows already sit there
     (0005).
  5. Inserts with `actor_type = 'import'`, `actor_id = p_run`, the run's `location_id` and
     `owner_account_id`, `undoable_until = NULL`, and `diff` plus `{"_importedActor": actorName}`
     so history renders "Alfred (before the import)". Subjects go to `audit_event_subjects`.
  6. Returns the number written. At most 5,000 events per call.
- [ ] **Step 3: `kept.adopt_short_code(p_run uuid, p_code char(6), p_state text, p_thing uuid, p_place uuid) RETURNS boolean`**,
  a definer, APP (Q9).
  - The same run checks as step 2; `p_state` ∈ assigned · blank · retired; for `assigned`, exactly
    one of thing and place, in the run's location.
  - `INSERT INTO public.short_ids (code, location_id, thing_id, place_id, state, is_primary) … ON CONFLICT (code) DO NOTHING`,
    returning whether it was inserted. The blank-label cap (0042's `guard_blank_cap`) still
    applies to blanks.
  - It reveals only whether a code is in use somewhere on the server, never where; accepted (Q9).
- [ ] **Step 4: Tests.**
  - Events from 18 months ago create their month's partition, and `audit_events_default` stays
    empty (assert `kept.audit_default_partition_rows()` is 0).
  - A 3-year-old event is dropped and counted.
  - A diff holding a secret value (`{before: 'x'}` with class secret) → 22023.
  - Louis (member) calling either door → 42501, and so does Bruce on a run he didn't start.
  - kept_app can't insert an `actor_type = 'import'` row directly (the step-1 policy).
  - A free code is adopted; a taken one returns false and leaves the other location's row alone.
- [ ] **Step 5: Leak.** `fillTenant()` adds an `import`-actor event in the tenant location and a
  `kept` legacy code. Commit: `feat(db): carried history, adopted short IDs and kept legacy codes`.

### Task 6: Stock rules and field conversion (`<N+4>` generated, `<N+5>` custom)

**Files:**
- Create: `src/db/schema/consumables.ts`
- Migrations: `<N+4>_consumables.sql`, `<N+5>_consumables_fields_rls.sql`
- Test: `src/db/consumables.test.ts`, `src/db/field-convert.test.ts`; update the leak and migrate lists

- [ ] **Step 1: `stock_rules`** (§1.6, D14).

  ```sql
  CREATE TABLE stock_rules (
    thing_id uuid PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    min_quantity numeric(12,3) NOT NULL CHECK (min_quantity > 0 AND min_quantity <= 1000000),
    created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), row_version int NOT NULL DEFAULT 1,
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  CREATE INDEX stock_rules_location_idx ON stock_rules (location_id);
  ```

  - `kept.guard_stock_rule()`, BEFORE INSERT OR UPDATE: the thing's type has the `consumable`
    capability through inheritance (`kept.type_capabilities`), else 23514 `stock_rules_consumable`.
  - Policies: SELECT visible; INSERT, UPDATE and DELETE writable (`things.edit` is owner, admin
    and member). `GRANT UPDATE (min_quantity, updated_at, row_version)`. `touch_row`.
- [ ] **Step 2: Field conversion doors** (D172, D177, §7.13 "Converting a field to secret moves its
  values and scrubs `custom`, `search_tsv` and past audit diffs"). The conversion itself needs the
  keyring, which SQL doesn't hold, so it is two doors around the app's crypto:
  - `kept.field_conversion_preview(p_field uuid, p_to jsonb) RETURNS TABLE (location_id uuid, location_name text, values int, convertible int, to_notes int)`:
    the caller owns the field's account (`kept.current_owner_account_id()`), else 42501 (D177:
    owner only). Counts per location of things and places holding a value; **never a value**.
  - `kept.field_conversion_rows(p_field uuid, p_after uuid, p_limit int) RETURNS TABLE (subject_kind text, subject_id uuid, location_id uuid, value jsonb, ciphertext jsonb, key_version int)`:
    same caller check; for a secret field, the current `secret_values` ciphertext; otherwise
    `custom->key`. At most 1,000 per call.
  - `kept.apply_field_conversion(p_field uuid, p_to jsonb, p_rows jsonb, p_finish boolean) RETURNS int`:
    same caller check. Writes one batch: into `secret_values` (sealed by the app) and out of
    `custom`, or the reverse; a kind change writes the converted value or appends
    `"<label>: <value>"` to `notes`. With `p_finish`: flips `type_fields.secret` or `kind`
    (`options`, `unit`), **scrubs past audit diffs** of that key in the account's locations to
    `{changed: true, class: 'secret'}` (to-secret only), and calls `kept.reindex_location()` for
    each affected location.
  - `kept.guard_field_secret()` (0024) is replaced to allow the change when `current_user =
    'kept_owner'`, which is true only inside an owner-owned definer. Read the kind guard in 0024
    (`kept.guard_type_field`) and give it the same exception.
- [ ] **Step 3: Tests.**
  - A stock rule on a non-consumable → 23514; a viewer can't write one.
  - Alfred converts "Door code" to secret: values move to `secret_values`, `custom` loses the key,
    a search for the old value finds nothing, and history shows "changed" with no value.
  - Bruce (admin, not the account owner) → 42501 for all three doors.
  - kept_app `UPDATE type_fields SET secret = true` → 23514 (the guard still holds outside the door).
  - Converting a text field of numbers to `number`: "12" moves, "about 12" goes to notes.
- [ ] **Step 4: Leak.** `fillTenant()` adds a stock rule. Commit:
  `feat(db): stock rules and field-conversion doors`.

---

## Phase B: services and routes (T7–T18, parallel; each owns `src/<area>/`)

All routes follow step 2's rules: `scopedRead`/`scopedWrite` (`http/write.ts`, except the
passphrase routes, see ground rules), `requireMembership` + `requireCan`, `config.module` where a
module applies, responses through `serialize/gates.ts`, every write through `audited()` with
`requestId: req.id`, a route-catalogue marker, lists as `{items, next_cursor}`.

### Task 7: The safe archive module (`src/portability/zip/`)

**Files:** `src/portability/zip/{read.ts,write.ts,blob-reader.ts,limits.ts}`, `test/fixtures/zip/`
(from Z1); tests `portability/zip/*.test.ts`

- [ ] **`blob-reader.ts`**: `blobRandomAccessReader(blobs, key)`, the Z1 reader, used on both
  drivers; a test runs it on the local store and (when `KEPT_TEST_S3` is set, as `s3.test.ts`
  does) on RustFS. *(T0, Z1)*:
  - **`read()` is served from a block cache: 1 MiB blocks, at most 16 held, one GET each.**
    yauzl makes two small reads per directory entry and two per local header, one GET each
    without the cache. With it, a 200,001-entry directory cost 13 GETs on RustFS.
  - `_readStreamForRange(start, end)` returns a `PassThrough` at once, piping in
    `blobs.stream(key, {start, end: end - 1})` when it resolves (yauzl's end is exclusive,
    BlobRange's inclusive). Errors and `destroy()` propagate both ways.
  - A test counts the store's GETs.
- [ ] **`read.ts`**: `openArchive(blobs, key, bytes, {expect})` → `{entries(): AsyncIterable<{name, size}>, read(name): Promise<Readable>, json<T>(name, schema), ndjson<T>(name, schema): AsyncIterable<T>}`.
  - `expect` is a matcher of allowed names (exact names and `attachments/<uuid>`); other names are
    counted as `entry_ignored`.
  - Every refusal of the archive rules (ground rules) throws `ArchiveError` with a reason
    (`too_many_entries`, `too_large`, `ratio`, `symlink`, `bad_name`, `duplicate_name`,
    `truncated`), mapped to 400 `archive_invalid` / 413 `archive_too_large` with that reason.
  - Inflated bytes are counted per entry and in total **while streaming**; the stream is destroyed
    at the cap. The declared sizes are checked first, before anything is inflated.
  - **The 100 : 1 ratio applies only above 1 MiB inflated** (`ZIP_LIMITS.ratioFloorBytes`,
    *T0, Z1*): small, very compressible entries (an empty JSON array, a CSV of spaces) are normal.
  - yauzl's `validateEntrySizes` refusal of an understated header ("too many bytes in the
    stream") maps to the reason `ratio`.
  - `json()` refuses an entry over 64 MB; `ndjson()` refuses a line over 1 MB.
- [ ] **`write.ts`**: `writeArchive(tmpFile, build)` over yazl: `addFile(name, stream, {compress})`
  (JPEG, PNG, WebP, HEIC, AVIF, GIF and PDF stored, not deflated; JSON, CSV and HTML deflated),
  a fixed `mtime`, mode `0o600`, and the SHA-256 and size of the finished archive.
- [ ] **Tests:** every hostile fixture from Z1 refused with its reason, before its cap is exceeded
  (a counting stream asserts it); a good archive reads by name; a written archive reads back
  through `openArchive` with identical bytes; names are never joined into a filesystem path (a
  grep test for `path.join` in `portability/zip/` and the importers).
- [ ] **Commit:** `feat(portability): a safe archive reader over the blob store, and a streaming writer`.

### Task 8: Archive imports: upload, inspect, target, prune

**Files:** `src/imports/{archive.ts,prune.ts}`; modify `src/imports/routes.ts` (list and view
include archive runs), `src/imports/job.ts` (`RunRow.source`), `jobs/system.ts`; tests
`imports/archive.test.ts`

- [ ] **Routes.** `location.export-import` (owner and admin) once a target is set; before that,
  the run's creator.

  | Method and path | Body → Response |
  |---|---|
  | `POST /api/v1/imports/archive` | `{id, source: 'homebox_zip'\|'kept_zip', bytes, sha256}` → 201 `ImportRun` (`draft`, no location). `bytes` over `ZIP_LIMITS.archiveBytes` → 413 before anything is stored |
  | `PUT /api/v1/imports/:id/archive` | raw body (`application/zip`), `Content-Length` = `bytes`, `X-Kept-Sha256` → 200 `ImportRun` with `archiveReadyAt`. Streamed to `KEPT_DATA_DIR/tmp` with `receive()` (upload.ts), checked against `bytes` and `sha256`, then `put()` to `i/<id>.zip`, then the tmp file removed. Fastify `bodyLimit` for this route only: `archiveBytes`. A replay with the same sha → 200; other bytes → 409 `idempotency_mismatch`. Audited `import.archive` (size and sha only) |
  | `POST /api/v1/imports/:id/inspect` | → `{source, sourceVersion, collections: [{id?, name?, counts: {entities, locations, attachments, maintenance, tags, types}}] \| kept: {locationName, kind, exportedAt, keptVersion, counts, includesSecrets, members: [{name, role}]}}`. Reads only the manifest and row counts through `openArchive` (T7), and T9's or T14's `read.ts`. Stored in `import_runs.inspect`. A bad archive → 400 `archive_invalid` with its reason, and the run is `failed` |
  | `POST /api/v1/imports/:id/target` | `{locationId}` (Homebox only: an existing location the caller administers) \| `{newLocation: {name, kind, timezone, currency, languages?}}` → `ImportRun` with `locationId`. A new location is created through the step-1 locations service **in the same transaction**, owned by the caller's account. Kept ZIPs take only `newLocation` (Q8) |

  `GET /imports/:id`, `GET /imports?locationId`, `/dry-run`, `/run` and `/cancel` from T18 of step 3
  serve archive runs too; `/dry-run` and `/run` dispatch on `source` to T9/T10 or T14.
- [ ] **`prune.ts`**, the `prune-imports` system job (daily): for each run from
  `kept.stale_import_runs(now() - 7 days, 200)`, delete `i/<id>.zip` (a missing blob is fine), then
  `kept.clear_import_run(id)`. The archive of a `done` run is deleted when the run finishes (T10,
  T14); the prune catches what a crash left.
- [ ] **Tests:**
  - Louis (member) can't target Home (403); Bruce can;
  - a 5 GB + 1 declaration → 413 with nothing stored; a body shorter than declared → 400 and no
    blob;
  - inspect on a hostile fixture → 400 with the reason, the run `failed`;
  - a Kept ZIP with `{locationId}` → 400 (new location only);
  - the new location belongs to the caller's account and has the Unplaced area (D118);
  - the prune removes a week-old draft's archive and clears the row, and leaves a running run alone.
- [ ] **Commit:** `feat(imports): archive upload, inspection, targets and pruning`.

### Task 9: The Homebox reader, planner and dry run (depends on T0's H1, T7, T8)

**Files:** `src/imports/homebox/{format.ts,read.ts,lookups.ts,plan.ts,icons.ts}`; tests
`imports/homebox/*.test.ts` over `test/fixtures/homebox/`

- [ ] **`format.ts`**: one zod schema per Homebox table **as H1 recorded it** (the manifest,
  `entity_types`, `entity_templates`, `template_fields`, `tags`, `entities`, `entity_fields`,
  `maintenance_entries`, `attachments`, `tag_entities`; not `notifiers`, below; D146 and the research). Unknown
  fields are ignored; a row that fails its schema becomes an issue on that row, never a crash.
  `manifest.schemaVersion` other than the versions H1 and V25 saw → 400 `archive_invalid`
  (`unsupported_version`), naming the version. *(T0, H1)* Start from
  `docs/spikes/code/step7/h1_format.ts`:
  - each table is one JSON array, read with `json()`, not NDJSON;
  - booleans are `0`/`1` or `true`/`false`;
  - `entity_location_entities` is optional (v0.27);
  - **`notifiers.json` is never opened**: its URLs are credentials, and only the manifest's count is
    reported. So there is no notifiers schema in `format.ts`.
- [ ] **`read.ts`**: loads the tables into memory-light maps keyed by UUID (a household's rows are
  small; files stay in the archive). Builds the tree from each entity's `parent` and the location
  rule "the nearest ancestor whose type has `is_location`" (research). *(T0, V25)*:
  - `entity_location_entities`, when set (v0.27+), is the location and beats the ancestor walk.
  - The parent column is `entity_children`, and a tag's parent is `tag_children`: the SQL names,
    which read backwards.
  - The collection id is `manifest.groupId` (Q4 settled; every row's group column equals it).
- [ ] **`plan.ts`**: `planHomebox(run, tables, lookups)` → `PlannedEntity[]` in apply order: types
  and their fields → tags → places → things → purchases, warranties, sales → attachments →
  maintenance → templates → legacy codes. **The mapping is D146's, rule by rule:**
  - each collection → the run's location;
  - location-type entities → places, keeping the hierarchy; one inside an item → a container
    thing (`hb_location_in_item`), because places can't sit inside things;
  - other entities → things; one with children → a container (its Kept type gets the `container`
    capability through the type mapping, or `box_bin` when the mapped type can't contain);
  - entity types → Kept types, by the run's `types` choice (matched by `kept.normalize(name)` to an
    account type or a built-in's localised name, else created); icons per H2;
  - name, description + notes → name and notes (description first, a blank line, then notes);
  - manufacturer, model and serial → brand (deduplicated into the registry by normalised name),
    model and serial;
  - purchase date, from and price → a purchase with one line (D115) and the vendor in the registry,
    in the run's `currency` choice;
  - warranty expiry and details → a warranty; `lifetime_warranty` → a warranty with `lifetime`
    (`hb_needs_module` until `warranties` exists);
  - sold date, price, to and notes → lifecycle `sold` with `ended_on`, `ended_price`,
    `ended_currency`, `ended_to`, `ended_notes`;
  - tags → tags with colours, **flattened by also applying every ancestor tag**; tag icons dropped;
  - custom fields `text`/`number`/`boolean`/`time` → Kept fields `text`/`number`/`boolean`/`date`,
    matched to the mapped type's field by normalised label and compatible kind; otherwise the
    run's `fields` choice: add the field to the type (a built-in is first copied into the account
    with `kept.customise_type`) or keep `"<name>: <value>"` in notes (Q16);
  - `insured` → a yes/no field "Insured" on the mapped type, only when some entity is insured, per
    the `insured` choice (Q25);
  - `quantity` `0` (what an API client gets by default in Homebox) → 1, with `hb_quantity_zero`
    *(T0, H1)*;
  - fractional `quantity` → decimal (D183); where D10 forces 1 (serialized, metered), 1 with the
    original in notes (`hb_quantity_rounded`);
  - `archived` → skipped (`hb_archived_skipped`) or imported with the tag "Archived in Homebox",
    per the `archived` choice;
  - attachments: `photo` → photo (the `primary` first), `manual` → manual, `warranty` → the
    warranty's document, `receipt` → the purchase's receipt, `attachment` → document; thumbnails
    skipped; link attachments → `attachments.url` rows. A file that won't sniff as an allowed type
    → `file_type_refused`, listed with its title and MIME type (Q15);
  - completed maintenance → service records (`cost` is a JSON number in the ZIP, a string only in
    the API; `0001-01-01T00:00:00Z` in `date` or `scheduled_date` means none, *T0*);
    scheduled maintenance → a one-off schedule with `due_on` (`hb_needs_module` until those
    tables exist);
  - templates → account templates, best effort (`hb_template_partial` for anything D177 forbids in
    a payload: money, secrets);
  - **dates** are midnight UTC: take the UTC date part, never a local conversion *(T0)*;
  - **seeded places and tags** *(T0)*. Every Homebox collection starts with eight places (Living
    Room, Garage, Kitchen, Bedroom, Bathroom, Office, Attic, Basement) and six tags (Appliances,
    IOT, Electronics, Servers, General, Important), usually left empty. A dry-run choice, `seeded`:
    skip the ones that are **empty and unused** (default) or import them all. The issue is
    `hb_seeded_skipped`, with the names listed;
  - **`time` custom fields** *(T0, untested heuristic)*: Homebox's API can't set an entity's
    `time_value`, so it is usually the row's creation time. A `time_value` within one second of the
    field row's `created_at` is treated as **empty** (`hb_time_default`); the fixtures have only
    such values. Revisit if a real export shows a chosen date that close to creation;
  - notifiers → not imported (`hb_notifier_skipped`, from the manifest count only); members, memberships and roles → not in the
    ZIP (T11 lists them when connected);
  - **legacy codes:** every non-zero `asset_id` as `homeboxAssetCode(asset_id)` and every entity
    UUID (lower-case, through `legacyCodeOf()`), `source = 'homebox'`, `source_collection` = the
    collection id H1 found in the rows, else the run id (Q4). A code the location already has
    under any source → `code_taken` (D208: one code per location).
  - **source ids:** `import_source_ids (location, 'homebox', <uuid>)` per entity, attachment,
    maintenance entry and template; `<entityUuid>:purchase`, `:warranty`, `:sale` for the derived
    records.
- [ ] **The dry run** (`POST /imports/:id/dry-run`, T8's dispatch): runs `planHomebox` over
  `Lookups` loaded for the target (brands, vendors, tags, types, places, taken codes and source
  ids, as `imports/dry-run.ts` does), writes nothing, and stores
  `{summary: {places, things, containers, purchases, warranties, services, schedules, attachments, links, tags, types, fieldsAdded, legacyCodes, skipped, asText, refusedFiles}, rows: [...]}`
  keeping **only rows with issues** plus the summary (Q27). Status `checked`.
  - **Restarting Homebox** *(T0)*: v0.26.x exports once per process. The upload step's help says:
    "If Homebox says 'Topic has been Shutdown', restart Homebox and export again."
  - **Choices the dry run needs before it can run** (screens §6 "dry-run choices (D146)"): the
    currency (prefilled from T11's connection, else the target location's currency; a code not
    enabled offers "Enable it" to an instance admin or "Choose one of the enabled", which relabels
    without converting, and says so; D136, D168), archived, the type mapping, the fields, insured.
    `POST /imports/:id/choices {choices: HomeboxChoices}` stores them (If-Match on the run).
- [ ] **Tests** over both fixtures:
  - the summary counts match the fixture's README;
  - the item-inside-an-item is a container; the location-inside-an-item is a container with its
    issue;
  - a lifetime warranty maps to `lifetime`; a sold item gets its end details;
  - a child tag also carries its parent;
  - the `time` custom field becomes a date field, empty in these fixtures (`hb_time_default`); an integer `number` field carries
    `hb_number_integer`;
  - the second collection's `000-001` is a separate legacy code with its own collection;
  - a `.docx` manual is refused and listed by name;
  - an archived item is skipped or tagged per the choice;
  - the dry run writes nothing (row counts before and after);
  - a malformed row is an issue, and the rest plan.
- [ ] **Commit:** `feat(imports): Homebox export reader, planner and dry run (D146)`.

### Task 10: The Homebox import job (depends on T9)

**Files:** `src/imports/homebox/{apply.ts,job.ts}`; tests `imports/homebox/job.test.ts`

- [ ] **`job.ts`** (tenant, 1 attempt, 2 h, resumable), the CSV job's shape
  (`imports/job.ts`):
  - the run is locked and its status read first in each chunk, so a cancel stops at the next
    chunk and two workers never take the same entities; the role is re-checked (D180);
  - **rows** in chunks of 200 per transaction through the step-2 services (`createPlace`,
    `createItem` for brands, vendors and tags, `insertThing` with `created_via = 'import'`, type
    and field creation through `types/service.ts`), each with its own audit row, and one
    `import.run` event per chunk with the things as subjects (Q11);
  - **files** outside any transaction: for each attachment, stream the entry from the archive to
    `KEPT_DATA_DIR/tmp` through `receive()` with `maxFileBytes`, then `ingestFile()` (T2) with a new
    UUIDv7 id, then `createAttachment()` in the chunk's transaction. A per-location sha hit
    reuses the existing file (D177). An entry over the file size cap → `file_too_large`, listed;
  - every applied entity writes its `import_source_ids` row in the same transaction, so a resumed
    or re-run import skips it; a row that fails anyway is rolled back to its savepoint and
    reported;
  - progress moves per chunk; the last chunk sets `done`, deletes `i/<id>.zip`, and clears
    `inspect`'s bulk.
- [ ] **Tests:**
  - the full fixture imports, then the counts equal the dry run's summary;
  - a re-run of the same ZIP creates nothing new (one `import_source_ids` row per source id);
  - a run killed after chunk 2 resumes from chunk 3 and ends with the same counts;
  - cancel stops at the next chunk;
  - a photo becomes a file with derivatives and no GPS in them; a PDF manual gets `file_text` (the
    `pdf-text` job ran);
  - **the fixture's printed labels resolve:** `POST /scan/resolve` with
    `https://homebox.example/a/000-001` opens the thing; with both collections imported into Home
    and Garage, it answers `legacy_ambiguous` with both (step-3 T17);
  - Louis can't run it (403); an admin demoted mid-run stops the job at the next chunk with
    `failed` / `not_permitted`;
  - a 3 : 1 mix of fixtures at 10,000 entities imports in under 10 minutes on the laptop (joins
    `test/perf` in T25).
- [ ] **Commit:** `feat(imports): the resumable Homebox import job, with files and legacy labels`.

### Task 11: The optional Homebox connection (version, currency, members)

**Files:** `src/imports/homebox/api.ts`, a route in `src/imports/archive.ts`; tests
`imports/homebox/api.test.ts` (against a stub server)

- [ ] **`POST /api/v1/imports/:id/homebox-connect`** `{baseUrl, apiKey}` \|
  `{baseUrl, username, password}` → `{version, collections: [{id, name, currency}], members?: [{name, email}]}`.
  - Runs **during the request**, with no transaction open (like step 3's "Test connection").
  - Through `net/ssrf.ts` `guardedFetch`, with redirects refused, a 10 s timeout, and
    `instance_settings.ssrf_allow_private` honoured (step-3 Q9: a Homebox on the LAN is the usual
    case, so the private-address error offers the instance admin's switch).
  - Calls, with shapes as H3 recorded: `GET /api/v1/status`; for a password,
    `POST /api/v1/users/login` once for a session token; `GET /api/v1/groups/all`; `GET
    /api/v1/groups` with `X-Tenant: <groupUUID>` per collection; *(T0, H3)*
    `GET /api/v1/groups/members` with `X-Tenant` → `[{id, name, email}]`, no roles. The report
    prefills each email and asks for a role, default member. `currency` comes back upper-case;
    normalise it anyway. Kept matches a ZIP to its collection by `manifest.groupId`.
  - **The key, password and token are never stored, logged or audited** (D146: "never stored").
    The route is on the idempotency exception list (ground rules). Audited `import.homebox_connect`
    with the host and version only.
  - The answer prefills the run's currency choice and the members list in the report.
- [ ] **Not built in step 7:** the API as the full import path for servers older than v0.26 (Q1).
  The web says "Homebox older than v0.26 can't export; update it, then export" with a link to
  Homebox's own docs.
- [ ] **Tests:** a private address without the setting → 400 `private_address`; a redirect →
  refused; a stub returning `usd` fills `USD`; the request log and the audit row hold no key.
- [ ] **Commit:** `feat(imports): an optional Homebox connection for version, currency and members`.

### Task 12: The Kept export

**Files:** `src/exports/{routes.ts,service.ts,job.ts,registry.ts,data.ts,files.ts,secrets.ts,history.ts,purge.ts}`,
`src/portability/passphrase.ts`; tests `exports/*.test.ts`, `exports/registry.test.ts`

- [ ] **`registry.ts`**: for every exported entity, its data file name, the query that reads it
  **as the requester under RLS** (never the owner role), its columns in camelCase, and its money
  and secret classes. A list `NOT_EXPORTED` names every other location-scoped table with a reason
  (`sync_ops`: device state; `inbox_items`: open decisions, re-made by the importer; `extractions`:
  derived; `label_batches`: print jobs; `import_runs`, `import_source_ids`: this server's
  bookkeeping; `llm_calls`: written as `ai-calls.csv` instead; …).
  **`registry.test.ts` walks `pg_class` for tables with a `location_id` column** (and account
  registries reached through the location's things) and fails on any table in neither list, so
  step 4–6 tables must be decided.
- [ ] **The archive layout** (format `kept-export` v1, Q5):

  ```
  manifest.json          {format, version, keptVersion, exportId, createdAt, createdBy: {displayName},
                          location: {id, name, kind, timezone, currency, languages, modules},
                          counts, includesSecrets, members: [{name, role}], files: [{id, sha256, bytes, mime}]}
  data/<entity>.ndjson   one API-shaped JSON object per line, ids as on this server
  files/<fileId>         every original the location's attachments reference, byte-identical (D117)
  secrets.json           only with "Include secrets" (below)
  ai-calls.csv           the location's AI call ledger, §7.15 list columns, money per the gate, no thread ids
  readable/…             T13
  ```

  - Things carry their short IDs, own codes and legacy codes; people carry contact details only
    where `kept.person_contact_visible()` is true for the requester (D177, Q22); members appear by
    name and role only (Q23).
  - **History** (`data/history.ndjson`, §3.3: audit events "included in exports"): the location's
    events rendered through `renderAudit(event, requester)`, so secrets are `{changed: true}` and
    money follows the requester's gate (D110).
  - Options: ended things (default on), trashed things (off), history (on), AI calls (on),
    readable copy (on), inventory PDF (on).
- [ ] **`secrets.ts` and `passphrase.ts`** (D68).
  - `POST /exports` with `includeSecrets` needs the owner (`kept.owns_location`, 403 otherwise),
    the recovery-kit acknowledgement (409 `recovery_kit_required`, D193, as setting a secret
    does), and `passphrase` twice (equal, at least `PASSPHRASE_MIN` characters: 400
    `passphrase_weak`).
  - In the request: `salt = randomBytes(16)`, `key = scrypt(passphrase, salt, KDF)`; the key is
    sealed with the keyring into `export_runs.secrets_key_ciphertext`; the passphrase and key are
    dropped. The route does not use the Idempotency-Key store.
  - In the job: open the key, read each secret value through the existing reveal path's crypto
    (`secrets/service.ts`), write `secrets.json` =
    `{format: 'kept-secrets', version: 1, kdf: {name, N, r, p, salt}, cipher: 'aes-256-gcm', iv, tag, data}`
    where `data` decrypts to NDJSON `{subject: {kind, id}, fieldKey, value, updatedAt}` and the
    AAD is `kept-export|<exportId>|secrets`. Clear the sealed key when the run ends, whatever the
    outcome.
  - Audited `export.secrets` (count only), besides `export.create`.
- [ ] **Routes.** `location.export-import` for a location; anyone for `me`.

  | Method and path | Body → Response |
  |---|---|
  | `POST /api/v1/exports` | `{id?, scope: {locationId} \| {me: true}, options?, includeSecrets?, passphrase?, passphraseAgain?}` → 202 `ExportRun`. 429 past `EXPORT_LIMITS.perHour` (Retry-After), 409 `export_running` while one runs for that location. Sends the `export` tenant job in the same transaction. Audited `export.create` |
  | `GET /api/v1/exports/:id` | → `ExportRun = {id, scope, locationId?, status, progress: {done, total}, bytes?, sha256?, includesSecrets, options, createdAt, finishedAt?, expiresAt?, fileUrl?}`. `fileUrl` is a 5-minute signed URL (`x/<id>.zip`, attachment, `kept-<location>-<date>.zip`), given only while `done` and unexpired and only after the role re-check (the policy, D180). Audited `export.download` when `fileUrl` is issued |
  | `GET /api/v1/exports?locationId&cursor` | the caller's own runs |
  | `POST /api/v1/exports/:id/cancel` | → `ExportRun` (`cancelled`); the job stops at the next entity |

- [ ] **`me` scope** (Q14): the Personal location's export plus `me.json` (profile, display and
  notification preferences, hints, saved views, own AI calls as `my-ai-calls.csv`); never tokens'
  hashes or sessions.
- [ ] **`job.ts`**: reads entity by entity with keyset pages of 1,000, writes NDJSON to
  `KEPT_DATA_DIR/tmp/<id>/`, streams files from the BlobStore into the archive (`writeArchive`,
  T7), checks free space first (`fs.statfs`: refuse with `error = 'no_space'` below the estimated
  size × 1.1), `put()`s `x/<id>.zip`, records bytes and sha, sets `expires_at = now() + 7 days`,
  and sends the "Your export is ready" mail (step-3 mailer; the notification when step 4's centre
  exists). Progress per entity file and per 100 files.
- [ ] **`purge.ts`**: the `purge-exports` job deletes `x/<id>.zip` for each id from
  `kept.purge_expired_exports(200)`.
- [ ] **Tests:**
  - a Home export has every registry entity, every file byte-identical, and a manifest whose counts
    match;
  - no secret value anywhere in the archive without "Include secrets" (a byte search for each
    fixture secret);
  - with it, `secrets.json` opens with the passphrase and fails with another (GCM tag);
  - Bruce's export can't include secrets (403); Talia (viewer) can't export (403);
  - a viewer-gated money value is present for Bruce (admin sees money) and history is redacted per
    D110;
  - Bruce demoted to member: `GET /exports/:id` → 404, no URL;
  - the sixth export in an hour → 429;
  - the sealed key column is null after `done` and after `failed`;
  - the job's data in pg-boss holds only `{exportId}` (read the job row).
- [ ] **Commit:** `feat(exports): full-fidelity Kept export with files, history, AI calls and passphrase-sealed secrets`.

### Task 13: The readable copy (depends on T12)

**Files:** `src/exports/readable/{index.ts,html.ts,csvs.ts,thumbs.ts}`; modify
`src/reports/gather.ts` (a paged read); tests `exports/readable.test.ts`

- [ ] **What it holds** (D159, Q12), under `readable/` in the archive, with **no script, no remote
  resource and no secret**:
  - `index.html`: the location, its places as a tree, and per place its things (thumbnail, name,
    short ID, type, brand and model, serial, quantity, condition, tags, last seen, purchase date
    and price where the requester's gate shows money), each thing linking to its photos, receipts
    and documents under `../files/<fileId>` (the originals already in the ZIP; nothing copied
    twice);
  - `things.csv`, `places.csv`, `purchases.csv`, `attachments.csv`, `readings.csv` (and one per
    step 4–6 entity the registry exports), through `safeCsvCell`, UTF-8 with BOM (Q12);
  - `thumbs/<fileId>.jpg`: the 400 px thumb derivatives;
  - `inventory.pdf`: the step-2 report engine's inventory report for the location, when it holds at
    most `MAX_THINGS` (2,000, `reports/gather.ts`); above that the index says the PDF was left out
    and why.
- [ ] **HTML:** built from `reports/view.ts`'s grouping (things by place path), in the export's
  language and digits (`options.locale`, `options.digits`), `dir="rtl"` for Arabic, the Label-tape
  brand and IBM Plex referenced as system fallbacks (no font files needed), inline CSS only, user
  text escaped and bidi-isolated (`<bdi>`). One `places/<placeId>.html` per place when a place
  holds more than 500 things, so no page is huge.
- [ ] **`gather.ts`:** a paged variant that yields per place, so the readable copy has no
  2,000-thing cap; the report path keeps its cap.
- [ ] **Tests:** the index opens from disk with no network (Playwright `file://` in T25); an
  Arabic export is RTL with Eastern digits when chosen; a thing named `=HYPERLINK("x")` is
  neutralised in the CSV and escaped in the HTML; no secret value and no `<script` anywhere under
  `readable/`; a 2,500-thing location has no PDF and says why.
- [ ] **Commit:** `feat(exports): the readable copy: HTML index, safe CSVs, thumbnails and the inventory PDF`.

### Task 14: The Kept import (depends on T7, T8, T12)

**Files:** `src/imports/kept/{read.ts,plan.ts,apply.ts,job.ts,history.ts,codes.ts,secrets.ts}`;
modify `src/scan/resolve.ts` (the `kept` legacy fallback); tests `imports/kept/*.test.ts`,
`test/portability/round-trip.test.ts`

- [ ] **`read.ts`**: the manifest (format `kept-export`, version ≤ `EXPORT_VERSION`; newer → 400
  `archive_invalid` `unsupported_version` "This export is from a newer Kept; update this server
  first"), then each `data/*.ndjson` with a zod schema per entity from T12's registry (the same
  source of truth, so the writer and reader can't drift).
- [ ] **`plan.ts`**: every source id is remapped to a new UUIDv7, remembered in
  `import_source_ids (location, 'kept_zip', <old id>)`. Registries (types, fields, brands,
  vendors, people, tags, place kinds, templates) are matched by normalised name in the target
  account or created, as the CSV job's `ensureItem` does; built-in types by `builtinKey`. Money in
  a currency not enabled here → the D168 choice (enable, or keep as text in notes).
- [ ] **The dry run** reports counts, codes adopted versus re-issued (a read-only probe per code:
  "free" or "taken"), members to invite, secrets present, and history events within retention.
- [ ] **`secrets.ts`**: `POST /api/v1/imports/:id/passphrase {passphrase}` (no Idempotency-Key
  store) reads `secrets.json`'s header from the archive, derives the key, **checks it by
  decrypting** (a wrong one → 400 `passphrase_wrong`, 10 tries an hour per run), and seals it
  into `import_runs.secrets_key_ciphertext`. Without it the import runs and secrets are left out,
  and the summary says how many. The job seals each value under this server's keyring with its
  new row's AAD, then clears the column.
- [ ] **`codes.ts`** (Q9): each thing's and place's primary short ID, and blank and retired codes,
  through `kept.adopt_short_code()`; a taken code → a new short ID from `randomShortCode()` plus a
  `legacy_codes (source 'kept')` row with the old code, so the old label still opens it here.
  `insertThing` gains an option to create without allocating a code (the import only), so a code
  is never allocated and then thrown away.
- [ ] **`scan/resolve.ts`**: for `kept`, `byShortCode(code) ?? byLegacy(code, ['kept']) ?? anyLegacy(text)`.
  One line and its test; the "identical miss" property holds (a random code and another
  household's code still give byte-identical bodies).
- [ ] **`history.ts`**: after the rows, the history in batches of 5,000 through
  `kept.import_history()` (T5), ids remapped; events naming entities the import skipped are
  dropped.
- [ ] **`job.ts`**: the Homebox job's shape (chunks, savepoints, files through `ingestFile()`,
  cancel, resume, role re-check), apply order as `EXPORT_ENTITIES`.
- [ ] **`test/portability/round-trip.test.ts`** (D69: "An export → import round-trip test runs in
  CI"):
  1. Seed `households`. Export Home as Ibrahim with secrets and passphrase.
  2. Import it as a new location in Alfred's account on the same server, and in a **fresh
     database** (`startKept` on a second test database) as a new user.
  3. Compare a **canonical projection** of both locations: every exported entity with ids
     replaced by `import_source_ids` lookups and timestamps of creation ignored, file SHA-256s,
     short IDs (fresh database: identical; same server: re-issued with `kept` legacy codes),
     secrets revealed by their owners, history event count within retention, AI-call CSV rows.
  4. Scanning each old label URL on the fresh server opens the same thing.
  5. Re-running the import creates nothing.
- [ ] **Tests:** a newer-format manifest is refused; a wrong passphrase three times → the import
  still runs without secrets when asked; a Kept ZIP whose `files/` lacks an attachment's file →
  `file_missing`, listed, and the thing imports without it; a hostile Kept ZIP (a symlink) → 400.
- [ ] **Commit:** `feat(imports): Kept export import with remapped ids, adopted labels, history and secrets, and the round-trip test`.

### Task 15: Alias enrichment after an import (depends on T10; D41, D69, D206)

**Files:** `src/enrich/{routes.ts,estimate.ts,job.ts,prompt.ts}`; tests `enrich/*.test.ts`

- [ ] **Routes.** `ai.capture` in the location, `ai_capture` effective (step 3).

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/imports/:id/enrich/estimate` | → `{things, calls, tokens: {input, output}, cost?: {amount, currency}, costSource, payer: {scope, label}, provider: {kind, model}}`. The token cost shown first (D69); `cost` omitted without a price or for a viewer-gated reader. `ai_unavailable` without a provider |
  | `POST /api/v1/imports/:id/enrich` | → 202 `{jobId}`. Things of this run with no aliases in the location's languages. Audited `import.enrich` |

- [ ] *(T0, E1)* **Batches of 20 things, two aliases per language, `maxOutputTokens: 900`, and
  `reasoning: 'provider-default'` on Groq.**
  - `@ai-sdk/groq` drops `'none'` for this model. With no `reasoning_effort` sent, Groq reported
    no reasoning tokens.
  - At `low`, reasoning alone took 390–590 of the 900.
  - Groq refuses any request whose `max_tokens` exceeds the 1,000-a-minute output limit.
  - **Aliases are checked by script** in `cleanAliases`: the language's script (Latin acronyms
    allowed in Arabic), not the name, at most four words, no URL, not digits alone.
  - **Open for the maintainer:** a third of the Arabic aliases were wrong or non-words.
    Proposed: ask for one Arabic alias and show Arabic aliases for review rather than
    auto-accepting them (D19); English stays auto-accepted.
- [ ] **`job.ts`** (tenant, as `extract`): batches of the size E1 found; each call through step-3
  `callModel()` with task `enrich_aliases`: reservation, settlement, one ledger row, caps and
  pauses as for extraction (a paused cap shows "AI paused until …" on the run). The prompt sends
  names, types and the location's languages; **the model never returns ids** (L51): answers are
  by the batch's index. Aliases go through step-3 `extraction/checks.ts`'s alias limits and are
  applied where the thing has none (auto-accept, D19), audited `thing.enrich`.
- [ ] **Tests** (mock provider): the estimate equals the sum of the calls' estimates; a batch
  answer with an id or URL is dropped; a length stop fails the batch and the run continues; a
  location cap pauses it with a visible date; aliases in Arabic and English land on the right
  things.
- [ ] **Commit:** `feat(enrich): opt-in AI aliases for imported things, cost first`.

### Task 16: Safe CSVs, exporting and printing a list, the import filter (D169)

**Files:** `src/lists/things-csv.ts`; modify `src/things/routes.ts` (the CSV route and the
`importRunId` filter), `src/reports/service.ts` (a `thingIds` filter), `src/ai/calls.ts` (use
`safeCsvCell`); tests `lists/things-csv.test.ts`, `ai/calls.test.ts`

- [ ] **`GET /api/v1/things.csv?<every GET /things parameter>`** → `text/csv; charset=utf-8`, BOM
  first. Columns: short ID, name, place path, type, brand, model, serial, quantity, condition,
  tags, lifecycle, last seen, own codes, and (only where the gate shows money) purchase date,
  price, currency. Never a secret, a person's contact detail or a document. Up to 100,000 rows;
  5 an hour per person (§3.5's CSV limits); audited `things.export_csv` with the filter and row
  count. Any member can export what they can see (D169).
- [ ] **Print:** `InventoryReportBody.filters` gains `thingIds` (≤ `MAX_THINGS`), so the web's
  "Print" on a list is the inventory report of exactly that list (D201). More than 2,000 → the web
  says "Narrow the list to 2,000 things to print it" (Q26).
- [ ] **`importRunId`** (carry-over): `GET /things?importRunId=<id>` → things in that run's
  `import_source_ids` (`entity_type = 'thing'`), for the import summary's "See what was imported".
- [ ] **`ai/calls.ts`**: `csvCell` is replaced by `safeCsvCell`, which also neutralises a leading
  tab or carriage return (D169 names both; the current function checks only `= + - @`). The web
  mock's twin (`api/capture/mock/ai.ts`) follows in T22.
- [ ] **Tests:** a viewer's CSV has no money columns in an Essentials location; a cell starting
  with a tab is neutralised; the CSV of a filtered list equals the list's rows; `importRunId`
  returns the run's things only, and B's run id returns nothing; the 6th export in an hour → 429.
- [ ] **Commit:** `feat(lists): export and print the list you're looking at, safely (D169)`.

### Task 17: Consumables (D14)

**Files:** `src/consumables/{routes.ts,service.ts}`; modify step-2 `src/home/service.ts` (the
low-stock attention row); tests `consumables/*.test.ts`

- [ ] **Routes.** `config.module: 'consumables'`.

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/consumables?locationId*&state=low\|all&placeId&cursor&limit` | → `{items: [{thing: ThingRow, minQuantity, low}], next_cursor}`, low first, then by name (ICU collation) |
  | `PUT /api/v1/things/:id/stock-rule` (If-Match when it exists) | `{minQuantity}` → `StockRule`. `things.edit`; a non-consumable type → 409 `not_consumable`. Audited `thing.stock_rule`, undoable |
  | `DELETE /api/v1/things/:id/stock-rule` | → 204. Audited, undoable |
  | `GET /api/v1/things/:id/stock-rule` (added by T23) | → `StockRule`, or 404 when the thing has none (or the module is off). The thing page's "Keep at least" and the Adjust sheet read the rule's `rowVersion` here for PUT/DELETE's If-Match; `ConsumableRow` carries no versions |
  | `POST /api/v1/things/:id/adjust` (If-Match) | `{delta}` or `{quantity}` → `ThingRow`. Quantity ≥ 0 (a consumable may reach 0, D183). Audited `thing.update`, with `undo` (D150) |

- [ ] **Home:** the attention panel's `lowStock` count (screens §8 order: last), only where the
  module is on.
- [ ] **Reminders:** if step 4's engine exists, register the `stock` source (`reminder_occurrences.source_type
  = 'stock'`, product design §1.9) with its scan rule; if not, leave a `TODO(step 4)` in
  `consumables/service.ts` and a carry-over line.
- [ ] **Tests:** "keep at least 4" with 3 left is low, with 4 is not; the module off → 404 reads
  and 409 writes; Talia can read but not adjust; an adjust is undone by the toast route.
- [ ] **Commit:** `feat(consumables): keep-at-least rules, the low-stock list and adjust`.

### Task 18: Field conversion (depends on T6)

**Files:** `src/types/convert.ts`; modify `src/types/routes.ts`; tests `types/convert.test.ts`

- [ ] **Routes.** The account owner only (D177: "converting a field to or from secret is owner
  only"); others → 403 (visible type) or 404.

  | Method and path | Body → Response |
  |---|---|
  | `POST /api/v1/type-fields/:id/convert/preview` | `{toSecret: boolean} \| {kind, options?, unit?}` → `ConvertPreview` (T1). Counts only, never a value; locations the caller can't see appear as counts with no name (D123) |
  | `POST /api/v1/type-fields/:id/convert` (If-Match: the field's `rowVersion`) | same body → `{converted, toNotes}`. To-secret needs the recovery kit acknowledged (409 `recovery_kit_required`, D193) and the `secrets` module on in at least one affected location. One transaction: rows in pages of 1,000 through `kept.field_conversion_rows`, sealed or opened with the keyring (`crypto/envelope.ts`, AAD per §7.3) in memory, written by `kept.apply_field_conversion`, the last page with `p_finish`. Audited `type.field_convert` (counts only). **Not undoable** (a secret-class change, screens §8) |

- [ ] **Tests:** the preview matches the conversion's result; nothing in the response, the audit
  row or the request log holds a value; a secret made plain again restores every value; a
  conversion racing an edit (If-Match) → 412; Bruce → 403.
- [ ] **Commit:** `feat(types): convert a field to or from secret, or to another kind, with a preview`.

---

## Phase C: web (T19–T24, parallel by area; each starts on the mock)

Shared rules: build to the screens spec §6 ("Import stepper"), §5–§6 settings, and the T3 frames.
Controls follow screens §3: hidden for the role; "Off in this location" for a module; disabled
with the reason when offline ("Needs a connection"). User text is bidi-isolated. Tests use Vitest
and Testing Library against the mock: keyboard, RTL, the viewer variant, the module-off variant,
and offline. Check at 375, 768 and 1280 px, in both themes.

### Task 19: The import stepper for archives

**Files:** `components/import/{source-step.tsx,archive-step.tsx,target-step.tsx,homebox-choices.tsx,kept-choices.tsx,entity-report.tsx,enrich-offer.tsx}`,
modify `components/import/stepper.tsx`, `routes/_app/settings.import.tsx`; tests

- [ ] **Steps** (screens §6: source → collection → location mapping (new or existing) → dry-run
  choices → per-row report → progress → summary):
  1. **Source:** CSV (step 3's flow, unchanged) · Homebox export · Kept export. Homebox notes
     "Homebox v0.26 or newer: Collection settings → Export" (wording from H1's observed UI) and
     "older than v0.26: update Homebox first" (Q1).
  2. **Archive:** a file picker (`.zip`), then `POST /imports/archive` and a streamed
     `PUT …/archive` with a progress bar (`XMLHttpRequest` upload progress; fetch has none), the
     SHA-256 computed in a worker first (`crypto.subtle.digest` on chunks). Leaving the page warns
     through the app's own confirm (`useConfirm`), never `beforeunload` text of our own.
  3. **Inspect:** what the archive holds (collection name, counts, Homebox version, or the Kept
     location, its export date and whether it carries secrets).
  4. **Connect (Homebox, optional):** base URL + API key, or username + password "used once, never
     stored"; the result fills the currency and the members list. Skippable.
  5. **Target:** new location (name prefilled from the collection or the export) or, for Homebox,
     an existing location the person administers.
  6. **Choices:** currency (with the enable-or-choose explanation), archived, the type mapping (a
     `ListSurface` of Homebox types with a combobox of Kept types or "Create"), fields ("Add to the
     type" or "Keep in notes"), insured; for a Kept ZIP with secrets, the passphrase.
  7. **Report:** the summary counts, then `entity-report.tsx`: only rows with issues, grouped by
     issue code, each translated from its code and params, with Adjust · Import anyway. Members to
     invite, when known, with an Invite link.
  8. **Progress, then summary:** links to "See what was imported" (the things list with the
     `importRunId` filter, T22) and the **enrichment offer** (T15's estimate: "About 40,000 tokens
     · ≈ USD 0.03 · paid by Home" or "cost unknown"), off by default.
- [ ] **Tests:** each issue code has a translation (a test walks `IMPORT_ISSUE_CODES`); a Kept
  export can't target an existing location; a 5 GB + 1 file is refused before upload; the upload
  resumes nothing but restarts cleanly after an error; Arabic RTL; offline → "Needs a connection".
- [ ] **Commit:** `feat(web): import Homebox and Kept exports: upload, inspect, target, choices and report`.

### Task 20: Old labels: Homebox and re-issued Kept codes

**Files:** `routes/_app/{a.$assetId.tsx,item.$uuid.tsx,location.$uuid.tsx}`,
`components/legacy/{legacy-resolve.tsx,collection-picker.tsx}`; modify `offline/store.ts` and
its Dexie implementation (`byCode` falls back to `kept` legacy codes); tests

- [ ] **The three paths** (D146: "If the old Homebox hostname is pointed at Kept, those paths
  redirect too"; step 3's former hostnames already 301 the host). Each page sends
  `window.location.href` to `POST /scan/resolve` (online) or the offline store (offline) and
  renders the same outcomes as `/l/$code` (step 3 T26): open, `legacy_ambiguous` → the
  **collection picker** (location name and thing name per candidate), not in your Kept, not on
  this phone. Signed out → sign in, then back.
- [ ] **Offline store:** `byCode(code)` tries short IDs, then legacy codes with source `kept`, so a
  re-issued label opens offline too.
- [ ] **Tests:** `/a/000-001` with two candidates shows the picker and opens the chosen one;
  `/item/<uuid>` opens directly; an unknown asset → "Not in your Kept"; offline, a `kept` legacy
  code opens from the store.
- [ ] **Commit:** `feat(web): old Homebox and re-issued Kept labels open in Kept`.

### Task 21: Export UI, export my data, export first

**Files:** `routes/_app/settings.export.tsx`, `components/export/*`; modify
`routes/_app/settings.location.$id.general.tsx` (the delete sheet), the Me settings page; tests

- [ ] **Settings → Import / export → Export:** the location picker (owner and admin locations),
  options (ended, trashed, history, AI calls, readable copy, PDF), language and digits for the
  readable copy, and **Include secrets** for owners only: two passphrase fields (the app's own
  password inputs, never stored in browser storage), the rule "at least 12 characters", and the
  warning "Anyone with this file and the passphrase can read every secret in it. Kept can't
  recover a forgotten passphrase."
- [ ] **The export list** (`ListSurface`): state, size, expiry, Download (fetches `GET
  /exports/:id` for a fresh URL each time), Cancel while running; "Expired · Export again" (§5
  of the engineering spec, "Export ready / expired").
- [ ] **Me → Export my data:** starts a `me` export and shows it in the same list.
- [ ] **Delete a location** (D149): no web caller of `deleteLocation` exists on 2026-09-30 (only
  `api/locations.ts` defines it), so build the owner's sheet here: "Export first" (starts an export
  and waits for it, or skips), then type the location's name, then the 30-day grace explanation.
  Where account deletion exists (D49), the same "Export first" is offered.
- [ ] **Tests:** a member sees no Export; an admin sees no "Include secrets"; mismatched
  passphrases block the button with the message beside the field (WCAG 4.1.3); the download URL is
  fetched on click, never kept in the page; the delete sheet refuses a mistyped name.
- [ ] **Commit:** `feat(web): location and personal exports, secrets with a passphrase, export before deleting`.

### Task 22: Export and print a list; "Imported by"

**Files:** `components/filters/list-export.tsx`; modify `components/filters/registry.tsx`, the
things lists that use the filter strip, `api/capture/mock/ai.ts` (`safeCsvCell`); tests

- [ ] **"Export view" and "Print"** in the actions of every things list that uses the filter strip
  (location, place, container, search, saved views; screens §2 "Export view (D169)"): Export
  downloads `things.csv` with the list's current parameters; Print starts the inventory report
  with `thingIds` (T16) and follows step 2's report progress UI. More than 2,000 things: "Narrow
  the list to 2,000 things to print it".
- [ ] **"Imported by"**: a filter-strip filter backed by `importRunId`, labelled with the run's
  source and date.
- [ ] **Tests:** the CSV request carries exactly the strip's parameters; a viewer's Export works;
  Print is disabled above 2,000 with the reason; Arabic RTL; offline disabled.
- [ ] **Commit:** `feat(web): export or print the list you're looking at, and filter by import`.

### Task 23: Consumables UI

**Files:** `routes/_app/consumables.tsx`, `components/consumables/*`; modify the thing page
(a "Keep at least" row for consumable types) and Home's attention panel; tests

- [ ] **Consumables** (screens "Other screens": "low stock, with Adjust"): a `ListSurface` with
  Low first, a location filter, and per row the quantity, the minimum and **Adjust** (a sheet with
  −, +, and a number field that accepts ٠–٩ and ٫, D172).
- [ ] **Thing page:** "Keep at least N" for consumable types, editable by members and above.
- [ ] **Home:** the "low stock" attention row, last in the fixed order, hidden at zero.
- [ ] **Tests:** module off → "Things you run out of is off in this location"; a viewer sees no
  Adjust; Adjust shows the undo toast; Eastern digits parse.
- [ ] **Commit:** `feat(web): consumables: keep at least, the low-stock list and adjust`.

### Task 24: The type editor's conversions

**Files:** `components/registries/convert-field-sheet.tsx`; modify
`components/registries/type-editor.tsx`; tests

- [ ] In the field list (screens "Type editor"), for the account owner only: **Make secret** /
  **Make plain** on a text field, and **Change kind** on convertible kinds (T1's `CONVERSIONS`).
  The sheet shows the preview per location ("Home: 12 values move · Garage: 3 go to notes"), the
  warning for to-secret ("Past history keeps that the value changed, but no longer the value.
  Exports made before now still hold it."), and needs the field's name typed to confirm.
- [ ] **Tests:** hidden for admins who aren't the owner; the preview's counts render; the
  recovery-kit 409 opens the kit step (step 3's flow); RTL.
- [ ] **Commit:** `feat(web): convert a field to or from secret, or to another kind, with a preview`.

---

## Phase D: finish

### Task 25: i18n, e2e, the round trip in CI, leak, perf, docs

**Files:** `apps/web/src/locales/{en,ar,fr,de,it}/messages.po`; `apps/web/e2e/step7.spec.ts`;
`apps/server/test/perf/portability.perf.test.ts`; `scripts/ci-local.sh`; `README.md`;
`docs/runbooks/move-to-a-new-server.md`, `docs/runbooks/read-an-export.md`;
`docs/plans/step-7-carryover.md`; product design §19 (V25); engineering spec §1.10 (`export_runs`,
`import_runs`, `import_source_ids`, `legacy_codes` source `kept`), §3.1b (the archive upload cap),
§7.3 (the passphrase envelope), §7.15 (`enrich_aliases`)

- [ ] **i18n:** extract once (a temporary worktree at HEAD plus the step-7 files, per the agent
  rules) and translate every new string into all five catalogues, Arabic in the house style; the
  catalogue gate passes.
- [ ] **Playwright** (Chromium, the `households` seed, `KEPT_AI_MOCK=1`, 375×780 and 1280×800):
  1. **Homebox:** Ibrahim imports the first fixture ZIP into a new location "Homebox (old)": upload,
     inspect, skip connect, choices, the report shows the refused `.docx`, run, summary; "See what
     was imported" lists the things; the enrichment offer shows a cost and runs on the mock.
  2. **Old labels:** a fake camera QR of `https://homebox.example/a/000-001` in Scan opens the
     thing; after importing the second fixture into Garage, it asks which.
  3. **Round trip through the UI:** export Home with secrets; download; import it as Alfred in a
     second browser context as a new location; a revealed secret matches after the passphrase.
  4. **Readable copy:** unzip the download in the test and open `readable/index.html` over
     `file://` with the network blocked: places, things and thumbnails render; Arabic export is RTL.
  5. **List export:** a filtered Garage list → CSV rows equal the visible rows.
  6. **Consumables:** Adjust a battery pack to below its minimum → the Home row appears; undo.
  7. **Conversion:** Alfred makes "Door code" secret; its value is gone from search.
  8. **Viewer:** Talia sees no Import, Export, Adjust or conversion.
  9. axe on every page visited.
- [ ] **CI** (`scripts/ci-local.sh`): a `portability` step runs
  `test/portability/round-trip.test.ts` and the zip hostile-fixture suite; `licences` passes with
  yauzl and yazl.
- [ ] **Leak:** `leak-portability.ts` fixtures; export, import, consumables and conversion cases
  with A and B from `fillTenant()` (B's run id, export id, stock rule and field id each 404, and a
  byte search of A's export for B's names finds nothing).
- [ ] **Perf** (`test/perf`, full mode): export of 10,000 things with 2 GB of files; Homebox and
  Kept imports of 10,000 entities; RSS during each under the 2 GB floor's budget
  (`--max-old-space-size=512`). Record in `docs/perf/2026-xx-step7.md`. The real 2 GB VM run stays
  due before 1.0 (V5, D209).
- [ ] **Docs:**
  - runbook "Move Kept to a new server with an export" (export each location with secrets, new
    server, import, point the old hostname at it with former hostnames, check labels);
  - runbook "Read an export without Kept" (unzip, open `readable/index.html`, the CSVs in a
    spreadsheet);
  - README: exports and imports in one paragraph each;
  - §19: V25 re-checked (T0's result);
  - `docs/plans/step-7-carryover.md`.
- [ ] **Gate:** `bash scripts/ci-local.sh` exits 0. **Commit:**
  `chore: step-7 i18n, e2e, round trip in CI, leak and perf checks, docs`.

---

## Needs the maintainer's devices (and data), and how the build proceeds without them

Each item has a fallback that ships anyway. The checklist is `docs/spikes/2026-xx-step7-devices.md`
(T0).

| # | Check | Built meanwhile | If it fails |
|---|---|---|---|
| — | **A real Homebox export**, if the maintainer runs Homebox: the dry run and import on real data, and his printed Homebox labels scanned in Kept | The H1 fixtures, made from a local Homebox with synthetic data | Issues found become fixture cases and mapping fixes; nothing waits |
| V25 | Homebox's latest stable release still matches D146 when T9 starts (v0.27.0-rc.1 exists on 2026-09-30) | The T0 diff | A changed table or field is a schema version branch in `format.ts` |
| — | iPhone Safari downloads a 1 GB export ZIP into Files, and picks a `.zip` from Files in the import stepper | Desktop is the primary path for exports and imports | Help says "Export and import from a computer"; the phone path stays |
| — | `readable/index.html` opens from Files on an iPhone with its thumbnails (relative links inside an unzipped folder) | `inventory.pdf` in the same folder opens anywhere | Help points iPhone readers to the PDF |
| — | Excel (Windows and Mac), Numbers and LibreOffice open the CSVs with Arabic intact and no formula evaluated | UTF-8 with BOM, CRLF, neutralised cells (T1) | Add a "for Excel" UTF-16 variant only if the BOM isn't enough |
| E1 | The alias batch size on the maintainer's Groq tier (V36: 1,000 output tokens a minute on the development tier) | The mock in CI; the E1 batch size | Smaller batches; enrichment stays opt-in with its estimate |
| V5 | Export and import at 10,000 things on a real 2 GB, 2-vCPU VM (D209) | The laptop under `--max-old-space-size=512` and the slower-core proxy | Lower chunk sizes and file concurrency; record it |

The build **never waits** for a device result.

---

## Definition of done for step 7

- `bash scripts/ci-local.sh` exits 0, including `drift`, `licences`, `perf`, `e2e`, and the new
  `portability` step (the round trip and the hostile archives).
- The leak test covers every new table and function; `export_runs` and `import_runs` expose
  nothing across tenants or to a demoted creator; a byte search of an export finds nothing of
  another tenant.
- Every non-GET route writes an audit row or is allowlisted with a reason; no passphrase, key,
  password or secret value appears in an audit row, a log line, `idempotency_keys` or pg-boss job
  data (a test reads each).
- The export registry names every location-scoped table, exported or left out with a reason.
- On a fresh `docker compose up`, seeded with `households`:
  - Ibrahim exports Home with secrets, downloads it, and reads `readable/index.html` and the CSVs
    with no network and no Kept;
  - Alfred imports that ZIP into a new location on another fresh instance: things, places, files,
    labels, history and (with the passphrase) secrets are there, and Home's printed labels open
    the imported things;
  - a Homebox v0.26 export imports with a dry run that explains every lossy mapping, and its old
    labels (`/a/…`, `/item/…`, `/location/…`) open the imported things, asking which collection
    when an asset ID repeats;
  - a re-run of either import creates nothing;
  - a hostile archive is refused with a reason and nothing stored;
  - Louis exports the Garage list as a CSV that opens safely in a spreadsheet, and prints it;
  - a consumable below its minimum shows on Home and in Consumables, and Adjust fixes it;
  - Alfred converts a field to secret and back without losing a value.
- The device checklist is filled in, or each open row names the fallback in use. §19 is updated
  for V25. `docs/plans/step-7-carryover.md` lists anything deferred, each with the step that takes
  it.

---

## Spec questions that are genuinely ambiguous, with proposed answers (adopt these)

1. **The Homebox API path.** D146 makes the ZIP primary and the API "the full path for servers
   older than v0.26"; the master plan's scope advice lists that path for 1.x, keeping the ZIP.
   D130's 1.x list still says "the Homebox ZIP fallback", written before D146 swapped the order.
   **Proposal:** step 7 builds the ZIP path plus the optional connection (T11) for the version,
   currency and members; the full pre-v0.26 API import moves to 1.x. Update D130's line to "the
   Homebox API import for servers older than v0.26". **Decided 2026-09-30: adopted; D130 and §17
   updated.**
2. **Re-runs across the two Homebox paths.** `import_source_ids.source` has `homebox_zip` and
   `homebox_api`, so the same entity imported both ways would be made twice, against D146's
   "idempotent on the Homebox entity UUID". **Proposal:** add `homebox` and write it from both
   paths; `import_runs.source` keeps which path ran.
3. **Currency for a ZIP import.** The ZIP has no group row, so no currency (research). **Proposal:**
   a dry-run choice, prefilled from the connection when given, else the target location's currency.
   "Choose one of the enabled" relabels amounts without converting them, and the dry run says so
   (Homebox's default is `usd`, which many collections never changed).
4. **The collection of an asset ID** when the ZIP rows carry no group id. **Proposal:** use the id
   H1 finds in the rows; failing that, the run's id. Ambiguity is still resolved by asking,
   because each collection lands in its own location.
5. **What a Kept export is.** D69 says "full-fidelity JSON"; step 3 already has a raw per-table
   dump (`kept admin export`). **Proposal:** the Kept export is API-shaped, versioned
   (`kept-export` v1) and per location, so it survives schema changes and imports into another
   account; the raw dump stays the operator's backup tool.
6. **`export_runs.file_id` (§1.10) against §7.2** ("Export ZIPs carry `location_id` and aren't
   `files` rows"). **Proposal:** follow §7.2 (§7 wins): the ZIP is the blob `x/<runId>.zip`, and
   the table records its bytes and SHA-256.
7. **The passphrase and an asynchronous job.** The job can't be given the passphrase: pg-boss
   stores `data` in plain text. **Proposal:** derive the key in the request (scrypt, parameters
   from P1) and store it sealed under the keyring on the run, cleared when the run ends; minimum
   12 characters, no composition rules; wrong-passphrase tries limited to 10 an hour per run.
8. **Where a Kept ZIP lands.** **Proposal:** always a new location. Merging an export into a live
   location has no safe conflict rule; a Homebox import may target an existing location, as CSV
   does.
9. **Short IDs on a Kept import** (labels are permanent, D45; codes are instance-unique, D120).
   **Proposal:** adopt each code when it is free on this server (moving servers keeps every label
   working); when taken (the same server, or a one-in-a-billion clash), issue a new code and keep
   the old one as a `kept` legacy code that the scanner and the phone resolve. The adopt door
   reveals only that a code is in use somewhere, never where; accepted, like §7.4's side channel.
10. **History on import, and the `import` actor type** (step-3 Q18 left it to step 7).
    **Proposal:** a Kept import carries the exported history as `actor_type = 'import'` events
    (actor = the run), original actor names shown as "Alfred (before the import)", only within the
    2-year retention, with partitions created before insert so nothing lands in the default
    partition. Homebox has no history to carry.
11. **Who is the actor of imported rows.** **Proposal:** the importing person, as CSV does
    (`created_via = 'import'`, one `import.run` event per chunk). The `import` actor is only for
    carried history.
12. **The readable copy's format.** D69 says "CSV/Markdown"; D159, later, says "an HTML index,
    CSVs, thumbnails and receipts". **Proposal:** HTML and CSV, no Markdown, plus the inventory
    PDF (the step-2 engine) up to 2,000 things. CSVs are UTF-8 with a BOM so Excel reads Arabic.
13. **D169's tab and carriage return.** `ai/calls.ts` `csvCell` neutralises only `= + - @`.
    **Proposal:** one `safeCsvCell` in `@kept/shared` with all six triggers, used by every CSV
    writer, the AI calls CSV included (T16).
14. **"Export my data"** (screens, Settings → Me). **Proposal:** the Personal location's export,
    plus `me.json` (profile, preferences, hints, saved views) and the person's own AI calls.
    Locations they own are exported from Location settings.
15. **Homebox files outside Kept's allow-list** (a `.docx` manual; `storage/sniff.ts` allows photos
    and PDF). **Proposal:** not imported, listed by title and type in the dry run and the summary;
    the allow-list isn't widened.
16. **Homebox custom fields** are per item; Kept's are per type. **Proposal:** per Homebox type,
    match fields by normalised label and compatible kind; otherwise "Add to the type" (the
    default; a built-in is first copied into the account) or "Keep in notes".
17. **Export limits and expiry.** **Proposal:** 5 an hour per person, one running per location,
    kept 7 days after ready (§3.3), purged hourly.
18. **Uploading an import archive.** **Proposal:** one streamed PUT of up to 5 GB (the §3.1b
    uncompressed cap, reused for the compressed file) into the BlobStore, read by range; no
    resumable upload in step 7. Abandoned runs and their archives are pruned after 7 days. The
    runbook notes a reverse proxy's own body limit.
19. **When a consumable is "low".** **Proposal:** quantity below "keep at least N" (so N left is
    fine). Low-stock reminders wait for step 4's engine.
20. **Secret conversion scope.** Types are per account; D177 says conversion is "owner-only, per
    location". **Proposal:** the account owner converts the field for every location that uses the
    type (they own them all), with the preview per location; past diffs are scrubbed; exports
    already made are not reachable and the sheet says so. Not undoable.
21. **Alias enrichment's task and budget.** **Proposal:** ledger task `enrich_aliases`, counted
    against the extraction budget and caps, batch size from E1, opt-in after each import.
22. **People's contact details in an export** (D177). **Proposal:** included only when
    `kept.person_contact_visible()` is true for the exporter.
23. **Members in a Kept export.** **Proposal:** names and roles only, listed as "people to invite"
    on import; no emails.
24. **Tables steps 4–6 add.** **Proposal:** the export registry test fails until each is exported
    or left out with a reason, so step 7 can't silently miss them.
25. **Homebox `insured`.** D146 is silent; the research proposes a yes/no field. **Proposal:** add
    an "Insured" yes/no field to the mapped type only when some item is insured, as a dry-run
    choice (default on).
26. **Printing a list** (D169 "or print it") with a report capped at 2,000 things. **Proposal:**
    print is the inventory report of the list's thing ids; above 2,000 the web asks to narrow it.
27. **The size of an archive dry run's report.** CSV stores every row. **Proposal:** archive
    imports store the summary and only the rows with issues, so a 10,000-entity report stays small.

**Decided while building T14 (the Kept import), 2026-10-07:**

28. **How rows are written.** The export registry names one table per entity, so the importer
    writes every entity with one registry-driven insert, as the importing person under row-level
    security and every check and guard (`ON CONFLICT DO NOTHING`), not through each service: a
    service's side effects (a default odometer, a fresh short ID, an audit row per thing) would
    duplicate what the export carries. `created_by` (and `logged_by`, `checked_by`) is the
    importer and `created_via` is `import` (Q11). Rows apply in dependency order
    (`imports/kept/apply.ts` APPLY_ORDER), not EXPORT_ENTITIES' write order, which would insert
    things before their types; self-referencing rows (places, things, types, documents) are
    sorted parent first. A reference to a row the export doesn't hold becomes null (a thing whose
    container is gone goes to Unplaced); a non-null one leaves its row out, reported.
29. **The new ids.** Each is a UUIDv7 derived from the run and the old id (the old id's time
    bits, an HMAC of it keyed by the run for the rest), so a resumed chunk meets its own rows
    with no lookup table, and two imports of one export never share an id. import_source_ids
    still records what each id became where its `entity_type` list names the entity; steps 4–6
    entities beyond that list (loans, incidents, claims, …) are not recorded there.
30. **Labels on import (Q9, details).** A taken printed code: its thing or place gets a new
    primary code and the old one is a `kept` legacy code; a taken blank or retired code is
    dropped (a retired label opened nothing there). The dry run's free-or-taken probe tries the
    codes as retired rows of the target inside a savepoint it rolls back: the same side channel
    the adopt door has, no new door.
31. **Left out on import.** `own_code_counters` (only kept.next_own_code() moves it, and it skips
    numbers already taken); the AI call ledger (an export carries it as `ai-calls.csv` only);
    history diff entries whose money the exporter couldn't see. Money in a currency this server
    hasn't enabled is imported as it is (the currencies table holds every code); the dry run
    doesn't ask (D168's choice stays with the instance admin's currency settings).

---

### Critical files for implementation
- apps/server/src/imports/ (`dry-run.ts` `planRow()` and `Lookups`, `job.ts` chunking, savepoints,
  cancel and resume, `routes.ts`, `csv.ts` `legacyCodeOf()` and `rowHash()`): the pattern both
  archive importers copy
- apps/server/src/backup/ (`export.ts`, `manifest.ts`, `restore.ts`): the raw escape hatch, its
  manifest and SHA-256 checks, and what it deliberately leaves out
- apps/server/src/storage/blob-store.ts (id-built keys, `stream(key, range)`), storage/sniff.ts,
  storage/derivatives.ts, files/upload.ts (`receive()`, the upload steps `ingestFile()` extracts),
  files/pdf-text.ts
- apps/server/src/reports/ (`service.ts` run/job/signed-URL/purge shape, `gather.ts`
  `MAX_THINGS`, `view.ts` grouping) and migrations/0032_report_runs.sql (the policy shape
  `export_runs` copies)
- apps/server/src/scan/resolve.ts and packages/shared/src/scan.ts (`homeboxAssetId()`, the legacy
  lookups), apps/server/migrations/0035–0036 and 0046 (`legacy_codes`), 0037–0038 (`import_runs`,
  `import_source_ids`), 0005 (`audit_events` partitions and the default partition), 0024
  (`guard_field_secret`)
- apps/server/src/secrets/ (`service.ts` crypto paths, `rotate.ts` `CIPHERTEXTS`, `routes.ts`'s
  reason for skipping the Idempotency-Key store), crypto/envelope.ts
- apps/server/src/ai/calls.ts (`csvCell`, the CSV route shape), ai/call.ts `callModel()`,
  net/ssrf.ts `guardedFetch`
- docs/research/2026-09-26-homebox-import-research.md and product design D146: the only source
  for Homebox formats; anything they don't state is a T0 spike, never a guess
