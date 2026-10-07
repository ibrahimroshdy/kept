# Step 2 carry-over

Work left open at the end of step 2, and the server backlog closed after it, with where each
piece lands.

## Server backlog after fix passes A and B

Found by the fix passes and while wiring the web to the real server. Each item is closed by the
commit named.

- [x] **Locations answered `thingCount: 0`** (`locations/views.ts`). *Done (684ba1a): each location
  row counts its live things (trash left out) under the caller's policies, one correlated count
  on `things_location_id_uq`, for `GET /locations` and `GET /locations/:id`.*
- [x] **Search rows lacked `isContainer`.** *Done (684ba1a): one SQL rule, `isContainerSql()` in
  `search/query.ts` (a container type, or anything live inside), shared by search rows, thing
  rows and place contents.*
- [x] **Money came out in two forms** (the thing's purchase `unitPrice` `"150.0000"`,
  `/purchases/:id` `"150"`). *Done (ef55d3c): `canonicalAmount()` and `canonicalMoney()` in
  `packages/shared/src/money.ts`. Every amount leaves in `parseAmount()`'s form: purchases, the
  thing's end price and purchase unit price, custom money values (things and places), money in
  rendered audit diffs. Amounts sent in are stored canonical: a thing's purchase and end price,
  and custom money through `customSchema()`. Existing rows are not rewritten; output normalises
  them.*
- [x] **Writes didn't return their audit event id.** *Done (d46f76b, f195ce6): `X-Kept-Audit-Event` on
  every write that recorded an undoable change (`http/write.ts`, `AUDIT_EVENT_HEADER`); one id
  per changed thing, comma-separated, for a bulk move; absent otherwise; replayed with an
  Idempotency-Key. Engineering spec §7.7.*
- [x] **`PlaceKindNode` couldn't tell a built-in from the account's copy.** *Done (8e3b850):
  `ownerAccountId`, null for a built-in.*
- [x] **`thing.lifecycle` history `summaryParams` were English.** *Done (7d6a195):
  `summaryParams.lifecycle` is the stored code (`given_away`), left out when the row shows no
  lifecycle change.*
- [x] **`kept.thing_receipts()` returned no file metadata** (migration 0033). *Done (9d3cf66): it returns
  the file's sha256, bytes, mime, class, GPS flag, dimensions, derivative state and its thumb and
  display keys, so a receipt reached after a move (the purchase stayed where the caller can't
  see) gets the full view with signed previews. Originals stay behind
  `kept.thing_receipt_file()` (members and above, D117).*
- [x] **Moves didn't take blob locks before copying files.** *Done (9d3cf66): `things/move.ts` takes
  `lockBlobKeys()` on the originals and derivatives of the moved things' (and their readings')
  attachments before `kept.move_things()` on every move that leaves its location (the definer
  copies file rows then, D161), and, across accounts, on the receipts `copy_purchase_line()`
  copies (keys from `kept.thing_receipts()` and `kept.thing_receipt_file()`).*
- [x] **`scripts/check-no-local-paths.mjs` failed `biome check .`.** *Done (9168374).*
- [x] **Dev database at HEAD.** *Done: migrated through 0033.*
- [x] **`bench/_explain.mts`** broke the typecheck (TS5097). *Gone: the perf work removed its
  scratch file; `apps/server/bench/` holds only `rls.bench.ts`.*

## After the RLS benchmark (task 24, docs/perf/2026-09-26-rls-bench.md)

All 76 path × actor figures are inside budget on the constrained gate pass (80eb297). Open:

- [ ] **Profile a 200-thing move on the 2 GB floor** (a 2 GB, 2-vCPU VM, D209) with the V5 run
  before 1.0. On the slower-core proxy it takes 0.7–1 s at p50, the tightest path; whether the
  proxy matches the floor is inferred, not measured.
- [ ] **A bulk-tag route.** Step 2 has none, so tagging 20 things is 20 PATCHes (495 / 780 ms on
  the gate pass). Decide in step 3 alongside the multi-select actions.
- [ ] **Home's counts at 50,000 things.** The global lists and Home's counts scan every visible
  thing (5–30 ms now, linear in size); keep per-location counts if Home passes its budget.
- [ ] **Declare `things_trash_batch_idx` and `places_trash_batch_idx` in the Drizzle schema.**
  They live in 0030's custom SQL because its snapshot was already committed; the migration
  header says how to move them.
- [x] **The leakproof rule** is in engineering spec §7.2.

## For the web (API changes above)

- `LocationView.thingCount` is real now.
- `ThingRow` in search results has `isContainer`.
- Every money string is canonical (`"150"`, `"1250.5"`); comparing or displaying needs no
  trimming.
- `X-Kept-Audit-Event` carries the id for the Undo toast (split on `", "` for a bulk move).
- `PlaceKindNode.ownerAccountId` (null: built-in).
- `summaryParams.lifecycle` is a code: localise it with the lifecycle words instead of reading
  the diff; it may be missing.
- A receipt after a move has `file.sha256`, `class`, dimensions and `thumbUrl` / `displayUrl`.
