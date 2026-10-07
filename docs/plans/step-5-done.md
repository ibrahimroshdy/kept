# Step 5: the definition of done, item by item

T25 wrote this on 2026-10-07. It takes each item of "Definition of done for step 5"
([2026-09-30-step-5-vehicles.md](2026-09-30-step-5-vehicles.md)) and marks it **met**, **met with
a note**, **not met**, or **maintainer check pending**. A pending item needs the maintainer's
phone, his real data or a fresh install, and the fallback in use is named. The evidence is a test
(file and title), a commit or a document. What is still open, and where it goes, is in
[step-5-carryover.md](step-5-carryover.md).

**Summary:** 7 met or met with a note, 3 not met (the one-run gate, perf, and the e2e's clean run),
and the walkthrough on a fresh install is a maintainer check. Most of the walkthrough's steps are
covered by server and component tests, and several by e2e runs that passed.

**The machine.** From 2026-10-06 evening the shared dev Postgres (5452) was overloaded by other
agents' suites:
- checkpoints took 49–83 s, forced by their `DROP DATABASE`s;
- a plain schedule read hit the 15 s `statement_timeout` while seeding (code 57014);
- at 21:47 UTC Postgres crashed and recovered (an untracked child exited, all backends were
  terminated);
- load was 15–65.

Every gate below that needs the database ran in that window, or did not run.

## 1. `bash scripts/ci-local.sh` exits 0, including `drift`, `licences`, `perf` and `e2e` (`step5.spec.ts`): **met in the final check, except the release dry run (disk)**

**Final check (2026-10-07).** The gate at 825c4c5, as `KEPT_TEST_RESTIC=1 KEPT_RELEASE_DRY_RUN=1 bash scripts/ci-local.sh`
(restic 0.19.1 darwin, checked against the spike's SHA-256; no smoke override), run from the top
and re-run `--from` the step that failed after each fix, in the main tree with no other agent on
the machine: install 1 s, lint 6 s, catalogues 3 s, typecheck 11 s, compose 1 s, test 511 s
(5,868 tests), drift 3 s, licences 2 s, attribution 1 s, docs 13 s, helm 1 s, prod-boot 17 s,
eval 36 s, portability 22 s, backup 135 s (the real restic), perf 554 s, e2e 633 s (76 passed,
42 one-project skips, the update spec 1), images 252 s: **all ok**. `release-dry-run`: built,
pushed by digest and smoked arm64 (PASS), then **stopped by hand at 3.3 GB free** (the agent
rules' 5 GB floor; it needs 15 GB, `KEPT_RELEASE_MIN_FREE_GB`); not completed. What failed on the
way and was fixed: 7a1c6a4, 900f425, 3062671, 9c1a70a, 95ad483, f6a925e, a7faf33, 825c4c5.

What T25 recorded before it:

- **Not run as one gate.** The database was unusable for long stretches (see above), and `perf`
  fails by design until the carry-over's agenda fix lands (§3).
- **lint and catalogues: ok.**
  - `check-i18n`: "4718 messages; every one is in the catalogues".
  - `check-i18n-extract`: "extracting adds nothing to ar, de, en, fr, it; no empty translation".
  - 24e3d92 fixed `check-i18n` so a one-word plural branch (`{thing}`) is no longer taken for a
    placeholder (an ICU walk, with tests in `scripts/check-i18n.test.mjs`).
  - The catalogues were reconciled and two pending appends committed. The coordinator asked for
    this. It landed in b10a0b4, which another agent committed by path.
- **typecheck: ok** for server, web and `e2e` (`tsc -p e2e`), at each of T25's commits.
- **Web suite** (`vitest --project @kept/web --maxWorkers=3`, in the shared main tree, which also
  holds other agents' uncommitted work): 1,455 passed and 11 failed in 10 of 138 files. Run alone,
  9 still fail:
  - three in step-5 screens: `fuel.test.tsx` "refuses an odometer lower than the reading
    before it", `contract.test.tsx` "a backwards reading is refused", and `vehicle-services.test.tsx`
    "makes a draft, Confirm all…";
  - six elsewhere: `home`, `ops-shell`, `paperwork`, `people`, and two in `sidebar`.

  These failures were not checked on a clean tree of HEAD. That run was stopped, so whether they
  come from HEAD or from uncommitted work is not established. The step-5 three expect English
  words ("Lower than the reading before it (52,541 km)", "Log a service") that a70f9e6's UI pass
  (units and digits in the reader's language) may have changed. That is inferred, not checked.
- **Server suite: not run in full.** The files T25 touched pass: `schedules`, `meters` and
  `incidents` at 9ec67d9, 101 tests, one 20 s timeout passing alone. The seed test at HEAD failed
  during the database stall, with "Extension cord, 10 m: 500", a statement timeout.
- **e2e:** see §4.

## 2. The leak test covers every new table, column and function; no route or PDF gives a viewer money: **met**

- `test/leak-vehicles.ts` (written by T4–T6) fills every step-5 table and column for both tenants:
  meter nudges, a reading with its proof, a service draft with its invoice and extraction, a fill
  with its reading and receipt, document costs, and a `vehicle_history` report run. `leak.test.ts`
  runs it with the step-2–4 fixtures.
- Viewer money:
  - `vehicles/vehicles.test.ts` "give a viewer the months and their notes, and no amounts";
  - `fuel/fuel.test.ts` "shows a viewer litres, odometer and consumption, and no cost, price,
    receipt or per-km";
  - `reports/vehicle.test.ts` "gives a viewer no amounts…" (the PDF text has no "EGP");
  - `services/drafts.test.ts` "shows the succeeded read as suggestions; a viewer gets no amounts";
  - in a browser, `e2e/step5.spec.ts` "Talia, a viewer of the Garage…" passed on 2026-10-06 run
    3: no Log buttons, no figure beside a currency, and `/costs` answers `moneyHidden`.
- Not checked by T25 in this run: `leak.test.ts` itself (the server suite did not run, §1).

## 3. Every non-GET route writes an audit row or is allowlisted: **met with a note**

`test/route-catalogue.test.ts` holds this. The step-5 routes carry `// catalogue:` markers in
their tests, for example `reports/vehicle.test.ts` `POST /api/v1/reports/vehicle-history`, and
`schedules.test.ts` snooze and complete. **Note:** this was not re-run by T25 in its gate (§1).

## 4. The walkthrough on a fresh `docker compose up`, on a phone over HTTPS: **maintainer check pending**

The device rows are in [2026-09-30-step5-devices.md](../spikes/2026-09-30-step5-devices.md). Each
is "maintainer check pending", with its fallback. What covers each step today:

| Step | Covered by |
|---|---|
| `/vehicles` lists the Corolla with odometer, age, next due, a document due | `vehicles.test.ts` "lists the Corolla for Ibrahim, Bruce and Alfred, with its odometer, estimate, next due, documents and consumption"; `vehicles-list.test.tsx`; e2e Arabic run (`/vehicles`, run 3) |
| Log a reading from Home, offline, with a photo: syncs, fits, in the proof strip | `readings.test.tsx` "queues one log_reading with its photo…"; `meters/step5.test.ts` "hangs the proof photo on the reading…"; e2e journey 1 written. Its last failure was the phone's copy not yet holding a new car, and the wait added for that has not run since |
| Capture READING with a typed value queues `log_reading` | T19 component tests; not in the e2e (carry-over) |
| A jump asks "Is it right?"; backwards is refused with "Meter replaced" | `readings.test.tsx` "a jump over the daily limit asks first…", "backwards is refused…"; `meters/step5.test.ts` "keeps an implausible jump for review, unless confirmed" |
| A reading that doesn't fit, by sync, lands in the inbox | **e2e passed** (journey 3, run 2) |
| Starter schedules, estimated dates after two readings | `vehicles.test.ts` "makes the four on a car in km…"; `vehicle-page.test.tsx`; the e2e journey reached the dialog. The last run timed out on a page heading under load |
| Log a service from an invoice: AI lines, pre-tick, Save restarts the schedule | `services/drafts.test.ts` "logs it under the create rules and completes a schedule…"; in the e2e (run 3) the mock read 3 lines, Confirm all, Save and "Service logged" all worked, and the check failed only on the total's shape (`{amount, currency}`), since fixed |
| Fuel (full, partial, missed): consumption and cost per km | `fuel.test.ts` "gives the Corolla's 7.3 L/100 km…", "breaks only the interval a missed fill-up is in…"; e2e run 3 reached "7.5 L/100 km" and failed only the soft axe check (heading-order, fixed by T24's a70f9e6) |
| Registration card in LABEL mode, then an inbox document suggestion | `documents-tab.test.tsx`, the server's extraction tests; run by hand on the real server in T24's review |
| Costs: months by category, the current month "so far" | `vehicles.test.ts` "match the board's table: 29,800 EGP over 11,346 km…"; `vehicle-page.test.tsx` |
| The history report as a PDF in English and Arabic | `reports/vehicle.test.ts` "renders the Corolla in English and Arabic…"; **e2e passed** (journey 7, runs 2 and 3) |
| A stale-reading nudge raises once after 30 days | `reminders/vehicles.test.ts` "a meter last read 31 days ago in Cairo reminds once across two scans…" |
| With no AI provider, the invoice lines and card are typed | `services/drafts.test.ts` "with AI capture off, a draft has no read and no suggestions"; in the e2e, a location without a provider showed "AI is paused here … Type the lines" |
| Vehicles off: "Off in this location", readings and services still work | `vehicles.test.ts` "drops the Garage's vehicles with Vehicles off there"; `fuel.test.ts` "answers 'off in this location' with Fuel off…"; `reports/vehicle.test.ts` (409 `module_off`) |
| No amount in the phone's store; meters carry only `latest` | `sync/snapshot.leak.test.ts` "has no money, secret, document, note or contact field"; `sync/snapshot.test.ts` "carry a thing whose meter got a reading, with the latest (step 5, Q18)" |

**The e2e as a whole: met in the final check.** `step5.spec.ts` passed whole in the gate's e2e (all
9 journeys). Four had failed in the first gate run, and two of those were product bugs: an offline
reading whose proof photo the location already had was dropped as `target_missing` (fixed in
9c1a70a: the op carries the photo's hash, as a capture does), and "Service logged" had no Undo
(95ad483). The other two were the spec's (f6a925e): it went offline before the vehicle's sections had
loaded, and matched the chart's hidden data table. Undo of a confirmed service makes it the draft
again, as `services/drafts.ts` intends; the spec now says so. Before the final check:
- `step5.spec.ts`: 9 journeys. The best full run (run 3, load 37–50) had 3 passed and 6 failed.
  Every failure had a spec-side cause, fixed afterwards, or was a timeout under load. The four
  runs after the last fixes never started, because the instance failed to seed (statement
  timeouts, the Postgres crash) or missed the 300 s start.
- `step4.spec.ts`: the 7 step-4 journeys that were not in a browser, in 11 tests. Each new journey
  passed in at least one full run. The last full run (load 65) had 6 passed and 5 failed, all 10 s
  waits on slow writes, and the waits are now 30 s. The existing schedules test never passed in
  this window; it has a statement timeout and a pending write. Two existing tests were updated for
  the step-4 rows now in the seed (the drill is already lent; Home's Due link goes to Expiring).
- axe found one real step-5 issue, a second "Fuel" landmark on a phone's one-page vehicle, fixed in
  395eba8.

## 5. No fuel, service or document amount in the phone's store: **met**

See the snapshot rows in §4. `SnapMeter.latest` is a value and a time only.

## 6. The device checklist is filled in or names its fallback; §19 updated; the carry-over: **met**

- [2026-09-30-step5-devices.md](../spikes/2026-09-30-step5-devices.md): every row reads
  "maintainer check pending (2026-10-06): the 'In use now' fallback ships".
- Product design §19: V1, V3, V21 and V38 carry their step-5 state. V39's spike result stands. The
  build's own five-year render is 2.0–3.8 s and under the 512 MB limit
  ([docs/perf/2026-10-06-step5.md](../perf/2026-10-06-step5.md)).
- The engineering spec is updated (22a0379):
  - §1.6: `nudge_days`; proofs on `attachments.meter_reading_id`; owned readings; service drafts
    (`review_state`); `is_full`; documents' `issued_on` and `cost`.
  - §7.13: the report kinds with `thing_id`, one owner per reading, `fuel_entries_reading_thing`.
- [step-5-carryover.md](step-5-carryover.md) is written.

## 7. Perf: **met in the final check**

[docs/perf/2026-10-07-final.md](../perf/2026-10-07-final.md): every limit passes, alone on the
machine. Home with the vehicles p95 63.2 ms (limit 110.4), the agenda's first page 46.9 (146.5), the
Vehicles list 64.3 (200). Before (T25's two runs under load):

[docs/perf/2026-10-06-step5.md](../perf/2026-10-06-step5.md). Two runs, both under other agents'
load. These pass:
- the costs over five years: p95 179 ms against 200;
- the fuel summary over 600 fills: 95 ms against 100;
- a thing page with 3 meters: 88 ms against 200;
- the five-year report: under 512 MB.

These miss:
- Home and the agenda with step 5's branches: 849 and 758 ms p95. That is 2.2× and 1.6× their own
  figure before the vehicles, in the same run, against limits of 110 and 147 ms.
- The Vehicles list: 1,026 ms against 200.

The limits were not loosened. The cause is inferred to be one `kept.meter_estimate` per unit
schedule (never inlined) over all of a meter's readings. Carried over.

## Found and fixed by T25

- 24e3d92: `check-i18n` takes plural branches as text (ICU walk).
- 9ec67d9: the pg "client is already executing a query" warning. `serviceImage`, the service
  list, a reading's placement, the readings page and an incident read no longer run `Promise.all`
  on one client.
- 395eba8: the Overview's fuel card is no second "Fuel" landmark on a phone (axe
  landmark-unique), and the web's `Brand` type carries `hasLogo`.
- b6afaef: `test/perf/vehicles.perf.test.ts`, step 4's fixture shared (`household.ts`,
  `timing.ts`), and the perf doc.
- 8e0e6ec:
  - `step5.spec.ts`, the `vehicles` instance (port 8189, AI mock);
  - a fixture invoice (`make-invoice.mjs`, its mock answer);
  - step 4's seven journeys.
- 22a0379 (committed by the coordinator from T25's edits): the README's status and seed note, the
  spec rows, §19 and the device checklist.
