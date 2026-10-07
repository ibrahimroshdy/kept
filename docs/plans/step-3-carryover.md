# Step 3 carry-over

Work left open in build step 3, with where each piece lands.

## The first UI audit (T31b, docs/audits/ui-2026-09-29.md)

Every high and medium finding is fixed. The lows, by the audit's numbers, were carried to the next
pass over the web; all eleven are done, most in the phone pass of 2026-09-30 (below the list).

- [x] **L1 Tabs wrap at 375 px.** Settings (Me · Locations · Account · AI · Import · Admin) and AI
  usage's scopes drop onto a second row. A horizontally scrolling tab strip keeps one row; nothing
  may be cut with ….
  **Done: 0339b7b, 8b44e45.** Every tab strip (LinkTabs: Settings, Admin, Account, a location's
  settings; AI usage's scopes; the React Aria tab list; a thing's section chips, where History sat
  alone) keeps one row that scrolls sideways, the current tab scrolled into view. AI usage's
  Period, which wrapped inside its segments, takes two columns on a phone.
- [x] **L2 The model ID breaks mid-token** in "Measured by Kept … · qwen/qwen3.8-27b" on AI settings
  at 375 px. Keep the ID whole (`white-space: nowrap` on the mono span) and let the line wrap
  before it.
  **Done: d174a15** (the `model-id` inline block in AI settings), and **e12c39c** for AI usage's
  Model chart and tables, the last places an ID still broke.
- [x] **L3 Import's "Step 1 of 5" is in Plex Mono.** D132 keeps mono for codes; use the sans small
  size, as the setup frame's steps do.
  **Done: 60feb45**, in Import, Two-factor and New location.
- [x] **L4 Templates' empty state** puts "New template" under the dashed card; the other empty
  states hold their action inside it. **Done: 263a6e7.**
- [x] **L5 A container's "Select"** sits alone on a row between "Add a thing" and the filter strip.
  Put it on the Contents heading's row.
  **Done: 128585b**, on the location, place and container pages alike. It sits at the end of the
  search box's row, since the location and place pages have no Contents heading.
- [x] **L6 Inbox at 1280:** the filter strip wraps in the 384 px list column (Views drops a row), and
  the review pane says "Choose an item to review it here." while nothing waits.
  **Done: 7701f31.** The search box takes its own row in that column, and the pane shows only while
  something waits.
- [x] **L7 Inbox at 375:** an item's actions wrap "Discard" alone onto a row; the meta line runs the
  type and the place together with no separator. **Done: 2579aee** (Accept, Edit and More).
- [x] **L8 Text fields are 40 px tall** where the kit's `.input` is 44, and an `<input>` can't take
  the `::after` touch area the audit added to controls (fd2bb64).
  **Done: d2779eb.** The last two, the type tree's search and New location's room rows, are 44.
- [x] **L9 A created thing's history row lists its defaults** ("Review → Confirmed", "Not sure where
  → no", "Status → In use"). Leave out, on create, the values every new thing starts with.
  **Done: dd15341** (the web leaves them out of a create row, so existing rows read right too).
- [x] **L10 `/l/<code>` adds `?view=photos`** for a thing that isn't a container; only a scanned box
  opens on its photo grid (D195). **Done: 05c6a63**, in the scanner too.
- [x] **L11 The phone's Filters · Views · Display row is at its limit in Arabic.** Add a filter-strip
  test at 375 px in all five languages, for every list's longest sort word, so a new list can't
  wrap it again.
  **Done: d8e38f1**, in `e2e/audit.spec.ts` (phone project), with the location list's longest
  Display words (Last seen or Changed, by type). jsdom has no layout, so this is an e2e test.

**The phone pass (2026-09-30)** checked every route at 375 and 390 px, light, dark and Arabic, in
Chromium with iPhone emulation, after the maintainer's iPhone report. Besides the lows above it
fixed: a date or an approximate cost splitting across lines (72c4d3d), What uses AI's lines starting
with "·" (ec51ff7), the saved key's card (840c6ee), Admin → Users' Disable alone on a row (ba570e4),
a price's Stop pricing alone on a row (9f02d95), a date field's Western digits in Arabic (f782bef),
"Places · 5" in Western digits in Arabic (cbc26eb), the Arabic Search placeholder clipped at 375
(4c067bc, c34cf84), and running text leaving one word on its last line (ea941e3). Before and after
screenshots are session working files, not in the repo.

## The step-3 build (T32: from the task notes, the e2e run and the leak test)

Each item names the step that takes it (T32's proposal; the maintainer decides). "Found in T32"
items were seen in the e2e run on 2026-09-29; the others were recorded open by the task named, and
checked against the code where it says so.

### Before step 3 is declared done (T32 part B and the device checklist)

- [ ] **Run the full gate on a quiet machine:** `bash scripts/ci-local.sh` (every step, including
  `catalogues`, `eval`, `perf`, `e2e`). Part A ran only `catalogues`, `eval`, `prod-boot`, the
  leak and route-catalogue tests, and `step3.spec.ts`/`step3-update.spec.ts` alone.
  **Part B (2026-09-30, at 2f3f47a):** every step passes except `prod-boot`, which could not
  start: port 8080 is held by an orphaned `prod-boot` server from an earlier run (pid 23321,
  started 2026-09-29 21:01) that the session wasn't permitted to stop. **Left:** stop it, then
  `bash scripts/ci-local.sh --from prod-boot`. Record and fixes: [step-3-done.md](step-3-done.md).
- [x] **Perf numbers:** ci-local's `perf` step (the snapshot bench at 10,000 things, and
  `test/perf`: a 50-op sync batch and the inbox at 500 open items). Record them in
  `docs/perf/`, and set `test/perf/step3.perf.test.ts`'s provisional limits (2 s and 300 ms) from
  them. Under load 20 on 2026-09-29 the batch p95 was 790 ms and the inbox page p95 26 ms: not
  evidence. Also re-measure T12's snapshot (726 ms in-process under load 40–86), T18's CSV import
  (about 10 queries a row, 34 s a 200-row chunk under load) and `things/move.test`'s "200 things
  < 1 s" (2.1 s under load).
  **Done in T32 part B:** [docs/perf/2026-09-30-step3.md](../perf/2026-09-30-step3.md). The
  snapshot meets 600 ms on the laptop and 2 s on the 1-CPU gate pass, and **misses 2 s on the
  slower-core proxy** (p95 2.0–2.7 s): the V5 run on a real 2 GB VM decides it, **before 1.0**.
  The limits are now 1.5 s (batch p95), 100 ms (inbox p95) and 10 s (a 200-row import chunk,
  about 65 rows a second, a new case); the 200-thing move takes about 0.33 s with its setup.
- [ ] **The device checklist** (`docs/spikes/2026-09-26-step3-devices.md`), then the §19 rows.

### Found in T32 (step 3's finish, or step 4's first web pass)

- [x] **A cold start offline doesn't open the app.** Reloading, or reopening the installed app,
  while offline showed "Couldn't load this · Needs a connection": the signed-in frame
  (`routes/_app.tsx`, `lib/signed-in-gate.ts`) needs `/api/v1/me` and `/api/v1/setup`, and
  nothing kept them for offline. **Fixed in step 3:** the frame keeps a last-known `/me` (no
  email) and locations in the person's own database (`offline/shell.ts`, the `shell` meta row,
  never the Cache API: D181); with no network the gate starts from it and the screens say "as of
  last sync"; a 401 clears it with the cache (D210), so a locked phone still needs a connection.
  App lock (D159, D181) isn't built yet; when it is, it guards this copy with the rest. The e2e
  test "a cold reload while offline…" passes, and goes on to a 401 that locks.
- [x] **Offline, the Search screen doesn't search the phone.** Its Things group stayed "Loading"
  (`components/search/results.tsx` asked only the server). **Fixed in step 3:** offline, or when
  the server can't be reached, the Things group answers from `store.search()`
  (`components/search/offline-results.tsx`): names, aliases, short IDs, legacy and own codes,
  Arabic folding, queued captures as "ID pending", each with its path, under "On this phone · as
  of last sync". It applies the location and type filters and says the others wait for a
  connection; documents keep "Documents need a connection". The e2e finds a queued capture in the
  offline flow and a synced thing by name and by short ID.
- [ ] **Offline, a thing or place page doesn't open from the phone.** A search result's link goes
  to `/t/<id>`, which (like `routes/_app/p.$id.tsx`) reads only the server, so offline it needs a
  connection unless it was open before; the result row itself says where the thing is (inferred
  from the routes, which have no offline path; not run). **Step 4.**
- [x] **The running mock can't give a `$` receipt.** `KEPT_AI_MOCK=1` looks answers up by the
  image's SHA-256, but `test/fixtures/eval/mock-answers.json` is keyed by case id (the eval
  harness maps them itself), so a running server only ever gave each mode's default answer (an
  EGP receipt). **Fixed in step 3:** `startKept` takes `aiMockAnswersFile` (the existing
  `createAiDeps` `mockAnswersFile`), and `e2e/serve.mjs` writes one from
  `e2e/fixtures/mock-answers.json` (keyed by fixture file), each re-keyed to the hash of the
  image the server sends (`reencode` of the fixture, as for a receipt). The e2e picks
  `receipt-usd.jpg` (made by `make-receipt.mjs`) from the Gallery in Receipt mode: "Needs a
  currency" offers USD and CAD with neither chosen, USD is picked, and the review creates the two
  things. The run found that the review didn't take the answer (fixed: the review fills an unset
  currency and amounts from the purchase).
- [x] **The "Needs a currency" item has no shop, total or photo on a real server:** its title was
  "Receipt", because `inbox/view.ts` filled `receipt` only for `kind = 'receipt'` (the web mock
  gives the currency item one, so the component tests didn't see it). Found in the step-3 e2e.
  **Fixed in step 3 (T32 part B):** a currency item carries its purchase's summary too, the shop
  from the extraction's read, the total and pages behind the money gate
  (`inbox.test.ts` "gives the currency question the receipt's shop, total and pages…").
- [ ] **A toast leaves a dangling live-region node for a few seconds:** React Aria's announcer
  keeps `<div role="img" aria-labelledby>` pointing at the closed toast, so axe right after a
  toast reports `role-img-alt` (serious). Found in the step-3 e2e (the receipt flow runs axe
  before its toasts). **Step 4's UI pass.**
- [x] **A Gallery file taken in Receipt mode arrived as a Thing draft** once in exploration (the
  mode strip showed Receipt). **Reproduced and fixed in step 3:** not a race and not
  `fileClassFor`; the capture screen's `takeFiles` forced every Gallery pick to THING (D140's
  "each becomes a THING draft"), whatever the strip said, so a saved receipt picked in Receipt
  mode (iPhone's only way in, V9) became a Thing draft. Gallery now follows the mode strip: THING
  drafts in Thing mode as D140 says, receipts in Receipt mode; a PDF is a receipt in any mode.
  Tests: `capture-screen.test.tsx` (fails on the old code), `enqueue.test.ts`, and the e2e
  "Gallery in Receipt mode…". D140's wording could say so (the maintainer's call).
- [x] **Alfred's profile language is `ar-EG`, but a fresh sign-in showed English** (`html
  lang="en"`); the e2e sets `kept.locale` itself. **Answered in step 3: this is what D204 says.**
  D204 puts the interface language in Settings → Me → Display, and screens §"Settings" makes
  Display "device preferences kept per device and applied before first paint"; nothing in D204
  applies the profile's language at sign-in. The web picks the stored `kept.locale`, else the
  browser's language if it is one of the five, else English (`lib/prefs.ts` `initialLocale`,
  `main.tsx`), and never reads `profile.locale`. The profile's locale is the Accept-Language at
  sign-up (the seed sends Alfred's as `ar-EG`) and is the language of the person's mail
  (`kept.mail_locale()`). The e2e browser is `en-GB`, so English is right. Making a new device
  start in the profile's language would be a new decision (the maintainer's), not a fix.
- [ ] **Small wording:** a queued label claim counts as "Offline: 1 capture waiting"; the capture
  screen's live region keeps "Captured. N waiting to sync" after the queue has synced. **Step 4's
  UI pass.**

### Web

- [ ] **The phone's suggest-location preference** lives on the device: `user_profiles.
  suggest_location` exists but no route reads or writes it (checked: only the schema names it).
  Add it to `/me`. **Step 4.**
  Server half done in step 4 (T19): `/me`'s profile carries `suggestLocation` and
  `PATCH /api/v1/me {suggestLocation}` sets it (audited `me.preferences`). Left: Settings → Me
  reads and writes it, and `Me.profile` in `apps/web/src/api/types.ts` gains the field (T28).
- [ ] **READING has no typed value:** a photo and a note only, so nothing queues `log_reading`
  (T25, T14). **Step 5 (vehicles and meters).**
- [ ] **Multi-item drafts (split, `s`)** are 1.x (D20, D130); the key is in the map, unhandled.
- [ ] **The scanner's slow setting** (`SLOW_PHONE`, 4 fps and 640 px, `camera/scanner.ts`) is
  exported but used nowhere: wire it after the V12 device result. **Step 3's device pass.**
- [ ] **AI usage:** the `ai-calls` saved-view surface, the history filter strip, and an instance
  cap's per-account override picker (the admin has no accounts list) (T29a). **Step 4.**
  Server half done in step 4 (T19): saved views on the `ai-calls` surface (their `at` date
  checked like `when`), and `GET /api/v1/admin/accounts?q&limit` → `{items: [{id, ownerName,
  locations}]}` for instance admins. Left: the web's saved views, history filter strip and
  override picker (T28).
- [x] **`PROVIDER_TERMS` is empty** (`components/ai/data-use-note.tsx`): each provider's data-use
  summary must be read from its own policy first. **Before 1.0.** **Done 2026-10-07 (step 8
  T27, 394349c):** OpenAI, Anthropic, Google, OpenRouter and Groq, each read from its own page that
  day and quoted beside its entry; re-read before each release (`docs/release/1.0-checklist.md`).
- [ ] **Import:** no `importRunId` search filter; no design-board frames for import and
  templates (T30). **Step 7 (portability).**
- [ ] **Home has no row for unprinted labels** (the count is in `counts.unprintedLabels`; screens
  §8 has no row). A UI-audit question. **Step 4.**
- [ ] **The web build reports version `0.0.0-dev`** everywhere (every op's `clientVersion`, the
  sidebar): inject the real version with a Vite `define` (D148 relies on it). **Step 8
  (operations: the release build).**

### Server

- [x] **Codes:** `POST /things/:id/duplicate` doesn't return `ownCodes`; `PathStep` has no short
  ID (breadcrumb containers link by UUID); no `code` tombstone is written, so a code moved from
  thing A to thing B shows on A until A resyncs (T17a, the final fix pass). **Step 4.**
  **Done in step 4 (T19):** the duplicate answers `ownCodes`; every path step carries `shortCode`;
  and, instead of a tombstone (the phone applies removals after changes, so it would delete the
  code from B), a code moving off A bumps A's `state_version` (0055), so the next delta resends A
  beside the code's own row (`sync/snapshot.test.ts`).
- [x] **Sync ops:** `location_revoked` needs a prior op in that location, otherwise the answer is
  `not_permitted` (a definer would fix it); a queued `mark_seen` stamps the time it is applied,
  not `takenAt` (T14). **Step 4.**
  **Done in step 4 (T19):** `kept.was_member_of()` (0055) answers a former member without a prior
  op; `mark_seen` stamps `takenAt`, keeping a later sighting (`sync/ops.test.ts`).
- [ ] **AI:** an AI-set type doesn't add its default meter; no history `ai_call` entries; no
  receipt retry route; retry at the learned output limit needs a migration (T10, the AI
  follow-up). **Step 5** (meters) and **step 6** (assistant) respectively.
- [ ] **Crop to paper stays off:** every receipt outline measured `cuts_paper` (T11). Revisit with
  real photos. **Step 6.**
- [x] **Money caps count only their own currency** (no exchange rates yet), and the plan's "counted
  through an exchange-rate row" test isn't written (T7). **When exchange rates land (step 4).**
  Done in step 4: caps count other currencies through the account's rates (0049, T4;
  `src/db/ai.test.ts`), and a rate entered through the exchange-rate route moves a cap's
  percentage and its "not counted" list (T8, `src/money/money.test.ts`).
- [ ] **Abandoned import rows aren't pruned** (`prune_stale_rows` doesn't cover them; T18).
  **Step 7.**

### Real data and credentials (the maintainer)

- [ ] **V1, V3, V37:** 30 or more real photos for the evaluation (synthetic: V1 and V3 fail).
- [ ] **V35:** raise the OpenRouter key's credit limit.
- [ ] **L50:** OpenAI, Anthropic, Google and Ollama keys for the structured-output-with-image spike.
