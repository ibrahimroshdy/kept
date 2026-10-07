# Step 5: Vehicles. Implementation plan

**Goal:** make a car (or a motorbike, or a generator) something Kept looks after, from the
odometer to the day it is sold. Step 4 ([its plan](2026-09-30-step-4-household.md)) builds the core
service records, the Log a service screen without AI, schedules, expiring documents and the reminder
engine; step 5 builds the vehicle on top of them. That means:
- **readings, finished:** meters and readings are core since step 2, and READING capture since
  step 3. Step 5 adds:
  - a typed value in READING mode, queued offline as `log_reading` (step-3 carry-over);
  - "Log a reading" from Home and from the vehicle, online and offline (screens §6 Quick log);
  - the proof photo linked to the reading it proves, and the **odometer proof strip** (D27, D195);
  - "It's right" for an implausible jump at entry (D26), and a first reading prompted when a
    metered thing is created (D52);
  - usage **estimates**: per day, "estimated ~date" on distance schedules (step 4's Q2 leaves this
    to step 5), "reading is 34 days old", "unknown — reading needed" after 60 days (D52, D188);
  - the per-vehicle **stale-reading nudge**, the `reading_stale` source step 4's engine reserves
    (D52; step 4's Q3);
  - an AI-set type adds its default meter (step-3 carry-over).
- **services, for vehicles** (D26, D29): on step 4's service records, the invoice's line items read
  by AI as Suggested values (screens §5 "Log a service"), lines that pre-tick the schedules they
  complete, the photo-proof slot, and the vehicle's Services tab. **Starter schedules** (oil, tyre
  rotation, brake fluid, air filter; D52, §3.4), which step 4 leaves to vehicles.
- **fuel and charging** (D28, D170; the Fuel & charging module): fills and charges in litres, kWh
  or gallons, cost, full or partial, "missed a fill-up", the station as a vendor, the odometer →
  consumption, cost per km, trends.
- **vehicle documents** (D26, D52): on step 4's expiring documents, with an issue date and a cost;
  the **registration card read in LABEL mode** becomes a suggested document, not a thing's
  `expires_on`.
- **costs** (D26): per vehicle, per month, per km, by category (fuel · service and parts · fees
  and insurance), the current month "so far" (D188).
- **the Vehicles module's screens** (screens §1, §8): `/vehicles`, and the vehicle's tabs Overview ·
  Readings · Services · Fuel · Schedules · Documents · Costs on `/t/<id>`.
- **the vehicle history report** (D51, D201): a generated PDF on the step-2 Typst engine: odometer
  history with proof photos, every service with its lines and invoice thumbnails, the fuel summary,
  the documents.

**Architecture:** it stays the same as steps 2–4. What's new:
- **Readings stay one series per meter** (D52). Fuel entries, like step 4's service records, don't
  store an odometer of their own: each points at a `meter_readings` row (`source = 'fuel'`) created
  in the same transaction through the step-2 meters service, so the neighbours check (D112) applies
  to all four sources. A reading owned by a fill or a service is edited through its owner (Q11).
- **Money stays behind the gates.** Fuel costs and document costs join the service totals as money:
  `serialize/gates.ts` decides, the audit tags them (`audit/classes.ts`), the snapshot never holds
  them, and so fuel needs a connection (screens §4; Q3).
- **Estimates have one implementation, in SQL** (`kept.meter_estimate`, `kept.meter_eta`), used by
  the API, the vehicles list, the report, and step 4's `kept.schedule_next` and `agenda_items`, so
  the screen and the reminder scan agree (Q8).
- **The history report is a third kind on the report engine** (after step 4's `insurance`):
  `report_runs` gains a `thing_id`; the `report` job dispatches on the kind; the Typst renderer,
  fonts, thumbnails, signed download and 24-hour purge are reused.
- **The web reuses the list standard:** every list is a `ListSurface` with the filter strip (D205),
  the Display button (D211) and pull to refresh (D212); offline "Log a reading" goes through the
  step-3 offline store and the `log_reading` op. Charts arrive here (visx, D133): step 4 adds none.

**Before you start (status on 2026-09-30).**
- `git log` ends at `a010a9a` (pull to refresh, D212). Step 3's definition of done is met except
  the `prod-boot` gate step and the device checklist ([step-3-done.md](step-3-done.md)).
- The migration journal's latest entry is `0047_thing_meter_version`. Step 4's plan takes the
  numbers from 0048 on. **No number is fixed here:** Phase A starts at **the next free number at
  build time**, written `<N>`, `<N+1>`, … below.
- Built in steps 1–3, and reused, not rebuilt:
  - **meters and readings** (step 2 T16): `src/meters/{service,check,routes}.ts`: `createReading()`
    with `source` and `{via: 'op'}`, `placementOf()`, `recordReplacement()`, the neighbours check
    (`check.ts` `placeReading`, `dailyLimit`), and the routes in its header;
  - **READING capture** (step 3 T13): `capture/service.ts` `captureReading()` (proof attached to the
    thing, a typed `readingValue` online only), the extraction's `needs_review` reading
    (`extraction/apply.ts`), the inbox `reading` item and its actions (`POST /inbox/:id/reading`
    keep · edit · discard · meter_replaced);
  - **the `log_reading` op** (`sync/handlers/log-reading.ts`) and **meters in the snapshot**
    (`SnapMeter`, migration 0047's `things.meter_version`);
  - **the report engine** (step 2 T31–T32): `reports/{service,gather,view,jobs,routes}.ts`,
    `reports/render/*`, `template/report.typ`, `report_runs` (0032);
  - **the web list standard:** `components/list-surface.tsx`, `components/filters/{strip,registry,
    display,views}.tsx`, `components/pull-to-refresh.tsx` (its `PULLS` list), `components/things/
    meters-section.tsx`, `components/reports/{print-sheet,progress}.tsx`;
  - **the offline store and sync** (`apps/web/src/offline/*`: `enqueue`, the uploader, which already
    treats a `log_reading` blob as evidence in `offline/queue.ts`);
  - **undo** (`audit/undo.ts` `registerUndo`, `undo/service.ts`).

Step 5 depends on step 4 in these places (the names are step 4's plan's):

| Step-5 task | Needs from step 4 | If it isn't there yet |
|---|---|---|
| Phase A (T5–T7) | step 4's Phase A merged (0048–0055 in its plan), so the journal is settled and `service_records`, `schedules`, `expiring_documents`, `report_runs.kind` and `agenda_items` exist | **Wait.** T4 alone may go first (it touches only meters and readings) |
| T7 (estimates in `kept.schedule_next`, the `reading_stale` branch of `agenda_items`) | step 4 T6's `kept.schedule_next` and the `agenda_items` view | Wait; T7's `meter_estimate`/`meter_eta` and `is_vehicle_type` may land first |
| T9 (invoice drafts), T20 (Log a service) | step 4 T11's `src/schedules/services.ts` and `POST /api/v1/service-records`; step 4 T21's Log a service screen (`components/services/*`) | **Hard dependency** |
| T12, T22 (documents) | step 4 T12's `src/paperwork/documents.ts` and `/api/v1/documents`; its documents components | Hard dependency |
| T13 costs in one currency | step 4 T8's `fx_rates` and its conversion helper | Totals per currency, never converted |
| T14 (nudges, threshold checks) | step 4 T14's scan, occurrences and delivery | Wait. T14 is the last server task |
| T18, T19 offline vehicle page | the offline thing page (a step-3 carry-over step 4 takes, its T28) | The vehicle page needs a connection; "Log a reading" works offline from Home and Capture |
| T25 e2e reminders | email and web push delivery | The e2e checks the occurrence rows, not the delivery |

Phase 0, T4, T8, T11 and the web tasks on the mock never wait.

**Tech stack.** The pins from steps 1–4 still hold. New packages, each looked up with `npm view` on
2026-09-30. Pin them exactly, and read each `.d.ts` before relying on an API:

| Package | Version | Licence | Used by |
|---|---|---|---|
| `@visx/shape` | 4.0.0 | MIT (peer: react `^18 \|\| ^19`) | web: bars and lines (the chart library is visx, D133) |
| `@visx/scale` | 4.0.0 | MIT | web |
| `@visx/axis` | 4.0.0 | MIT (peer: react) | web |
| `@visx/group` | 4.0.0 | MIT (peer: react) | web |
| `@visx/tooltip` | 4.0.0 | MIT (peer: react, react-dom) | web: hover and focus tooltips |
| `@visx/responsive` | 4.0.0 | MIT (peer: react) | web: `ParentSize` |

- These are the app's first visx charts (step 4's plan adds none; the AI usage page's charts are
  hand-drawn SVG, `components/ai/usage-charts.tsx`). visx brings d3 packages transitively
  (`@visx/vendor` 4.0.0 is "MIT and ISC"): `ci-local`'s `licences` step must pass with them.
- Charts are lazy-loaded (the Costs, Readings and Fuel tabs), so the entry chunk doesn't grow.
- **Not added:** a date library (timezone arithmetic stays in `@kept/shared` `tz.ts` and SQL), a
  units library (the few conversions are exact constants, T1), a PDF library (Typst stays).

**Ground rules for every task** (steps 1–4, repeated):
- **Spec order:** the specs in `docs/specs/` are the contract. Engineering spec §7 beats §1–§6;
  screens §8–§10 beat older frames; where a board frame and the spec differ, the spec wins. Where
  this plan and step 4's plan touch the same thing, step 4's shapes stand and step 5 extends them.
- **Library APIs:** read the installed package's `.d.ts` or README. Never guess. If an API differs
  from what this plan shows, follow the library and say so in the commit body.
- **TDD:** a failing test, then the minimal code, then green, then commit.
- **Commits:** conventional messages, the repo's git identity, **no attribution lines** (D173).
  Commit by path: `git commit -m "…" -- <your paths>`. Never `git add -A`.
- **Node 24:** `export PATH=/opt/homebrew/opt/node@24/bin:$PATH` first. Tests pin
  `TZ=Africa/Cairo`.
- **Ports:** Postgres 5452, Mailpit 8025 and 1025, RustFS 9452. Never touch 5432, 5433 or 5442.
- **No GitHub Actions.** CI is `scripts/ci-local.sh`, gating on exit codes.
- **Content:** the sample cast only (Ibrahim, Alfred, Bruce, Louis, Talia, Peter, Murdock). The
  seed's car is Ibrahim's **Toyota Corolla** `4VC7HD` in Garage › Bay 2; Alfred logs its readings.

**Step-5 additions:**
- **One migration owner.**
  - Phase A (T4–T7) is done in order by one agent. It reads `migrations/meta/_journal.json`
    **right before each generate** and takes the next free number.
  - Before a `CREATE OR REPLACE` of anything step 4 defined (`kept.schedule_next`, the
    `agenda_items` view, `kept.recompute_schedule_anchor`, `report_runs_kind_chk`,
    `attachments_one_subject_chk`), re-read its newest definition in the journal and keep every
    clause.
  - Phases B and C never add a migration. If one turns out to be needed, stop and hand it to the
    owner.
  - Drizzle for tables, checks, uniques, plain and partial indexes and composite FKs; the custom
    migration for policies, grants, triggers, views and functions. After each task,
    `drizzle-kit generate` produces nothing.
- **Every new table** gets, in its task's custom migration:
  1. `ENABLE` + `FORCE ROW LEVEL SECURITY`;
  2. `owner_all` for `kept_owner`;
  3. `kept_app` policies on USING and WITH CHECK;
  4. `REVOKE UPDATE … FROM kept_app, kept_system`, then column `GRANT UPDATE (…)`, never on `id`,
     `location_id` or a `*_by` column;
  5. `touch_row`;
  6. composite FKs `(location_id, x_id) → parent(location_id, id) ON UPDATE CASCADE`;
  7. a `system_select` policy only where step 4's scan must read it (as its T6 does);
  8. a fixture row in `fillVehicles()` (the new file `apps/server/test/leak-vehicles.ts`, imported by
     `leak.test.ts` beside the earlier steps' fill files), in the same commit.
- **Every new `kept.*` function:** revoke `EXECUTE` from `PUBLIC, kept_app, kept_system`, grant it to
  exactly the right role; add it to `FUNCTIONS` in `test/leak.test.ts` **and** the map in
  `src/db/migrate.test.ts`; definers are owned by `kept_owner` with `SET search_path = pg_catalog,
  public`, schema-qualified names, and check the caller from `app.user_id`; anything invisible
  raises `42501` (a 404).
- **API conventions**, as before: camelCase JSON; money as a decimal string plus `currency`,
  **omitted** when gated, with `moneyHidden: true`; `assertClientId()` on client ids; `If-Match` on
  every PATCH, DELETE and confirming POST; 404 for anything invisible, 403 for a visible row the
  role can't change; every non-GET route calls `audited()` and carries a `// catalogue:` marker;
  lists are `{items, next_cursor}`; an undoable write answers `undo: {eventId, until}`.
- **Modules** (D113): readings, services and stale nudges are **core** (no gate). Vehicle screens,
  vehicle documents, costs, estimates on the vehicles list, starter schedules and the history report
  are `vehicles`; fuel is `fuel` (which needs `vehicles`). Routes declare `config.module` and a
  `moduleLocation` resolver (`http/modules.ts`).
- **Roles** (`packages/shared/src/roles.ts`): add a reading or fuel entry `logs.add`; edit or delete
  your own `logs.edit-own`; anyone's `logs.edit-delete-others` (owner, admin); a meter's settings
  (`nudgeDays`, the daily limit) `meters.manage`; starter schedules `schedules-claims.manage`;
  documents `things.edit`. Viewers read, money per the gate.
- **Web:**
  - Every list uses `ListSurface` with the filter strip, the Display button and saved views; state in
    the URL.
  - React Aria only: no native `select`, date picker or `confirm`. Logical CSS only. Nothing cut to
    "…" on a phone. RTL mirrors; readings, amounts and dates follow the digits setting, VINs and
    short IDs stay Western and LTR, plates stay as printed (screens §8).
  - Check at 375, 768 and 1280, light and dark, English and Arabic.
  - **No new route files after T3.**
  - **Parallel web tasks never run `i18n:extract` or edit `.po` files.** T25 does it once, in all
    five catalogues (en, ar, fr, de, it).

**Parallel execution (waves).** Tasks within a wave touch disjoint files.

| Wave | Tasks | Notes |
|---|---|---|
| 0 | T0 ∥ T1 ∥ T2 ∥ T3 | T0's chart spike can change T18's and T21's chart code; T1–T3 don't depend on it |
| 1 | T4 → T5 → T6 → T7 | one owner, sequential, after step 4's Phase A (T4 may go first). T1's pure maths may start meanwhile |
| 2 | T8 ∥ T11 ∥ T12 ∥ T13 ∥ T16; then T9 (after step 4's T11); T10 (after T8, T9, T12); T15 (after T11, T12); T14 (after T7 and step 4's T14) | each owns its own files. `extraction/` and `inbox/` belong to T10 alone; step 4's `src/schedules/services.ts` to T9 alone |
| 3 | T17 ∥ T18 ∥ T19 ∥ T20 ∥ T21 ∥ T22 ∥ T23 | on the mock from T3; each switches to the real server when its wave-2 task is done; T20 and T22 start after step 4's T21 and T23 |
| 4 | T24 → T25 | the UI pass, then i18n, e2e, leak, perf, CI and docs |

---

## File structure (created or changed across the tasks)

```
packages/shared/src/
  vehicles.ts           VEHICLE_TYPE_KEY, COST_CATEGORIES, STARTER_SCHEDULES, estimate
                        constants (RATE_WINDOW_DAYS 90, MIN_SPAN_DAYS 7, ADVICE_DAYS 30,
                        UNKNOWN_DAYS 60, NUDGE_DAYS_DEFAULT 30), distanceBetween() over a series
  fuel.ts               FUEL_UNITS, consumption() (full-to-full, missed fills, one unit),
                        pricePerUnit(), perDistance(), display conversions (exact constants)
  services.ts           matchSchedules(names, lines), reconcileTotal()
  extraction.ts         + the service-invoice variant of RECEIPT (optional line kind)
  list-views.ts         + surfaces vehicles, fuel, readings (+ filter keys on step 4's services)
  sync.ts               SnapMeter + optional latest {value, takenAt}
  errors.ts             + reading_owned, reading_refused, service_draft, fuel_needs_meter
apps/server/
  migrations/<N>…<N+6>  Phase A (T4–T7)
  src/db/schema/        meters.ts (+nudge_days), fuel.ts (new), services.ts (+review_state),
                        schedules.ts (+expiring_documents issued_on, cost, currency),
                        files.ts (+fuel_entry_id), capture.ts (+extractions.service_record_id),
                        reports.ts (+thing_id)
  src/meters/           service.ts (+confirmJump, proof, owned readings), estimate.ts,
                        proofs.ts, undo.ts, routes.ts
  src/schedules/        services.ts (drafts, suggestions, filters; step 4's file), + starter.ts
  src/services/         routes.ts drafts.ts   (the draft and confirm routes only)
  src/paperwork/        documents.ts (issued on, cost, thing filter, the vehicles module; step 4's)
  src/fuel/             routes.ts service.ts summary.ts undo.ts
  src/vehicles/         routes.ts list.ts costs.ts series.ts
  src/reports/vehicle/  gather.ts view.ts          + template/vehicle.typ
  src/extraction/       apply.ts (reading proof, default meter, invoice lines, registration card)
                        prompts/service-invoice.ts
  src/inbox/            service.ts (a `document` suggestion's accept)
  src/audit/classes.ts  + fuel_entry.cost, expiring_document.cost
  src/seed/             inventory.ts (the Corolla's fills, services, documents, proof photos)
  test/leak-vehicles.ts test/perf/vehicles.perf.test.ts
apps/web/src/
  api/vehicles/         paths.ts types.ts queries.ts mock/{vehicles,fuel,costs,series,
                        service-drafts,documents,reports}.ts
  routes/_app/vehicles.tsx
  components/vehicles/  list.tsx vehicle-tabs.tsx overview.tsx readings-tab.tsx proof-strip.tsx
                        services-tab.tsx costs-tab.tsx schedules-tab.tsx starter-schedules.tsx
                        documents-tab.tsx history-report-sheet.tsx
  components/readings/  log-reading-sheet.tsx reading-field.tsx first-reading.tsx
  components/services/  (step 4's) + invoice-suggestions.tsx; the pre-tick rule
  components/fuel/      fuel-tab.tsx log-fuel-sheet.tsx fuel-summary.tsx
  components/charts/    bars.tsx series.tsx chart-table.tsx (lazy; visx)
  components/capture/   reading-target.tsx, capture-screen.tsx (typed READING value)
  components/home/      quick-log.tsx
```

---

## Phase 0: spikes, shared contracts and scaffolding (T0–T3, parallel)

### Task 0: Spikes: visx charts in RTL, and the vehicle report's photo load

**Files:**
- Create: `docs/spikes/2026-09-30-step5-charts.md`, `docs/spikes/2026-09-30-step5-vehicle-report.md`,
  `docs/spikes/2026-09-30-step5-devices.md` (the device checklist, filled in later)
- Throwaway code under `docs/spikes/code/`, never merged into `apps/`.

- [x] **Charts (proposed V38).** A stacked bar chart (three series, six months) and a line with a
  dashed estimate segment, on `@visx/*` 4.0.0 with React 19.3.
  - Pass if:
    - it renders in Arabic RTL with the time axis running right to left and Eastern digits from
      `Intl.NumberFormat('ar-EG')` in the ticks;
    - every bar and point is reachable by keyboard with a tooltip on focus, and "Show as table"
      gives the same numbers (the board's Costs tab);
    - reduced motion: no transitions;
    - the lazy chunk's gzipped size is recorded from the build (budget: 60 KB);
    - a horizontal drag across the chart on a 375 px touch viewport doesn't arm pull to refresh
      (D212's 16 px vertical rule).
  - Fail path: hand-drawn SVG with `@visx/scale` only. Record which path won; T18 and T21 use it.
  - **Result (2026-09-30): passed on visx.** Lazy chunk 30.4 KB gzip; 0 pull events for sideways
    drags at 375 px; every mark reachable from one tab stop, tooltips equal to the table. **Rule for
    T18 and T21:** a chart's `<svg>` is `direction: ltr` and RTL is drawn by geometry (reversed
    ranges, value axis on the right); inheriting `direction: rtl` flips SVG `text-anchor` and puts
    visx's tick labels on the plot.
- [x] **The vehicle report (proposed V39).** Render a vehicle history report on the step-2 Typst
  path (`reports/render/child.mjs`) with 5 years of data: 60 services with 3 invoice thumbnails
  each, 600 fills, 200 odometer proof photos, in English and in Arabic with an Arabic plate.
  - Pass if: peak memory stays under the report job's existing limit (read it from
    `reports/render/render.ts`), the plate's Arabic letters shape and stay in printed order, the VIN
    stays LTR, and it renders in under 60 s on the laptop.
  - Fail path: cap proof photos at the latest 60 in the report, with "N more in Kept"; record the cap.
  - **Result (2026-09-30): passed, no cap.** About 300 MB peak RSS in Kept's image under a hard
    512 MB limit, 1–11 s, plate and VIN correct in both languages. The 60-photo cap saved only
    18–23 MB: rows drive memory (ten years of the same car peaked at 507 MB). So T15 bounds rows,
    not photos: the odometer history prints proof and typed readings plus one a month, and fuel
    stays a summary (inferred, not measured). Keep the 200 px thumbnails.
- [x] **The device checklist.** Write the list from "Needs the maintainer's devices" below, with an
  empty result column.
- [x] **Commit:** `docs(spikes): step-5 charts and the vehicle report's photo load`.

### Task 1: Shared contracts: fuel maths, estimates, schedule matching, surfaces

**Files:**
- Create in `packages/shared/src/`: `vehicles.ts`, `fuel.ts`, `services.ts`, each with `*.test.ts`
  (if step 4 created a `services.ts`, add these to it instead)
- Modify: `extraction.ts`, `list-views.ts`, `sync.ts`, `errors.ts`, `index.ts` (all small, and
  shared with step 4: re-check each file is clean before editing)

- [ ] **Step 1: `fuel.ts`** (D28, D170; Q6, Q7).
  - `FUEL_UNITS = ['L', 'kWh', 'gal'] as const`; `gal` is the US gallon (Q7).
  - Values are decimal strings, compared and summed as thousandths in `BigInt`, like
    `apps/server/src/meters/check.ts` `milli()`. Move `milli`/`decimalOut` here and re-export them
    from `check.ts`, so both sides share one copy.
  - `consumption(fills, opts: {window: number})`. Input: a vehicle's fills, oldest first, each
    `{takenAt, amount, unit, isFull, missedBefore, reading: {value (offset-corrected)} | null}`.
    1. An **interval** runs from one full fill to the next full fill.
    2. Its fuel is the sum of the amounts of every fill after the first full, up to and including
       the closing full (partials in between count).
    3. It's **skipped** when: either end has no reading; any fill in it has `missedBefore`; any fill
       in it uses another unit (a plug-in hybrid, Q6); the distance is 0 or less.
    4. Returns the last `window` usable intervals (default 5) as `{perHundred, fromAt, toAt, fills}`,
       plus `whyNone` when there are none: `'too_few_full_fills' | 'missed_fill' | 'mixed_units' |
       'no_readings'`.
  - `displayConsumption(perHundred, fuelUnit, distanceUnit, units: 'metric'|'imperial')`: metric
    shows `L/100 km` and `kWh/100 km`; imperial `mpg` (US) and `mi/kWh`. Exact constants (1 US gal =
    3.785411784 L; 1 mi = 1.609344 km). Stored values are never converted (D76); only the derived
    figure is.
  - `pricePerUnit(fill)`, `perDistance(cost, distance)`: per currency, never mixed.
  - Tests (a table): three full fills with a partial between → one interval with both amounts; a
    `missedBefore` in the middle → that interval skipped; a kWh charge inside a litre interval →
    `mixed_units`; a full fill without a reading → `no_readings`; a meter replaced in the window →
    the right distance; 5 L over 72.5 km → `6.9 L/100 km` → `34.1 mpg`.
- [ ] **Step 2: `vehicles.ts`.**
  - `VEHICLE_TYPE_KEY = 'vehicle'` (the built-in key in `builtin-types.ts`); what counts as a vehicle
    is Q2.
  - `COST_CATEGORIES = ['fuel', 'service', 'fees']` (the board's Fuel · Service & parts · Fees &
    insurance; Q5).
  - `STARTER_SCHEDULES` (D52, engineering spec §3.4: "editable defaults, not manufacturer advice"):
    oil change 10,000 km or 12 months; tyre rotation 10,000 km or 12 months; brake fluid 24 months;
    air filter 20,000 km or 24 months. Keys and English names; the web translates them. The distance
    intervals apply only to a distance meter in km (Q25).
  - Estimate constants: `RATE_WINDOW_DAYS = 90`, `MIN_SPAN_DAYS = 7`, `ADVICE_DAYS = 30`,
    `UNKNOWN_DAYS = 60` (D52, D188; screens §8), `NUDGE_DAYS_DEFAULT = 30` (§3.4). The SQL in T7 is
    the implementation; these are its inputs and the web mock's (Q8).
  - `distanceBetween(series, from, to)`: the distance driven between two instants, with linear
    interpolation between the accepted readings around each end, and **no extrapolation** past the
    last reading. Tests: readings on both sides; a period ending after the last reading (clipped); a
    replacement inside it.
- [ ] **Step 3: `services.ts`.**
  - `matchSchedules(schedules: {id, name}[], lines: {description}[])` → schedule ids (Q13): a
    schedule matches when **one line** contains every significant word of its name, after
    `normalize()` and `stripPrefixes()` (the D42 twins); significant = 3 characters or more, not in
    a small stop list (`and`, `the`, `&`, `و`, `ال`…). Tests: "Oil & filter" ↔ "Oil filter" ✓,
    ↔ "Engine oil 5W-30" ✗; "Tyre rotation" ↔ "tyre rotation, 4 wheels" ✓; Arabic "تغيير الزيت" ↔
    "زيت محرك وتغيير" ✓.
  - `reconcileTotal(total, lines)`: `'ok' | 'flag'` at ±1% (the Purchase rule, screens §7), and the
    sum when `total` is omitted.
- [ ] **Step 4: `extraction.ts`.** `ServiceInvoiceExtraction` = `ReceiptExtraction` whose lines gain
  an optional `kind: Conf<'part'|'labour'|'fluid'|'other'>`. Same `MAX_OUTPUT_TOKENS` as receipts.
  `parseLenient` drops a bad `kind` alone (L52). Test: a line with `kind: 'tyres'` keeps its
  description and loses its kind.
- [ ] **Step 5: `list-views.ts`.** `LIST_SURFACES` gains `vehicles`, `fuel`, `readings` (the
  `saved_views.surface` CHECK is a pattern, so no migration). If step 4 made a surface for service
  records, it gains the keys below; otherwise add `services`. Filter keys:
  - `vehicles`: `location`, `type`, `state`, `reading` (fresh · stale · unknown · none), `due`
    (overdue · soon, from `agenda_items`);
  - services: `when`, `vendor`, `kind` (line kinds), `draft`;
  - `fuel`: `when`, `unit`, `vendor`, `full`;
  - `readings`: `when`, `source`, `state`.
  `MONEY_FILTER_KEYS` is unchanged (no cost filters in step 5).
- [ ] **Step 6: `sync.ts`.** `SnapMeter` gains `latest?: {value: string; takenAt: string}`
  (optional: older snapshot rows still parse; Q18). `PAYLOAD_VERSION` is unchanged: no queue payload
  changes.
- [ ] **Step 7: `errors.ts`.** Add `reading_owned` ("Change this reading from its fuel entry or
  service"), `reading_refused` (a fill's reading doesn't fit; carries `reason` and the neighbour;
  reuse step 4's code instead if its service records already have one), `service_draft` ("Finish
  logging this service first"), `fuel_needs_meter` ("This thing has no meter for the odometer"), each
  with its English message.
- [ ] **Step 8:** `pnpm test --project @kept/shared` passes. Commit:
  `feat(shared): fuel consumption, estimate constants, starter schedules, schedule matching and step-5 surfaces`.

### Task 2: Server scaffolding: route stubs, report kind, audit classes

**Files:**
- Create: a stub `routes.ts` in `src/{fuel,vehicles,services}/`, each
  `export async function xRoutes(app, deps) {}`, listed in `http/routes.ts`'s
  `INVENTORY_ROUTE_MODULES`. (`src/services/` holds only the draft routes; step 4's service-record
  routes stay in `src/schedules/`.)
- Modify:
  - `audit/classes.ts` `FIELD_CLASSES`: `fuel_entry.cost`, `expiring_document.cost` → `'money'`
    (D110). Step 4 adds the service-record money columns; this is a shared hot spot, so a small
    commit of its own.
  - `http/errors.ts`: `MESSAGES` for T1's codes; `CONFLICT_HINTS` for the constraint names T4–T7
    add.
  - `reports/jobs.ts`: after step 4's dispatch on `report_runs.kind`, `vehicle_history` goes to a
    stub that fails with `render`, filled in T15.
- Test: `audit/classes.test.ts` (the two money columns), `route-catalogue.test.ts` (stubs have no
  writes yet).

- [ ] **Step 1:** Write the failing tests, then make them pass.
- [ ] **Step 2:** Commit: `feat(server): step-5 route stubs, money audit classes and the vehicle report kind`.

### Task 3: Web scaffolding: the route stub, the vehicles API contract, the nav entry

**Files:**
- Create: `routes/_app/vehicles.tsx` (`<Page title>` + `ComingLater`), so `routeTree.gen.ts`
  changes once, here. The vehicle's tabs live on `/t/$id` as `?tab=` (screens §2: tabs are query
  parameters), so no other route.
- Create: `apps/web/src/api/vehicles/{paths.ts,types.ts,queries.ts}` and
  `apps/web/src/api/vehicles/mock/{vehicles,fuel,costs,series,service-drafts,documents,reports}.ts`;
  modify `api/mock/server.ts` to compose them. Service records and documents keep step 4's contract
  (its `api/*/types.ts`); step 5's additions to them go in `api/vehicles/types.ts` as extensions.
- Modify: `components/app-shell.tsx` (`useNavEntries`: the Vehicles entry, today without `to`, gets
  `to: '/vehicles'` and shows only when `vehicles` is on in at least one location, like Labels);
  `components/pull-to-refresh.tsx` (`PULLS` gains `/vehicles`).
- Test: the nav entry appears with the module and hides without it; `pullsOn('/vehicles')`.

- [ ] **Step 1: The contract.** Write `api/vehicles/types.ts` from the route tables in Phase B,
  verbatim; the server tasks implement the same shapes. Mocks answer from fixtures modelled on the
  seed: the Corolla (six months of fills, two services, a licence due in 23 days, an insurance
  document), a generator with an hours meter, a sold motorbike, and an Arabic household's car with
  Eastern-digit readings and an Arabic plate. One reading is 34 days old (advice), one meter 70 days
  (unknown).
- [ ] **Step 2:** Commit: `feat(web): step-5 route stub, vehicles API contract and mock, nav entry`.

---

## Phase A: schema, RLS and definers (T4–T7, sequential, one owner)

Each task ends with `pnpm test` green, **including `test/leak.test.ts`**, and `drizzle-kit generate`
producing nothing. `<N>` is the next free journal number when the task starts.

### Task 4: Meters and readings, step 5's additions (`<N>` generated, `<N+1>` custom)

**Files:**
- Modify: `src/db/schema/meters.ts`
- Migrations: `<N>_meter_nudges.sql`, `<N+1>_meter_readings_step5.sql`
- Test: `src/db/meters-step5.test.ts`; create `test/leak-vehicles.ts`; update `leak.test.ts` and
  `migrate.test.ts`

- [ ] **Step 1: The nudge interval** (D52, §3.4; Q19). Drizzle:

  ```sql
  ALTER TABLE meters ADD COLUMN nudge_days integer DEFAULT 30;
  ALTER TABLE meters ADD CONSTRAINT meters_nudge_days_chk
    CHECK (nudge_days IS NULL OR nudge_days BETWEEN 7 AND 365);   -- NULL: no nudge
  ```

  Custom: `GRANT UPDATE (nudge_days) ON public.meters TO kept_app;` (beside 0018's grant).
- [ ] **Step 2: Readings reach the snapshot** (Q18). The snapshot re-sends a thing only when its
  `change_xid` moves; a new reading doesn't touch the thing, so `SnapMeter.latest` would go stale.
  Custom, following 0047's `kept.touch_thing_meters()`:

  ```sql
  CREATE FUNCTION kept.touch_reading_meters() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  BEGIN
    UPDATE public.things t SET meter_version = t.meter_version + 1
      FROM public.meters m
     WHERE m.id = coalesce(NEW.meter_id, OLD.meter_id) AND t.id = m.thing_id;
    RETURN NULL;
  END $$;
  REVOKE EXECUTE ON FUNCTION kept.touch_reading_meters() FROM PUBLIC, kept_app, kept_system;
  CREATE TRIGGER meter_readings_thing_version AFTER INSERT OR DELETE ON public.meter_readings
    FOR EACH ROW EXECUTE FUNCTION kept.touch_reading_meters();
  -- Only a real change: a move's cascade rewrites location_id and nothing READING shows.
  CREATE TRIGGER meter_readings_thing_version_update
    AFTER UPDATE OF value, taken_at, state ON public.meter_readings FOR EACH ROW
    WHEN (OLD.value IS DISTINCT FROM NEW.value OR OLD.taken_at IS DISTINCT FROM NEW.taken_at
          OR OLD.state IS DISTINCT FROM NEW.state)
    EXECUTE FUNCTION kept.touch_reading_meters();
  ```

  - **Test the purge cascade:** `kept.purge_trash()` on a trashed car with readings. If the trigger's
    UPDATE of a thing being deleted in the same statement raises, make it a no-op when the meter row
    is already gone (the `FROM public.meters` join finds nothing) and re-test.
  - Test: logging a reading bumps the thing's `change_seq` but not its `row_version`; a move across
    locations bumps nothing extra.
- [ ] **Step 3: Proof photos move to their reading** (D27, D195; Q10). Step 3 attached READING
  proofs to the thing (`capture/service.ts` `captureReading`, `sync/handlers/log-reading.ts`).
  `attachments.meter_reading_id` already exists (step 2). Custom SQL, run once as the owner:

  ```sql
  -- READING captures with a typed value: the reading's id is the capture's id, and the capture's
  -- audit event names its attachments (capture/service.ts: after = {capture_id, meter_id,
  -- attachment_ids}). Other step-3 proofs stay on the thing; the strip shows them by date (Q10).
  WITH cap AS (
    SELECT (e.after->>'capture_id')::uuid AS reading_id,
           jsonb_array_elements_text(e.after->'attachment_ids')::uuid AS attachment_id
      FROM public.audit_events e
     WHERE e.action = 'thing.capture' AND e.after ? 'meter_id' AND e.after ? 'attachment_ids')
  UPDATE public.attachments a
     SET thing_id = NULL, meter_reading_id = cap.reading_id
    FROM cap JOIN public.meter_readings r ON r.id = cap.reading_id
   WHERE a.id = cap.attachment_id AND a.role = 'proof' AND a.location_id = r.location_id;
  ```

  Test with a fixture made through the step-3 capture service: the attachment moves; one without a
  reading stays.
- [ ] **Step 4: Leak.** Create `test/leak-vehicles.ts` with `fillVehicles(tenant)`: sets
  `nudge_days` on the tenant's metered thing and adds a reading with a proof attachment on the
  reading. Add `kept.touch_reading_meters` to both function lists (`OWNER_ONLY`).
- [ ] **Step 5:** Commit: `feat(db): meter nudges, readings in the snapshot, proof photos on their reading`.

### Task 5: Service records, step 5's additions (`<N+2>` generated, `<N+3>` custom)

**Files:**
- Modify: step 4's `src/db/schema/services.ts` (`service_records`), `schema/capture.ts`
  (`extractions.service_record_id`)
- Migrations: `<N+2>_service_drafts.sql`, `<N+3>_service_drafts_rls.sql`
- Test: `src/db/service-drafts.test.ts`; update the leak and migrate lists

Step 4 creates `service_records`, `service_lines`, `service_completions` and
`attachments.service_record_id` (its T5, T6). Step 5 adds only this:

- [ ] **Step 1: Drafts** (screens §5's invoice read by AI; Q12). Drizzle:

  ```sql
  ALTER TABLE service_records ADD COLUMN review_state text NOT NULL DEFAULT 'confirmed';
  ALTER TABLE service_records ADD CONSTRAINT service_records_review_state_chk
    CHECK (review_state IN ('draft','confirmed'));
  CREATE INDEX service_records_drafts_idx ON service_records (logged_by, created_at)
    WHERE review_state = 'draft';
  ```

  Custom: `review_state` joins the column grant. Step 4's anchor function
  (`kept.recompute_schedule_anchor`) and `agenda_items` must ignore drafts: re-create them from their
  newest definitions with `review_state = 'confirmed'` wherever they read `service_records` (and
  `service_completions` through it). A test: a draft that "completes" a schedule doesn't re-anchor
  it; confirming it does.
- [ ] **Step 2: One owner per reading.** If step 4 didn't add it:
  `CREATE UNIQUE INDEX service_records_reading_uq ON service_records (meter_reading_id) WHERE
  meter_reading_id IS NOT NULL;` (Q11).
- [ ] **Step 3: The extraction's target.** `extractions.service_record_id uuid` + composite FK
  `(location_id, service_record_id) → service_records(location_id, id) ON UPDATE CASCADE ON DELETE
  CASCADE`; the `num_nonnulls(thing_id, purchase_id, meter_id) <= 1` CHECK gains
  `service_record_id`. No UPDATE grant: it's set at insert only.
- [ ] **Step 4: Tests.** Every member of the location sees a draft (it shows on the Services tab); a
  draft is counted by nothing; a second live extraction for the same invoice is refused by step 3's
  `extractions_live_uq`.
- [ ] **Step 5: Leak.** `fillVehicles()` adds a draft service with an invoice and an extraction row on
  it. Commit: `feat(db): service drafts for invoices read by AI`.

### Task 6: Fuel, document costs and the report's thing (`<N+4>` generated, `<N+5>` custom)

**Files:**
- Create: `src/db/schema/fuel.ts`
- Modify: `schema/files.ts`, step 4's `schema/schedules.ts` (`expiring_documents`), `schema/reports.ts`
- Migrations: `<N+4>_fuel.sql`, `<N+5>_fuel_rls.sql`
- Test: `src/db/fuel.test.ts`; update the leak and migrate lists

- [ ] **Step 1: `fuel_entries`** (§1.6, §7.13; D28, D170).

  ```sql
  CREATE TABLE fuel_entries (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    thing_id uuid NOT NULL,
    taken_at timestamptz NOT NULL,
    amount numeric(10,3) NOT NULL CHECK (amount > 0),
    unit text NOT NULL CHECK (unit IN ('L','kWh','gal')),
    currency char(3) REFERENCES currencies(code), cost numeric(16,4) CHECK (cost >= 0),
    is_full boolean NOT NULL DEFAULT true,          -- §1.6 calls it `full`; FULL is a reserved word
    missed_before boolean NOT NULL DEFAULT false,   -- D170: no consumption across the gap
    vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,       -- the station (D11)
    meter_reading_id uuid,                          -- its odometer, source 'fuel'
    note text CHECK (char_length(note) <= 500),
    logged_by uuid NOT NULL, …mutable,
    UNIQUE (location_id, id),
    CHECK ((cost IS NULL) = (currency IS NULL)),    -- §7.13: null together
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, meter_reading_id) REFERENCES meter_readings(location_id, id)
      ON UPDATE CASCADE ON DELETE SET NULL (meter_reading_id));
  CREATE INDEX fuel_entries_thing_idx ON fuel_entries (thing_id, taken_at);
  CREATE UNIQUE INDEX fuel_entries_reading_uq ON fuel_entries (meter_reading_id)
    WHERE meter_reading_id IS NOT NULL;
  ```

  - The vendor must be the location's owner account's: the same guard step 4 puts on service
    records' `vendor_id` (reuse it, or copy `kept.guard_purchase_vendor()`'s shape from 0018);
    `kept.guard_currency_enabled()` on `currency`.
  - Policies, as step 4's service records (its T5): SELECT visible; INSERT writable with
    `logged_by = (SELECT kept.current_user_id())`; UPDATE and DELETE writable **and** (`logged_by =
    me` OR `location_id IN (SELECT kept.admin_location_ids())`): `logs.edit-own` vs
    `logs.edit-delete-others`, in the database as well as the API. A real DELETE, undoable through
    the audit (Q14).
  - `GRANT UPDATE (taken_at, amount, unit, currency, cost, is_full, missed_before, vendor_id,
    meter_reading_id, note, updated_at, row_version)`.
  - `attachments.fuel_entry_id` (a pump receipt photo, role `receipt`) + composite FK + index, and
    `attachments_one_subject_chk` re-created from its newest definition with `fuel_entry_id` added.
  - No `system_select`: no reminder reads fills.
- [ ] **Step 2: Document costs** (Q5). Step 4's `expiring_documents` gains:

  ```sql
  ALTER TABLE expiring_documents ADD COLUMN issued_on date;
  ALTER TABLE expiring_documents ADD COLUMN currency char(3) REFERENCES currencies(code);
  ALTER TABLE expiring_documents ADD COLUMN cost numeric(16,4);
  ALTER TABLE expiring_documents ADD CONSTRAINT expiring_documents_cost_chk
    CHECK ((cost IS NULL) = (currency IS NULL) AND (cost IS NULL OR cost >= 0));
  ALTER TABLE expiring_documents ADD CONSTRAINT expiring_documents_issued_chk
    CHECK (issued_on IS NULL OR issued_on <= expires_on);
  ```

  The three columns join its column grant; the currency guard as above.
- [ ] **Step 3: The report's thing** (D51, D201; Q17). Step 4 adds `report_runs.kind` with
  `CHECK (kind IN ('inventory','insurance'))`. Re-create that CHECK from its newest definition with
  `'vehicle_history'` added, and:

  ```sql
  ALTER TABLE report_runs ADD COLUMN thing_id uuid;
  ALTER TABLE report_runs ADD CONSTRAINT report_runs_thing_chk
    CHECK ((kind = 'vehicle_history') = (thing_id IS NOT NULL)
           AND (thing_id IS NULL OR location_id IS NOT NULL));
  -- custom: FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id)
  --   ON UPDATE CASCADE ON DELETE CASCADE
  ```

- [ ] **Step 4: Tests.**
  - A fill with cost and no currency → 23514; `amount = 0` → 23514; `unit = 'l'` → 23514.
  - Alfred edits and deletes his own fill, not Bruce's; Bruce deletes Alfred's.
  - A fill on B's car → 42501; B's vendor → 42501.
  - Two fills can't own one reading (23505).
  - A cross-location move of the car carries its fills and their receipt attachments.
  - A `vehicle_history` run without a thing → 23514; with a thing in another location → 23503.
- [ ] **Step 5: Leak.** `fillVehicles()` adds a fill with a receipt attachment and a reading, a cost
  on the tenant's document, and a `vehicle_history` report run. Commit:
  `feat(db): fuel entries, document costs and the vehicle report's thing`.

### Task 7: Estimates, estimated due dates, the nudge source and vehicle types (`<N+6>` custom)

**Files:**
- Migration: `<N+6>_vehicle_estimates.sql`
- Test: `src/db/estimate.test.ts`, `src/db/vehicle-type.test.ts`, step 4's agenda and schedule
  twin tests (extended); update the leak and migrate lists

- [ ] **Step 1: `kept.meter_estimate(p_meter uuid, p_now timestamptz DEFAULT now())`** (D52, D188;
  Q8). `RETURNS TABLE (last_value numeric, last_taken_at timestamptz, per_day numeric, basis_days
  int, age_days int, advice text)`, `LANGUAGE sql STABLE`, **invoker** (RLS decides what it sees),
  granted to `kept_app` and `kept_system` (step 4's scan reads `meters` and `meter_readings` through
  its `system_select` policies).
  - Values are offset-corrected with `meter_events` (the latest replacement at or before each
    reading), exactly as `meters/check.ts` does; a test compares the two on the same series.
  - Accepted readings only. The window is the `RATE_WINDOW_DAYS` (90) before the latest reading.
  - `per_day` = (last − first in the window) / span in days, when there are 2 or more readings
    spanning `MIN_SPAN_DAYS` (7) or more; otherwise NULL.
  - `age_days` = whole days from the latest reading to `p_now`.
  - `advice`: `'none'` (no reading) · `'fresh'` (< 30 days) · `'stale'` (30–59: "reading is 34
    days old") · `'unknown'` (≥ 60: `per_day` returned NULL, "unknown — reading needed").
- [ ] **Step 2: `kept.meter_eta(p_meter uuid, p_value numeric, p_now timestamptz DEFAULT now())
  RETURNS date`**, invoker, STABLE, same grants: the local date (the location's timezone) the meter
  reaches `p_value` at `per_day`; NULL when `per_day` is NULL or `p_value` ≤ the last value.
- [ ] **Step 3: Estimated due dates in step 4's schedules** (step 4's Q2; D52). Re-create
  `kept.schedule_next` from its newest definition so a unit schedule's result gains `estimated_on
  date` (= `kept.meter_eta(meter, due_value − lead_units)`) and `estimated boolean`; for "whichever
  first", an estimated date earlier than the months date makes the schedule due on it. **A due point
  from an estimate is labelled estimated everywhere** (D52). Update the TS twin `scheduleNext()` and
  step 4's twin test (10 more cases: stale, unknown, a replacement, months first, estimate first).
  `agenda_items` (re-created from its newest definition) carries `estimated`.
- [ ] **Step 4: The `reading_stale` branch of `agenda_items`** (D52, D113; step 4's Q3). A `UNION
  ALL` branch, `source_type = 'reading_stale'`, `source_id` = the meter:
  - meters with `nudge_days` set, on a thing whose subject is live (step 4's `<subject live>`: not
    trashed, lifecycle `in_use`), with at least one accepted reading;
  - `due_on` = the latest reading's local date (the location's timezone) + `nudge_days`; state `due`
    from that day; `due_period = 'date:' || due_on`;
  - no module clause: stale nudges are core (D113; step 4's `SOURCE_MODULE.reading_stale = null`).
- [ ] **Step 5: `kept.is_vehicle_type(p_type uuid) RETURNS boolean`**, invoker, STABLE (Q2): true
  when the type, walking `parent_id` **and** `copied_from_id` (a recursive CTE, depth ≤ 64), reaches
  the built-in with `builtin_key = 'vehicle'`. `kept.type_chain` follows `parent_id` only, so this
  is its own walk. Tests: built-in Car, Motorbike, Generator, Bicycle → true; a customised copy of
  Car (`kept.customise_type`) → true; an account type "Boat" under nothing → false; a custom type
  under a customised Vehicle → true.
- [ ] **Step 6: Documents on vehicles** (step 4's Q5). The `document` branch of `agenda_items` counts
  a document whose thing is a vehicle as on when **Paperwork or Vehicles** is on in the location
  (`kept.module_on`), so a household with Vehicles and no Paperwork still hears about its car's
  licence. `SOURCE_MODULE` in shared gains the same rule for the web.
- [ ] **Step 7: Leak.** The estimate functions return nothing for B's meter (an empty set, not an
  error); the agenda under B's scope has no `reading_stale` rows of A. Add the functions to both
  lists. Commit: `feat(db): meter estimates, estimated due dates, stale-reading nudges and vehicle types`.

---

## Phase B: services and routes (T8–T16, parallel; each owns its files)

All routes follow step 2's rules: `scopedRead`/`scopedWrite` (`http/write.ts`) with
`requireMembership` + `requireCan`; `config.module` + `moduleLocation` where a module applies;
responses through `serialize/gates.ts`; every write through `audited()` with `requestId: req.id`; a
route-catalogue marker; lists as `{items, next_cursor}`.

### Task 8: Meters and readings, finished (`src/meters/`, `src/capture/`, `src/sync/`)

**Files:** `src/meters/{service.ts,routes.ts,estimate.ts,proofs.ts,undo.ts}`,
`src/capture/service.ts` (`captureReading`), `src/sync/handlers/log-reading.ts`,
`src/sync/snapshot.ts`; tests `meters/*.test.ts`, `capture/capture.test.ts`, `sync/ops.test.ts`,
`sync/snapshot.test.ts`

- [ ] **The contract changes.**

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/things/:id` (step 2) | each `meters[]` entry gains `estimate: {perDay: string\|null, basisDays: number\|null, ageDays: number\|null, advice: 'none'\|'fresh'\|'stale'\|'unknown'}` and `nudgeDays: number\|null` |
  | `PATCH /api/v1/meters/:id` (If-Match) | gains `nudgeDays?: number (7–365) \| null` (`meters.manage`) |
  | `POST /api/v1/meters/:id/readings` | gains `confirmJump?: true` and `proofFileId?: uuid` → 201 `{reading, state, reason?, undo}`. With `confirmJump`, an implausible jump is **accepted** (the audit records `confirmed: 'implausible_jump'`; Q9); backwards is still 409 |
  | `GET /api/v1/meters/:id/readings` | items gain `proof?: {attachmentId, fileId, thumbUrl}` and `ownedBy?: {type: 'fuel'\|'service', id}`; filters `f.when`, `f.source`, `f.state`, sort by `takenAt` |
  | `PATCH /api/v1/readings/:id`, `DELETE /api/v1/readings/:id` | a reading with an owner → 409 `reading_owned` with `ownedBy` (Q11) |
  | `GET /api/v1/meters/:id/proofs?cursor&limit` | the odometer proof strip (D195) → `{items: [{readingId: string\|null, value: string\|null, takenAt, fileId, thumbUrl, by: ActorRef}], next_cursor}`: reading-linked proofs, plus step-3 proofs still on the thing, dated by their attachment (Q10), newest first |

- [ ] **`estimate.ts`**: reads `kept.meter_estimate()` per meter; the thing view (step 2) calls it
  once per meter. **The perf check:** a thing page with 3 meters stays under 200 ms p95 (§3.1).
- [ ] **Proof on the reading** (Q10), in every writer:
  - `createReading()` gains `proofFileId`: `requireUsableFiles`, then `attachFiles(client,
    locationId, {meterReadingId: id}, 'proof', [fileId])` (extend `attachFiles`' subject union). Step
    4's service records pass `proofFileId` through `createReading`, so they get this too;
  - `captureReading()`: with a typed `readingValue`, the files attach to the new reading, not the
    thing; without one (AI or the inbox asks), they stay on the thing until the reading exists (T10
    moves them);
  - `log-reading.ts`: `proofFileId` attaches to the reading.

  kept_app can't UPDATE attachment subjects (0020's grant is `role, sort`), so moving one is a
  DELETE and an INSERT of the same file under the new subject, in one transaction.
- [ ] **Owned readings** (Q11): `updateReading`/`deleteReading` refuse a reading referenced by
  `fuel_entries.meter_reading_id` or `service_records.meter_reading_id` with 409 `reading_owned`. The
  inbox's reading actions (step 3) go through the same service, so a fill's reading that landed in
  the inbox is kept or edited there, and the fill follows it.
- [ ] **Undo** (D150): `registerUndo('reading.create', …)` deletes the reading if it still holds the
  value and time it was created with (else `undo_refused`); `registerUndo('reading.delete', …)`
  re-inserts it with the same id through the meters service, re-placed (D112), refused if it no
  longer fits. Owned readings are undone with their owner (step 4's service undo, T11's fuel undo),
  never alone.
- [ ] **The snapshot** (`sync/snapshot.ts`, which step 4 also edits for derived states: re-check it's
  clean first): each `SnapMeter` carries `latest` (the latest accepted reading's value and time,
  offset-corrected). No money, nothing else.
- [ ] **Tests:**
  - an implausible jump with `confirmJump` → accepted; without it → `needs_review` (step 2's
    behaviour, unchanged); backwards with `confirmJump` → still 409;
  - a READING capture with a typed value → the proof is on the reading, and the proof strip lists it;
  - a `log_reading` op with a proof → the same;
  - a fill's reading → PATCH 409 `reading_owned`;
  - undo of `reading.create` with nothing changed → deleted; after an edit → refused;
  - a reading bumps the snapshot: the phone's next delta has the thing with `meters[].latest`;
  - the estimate: 90 days of Corolla readings at about 62 km a day → `perDay` ≈ 62; the last reading
    34 days old → `stale`; 70 days → `unknown` with `perDay: null`.
- [ ] **Commit:** `feat(meters): estimates, confirmed jumps, proof photos on readings, owned readings and reading undo`.

### Task 9: Service drafts from an invoice (`src/services/`, step 4's `src/schedules/services.ts`; after step 4's T11)

**Files:** `src/services/{routes.ts,drafts.ts}`, step 4's `src/schedules/services.ts` (drafts,
suggestions, list filters); tests `services/drafts.test.ts`

Step 4's `POST /api/v1/service-records` stays the one way a service is saved (and what "Complete"
on a schedule calls). Step 5 adds:

- [ ] **Drafts** (Q12): `POST /service-records/drafts` creates a `review_state = 'draft'` record with
  its invoice attached (role `invoice`) and, when AI capture is effective and the caller may
  `ai.capture`, queues an extraction (`mode = 'receipt'`, `service_record_id` set) and sends the
  `extract` job in the same transaction (D94; T10 runs it). Drafts count nowhere (costs, reports,
  anchors, the agenda) and show on the Services tab as "Draft · finish logging". Confirming runs step
  4's create rules (the reading, the lines, `completes`) on the draft's row.
- [ ] **Routes.**

  | Method and path | Body → Response |
  |---|---|
  | `POST /api/v1/service-records/drafts` | `{id, subject: {thingId}\|{placeId}, invoiceFileIds: [fileId] (1–10)}` → 201 `{serviceRecord: ServiceRecord, extraction?: {id, status}}`. `logs.add`. `Idempotency-Key` required |
  | `POST /api/v1/service-records/:id/confirm` (If-Match) | step 4's POST body → 200 as its POST; 409 `reading_refused` when the reading doesn't fit, nothing written |
  | `GET /api/v1/service-records/:id` | → `ServiceRecord` (step 4's type) with the fields below |
  | `GET /api/v1/things/:id/service-records` (step 4) | gains `q`, `f.when`, `f.vendor`, `f.kind`, `f.draft`, `sort`, `dir` |
  | `DELETE /api/v1/service-records/:id` (step 4) | a draft may be deleted by its logger at any time, with its extraction |

  Step 4's `ServiceRecord` gains:

  ```ts
  reviewState: 'draft' | 'confirmed';
  flags: string[];                                   // 'total_mismatch' (reconcileTotal, ±1%)
  suggestions?: Array<{field: 'line' | 'vendor' | 'servicedOn' | 'total' | 'currency';
                       value: unknown; confidence: number;
                       source: {extractionId: string; attachmentId: string}}>;   // drafts only
  extraction?: {id: string; status: string; statusReason?: string; pausedUntil?: string};
  ```

- [ ] **Tests:** a draft with AI off has no extraction and no suggestions; with the mock provider it
  has a queued extraction (roll back the transaction: no job); a draft never re-anchors a schedule
  and never appears in costs or the agenda; confirming a draft whose reading runs backwards → 409
  and it stays a draft; a viewer can't create one; money in suggestions is withheld from a viewer.
- [ ] **Commit:** `feat(services): service drafts from an invoice, with AI suggestions`.

### Task 10: Extraction for step 5 (`src/extraction/`, `src/inbox/`; after T8, T9 and T12)

**Files:** `src/extraction/{apply.ts,job.ts,prompts/service-invoice.ts}`, `src/inbox/service.ts`;
tests `extraction/extraction.test.ts`, `inbox/inbox.test.ts`

- [ ] **The service invoice** (Q12). An extraction with `service_record_id` runs the RECEIPT path
  with the `service-invoice` prompt (a new prompt version; the §2.1 RECEIPT fields plus each line's
  optional `kind`). Nothing is applied: the vendor, date, total, currency and each line become the
  draft's `suggestions` (screens: "Suggested · line items from the invoice", violet and dashed until
  confirmed, D131). The currency rule stays (D136, D189: a bare `$` waits with no preselection). The
  ledger task stays `extract_receipt` (its CHECK is unchanged).
- [ ] **READING's proof** (Q10): when the extraction makes its `needs_review` reading, the capture's
  proof attachments move from the thing to that reading (delete and insert, as T8).
- [ ] **An AI-set type adds its default meter** (step-3 carry-over): when the extraction sets a type
  on a thing with no meter, and the type's chain has a `default_meter`, create it through the same
  path as `things/service.ts` `createDefaultMeter()` (export it) and record it in the same audit
  event. Undoing the extraction removes the meter only if it still has no readings.
- [ ] **The registration card** (D52; Q15): LABEL on a thing where `kept.is_vehicle_type(type_id)`
  and `documentKind` ∈ `registration · insurance · licence · inspection` with an `expiresOn` → the
  suggestion is a **document** (`{field: 'document', value: {kind, expiresOn}}`), not
  `things.expires_on`. VIN and plate stay the thing's field suggestions (step 3). Other things keep
  step 3's `expires_on` suggestion.
- [ ] **`inbox/service.ts` accept:** accepting a `document` suggestion calls step 4's document create
  (with T12's additions), re-attaching the label photo to the new document as `registration`; one
  audit event per written row.
- [ ] **Tests:** the mock provider's invoice with three lines → a draft with three suggested lines and
  kinds; a `$` invoice → the currency waits; a car's registration card → a `document` suggestion,
  accepted into an `expiring_documents` row with the photo; a fridge's label with an expiry → step
  3's `expires_on` suggestion, unchanged; an AI-typed "Car" gets an odometer; a READING extraction's
  proof ends on its reading.
- [ ] **Commit:** `feat(extraction): service invoices, registration cards as documents, default meters from AI types`.

### Task 11: Fuel and charging (`src/fuel/`)

**Files:** `src/fuel/{routes.ts,service.ts,summary.ts,undo.ts}`; tests `fuel/*.test.ts`

- [ ] **`service.ts`**: `logFuel(ctx, thingId, input)`, the one implementation behind the route and
  step 6's `log_fuel` tool (§2.5). Module `fuel` (which needs `vehicles`), `logs.add`.
  1. `amount > 0`; `cost ≥ 0` with a currency (the location's by default) (screens §7).
  2. With `reading`: the thing's distance meter (or `meterId`; a thing with no meter → 400
     `fuel_needs_meter`); `createReading(ctx, …, 'fuel')` at `takenAt`. Backwards → 409
     `reading_refused`, nothing written. `proofFileId` on the reading.
  3. The station: vendor `{id}` or `{name}`, created inline with kind `station`.
  4. A pump receipt photo: `receiptFileId` attaches to the entry as `receipt`.
  5. Audit `fuel.create`, undoable.
- [ ] **`summary.ts`**: loads the thing's fills (oldest first) with offset-corrected reading values,
  calls `@kept/shared` `consumption()` and the price and distance helpers, and gates money.
- [ ] **Routes.**

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/things/:id/fuel?f.when&f.unit&f.vendor&f.full&sort&dir&cursor&limit` | → `{items: FuelRow[], next_cursor}`; `FuelRow = {id, takenAt, amount, unit, isFull, missedBefore, cost?, currency?, moneyHidden?, pricePerUnit?, vendor?: {id, name}, reading?: {id, value, state}, receipt?: {attachmentId, fileId, thumbUrl}, loggedBy: ActorRef, rowVersion}` |
  | `POST /api/v1/things/:id/fuel` | `{id, takenAt, amount, unit, cost?, currency?, isFull, missedBefore?, vendor?: {id}\|{name}, reading?: {meterId?, value, proofFileId?}, receiptFileId?, note?}` → 201 `{entry: FuelRow, reading?: {id, state, reason?}, undo}`; 409 `reading_refused`. `Idempotency-Key` required |
  | `PATCH /api/v1/fuel/:id` (If-Match) | the POST fields except `id` → `FuelRow` (a changed odometer re-places its reading) |
  | `DELETE /api/v1/fuel/:id` (If-Match) | → `{undo}`; its reading is deleted with it |
  | `GET /api/v1/things/:id/fuel/summary?window=5&months=6` | → `{byUnit: [{unit, consumption: {perHundred: string, distanceUnit, fills, from, to} \| null, whyNone?, trend: [{at, perHundred}]}], pricePerUnit?: [{unit, currency, latest, trend: [{at, price}]}], perDistance?: [{currency, amount, distanceUnit, from, to}], monthlyAverage?: [{currency, amount, months}], moneyHidden?: true}` |

- [ ] **Undo:** `fuel.create` (delete it and its reading), `fuel.delete` (re-insert both from the
  audit image; refused if the reading no longer fits), `fuel.update` (the field image).
- [ ] **Tests:**
  - the Corolla's six months of fills (the mock fixture's numbers) → `7.3 L/100 km` over the last 5
    full fills, `1.75 EGP/km` fuel only;
  - a partial between two fulls counts; a `missedBefore` fill breaks only its interval;
  - an EV (kWh) → `kWh/100 km`; a plug-in hybrid with both → per-unit summaries and `whyNone:
    'mixed_units'` where intervals mix (Q6);
  - a fill's reading below the last → 409, nothing written;
  - a viewer: no cost, price or per-distance, `moneyHidden: true`;
  - `fuel` off in Garage → the routes answer as other module routes do ("Off in this location");
    readings logged earlier by fills stay in the series;
  - EGP and USD fills on one car → two currencies, never added together (Q22).
- [ ] **Commit:** `feat(fuel): fills and charges with consumption, prices and cost per km`.

### Task 12: Vehicle documents (step 4's `src/paperwork/documents.ts`)

**Files:** step 4's `src/paperwork/{documents,view}.ts`; tests beside step 4's

- [ ] Step 4's document routes gain:
  - `issuedOn?`, `cost?` and `currency?` on `POST /documents`, `PATCH /documents/:id` and
    `POST /documents/:id/renew`; `ExpiringDocument` gains `issuedOn`, `cost?`, `currency?`,
    `moneyHidden?` (the gate);
  - `thingId` on `GET /documents` (a vehicle's Documents tab);
  - the module rule: a document on a vehicle (`kept.is_vehicle_type`) needs **Paperwork or
    Vehicles** on (step 4's Q5; T7 step 6 does the same in the agenda).
- [ ] **Tests:** the Corolla's licence with a 30-day lead is `expiring` on 14 Oct in Cairo when it
  expires on 6 Nov; renewing with a cost puts the cost in the renewal's `issuedOn` month (T13); a
  viewer sees no cost; with Paperwork off and Vehicles on in Garage, the Corolla's documents still
  work; a document on B's car → 404.
- [ ] **Commit:** `feat(paperwork): issue dates, costs and the vehicles module on documents`.

### Task 13: Vehicles, costs, series and starter schedules (`src/vehicles/`, `src/home/`)

**Files:** `src/vehicles/{routes.ts,list.ts,costs.ts,series.ts}`, `src/schedules/starter.ts`,
`src/home/service.ts` (the quick log); tests `vehicles/*.test.ts`, `home/home.test.ts`

- [ ] **Routes.** Module `vehicles` (the list: locations where it's on).

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/vehicles?q&f.location&f.type&f.state&f.reading&f.due&sort&dir&cursor&limit` | → `{items: VehicleRow[], next_cursor}`. Global across the caller's locations with `vehicles` on (screens §1). Default `f.state=in_use` (Q24). Sorts: name, last reading, next due, location |
  | `GET /api/v1/things/:id/costs?from&to` | → `CostReport` (below). Default: the last 6 full months, plus the current month "so far" (D188) |
  | `GET /api/v1/meters/:id/series?from&to` | → `{unit, points: [{takenAt, value, source}], estimate?: {perDay, through: [{at, value}]}, thresholds: [{scheduleId, name, value, estimatedOn: string\|null}]}` (thresholds from step 4's schedules, dates from T7) |
  | `POST /api/v1/things/:id/starter-schedules` | `{keys?: StarterKey[]}` (all four by default) → 201 `{schedules: Schedule[], undo}`. Modules `vehicles` and `schedules`; `schedules-claims.manage`. Creates step 4's schedules through its service in one transaction, anchored today at the latest reading; skips a key whose name the vehicle already has (normalised). One audit event, undoable |

  ```ts
  type Estimate = {perDay: string | null; basisDays: number | null; ageDays: number | null;
                   advice: 'none' | 'fresh' | 'stale' | 'unknown'};
  type VehicleRow = {
    thing: ThingRow;                                   // short code, name, type, path, cover photo
    meter?: {id; unit; latest?: {value; takenAt; source; by: ActorRef}; estimate: Estimate};
    nextDue?: {name; dueOn?: string; dueValue?: string; estimated: boolean; state};   // agenda_items
    documentsDue: Array<{id; kind; expiresOn; state}>;
    fuel?: {perHundred: string; unit; distanceUnit};   // when the fuel module is on
  };
  type CostReport = {
    period: {from; to};
    distance: {value: string; unit; basis: 'readings'} | null;
    months: Array<{month: string /* YYYY-MM */; soFar: boolean;
                   byCurrency: Array<{currency; fuel: string; service: string; fees: string; total: string}>;
                   notes: string[] /* a service's summary, for the direct labels */}>;
    totals: Array<{currency; fuel; service; fees; total; perDistance?: string; monthlyAverage: string}>;
    moneyHidden?: true;                                // then months carry no amounts, only notes
  };
  ```

- [ ] **`costs.ts`** (D26, D188; Q5, Q22):
  - fuel = fills' `cost` by `taken_at`'s local month; service = **confirmed** service records'
    `total` by `serviced_on`; fees = current and superseded documents' `cost` by `issued_on` (none
    without a date);
  - per currency; converted only when the person asks for a report currency and step 4's rates cover
    it (its conversion helper, never estimated, D76);
  - distance = `distanceBetween()` over the full months only; `perDistance` over full months only;
    the current month is `soFar: true` and never averaged or compared (D188);
  - an hours meter gives "per hour" the same way (a generator).
- [ ] **`list.ts`**: the things whose type `kept.is_vehicle_type()` in locations where
  `kept.module_on(location, 'vehicles')`, under RLS. `f.reading` uses `kept.meter_estimate().advice`;
  `nextDue` and `f.due` read `agenda_items`. One query per page, measured in T25.
- [ ] **Home** (screens §6 Quick log): step 4's `HomeResponse` gains `meteredThings: number` (things
  with a meter the caller can `logs.add` on), so Home shows "Log a reading" only when there's one.
- [ ] **Tests:** the Corolla in Garage is listed for Ibrahim, Bruce and Alfred, not for someone outside
  Garage; with `vehicles` off in Garage it disappears from the list; the sold motorbike appears only
  with `f.state=sold`; the costs match the board's table (Apr–Sep 2026: 29,800 EGP, 2.63 EGP a km over
  11,346 km) from the mock fixture's rows; October is `soFar`; a viewer's costs have `moneyHidden` and
  no amounts; starter schedules on the Corolla create four schedules, and a second call creates none.
- [ ] **Commit:** `feat(vehicles): the vehicles list, running costs, meter series and starter schedules`.

### Task 14: Reminders for vehicles (after T7 and step 4's T14)

**Files:** step 4's reminder templates and scan (read its T14 for the paths), `src/meters/reminders.ts`;
tests beside them

- [ ] **Stale readings** (D52, D113): T7's `reading_stale` branch feeds step 4's scan with no engine
  change. Add its template: it names the thing, its path, the location and the local date (D188,
  L113): "Toyota Corolla · Garage › Bay 2: the odometer was last read 30 days ago". Opted into per
  user and location like every kind (D29); admins get it by default, viewers never.
- [ ] **Crossing a threshold** (D52: "a reminder fires when a reading crosses the threshold"): step 4's
  scan runs every 15 minutes and reads the newest accepted reading, so a crossing is caught within 15
  minutes. If step 4's engine exposes a per-subject scan, call it after an accepted reading (all four
  sources) so it fires at once; otherwise leave it to the scan and say so in the carry-over.
- [ ] **Estimated dates:** a unit schedule's `estimated_on` (T7) makes it due by date; "unknown" after
  60 days (D188) removes the date and the reminder says "reading needed".
- [ ] **Selling** (D52): a terminal lifecycle stops the thing's sources and keeps its history (§7.13,
  step 4's `<subject live>`); test that a sold Corolla's nudge and schedules raise nothing and its
  services stay.
- [ ] **Tests:** a meter last read 30 days ago in Cairo raises one occurrence, exactly once across two
  scans (D111), and a second when 30 more days pass; `nudge_days = NULL` raises none; a reading that
  crosses 55,000 km raises the oil change by the next scan; Egypt's DST dates (V21) don't move a
  nudge's day.
- [ ] **Commit:** `feat(reminders): stale-reading nudges and estimated schedule dates for vehicles`.

### Task 15: The vehicle history report (`src/reports/vehicle/`; after T11, T12)

**Files:** `src/reports/vehicle/{gather.ts,view.ts}`, `src/reports/template/vehicle.typ`,
`src/reports/{service.ts,routes.ts,jobs.ts}` (the kind); tests `reports/vehicle.test.ts`

- [ ] **Route.**

  | Method and path | Body → Response |
  |---|---|
  | `POST /api/v1/reports/vehicle-history` | `{thingId, from?, to?, include?: {costs?, proofPhotos?, fuel?, documents?}, locale?: 'en'\|'ar', digits?: 'western'\|'eastern'}` → 202, the same `Created` shape as the inventory report. Module `vehicles` in the thing's location; the same per-user rate limit (`RATE_LIMIT` runs an hour, shared with the other report kinds) |
  | `GET /api/v1/reports/:id` | unchanged (the run's state and a signed download once done) |

- [ ] **Content** (D51; Q16), gathered under the requester's scope and gates:
  1. A cover: the Label-tape brand, the vehicle's name, type, short ID (with QR), VIN (LTR), plate (as
     printed), location, "as of" date and who generated it (D188).
  2. Odometer history: every accepted reading with its source and who logged it, a small chart, and
     the proof strip's photos beside their readings. Rows are bounded (T0, V39): every reading with a
     proof photo or typed by hand, plus the latest of each month; no photo cap below 200.
  3. Services: each confirmed one with its date, reading, vendor, lines, total (money-gated) and
     invoice thumbnails.
  4. Fuel summary: consumption, fills per year, per-distance cost (money-gated). Omitted when `fuel`
     is off.
  5. Documents: kind, dates, state, cost (money-gated).
  6. Footer: the instance and generation time; page numbers; a table of contents (as the inventory
     report).
- [ ] **Security:** a viewer's report has no money unless the location allows it; secrets never
  appear (the vehicle's secret fields aren't read); photos go in as the GPS-stripped thumbnails
  (derivatives only, D117), never originals.
- [ ] **Tests:** English and Arabic PDFs render for the seed's Corolla (the step-2 helper
  `test/pdf.ts` reads their text); the Arabic run keeps the VIN LTR and the plate's letters in order;
  a viewer's PDF text has no amounts; a vehicle in B's location → 404; `vehicles` off → "Off in this
  location"; the run is audited `report.generate` with its kind.
- [ ] **Commit:** `feat(reports): the vehicle history report on the Typst engine`.

### Task 16: Seed (`src/seed/`)

**Files:** `src/seed/inventory.ts`, `src/seed/seed.test.ts`

- [ ] The Corolla gains, through the service layer (D152): six months of fills (a partial, one
  `missedBefore`), starter schedules, two services (an oil change completing "Oil & filter", and front
  brake pads), a vehicle licence due in 23 days with its renewal cost and an insurance document, and a
  proof photo on two readings. Alfred logs most; Bruce one service. Vendors are a service centre and a
  fuel station with neutral names (not the board's example dealer).
- [ ] بيت العائلة gains Alfred's car with Arabic entries and an EGP fill history, and a generator with
  an hours meter.
- [ ] Alfred's existing typo reading (523,400, held for review) stays: it is the inbox's example.
- [ ] `seed.test.ts` asserts the counts and the Corolla's consumption.
- [ ] **Commit:** `feat(seed): vehicles with fills, services, documents and proof photos`.

---

## Phase C: web (T17–T23, parallel by area; each starts on the mock)

Shared rules for these tasks:
- Build to the screens spec (§1, §5 "Log a service", §6 Quick log, §7 validation, §8 "Vehicles,
  settings and admin") and the Vehicles frames in `docs/design/kept-screens.html`
  (`05-vehicles-settings`, and "Log a service" in `06-people-types`).
- Controls follow screens §3: hidden for the role; "Off in this location" for a module (the Fuel tab
  when `fuel` is off, with "Turn on" for admins); disabled with the reason when offline ("Needs a
  connection") except logging a reading.
- Money: amounts render only when the response has them; `moneyHidden` shows the step-2 treatment.
- Digits (D143): readings, amounts, dates and counts follow the setting; short IDs and VINs Western
  and LTR; plates as printed.
- Tests use Vitest and Testing Library against the mock: keyboard, RTL, the viewer variant, the
  module-off variant and the offline variant (`MemoryStore` + `navigator.onLine=false`).

### Task 17: The Vehicles list (`/vehicles`)

**Files:** `routes/_app/vehicles.tsx`, `components/vehicles/list.tsx`, `components/filters/registry.tsx`
(the new filter definitions); tests

- [ ] `ListSurface` with surface `vehicles`: the filter strip (location, type, state, reading, due),
  the Display button (sort: Name · Last reading · Next due · Location; group: Location · Type; no
  layout), saved views, and pull to refresh (T3 added the route to `PULLS`).
- [ ] A row: cover photo, name, short ID chip, path, the odometer with "read 12 days ago" (advice at
  30 days, "unknown — reading needed" at 60), the next due item ("estimated ~14 Nov" when estimated,
  D52), a document due, consumption when `fuel` is on. Nothing truncated at 375: rows wrap.
- [ ] Empty: "No vehicles yet" · **Add a vehicle** (the create sheet with Car preselected), with "or
  read its registration card in LABEL mode" (engineering spec §5, D52).
- [ ] **Tests:** keyboard and RTL; the sold motorbike only under `state: sold`; Arabic digits; the
  stale and unknown rows; offline → "Needs a connection" (the list isn't in the snapshot).
- [ ] **Commit:** `feat(web): the vehicles list`.

### Task 18: The vehicle page: tabs, Overview, Readings with the proof strip, Schedules, Costs

**Files:** `components/vehicles/{vehicle-tabs.tsx,overview.tsx,readings-tab.tsx,proof-strip.tsx,
costs-tab.tsx,schedules-tab.tsx,starter-schedules.tsx}`, `components/charts/{bars.tsx,series.tsx,
chart-table.tsx}`, `components/things/thing-screen.tsx` (mount the tabs for a vehicle); tests

- [ ] **Tabs** (screens §8): a vehicle's `/t/<id>` shows Overview · Readings · Services · Fuel ·
  Schedules · Documents · Costs as `?tab=`; the phone keeps one scrolling page with pinned section
  chips (screens §5 Thing detail). Other metered things keep step 2's Meters section and step 4's
  schedules and services sections. `thing-screen.tsx` is edited by other work (step 4's T20 too):
  check `git status` first and keep the change to one mount point.
- [ ] **Overview** (the board's phone frame): the licence banner when a document is due; the odometer
  card (latest, "last reading 12 days ago, 2 Oct, from a photo by Alfred", "About 62 km a day over
  the last 90 days"); the schedules card; recent services; the fuel card; the documents card.
  "Estimates use the reading from 12 days ago. A fresh one keeps ~14 Nov honest; Kept nudges you at
  30 days." under the schedules.
- [ ] **Readings:** the readings list (surface `readings`) with owned readings linking to their fill
  or service; the **odometer proof strip** (D195): a horizontal timeline of dashboard photos with
  value and date, opening the photo viewer; the series chart with the estimate dashed to the next
  threshold and "Show as table".
- [ ] **Schedules:** step 4's schedule list for the thing, with "estimated ~date" labels (T7) and, on
  an empty list, **Starter schedules** (engineering spec §5 "Schedules, none") → a sheet listing the
  four with their intervals, each untickable → `POST /things/:id/starter-schedules`.
- [ ] **Costs** (the board's desktop frame): the stacked monthly bars (fuel · service and parts ·
  fees and insurance), direct labels on service months, October "so far" outside the bars, totals,
  per km, the monthly fuel average, "Show as table"; one currency per chart with a switch when there
  are several (Q22). A viewer without money sees distance only and the hidden-money notice.
- [ ] Charts are lazy chunks, keyboard-reachable with focus tooltips, and reduced-motion safe; each
  chart `<svg>` is `direction: ltr`, mirrored by geometry (T0, V38).
- [ ] **Tests:** the tabs in the URL; RTL (the time axis mirrors, digits follow the setting); the chart
  table matches the bars; the viewer variant; a 70-day-old reading shows "unknown — reading needed"
  and no estimated dates; starter schedules.
- [ ] **Commit:** `feat(web): the vehicle page with readings, the proof strip, starter schedules and running costs`.

### Task 19: Log a reading, everywhere (the step-3 carry-over)

**Files:** `components/readings/{log-reading-sheet.tsx,reading-field.tsx,first-reading.tsx}`,
`components/capture/{capture-screen.tsx,reading-target.tsx}`, `components/home/quick-log.tsx`,
`components/things/{meters-section.tsx,create-sheet.tsx}`, `offline/store.ts`
(`pendingReadings(meterId)`); tests

- [ ] **The sheet** (the board's "Log a reading" frame): the meter, the value (a decimal field with
  `inputmode="decimal"`, Eastern digits accepted through `westernNumber`), taken at (now by default,
  Kept's own date and time picker), an optional proof photo, a note.
  - **Online:** `POST /meters/:id/readings`. Fits → "Fits: 1,120 km since 51,220 km on 14 Sep, about
    62 km a day." Backwards → refused with the reason and **Meter replaced** (step 2's
    `recordReplacement`). A jump over the daily limit → "That's 34,120 km in 18 days, about 1,900 km a
    day, over this car's limit of 1,500. Is it right?" with **It's right** (resends with
    `confirmJump: true`) and **Edit** (Q9).
  - **Offline:** `store.enqueue({op: 'log_reading', payload: {id, meterId, value, takenAt, note?,
    proofFileId?}}, blobs)` with `idempotencyKey = 'read:' + id`. The sheet says "Saved on this phone.
    Kept checks it against your other readings when it syncs; if it doesn't fit, it waits in your
    Inbox." The meter card shows the pending value from `store.pendingReadings()` and the snapshot's
    `latest` (Q18), marked "waiting to sync".
- [ ] **READING capture gets a typed value** (carry-over): Capture in READING mode offers a value field
  beside the note. With a value, the shutter enqueues **`log_reading`** with the photo as
  `proofFileId` (not `create_thing`), online or offline. Without one, step 3's path stays (AI reads it,
  or the inbox asks).
- [ ] **Quick log:** Home shows "Log a reading" when `meteredThings > 0` (T13): a sheet that picks the
  metered thing (recent first) and then the meter. Offline, the pick comes from the snapshot's meters.
- [ ] **First reading** (D52; Q21): after creating a thing whose type has a default meter, the create
  sheet continues to "Add the first reading" (skippable).
- [ ] **Tests:** each online outcome; offline enqueue writes one `log_reading` entry with its blob and
  no `create_thing`; READING with a typed value enqueues `log_reading`; Arabic digits in the field;
  the first-reading step after creating a Car; a viewer has no Log a reading anywhere.
- [ ] **Commit:** `feat(web): log a reading online and offline, a typed value in READING capture, quick log and the first reading`.

### Task 20: Log a service, with the invoice read (after step 4's T21)

**Files:** step 4's `components/services/*` (+ `invoice-suggestions.tsx`),
`components/vehicles/services-tab.tsx`; tests

- [ ] **The invoice with AI** (screens §5, the board's frame): attaching an invoice creates the draft
  (`POST /service-records/drafts`); while the extraction runs, the lines area says "Reading the
  invoice…"; its suggestions appear violet and dashed ("Read by AI: 3 lines, total matches") with
  **Confirm all** and per-line Edit (D131); `$` asks USD or CAD with neither chosen (D189). Save sends
  `/service-records/:id/confirm`. Without AI, step 4's typed lines stay.
- [ ] **Completes:** a schedule is pre-ticked only when `matchSchedules` matches a line ("Matches 'Oil
  filter' · was estimated ~14 Nov · restarts at 55,120 km"); the others show "no matching line". This
  replaces whatever pre-tick rule step 4 shipped (Q13).
- [ ] **The proof slot** beside the odometer, joining the proof strip (D195), if step 4's screen
  doesn't have one.
- [ ] **Services tab:** the thing's service records, drafts first as "Draft · finish logging", with
  "Discard draft".
- [ ] **Tests:** the draft's suggestions confirm into lines; Completes pre-ticks by the matching line;
  a `$` invoice; the offline variant ("Needs a connection: it has money. A reading alone can be logged
  offline."); RTL.
- [ ] **Commit:** `feat(web): invoices read into service lines, and the services tab`.

### Task 21: Fuel and charging

**Files:** `components/fuel/{fuel-tab.tsx,log-fuel-sheet.tsx,fuel-summary.tsx}`; tests

- [ ] **Log fuel** (the board): amount and unit (L · kWh · gal, remembered per vehicle), cost and
  currency, full or partial, "I missed a fill-up before this one" (D170), the station (Combobox,
  create-inline as a station), the odometer (optional, with the neighbours message and proof slot),
  a pump-receipt photo, a note. Needs a connection (money; Q3).
- [ ] **Fuel tab:** the summary card ("7.3 L/100 km · last 5 full fills", "1.75 EGP/km fuel only",
  "≈ 3,300 EGP a month") in the person's units (Q7); the consumption and price trend charts; the fills
  list (surface `fuel`). When no consumption can be shown, `whyNone` in words ("Consumption needs two
  full fills with odometer readings").
- [ ] **Module off:** the tab shows "Fuel & charging is off in this location" with Turn on (admins).
- [ ] **Tests:** partial and full; imperial units show mpg; `whyNone` copy for each reason; the viewer
  sees litres and consumption but no money; RTL.
- [ ] **Commit:** `feat(web): fuel and charging with consumption and cost per km`.

### Task 22: Vehicle documents, and the registration card in the inbox (after step 4's T23)

**Files:** `components/vehicles/documents-tab.tsx`, step 4's document sheet (issued on, cost), the
inbox item view (the `document` suggestion); tests

- [ ] **Documents tab:** the vehicle's documents (step 4's rows, filtered by `thingId`) with state
  ("Due in 23 days", "Valid", "Expired"), dates, lead time, files, cost (money-gated); Add and Renew
  through step 4's sheet, which gains issued on and cost. The Registration card row reads "Read in
  LABEL mode: VIN, plate and licence expiry" with a Capture shortcut into LABEL mode on this vehicle.
- [ ] **Inbox:** a `document` suggestion reads "Vehicle licence · expires 6 Nov 2026" with Accept and
  Reject (and step 3's `y`/`n` keys).
- [ ] **Tests:** add and renew with a cost; the inbox suggestion accepted; the viewer variant; RTL dates.
- [ ] **Commit:** `feat(web): vehicle documents and the registration card suggestion`.

### Task 23: The history report sheet

**Files:** `components/vehicles/history-report-sheet.tsx` (reusing `components/reports/progress.tsx`
and the print sheet's structure); tests

- [ ] "History report" in the vehicle's action menu and on the Overview: a sheet with the period,
  what to include (costs, proof photos, fuel, documents), the language, then the step-2 progress and
  Download. Offline: disabled with the reason. Viewers may make one; the sheet says costs appear only
  if they can see money.
- [ ] **Tests:** the request body; progress to Download on the mock; offline disabled.
- [ ] **Commit:** `feat(web): the vehicle history report sheet`.

---

## Phase D: finish

### Task 24: A UI pass over the new screens

**Files:** fixes in `apps/web/**`; findings in `docs/audits/ui-<date>-step5.md`

- [ ] Screenshots of `/vehicles`, each vehicle tab, Log a reading (each outcome), Log a service with
  suggestions, Log fuel, the starter schedules and document sheets and the report sheet at 375, 768
  and 1280, light, dark and Arabic, on the seed.
- [ ] axe on each (nothing above minor); a Playwright keyboard walk: Vehicles → Corolla → Log a
  reading → Log fuel → Log a service → History report.
- [ ] Check against the board's Vehicles frames; fix every high and medium; carry the lows. (Not the
  second full audit, which stays before 1.0.)
- [ ] **Commit:** `fix(web): the step-5 UI pass` and `docs(audits): ui-<date>-step5`.

### Task 25: i18n, e2e, leak, perf, CI, docs and the device checklist

**Files:** `apps/web/src/locales/{en,ar,fr,de,it}/messages.po`; `apps/web/e2e/step5.spec.ts`;
`apps/server/test/perf/vehicles.perf.test.ts`; `scripts/ci-local.sh`; `docs/plans/step-5-carryover.md`;
product design §19 (V1, V3, V21, and the new V38, V39); engineering spec §1.6 (`is_full`,
`nudge_days`, documents' `issued_on` and `cost`, service drafts) and §7.13 (report kinds)

- [ ] **i18n:** extract once (in a temporary worktree at HEAD plus the step-5 files, so other agents'
  strings stay out) and translate every new string in all five catalogues, Arabic in the house style.
  A small commit of its own, re-checking the catalogues are clean right before.
- [ ] **Playwright**, on the `households` seed with `KEPT_AI_MOCK=1`, at 375×780 and 1280×800:
  1. **Offline reading:** open the Corolla online; go offline; Home → Log a reading → 52,900 km with a
     photo → "Saved on this phone"; online → it syncs, appears in Readings and in the proof strip.
  2. **A misfit by sync:** offline, log 25,000 km → online → the op answers `needs_review` → the inbox
     item "25,000 km is lower than …" → Meter replaced.
  3. **READING with a typed value:** Capture → READING on the Corolla → type the value → it queues
     `log_reading` (not a capture).
  4. **Service:** Log a service with the fixture invoice → three suggested lines → Confirm all →
     Completes "Oil & filter" pre-ticked → Save → the Services tab and Costs update; Undo from the
     toast.
  5. **Fuel:** two full fills and a partial → the summary's consumption; imperial units show mpg.
  6. **Registration card:** Capture LABEL on the Corolla with the fixture card → the inbox's document
     suggestion → Accept → the Documents tab.
  7. **Starter schedules** on a new car → four schedules with estimated dates after two readings.
  8. **Report:** make the history report in English and Arabic → Download → the PDF opens
     (`test/pdf.ts` reads its text).
  9. **A viewer** (the seed has no viewer in Garage: the e2e adds Talia as one): no Log buttons, no
     amounts.
  10. **Arabic RTL** on the vehicle page; axe on every page visited.
- [ ] **Leak:** `leak-vehicles.ts` covers every new table, column and function; the costs, fuel
  summary, series and report routes never return B's rows or a viewer's money (a JSON search of the
  responses and of the PDF text).
- [ ] **Perf** (`test/perf`, full mode): the vehicles list with 50 vehicles < 200 ms p95; costs over 5
  years (600 fills, 60 services) < 200 ms p95; the fuel summary over 600 fills < 100 ms p95;
  `agenda_items` with the new branches no slower than step 4's recorded figure by more than 20%; the
  report for 5 years under the job's memory limit. Record in `docs/perf/<date>-step5.md`.
- [ ] **CI:** `licences` passes with visx and its d3 dependencies; the e2e step runs `step5.spec.ts`.
- [ ] **Docs:** the engineering spec rows above; §19 rows for V38 and V39 with results;
  `docs/plans/step-5-carryover.md` (anything deferred, each with the step that takes it).
- [ ] **Gate:** `bash scripts/ci-local.sh` exits 0. **Commit:** `chore: step-5 i18n, e2e, leak and perf checks, CI and docs`.

---

## Needs the maintainer's devices (and real data), and how the build proceeds without them

Each item ships with a fallback first. The checklist is `docs/spikes/2026-09-30-step5-devices.md` (T0),
filled in from the diagnostics "Copy report" and by hand. Test over HTTPS, installed and in Safari.

| # | Check | Built meanwhile | If it fails |
|---|---|---|---|
| V1 | Vision models read the Corolla's real odometer (the maintainer's photos, 30 or more) | READING always waits for review (D19); a typed value is one tap away (T19) | Per-provider note "readings: confirm by hand"; the typed value becomes READING's default field |
| V3 | Real Egyptian registration cards are read (VIN, plate, licence expiry) | The document suggestion waits in the inbox (T10); the VIN checksum drops a wrong VIN | The Documents tab's manual entry |
| — | Real service invoices (Arabic and English) are read into lines | Suggestions only, never applied (T10) | Lines typed by hand, as step 4 ships |
| — | The decimal keypad in the installed iPhone app accepts Arabic-Indic digits and a decimal separator | `westernNumber` on every numeric field | A Western-keypad hint under the field in Arabic |
| — | Charts: tooltips by tap, horizontal drags don't arm pull to refresh, VoiceOver reads the table | "Show as table" on every chart | Charts become the table on phones |
| — | Offline Log a reading with a photo from the system camera in the installed app, then sync | The step-3 queue and uploader | Photo-less offline readings, photo added online |
| — | The history report downloads and opens from the installed iPhone app (signed link) | The step-2 download path | An "Open in Safari" link in the sheet |
| V21 | Reminders at the right local time across Egypt's DST changes (step 4's check, reused for nudges) | DST-date tests (T14) | Step 4's fallback |
| — | The maintainer's own fill-ups (a few months) give a sensible L/100 km | The consumption tests (T1, T11) | Adjust the interval rules, recorded as a decision |

The build **never waits** for a device result.

---

## Definition of done for step 5

- `bash scripts/ci-local.sh` exits 0, including `drift`, `licences`, `perf` and `e2e`
  (`step5.spec.ts`).
- The leak test covers every new table, column and function; no route or PDF gives a viewer money
  they may not see.
- Every non-GET route writes an audit row, or is on the route catalogue's allowlist with a reason.
- On a fresh `docker compose up`, seeded with `households`, on a phone over HTTPS:
  - `/vehicles` lists the Corolla with its odometer, age, next due and a document due;
  - Log a reading from Home, offline, with a photo: it syncs, fits, and shows in the proof strip;
  - Capture READING with a typed value: it queues `log_reading`;
  - an implausible jump asks "Is it right?"; a backwards reading is refused with "Meter replaced";
  - a reading that doesn't fit, arriving by sync, lands in the inbox;
  - add starter schedules to a car; with two readings, their distance due points read "estimated
    ~date";
  - Log a service from an invoice photo: AI suggests the lines, the matching schedule is pre-ticked,
    Save restarts it;
  - log fuel (full, partial, a missed fill): consumption and cost per km appear in the person's units;
  - read the registration card in LABEL mode: the inbox suggests the licence document;
  - the Costs tab shows the months by category with the current month "so far";
  - the history report downloads as a PDF in English and Arabic;
  - a stale-reading nudge raises once after 30 days.
- With no AI provider, everything above still works except the invoice lines and the registration
  card's reading, which are typed.
- With the Vehicles module off, its screens, routes and report are "Off in this location", and
  readings and services still work on any metered thing (D113).
- No fuel, service or document amount is ever in the phone's store; the snapshot's meters carry only
  `latest`.
- The device checklist is filled in, or each open row names the fallback in use. §19 is updated.
  `docs/plans/step-5-carryover.md` lists anything deferred, each with the step that takes it.

---

## Spec questions that are genuinely ambiguous, with proposed answers (adopt these)

1. **Where step 4 ends and step 5 starts.** §17 lists "services, … documents" under step 5, but D29
   (completing a schedule creates a service record) and D155 (expiring documents in the paperwork
   library) put them in step 4's way. **Proposal:** adopt step 4's own Q1 and Q5: step 4 builds the
   core service-record tables, their API, the Log a service screen without AI, schedules, expiring
   documents and the reminder engine; step 5 adds service drafts and AI invoice lines, the pre-tick
   rule, fuel, estimates (and the estimated dates in step 4's schedules), the `reading_stale` source,
   document issue dates and costs, starter schedules, the vehicle screens, costs and the history
   report. Where a shape is step 4's, step 5 extends it and never redefines it.
2. **What counts as a vehicle** on `/vehicles` (D26, D154). **Proposal:** a thing whose type reaches
   the built-in `vehicle` through `parent_id` or `copied_from_id` (`kept.is_vehicle_type`), in a
   location with Vehicles on. So cars, motorbikes, bicycles, generators and custom types under
   Vehicle. Other metered things (a boiler with hours) get readings and services but aren't listed.
3. **Fuel offline.** It's "the most frequent vehicle entry" (D28), but it carries money, which the
   phone never holds (screens §4, D36). **Proposal:** fuel needs a connection in step 5, as services
   do; the odometer alone can be logged offline. A queued `log_fuel` op is a 1.x candidate (a new op
   kind and payload version).
4. **Amounts when the Money module is off** (D13; `serialize/gates.ts` shows money only with the
   `money` module). **Proposal:** one rule everywhere: fuel and document costs follow the gate like
   step 4's service totals. With Money off, Kept records litres, odometer and consumption; costs and
   per-km figures are hidden with "Turn on Money to see costs" for admins. Household, where Vehicles
   is on, includes Money, so the default case shows them.
5. **Where "Fees & insurance" comes from** (the board's Costs tab; D26 "by category"). No table has a
   cost for it. **Proposal:** `expiring_documents` gains `issued_on` and an optional `cost` +
   `currency`; a renewal's cost counts in its `issued_on` month. No free-form "other expense" table in
   1.0.
6. **The consumption method** (D28, D170). **Proposal:** full-to-full intervals; partial fills in
   between count; an interval is skipped when an end lacks a reading, when any fill in it is marked
   "missed a fill-up", or when it mixes units (a plug-in hybrid). `full` on a charge means "charged to
   your usual full". The headline is the last 5 usable intervals.
7. **Units** (D76: "stored values are never converted"). **Proposal:** entries keep their stored
   unit; only the derived figure follows the person's units (metric: L/100 km, kWh/100 km; imperial:
   mpg, mi/kWh). `gal` is the US gallon, since UK and Canadian pumps sell litres.
8. **What "estimated" means** (D52, D188). **Proposal:** the rate is the accepted readings' rise over
   the 90 days before the latest reading, needing 2 readings at least 7 days apart. At 30 days old the
   reading gets advice; at 60 the estimate is "unknown — reading needed" and estimated dates
   disappear. One SQL implementation (`kept.meter_estimate`, `kept.meter_eta`) serves the API, the
   list, the report and step 4's `schedule_next` and scan.
9. **"It's right" for a jump at entry** (D26 "asks for confirmation"; step 2 keeps an online jump as
   needs-review). **Proposal:** the online form asks; `confirmJump: true` stores it accepted and the
   audit records the confirmation. By sync, a jump still goes to the inbox (D112), and a backwards
   reading is never confirmable.
10. **Which reading a proof photo proves** (D27, D195). Step 3 attached READING proofs to the thing.
    **Proposal:** proofs attach to their reading (`attachments.meter_reading_id`) from step 5 on. A
    one-off migration moves the step-3 proofs it can link through the capture's audit event; the rest
    stay on the thing and appear in the strip by date, without a value.
11. **Editing a reading that a fill or service made** (D52: one series). **Proposal:** such a reading
    is changed through its owner (409 `reading_owned` from the readings routes); deleting the fill or
    service deletes its reading (step 4 already does this for services); the inbox's reading actions
    still work on it, and the owner follows.
12. **AI on service invoices** (screens §5: "With AI capture on, extraction fills the line items").
    **Proposal:** no new capture mode. Attaching an invoice makes a **draft** service record, and the
    step-3 RECEIPT extraction runs on it with a `service-invoice` prompt that adds each line's kind;
    the results are suggestions on the form, never applied. Drafts count nowhere and stay on the
    Services tab until saved or discarded. The ledger task stays `extract_receipt`.
13. **Which line "matches" a schedule** (screens §5: "each ticked when a line item matches it").
    **Proposal:** a line matches when it contains every significant word of the schedule's name after
    Kept's normalisation (Arabic included). It only pre-ticks; the person decides.
14. **Deleting fills, and undo** (D150). **Proposal:** the same as step 4's service records: a real
    delete, undoable for 7 days from the audit image; the reading goes and comes back with it; an undo
    that would put back a reading that no longer fits is refused with the reason.
15. **The registration card** (D52: "read in LABEL mode: VIN, plate, licence expiry"). Step 3 suggests
    the expiry as the thing's `expires_on`. **Proposal:** on a vehicle, a registration, insurance,
    licence or inspection expiry becomes a suggested **document** with the photo; `expires_on` stays
    for other things (a fire extinguisher, D141).
16. **Who can make a history report, and what it holds** (D51, D201, D113). **Proposal:** anyone who
    can see the vehicle, viewers included, in a location with Vehicles on; money per the gate; proof
    photos as GPS-stripped thumbnails, uncapped up to 200 (T0, V39); English or Arabic, like the inventory
    report.
17. **Report kinds** (step 4 adds `report_runs.kind` as a list: `inventory`, `insurance`).
    **Proposal:** step 5 re-creates the list with `vehicle_history` and adds `thing_id`, required for
    that kind only. (A pattern CHECK validated by the API would spare later steps this migration; it's
    step 4's to choose, and either works.)
18. **The latest reading on the phone.** **Proposal:** the snapshot's `SnapMeter` carries `latest`
    (value and time: not money, not secret), bumped by a trigger on readings, so offline "Log a
    reading" shows the last value and "waiting to sync". It's additive: an older phone ignores it.
19. **The stale-reading nudge's setting** (D52 "per-vehicle … 30 days by default"). **Proposal:**
    `meters.nudge_days` (7–365, default 30, NULL for none), set by owners and admins (`meters.manage`);
    a thing with several meters nudges per meter; only `in_use` things nudge; none before the first
    reading.
20. **Service lines that use stock** (D170). **Proposal:** step 4 already leaves
    `consumable_thing_id` and `consumed_quantity` to step 7's consumables; step 5 doesn't add them.
21. **The first reading** (D52: "prompted when a metered thing is created"). **Proposal:** the create
    sheet asks for it as a skippable second step; the server doesn't require it.
22. **Costs in several currencies** (D76, D136). **Proposal:** per currency, never added together; a
    chart shows one currency at a time with a switch. With step 4's rates, a report currency can be
    chosen and the chart says it's converted; without a rate for a pair, those costs stay listed
    apart, never estimated.
23. **Where "Log a reading" lives** (screens §6 Quick log: "from Home and from the vehicle").
    **Proposal:** a Home action shown when you have a metered thing you can log on, the vehicle's
    Overview and Readings, any meter card, and READING capture with a typed value.
24. **Sold vehicles on the list** (D52 "keeps its history"). **Proposal:** the list defaults to "In
    use"; the state filter shows sold, given away and the rest; their pages, costs and reports stay.
25. **Starter schedules and miles** (§3.4 gives the starter list in km). **Proposal:** on a meter in
    km they're created as listed; on a meter in miles they get the month intervals only, and the sheet
    says to set the distance by hand (no rounded conversion presented as advice). They are never
    created automatically: the person asks, from the empty Schedules tab.

---

### Critical files for implementation
- docs/plans/2026-09-30-step-4-household.md (T5, T6, T11, T12, T14, T21, T23, and its Q1–Q5: the
  shapes step 5 extends)
- apps/server/src/meters/{service,check,routes}.ts (`createReading`, `placementOf`, `placeReading`,
  the routes' header contract), migrations 0017/0018 (meters, readings, grants) and 0047
  (`kept.touch_thing_meters`, `things.meter_version`)
- apps/server/src/capture/service.ts (`captureReading`, `attachFiles`, `requireUsableFiles`),
  apps/server/src/sync/handlers/log-reading.ts, apps/server/src/sync/snapshot.ts,
  packages/shared/src/sync.ts (`SnapMeter`, `LogReadingPayload`)
- apps/server/src/extraction/{apply,checks}.ts (the LABEL suggestions for `vin`, `plate`,
  `expires_on`; the READING reading), apps/server/src/things/{service,fields}.ts
  (`createDefaultMeter`, `defaultMeterOf`), migration 0014 (`kept.type_chain`)
- apps/server/src/reports/{service,gather,view,jobs,routes}.ts, reports/render/*,
  reports/template/report.typ, src/db/schema/reports.ts
- apps/server/src/serialize/gates.ts, audit/{audited,classes,undo}.ts, http/{write,modules,
  conventions}.ts, test/leak.test.ts and the earlier steps' fill files, src/db/migrate.test.ts,
  migrations/meta/_journal.json (the next free number)
- apps/web/src/components/{list-surface,pull-to-refresh,app-shell}.tsx, components/filters/*,
  components/things/{meters-section,thing-screen,create-sheet}.tsx, components/capture/
  {capture-screen,reading-target}.tsx, components/reports/*, offline/{store,queue}.ts,
  packages/shared/src/list-views.ts
- docs/design/kept-screens.html (the Vehicles frames in 05-vehicles-settings, "Log a service" in
  06-people-types), docs/specs/2026-09-26-kept-screens.md §5, §6, §8
