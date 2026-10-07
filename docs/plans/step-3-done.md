# Step 3: the definition of done, item by item

T32 part B, 2026-09-29/30. Each item of "Definition of done for step 3"
([2026-09-26-step-3-capture.md](2026-09-26-step-3-capture.md)) is **met**, **met with a note**,
**not met**, or **device check pending** (it needs the maintainer's phone; the fallback in use is
named). The evidence is a test (file and title), a commit or a document.

**Summary:** 8 met or met with a note, 1 not met in a single run for reasons outside the code
(the gate: `prod-boot` could not start, see 1), and the phone walkthrough is a device check
pending, with every flow covered in desktop Chromium or by component and server tests.

## 1. `bash scripts/ci-local.sh` exits 0: **not met in one run** (every step passes but `prod-boot`, which could not start)

Run at 2f3f47a on 2026-09-30, 00:09–00:24, in a clean worktree of HEAD: other sessions had
uncommitted work in the main tree that failed `lint` (a new string not yet in the catalogues),
which is theirs, not step 3's. The worktree ran `ci-local`'s `install`, `lint`, `catalogues` and
`typecheck` commands as its step functions do, `compose` was checked up from the main tree (from a
worktree, its relative bind mount would recreate the shared dev database container), then:

```
bash scripts/ci-local.sh --from test     # test ok 196s · drift ok · licences ok · attribution ok · prod-boot FAILED
bash scripts/ci-local.sh --from eval     # eval ok 1s · perf ok 95s · e2e ok 422s · images ok 167s · exit 0
```

- `test`: 3,851 passed, 2 skipped. `e2e`: 47 passed, 13 skipped (the specs' own per-project
  skips), then the update-prompt run (`KEPT_E2E_UPDATE=1 KEPT_E2E_INSTANCES=capture … --project
  phone`): 1 passed. `images`: amd64 and arm64 built, `smoke: PASS (kept:ci-arm64)`.
- **`prod-boot` did not run:** port 8080 is held by an orphaned `prod-boot` server from an
  earlier `ci-local` run (pid 23321, `node --conditions=kept-dist apps/server/dist/main.js`,
  started 2026-09-29 21:01, parent pid 1, its database `kept_ci_boot_1790704894_23107`). The step
  refuses a busy port by design, so it failed honestly. This session was not permitted to stop
  that process. **To finish the gate:** stop pid 23321, then `bash scripts/ci-local.sh --from
  prod-boot` (it runs `prod-boot` and the steps after it). `prod-boot` passed in T32 part A.
- Load average 6–24 during the run; macOS's own `mediaanalysisd` and Spotlight were busy at
  times. That is why the 50-op batch's wall-clock check moved to `test/perf` (2f3f47a).

The step-3 plan's gate also asked for the update-prompt e2e alone:
`KEPT_E2E_UPDATE=1 KEPT_E2E_INSTANCES=capture pnpm --filter @kept/web exec playwright test
step3-update.spec.ts --project phone` is exactly `ci-local`'s last e2e command; it passed in
both full e2e runs that got that far (2026-09-29 23:03 and 2026-09-30 00:13).

**`docs/specs/00-master-plan.md` does not track build steps** (its Progress table is the 25 design
areas), so it is unchanged: step 3 is not marked done anywhere until `prod-boot` passes and the
maintainer decides.

## 2. The leak test covers every new table and function: **met**

`apps/server/test/leak.test.ts`:
- "classifies every public table: a scope column, its own id, or a listed exception (L15)", and
  "has fixture rows for B in every scoped table, so nothing below passes vacuously" (`fillTenant`);
- partitions: "puts each tenant's rows of every partitioned table into a partition" (the audit
  log and `llm_calls`);
- functions: "lets the runtime roles EXECUTE exactly the listed functions, definers deliberately"
  and "definer doors: every kept_app door is probed, or listed with its reason";
- "keeps a provider's key unreadable, and the ledger unwritable, by every runtime role (D206)":
  no runtime role may SELECT `ai_providers.key_ciphertext` or INSERT, UPDATE or DELETE
  `llm_calls`;
- `SYSTEM_TABLES` is unchanged since step 1 (last changed in dc6e2c4, migration 0011; checked with
  `git log -S`);
- "lists only the five AI counter tables as definer-only (D206)", and "gives the runtime roles no
  privilege at all on the definer-only tables".

## 3. Every non-GET route writes an audit row, or is allowlisted with a reason: **met**

`apps/server/test/route-catalogue.test.ts`, "has a marked, audit-asserting test for every non-GET
route, or an allowlisted reason". `GET /api/v1/sync/snapshot` is a GET; `POST /api/v1/scan/resolve`
(read-only) and `POST /share` (a redirect only) are on `ALLOWLIST` with their reasons.

## 4. The walkthrough on a phone over HTTPS: **device check pending**

The walkthrough is `docs/spikes/2026-09-26-step3-devices.md`, "The step-3 walkthrough on a phone";
none of it has been ticked on a phone yet. The first iPhone diagnostics report (iPhone 16 Pro,
iOS 18.7, installed, over Tailscale HTTPS; 296940c) settles some rows: the wasm scanner reads
under the CSP (T0 passes), HEIC decodes (V10, capture preview not tried), the camera's best is
4032×2160, and persistent storage is **refused** (V11 fails; the fallback, the sync line's
warning and a sync on every open, stays in use). Each step, with what already covers it:

| Step | Covered now by | Fallback in use / note |
|---|---|---|
| Install the app | `e2e/pwa.spec.ts` "the service worker installs, and the shell reloads offline"; the iPhone report shows `display-mode=standalone` | — |
| Offline: capture three with photos into a room, "ID pending", findable offline | `e2e/step3.spec.ts` "offline capture: three things into Garage › Shelf A, found offline, …", "a cold reload while offline opens the signed-in app from the phone", "offline, the Search screen finds things kept on the phone" | — |
| Online: IDs appear, AI names them (a key pasted and tested), the inbox holds them | the same e2e, with the mock provider (`KEPT_AI_MOCK=1`); `ai-settings.test.tsx` "a Groq key picks qwen, tests itself, is never echoed back…" | A real key on the phone is the maintainer's step |
| Accept with the keyboard on desktop, and undo | the same e2e (`Shift+A`, then Undo from the toast); `e2e/audit.spec.ts` "keyboard: capture → inbox → search → thing, with no mouse" | — |
| Labels on an A4 sheet from a start cell, "Printed OK" | `e2e/step3.spec.ts` "labels: three things on an A4 sheet from cell 5, printed to PDF at the sheet size, Printed OK ticks Home" | AirPrint on iOS: device check ("Print" row) |
| Scan a label to open it (last seen updates) | `e2e/step3.spec.ts` "scan: the camera reads a seeded label and opens it (seen now); …" (fake camera) | — |
| Scan a blank label and claim it as a new box | `e2e/step3.spec.ts` "the claim race: two phones claim one blank label offline; …" | — |
| Scan a random QR and a barcode | the scan e2e ("a random code is not in your Kept"); a barcode: `scan-screen.test.tsx` "a product barcode is added as a new thing, named by the lookup when it is on (D126)", `scan/scan.test.ts` "names a product barcode…", `scanner.decode.test.ts` "reads a product barcode and names its format" | Not through a camera in e2e (the fake camera plays a QR) |
| A receipt with `$` asks USD or CAD | `e2e/step3.spec.ts` "receipt: a `$` receipt picked from the Gallery in Receipt mode asks USD or CAD, and its review creates the things"; `inbox.test.ts` "gives the currency question the receipt's shop, total and pages, money behind the gate" (5abf9ae) | — |
| A reading that doesn't fit lands in the inbox | `extraction.test.ts` "never applies a reading: it waits for review with the neighbours check"; `capture.test.ts` "logs a typed reading from a reading capture, and asks the inbox when there is none"; `meters.test.ts` "accepts a late reading that fits between its neighbours, and refuses one that does not (D112)" | The web's READING has no typed value yet (step-3 carry-over, step 5) |
| CSV-import a spreadsheet with place paths | `imports.test.ts` "creates the Arabic place path المطبخ > الرف, once" and the import screen tests; `test/perf` imports 200 rows with two-level paths | Not in e2e |
| Box-check a box, and move 5 things with the tray | `boxcheck.test.ts` "marks seen and not here, splits "found 2 of 3", …"; `scan.test.tsx` "a box offers Box check…", "Pick up fills the tray…"; `browse.test.tsx` "picks up several things at once into the carrying tray" | Not in e2e; the V-list "Touch" row (a tap in Box check) is a device check |

## 5. With no provider, everything works except naming; drafts wait in the inbox: **met with a note**

`ai/extract.test.ts` "no provider → no_provider, and no ledger row (D19: everything still
works)"; `capture.test.ts` "makes a photo-only capture a draft with an inbox draft item, and
answers its undo event". The inbox shows such a draft as "Unnamed thing · Needs a name", and
Capture says "Unnamed ones wait in the Inbox for a name."; the DoD's words "unnamed photos to
finish later" are not the UI's copy. Since d7c7171 (another session, 2026-09-29 23:59), photos
captured before a provider was connected wait as `waiting_provider` and are named once a key is
saved, where before they were never named.

## 6. Nothing secret on the phone; the store wiped on logout and on a 401; no authenticated response in the Cache API: **met with a note**

- `sync/snapshot.leak.test.ts` "has no money, secret, document, note or contact field";
  `offline/shell.test.ts` "keeps only what the frame reads: no email, no version, successor or
  money setting".
- Logout: `offline-screens.test.tsx` "signing out anyway signs out, then wipes this person's
  whole database".
- 401: `sync-engine.test.ts` "a 401 drops the cache but keeps the unsent queue, locked; the same
  person resumes and it syncs (D210)"; `wipe.test.ts` "a 401 on a store this tab never opened
  clears the cache and keeps the unsent queue". **Note:** D210 (2026-09-27) refines this item: a
  401 wipes the cached inventory but keeps the person's own unsynced captures, locked.
- Cache API: `pwa.test.tsx` "never caches the API or files: they are NetworkOnly";
  `shell.test.ts` "lives in the person's database, and a 401 takes it with the cache (D210)".

## 7. Every AI call goes through `callModel()`: **met**

`ai/no-direct-calls.test.ts` "only ai/call.ts calls generateText and friends"; `ai/call.test.ts`
"sends one request with retries off (maxRetries: 0), even on a 5xx", "a 429 trips until
retry-after; the next call is held without a request", "ok: a usable object, one sent ledger row
with the tokens the model reported", "refuses an image that carries EXIF (GPS), before anything
else"; `extraction.test.ts` "fails a truncated answer without a retry, and an invalid one as
schema_invalid", "pauses at a cap until the 1st of next month, re-sends it, and Resume brings it
back"; `ai/breaker.test.ts` "trips on the first 429 until retry-after, else 60 s".

## 8. D206: the ledger, AI settings, caps, the AI line and the usage pages: **met**

- One ledger row per call, held-back ones included, with no prompt, image, reply or key:
  `call.test.ts` "the prompt, the reply and the image never reach the ledger", "the key never
  appears in logs, the ledger or the result, even when the provider echoes it", "a location at
  its cap: held with one over_budget row, never sent"; `db-adapters.test.ts` "a cap that refuses
  writes exactly one held-back row"; `ai/routes.test.ts` "no key, in any column of any table".
- AI settings open on "What uses AI in Kept": `ai-settings.test.tsx` "opens with What uses AI,
  then where the key lives, and marks the page opened (D191)".
- A Groq key pre-selects `qwen/qwen3.8-27b`: `ai-settings.test.tsx` "a Groq key picks qwen, …";
  `ai/routes.test.ts` "saves a pasted Groq key write-only, with the recommended model, and audits
  it as a secret".
- A location cap pauses only that location, with Resume now: `db-adapters.test.ts` "a location
  cap pauses that location only"; `ai-settings.test.tsx` "paused: the banner, and Resume now
  raises the cap by 25% and resumes"; `extraction.test.ts` "pauses at a cap … Resume brings it
  back".
- A Groq rate limit shows as waiting, not paused, and each AI-filled draft shows its AI line:
  `inbox.test.tsx` "shows where naming is: paused, waiting, naming, failed with Retry, and the AI
  line"; `extraction.test.ts` "waits for the provider on a 429, from its retry-after, and spends
  no attempt".
- The usage pages give each role its rows, with CSV: `ai/routes.test.ts` "shows each person their
  own calls; …", "shows the owner the account's calls with their cost; the instance admin sees
  instance-paid calls with no location", "exports the list as CSV: the same rows, formulas
  defused, money dropped where hidden, audited, 5 an hour"; `ai-usage.test.tsx` "the CSV request
  carries the list filters".

## 9. The service worker never reloads mid-upload; an outdated phone keeps its queue: **met**

`pwa.test.tsx` "waits while something uploads, then offers Reload, and hands over on Reload" and
"never reloads mid-capture: Reload waits while a capture session holds updates"; the e2e
`step3-update.spec.ts` "a new version waits while a capture is open, then offers Reload" (passed
inside the gate's e2e step); `sync-engine.test.ts` "client_outdated blocks the batch and keeps the
queue; an upgrade on the next start sends it (D148)"; `sync/ordering.test.ts` answers
`client_outdated` for the whole batch.

## 10. The device checklist, §19 and the carry-over: **met with a note**

- The device checklist (`docs/spikes/2026-09-26-step3-devices.md`) is not filled in, but every
  open row names the fallback in use ("In use now"); the first iPhone report settled T0, V11 and
  part of V10 and Cam (296940c). Its offline rows no longer list the cold start and offline
  Search as gaps (both fixed).
- §19: every step-3 V row has its result or "device check pending" with the fallback in use
  (8da6a83); D140 now records gallery import as built (d3a8cf0).
- `docs/plans/step-3-carryover.md` lists what is deferred, each with its step.

## Found and fixed by this gate (T32 part B)

- 5abf9ae: the "Needs a currency" item carries its receipt's shop, total and pages (the money
  gate applies); d3a8cf0: D140's as-built note.
- 22da531: a5dd66d's unformatted `pdftotext` calls failed `lint`.
- d6b42a3: `ci-local`'s e2e step looked for the fake-camera flags where they no longer are.
- 4bebb32: the nine e2e servers exhausted the dev Postgres's 100 connections (pg-boss alone held
  88 with the servers idle): `startKept` takes `poolMax`, and `serve.mjs` passes 3 (peak 50
  afterwards).
- cdfcc24, 1969bce, 47f247b: zod's eval probe was reported as a CSP violation (`script-src
  eval`, from the sync chunk); `jitless` is set by an inline script in `index.html` before any
  module runs.
- 3e8652d: the currency question and its receipt's review had the same accessible name.
- 6480d2e: an Undo toast covered the phone's tab bar.
- 0f84231: the shutter was enabled before the camera's first frame, and a press then was lost
  without a word.
- 11f7323: `j` then `e` within one frame could lose the Name field's focus. Inferred from the
  failure (the edit form open, focus on the row); the race was not reproduced on its own.
- 2f3f47a: the 50-op batch's wall-clock check moved from the parallel suite (3.1–9.3 s at load
  20–36) to `test/perf` (p95 under 1.5 s, alone).
- 3c115f6: the perf figures and limits ([docs/perf/2026-09-30-step3.md](../perf/2026-09-30-step3.md)).
