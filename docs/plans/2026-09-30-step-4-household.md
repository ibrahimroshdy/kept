# Step 4: Household modules. Implementation plan

**Goal:** make Kept remember what the household's things need, and tell the right people in time.
The build-order row (product design §17, D130, D185) is: money in the supported currencies,
valuations, incidents, the insurance report and claim packs shared by an expiring download link
(D158, D201), expiring things (D141), the calendar feed (D142), warranties and claims, schedules and
reminders (the core engine, D111, D113), lending and borrowing, the paperwork library, and the
channels email, web push and webhook. Concretely:
- **money** (Money module, D14, D136, D158, D168):
  - exchange rates entered per account, per pair and date (`fx_rates`), and one conversion helper
    that never estimates (D76);
  - dated valuations, with the thing's **current value** (D158);
  - the AI money caps finally counting other currencies through those rates (step-3 carry-over).
- **warranties and claims** (D53–D55, D158, D195):
  - several warranties per thing, by kind, with defaults from the brand or type and the purchase
    date, a registration flag and deadline, and the coverage bar;
  - claims and repairs whose `in_repair` state makes the thing read "at <service centre>";
  - brand logo uploads (step-2 Q9).
- **lending and borrowing** (D56, D57, D119, D172): loans out and in, partial quantities that split
  and merge back, condition photos, and the derived states lent, borrowed and in repair everywhere
  (thing page, path, search, Home, the offline snapshot).
- **schedules** (D29, D39, D52, D162): on things and places, "every N units and/or M months,
  whichever first", one-off dates, snooze, skip, and completion through a **service record**, whose
  core tables and "Log a service" screen land here (Q1).
- **paperwork** (D39, D155, D172): the library across locations, documents on a location or place,
  and expiring documents that renew while keeping the old one.
- **expiring things** (D141): `things.expires_on` (already a column) as a reminder source.
- **the reminder engine** (D29, D111, D113, D122, D162, D188): one agenda computed from every
  source, a scan every 15 minutes that writes each occurrence exactly once, deliveries exactly once
  per user and channel, a daily digest in the user's timezone, overdue sent immediately, quiet
  hours, per-location opt-ins, pausing by module, trash and lifecycle.
- **channels** (D30, D130, D139, D166): email (five languages), web push (VAPID, service worker,
  the iPhone install rule), a personal webhook, and admin alerts reaching push too.
- **the notification centre** (D39): the bell, the list with inline Complete, Snooze and Mark
  returned, and the in-app side of the notices that steps 1–3 could only mail (new members,
  memberships ending, AI caps, the AI monthly summary opt-out).
- **the calendar feed** (D142, D181).
- **incidents, the insurance report and claim packs** (D158, D169, D201): incidents grouping things,
  the insurance report as a generated PDF plus CSV, and a claim-pack ZIP behind an expiring download
  link.
- **step-3 carry-over** assigned to step 4 (`docs/plans/step-3-carryover.md`): offline thing and
  place pages, codes, sync ops, the UI audit's lows, and the smaller web items.

**Architecture:** the same as steps 2 and 3. What's new:
- **One agenda, computed, never stored.** A `security_invoker` view, `public.agenda_items`, turns
  every reminder source (schedules, warranties and their registration deadlines, expiring
  documents, loans, thing expiries) into rows with a due point, a state and the module it belongs
  to. Requests read it under row-level security as `kept_app`; the scan reads it as `kept_system`.
  Home's counts, the Schedules, Lending and Expiring screens, the calendar feed, the scan (and in
  step 6 MCP's `upcoming`) all read this one view, so a count and the list it opens always agree.
  Pausing (a module off, a trashed subject, a terminal lifecycle) is a `WHERE` in the view, derived
  at read time (§7.6, D162).
- **Occurrences and deliveries are the only stored reminder state** (D111, §7.13). The scan
  inserts `reminder_occurrences` with `ON CONFLICT DO NOTHING` on the D111 key, cancels or
  supersedes the open ones the agenda no longer shows, and fans each new occurrence out to
  `notifications` (in-app) and `reminder_deliveries` (one per user and channel). Sending happens
  in jobs; **a failed send never fails a write** (L112).
- **The service worker gains `push` and `notificationclick`.** Nothing else about the PWA changes.
- **Step-4 writes are online only.** The offline matrix (screens §4) has no lend, schedule or
  warranty action, so no new sync op is added; the snapshot only gains the derived states.

**Before you start (status on 2026-09-30).**
- `git log` ends at `a010a9a` (D212 pull-to-refresh review). Step 3 is done except two items in
  `docs/plans/step-3-done.md`: `prod-boot` must be re-run once the stray port-8080 server is
  stopped, and the phone walkthrough is a device check pending. Neither blocks step 4.
- Migrations run through **0047** (`0047_thing_meter_version`, journal idx 47). Phase A starts at
  **0048**. The migration owner re-reads `apps/server/migrations/meta/_journal.json` first and starts
  at the next committed number if it has moved.
- Built in steps 1–3 that step 4 **uses and does not rebuild**:

  | Built | Where | Step 4 uses it for |
  |---|---|---|
  | `audited()`, `renderAudit()`, the undo registry and `X-Kept-Audit-Event` (§7.7) | `src/audit/{audited,render,undo}.ts`, `src/http/write.ts` `AUDIT_EVENT_HEADER`, `src/undo/registry.ts` | every write; each task registers its own undo handlers with `registerUndo()` |
  | The filter strip, saved views (D205) and the Display button (D211) | `apps/web/src/components/filters/*`, `packages/shared/src/list-views.ts` | every new list; new `LIST_SURFACES`. `saved_views.surface` is a pattern CHECK (0034), so **no migration** for a new surface |
  | `ListSurface`, pull to refresh (D212) | `components/list-surface.tsx`, `components/pull-to-refresh.tsx` | every new list and page |
  | Money gates | `src/serialize/gates.ts` (`gateFor`, `moneyProps`, `stripMoney`), `packages/shared/src/money.ts` (`canonicalAmount`) | valuations, claim costs, service totals, the report; money is gated **at serialisation**, as for purchases, not by RLS |
  | Admin alerts, mail in five languages | `src/alerts/alerts.ts` `raiseAlert()`, `src/db/schema/alerts.ts` `ADMIN_ALERT_KINDS`, `src/mail/messages*.ts`, `src/mail/render.tsx` | reminder mail, digests, `reminders_not_scanned` |
  | The job queue | `src/jobs/{policies,system,queue,boss}.ts` | the scan, deliveries, digests, webhook sends, claim packs |
  | The report engine (Typst, D201, V34) | `src/reports/{service,jobs,routes}.ts`, `reports/render/*`, `reports/template/report.typ`, `report_runs` | the insurance report is a second template on the same engine |
  | Attachments with typed subjects | `src/files/routes.ts` (`OWNERS`, `CreateAttachmentBody`), `attachments` (0019/0020) | warranty documents, condition photos, invoices, incident and expiring-document files |
  | The SSRF guard | `src/net/ssrf.ts` (`guardedFetch`, `isPrivateAddress`) | the webhook channel and push endpoints |
  | Envelope crypto and key rotation | `src/crypto/envelope.ts` (`seal`, `open`), `src/secrets/rotate.ts` (its table registry) | webhook secrets and the VAPID private key |
  | Home's checklist and attention sections (D185) | `src/home/service.ts` `HomeResponse`, `apps/web/src/components/home/attention.tsx` | the new rows plug in here |
  | The offline store and snapshot | `packages/shared/src/sync.ts` `SnapThing`, `src/sync/snapshot.ts`, `apps/web/src/offline/*` | the derived states, and the offline thing and place pages (carry-over) |
  | The quiet-bump pattern | `0047_thing_meter_version.sql` (`meter_version`, `kept.touch_thing_meters()`) | `things.state_version`, so a loan or claim resends the thing to phones |
  | `kept.move_things()` (0021, 0024, 0047) | the definer | carrying the new children across locations and accounts |
  | The AI layer | `src/ai/*` | **not used** by step 4: email-in receipts (D21) are 1.x |

**Tech stack.** The pins from steps 1–3 hold. New packages, each looked up with `npm view` on
2026-09-30. Pin them exactly; read each `.d.ts` before relying on an API.

| Package | Version | Licence | Used by |
|---|---|---|---|
| `web-push` | 3.6.7 | MPL-2.0 (on `scripts/check-licences.mjs`'s `RUNTIME_ALLOWED`); deps `asn1.js`, `http_ece` 1.2.0, `https-proxy-agent`, `jws`, `minimist` (the `licences` step checks them) | server: `sendNotification(subscription, payload, options)` with `options.vapidDetails {subject, publicKey, privateKey}`, `TTL`, `urgency`, `topic` (≤ 32 URL-safe base64 characters), `timeout`, `agent`; `generateVAPIDKeys()`; errors are `WebPushError` with `statusCode` (all read in `@types/web-push` 3.6.4's `index.d.ts`) |
| `@types/web-push` | 3.6.4 | MIT | server, dev |
| `yazl` | 3.3.1 | MIT | server: the claim-pack ZIP, streamed to the blob store |
| `@types/yazl` | 3.3.1 | MIT | server, dev |

Deliberately **not** added:
- an iCal library: the feed is a few `VEVENT`s with all-day dates, written by hand to RFC 5545
  (line folding at 75 octets, escaping), with fixture tests (T17);
- an RRULE library: schedules are expanded one due point at a time, never as recurrence rules;
- `@visx/*`: charts belong to Insights (1.x, D130);
- an exchange-rate provider client: the optional provider stays off and unbuilt (Q22).

**Ground rules for every task** (steps 1–3, repeated):
- **Spec order:** the specs in `docs/specs/` are the contract. Engineering spec §7.14 beats
  §7.1–§7.13, which beat §1. The product design's decision log beats the screens spec where they
  disagree (screens §9, §10).
- **Library APIs:** read the installed package's `.d.ts` or README under `node_modules`. Never guess.
  If an API differs from this plan, follow the library and say so in the commit body.
- **TDD:** a failing test, then the minimal code, then green, then commit.
- **Commits:** conventional messages, the repo's git identity, **no attribution lines** (D173; the
  commit-msg hook rejects them). Commit by path: `git commit -m "…" -- <paths>`. Never push.
- **Node 24:** `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- **Test time zone:** `TZ=Africa/Cairo`. **Ports:** Postgres 5452, Mailpit 8025/1025, RustFS 9452.
  Never touch 5432, 5433, 5442 or 6379.
- **No GitHub Actions.** CI is `scripts/ci-local.sh`, gating on exit codes.
- **Sample cast** in fixtures, seeds, tests and copy: Ibrahim (instance admin; owns Home and
  Garage), Alfred (Arabic; owns بيت العائلة), Bruce (admin), Louis (member), Talia (viewer), Peter
  (Alfred's son, managed), and the contact Murdock. No other names.

**Step-4 additions:**
- **One migration owner.** Phase A (T4–T7) is done in order by one agent, from 0048. Phases B and C
  never add a migration; if one turns out to be needed, stop and hand it to the owner. Drizzle for
  tables, checks, uniques, plain and partial indexes and composite FKs; the custom migration for
  RLS, grants, triggers, functions and views. After each task `drizzle-kit generate` produces
  nothing.
- **Every new table**, in its task's custom migration:
  1. `ENABLE` + `FORCE ROW LEVEL SECURITY`;
  2. `owner_all` for `kept_owner`;
  3. `kept_app` policies on USING and WITH CHECK, or **none** when only definers touch it (say so
     in a comment);
  4. `kept_system` policies only where a system job needs them (the scan, deliveries, digests:
     T7 lists them), each with a comment naming the job;
  5. `REVOKE UPDATE … FROM kept_app, kept_system`, then column `GRANT UPDATE (…)`, never on `id`,
     a key column, `location_id`, `owner_account_id` or a `user_id`;
  6. `touch_row` when it has `row_version`; append-only tables have none (§7.13);
  7. a fixture row in `fillTenant()` (new file `apps/server/test/leak-household.ts`, imported by
     `test/leak.test.ts`), in the same commit.

  Location children use composite FKs `(location_id, x_id) → parent(location_id, id) ON UPDATE
  CASCADE`, and expose `UNIQUE (location_id, id)` when they have children of their own.
- **Every new `kept.*` function:** revoke `EXECUTE` from `PUBLIC, kept_app, kept_system`, then grant
  exactly the right role; list it in `FUNCTIONS` in `test/leak.test.ts` **and** the map in
  `src/db/migrate.test.ts`; definers owned by `kept_owner`, `SET search_path = pg_catalog, public`,
  schema-qualified names, caller checked from `app.user_id`; anything invisible raises `42501`.
- **API conventions** (§7.7, steps 2–3): camelCase JSON; money as a canonical decimal string plus
  `currency`, **omitted** when gated, with `moneyHidden: true`; `assertClientId()` on client ids;
  `If-Match` on every PATCH and every POST that changes a versioned row; 404 for anything
  invisible, 403 for a visible row the role can't change; lists as `{items, next_cursor}`; every
  non-GET route calls `audited()` and carries a `// catalogue:` marker or an `ALLOWLIST` entry
  with a reason; `config.module` + `moduleLocation` where a module applies; an undoable write sends
  `X-Kept-Audit-Event`.
- **Undo** (D150, Q25): step 4's undoable actions are listed per task. Creates are not undoable
  (§7.7). Deleting a warranty, claim, loan, valuation, schedule, service record, expiring document,
  incident or exchange rate is a **hard delete** whose audit event holds the full before-image;
  its undo re-inserts the row with the same id and re-links its attachments. Secret-class diffs
  never appear in step-4 tables.
- **Reminder rules** (D29, D111, D122, D188, §7.13):
  - "today" and "overdue" use the **location's** timezone; digest time and quiet hours the
    **user's**; end dates are **inclusive** (L2);
  - every reminder text names the thing (or place), its path, the location and the local date,
    and a template test checks it (L113);
  - Kept never messages anyone outside the household (D57): only Kept users receive anything.
- **Web:**
  - Every list uses `ListSurface` + the filter strip + the Display button; pull to refresh on every
    list and page (D212).
  - React Aria primitives only; no native `select`, date picker, `confirm`, `alert` or `prompt`;
    logical CSS only; nothing truncated with … on a phone; RTL correct; checked at 375, 768 and
    1280 px in both themes.
  - **No new route files after T3.** **Parallel web tasks never run `i18n:extract` or edit `.po`
    files**; T30 extracts once and writes all five languages.
  - There are **no design-board frames** for the Schedules, Lending, Paperwork, Expiring, Incidents,
    Reports and Exchange-rate screens. Build them from screens §5 and the kit, as step 3 built
    Import; the frames that exist (thing detail with warranties, claim, value and loans;
    the notification centre, frame 7; Settings → Me's notifications; Log a service) are binding.

**Parallel execution (waves).** Tasks in a wave touch disjoint files.

| Wave | Tasks | Notes |
|---|---|---|
| 0 | T0 ∥ T1 ∥ T2 ∥ T3 | T0's outcomes can change T15 (push), T18 (report, ZIP) and T9 (SVG logos); T1–T3 don't wait for them |
| 1 | T4 → T5 → T6 → T7 | one owner, sequential. T1's pure helpers (schedule maths, iCal writer) may start alongside |
| 2 | T8 ∥ T9 ∥ T10 ∥ T11 ∥ T12 ∥ T17 ∥ T19; then T13 (after T10–T12); T15 (after T7; its senders need no scan); T14 (after T13, T15); T16 (after T14, T15); T18 (after T8, T9) | each owns its own `src/<area>/` |
| 3 | T20 ∥ T21 ∥ T22 ∥ T23 ∥ T24 ∥ T25 ∥ T26 ∥ T27 ∥ T28 | on the mock from T3; each switches to the real server when its wave-2 task lands |
| 4 | T29 → T30 | the second-pass review of step-4 screens, then i18n, e2e, leak, perf, CI, docs and the device checklist |

**Sizes** are in developer-days (d), one developer at about 7 focused hours. **The tasks add up to
about 65 d (13 weeks) of one developer's time, above the master plan's 7–9 weeks for this step.**
The estimate in the master plan predates D205, D211, D212 and the step-3 carry-over, and it
counted the §17 row, not the screens and tests each item needs. With parallel agents (the waves)
the critical path is T1 → Phase A → T11 → T13 → T14 → T16 → T24 → T29 → T30, about **25 d (5
weeks)**. If one developer builds it, the master plan's 1.x candidates inside this step save about
8 d and can be dropped without touching anything else, because each is built last in its wave:
the calendar feed (T17 and its part of T25, about 2.5 d), incidents and claim packs (about 2.5 d of
T18 and 1.5 d of T26), and the webhook channel (about 1 d of T15 and T25). The maintainer decides.

---

## File structure (created or changed across the tasks)

```
packages/shared/src/
  household.ts          warranty kinds, claim statuses and transitions, loan directions,
                        valuation sources, incident kinds, document kinds, service-line kinds,
                        addMonthsClamped, warrantyEnds, coverage, scheduleNext (pure; SQL twins)
  reminders.ts          SOURCE_TYPES, SOURCE_MODULE, SOURCE_KINDS, OCCURRENCE_KINDS, duePeriod,
                        NOTIFY_KINDS, CHANNEL_KINDS, defaultPreference(), lead-time defaults
  inventory.ts          DERIVED_STATES += lent, borrowed, in_repair
  list-views.ts         LIST_SURFACES += schedules, lending, paperwork, expiring, notifications,
                        incidents, ai-calls (carry-over)
  modules.ts            reminderSources and nav per module (the comment's "as steps land")
  money.ts              convert(amount, from, to, on, rates) → {amount} | {missing}
  sync.ts               SnapThing.derived, SnapThing.loan
  errors.ts             + quantity_not_one, already_on_loan, thing_in_repair, open_loan,
                        open_claim, invalid_transition, schedule_interval_required,
                        rate_missing, push_unavailable, channel_unreachable, link_expired
apps/server/
  migrations/0048…0055  Phase A (T4–T7)
  src/db/schema/        money.ts warranties.ts lending.ts services.ts schedules.ts
                        reminders.ts notify.ts (+ things.ts, files.ts, reports.ts, alerts.ts)
  src/money/            routes.ts fx.ts valuations.ts convert.ts undo.ts
  src/warranties/       routes.ts service.ts claims.ts defaults.ts logo.ts view.ts undo.ts
  src/lending/          routes.ts service.ts return.ts view.ts undo.ts
  src/schedules/        routes.ts service.ts services.ts anchor.ts view.ts undo.ts
  src/paperwork/        routes.ts library.ts documents.ts view.ts undo.ts
  src/agenda/           routes.ts query.ts view.ts
  src/reminders/        scan.ts recipients.ts deliver.ts digest.ts quiet.ts jobs.ts status.ts
  src/notify/           routes.ts prefs.ts channels.ts email.ts push.ts vapid.ts webhook.ts
                        centre.ts notices.ts
  src/calendar/         routes.ts ical.ts feed.ts
  src/incidents/        routes.ts service.ts report.ts claim-pack.ts download.ts undo.ts
  src/reports/template/ insurance.typ
  src/mail/             messages*.ts (reminder, digest, membership-ended, test templates)
  test/leak-household.ts  test/perf/step4.perf.test.ts  test/fixtures/ical/
apps/web/
  src/sw.ts (+ push, notificationclick)   src/pwa/push.ts
  src/api/household/    paths.ts types.ts queries.ts mock/*.ts
  src/components/{warranties,claims,lending,schedules,services,paperwork,documents,
                  notifications,money,incidents,reports,agenda}/…
  src/routes/_app/      schedules.tsx lending.tsx paperwork.tsx expiring.tsx notifications.tsx
                        incidents.tsx incidents.$id.tsx reports.$kind.tsx
                        settings.me.notifications.tsx settings.account.exchange-rates.tsx
```

---

## Phase 0: spikes, shared contracts and scaffolding (T0–T3, parallel)

### Task 0: Spikes: web push end to end, the insurance report in Typst, ZIP streaming, SVG logos, DST

**Size:** 2 d. **Files:** `docs/spikes/2026-xx-step4-push.md`, `…-insurance-report.md`,
`…-claim-pack-zip.md`, `…-svg-logo.md`, `…-dst.md`, and the device checklist
`docs/spikes/2026-xx-step4-devices.md` (result column empty). Throwaway code under
`docs/spikes/code/` or a spike branch, never `apps/`.

- [ ] **Push in Chromium.** A minimal page registers a service worker, subscribes with a
  VAPID key from `generateVAPIDKeys()`, and the server sends with `sendNotification()`. Record:
  - that Playwright's Chromium can subscribe at all (headless Chromium's push service may be
    unavailable: if so, record it, and use the Chrome DevTools Protocol's
    `ServiceWorker.deliverPushMessage` to test the worker's `push` handler; **check that command's
    name and parameters in the CDP reference before relying on it**);
  - the request `web-push` makes (headers, `aes128gcm` against the default) against a local HTTP
    recorder standing in for a push service;
  - how `WebPushError.statusCode` reads for 404 and 410 from the recorder.
- [ ] **The insurance report in Typst.** Copy `reports/template/report.typ` to an insurance
  layout: per place, a row per thing (thumbnail, name, brand, model, serial, purchase date and price,
  current value, receipt count), per-place and per-location totals **per currency**, the "as of"
  header, and an incident header. Render English and Arabic with 60 and 500 things; record peak
  memory against the 512 MB child limit (V34's method).
- [ ] **ZIP streaming.** `yazl` writing the report PDF plus 200 files read from the blob store
  (local and RustFS S3) into one upload stream. Record peak memory and whether `ZipFile.outputStream`
  pipes straight into the S3 driver's upload (read `apps/server/src/files/` for the put API).
- [ ] **SVG brand logos (step-2 Q9, D157, D172).** Whether stock `sharp` 0.35.4 rasterises an SVG
  (read its docs for SVG input and the `density`/`limitInputPixels` options), whether an SVG with an
  external `<image href="http://…">` or `<use href>` makes a network request (it must not: run it
  with the network blocked), and the cost of a 4,000-element SVG. Pass: raster PNG, no fetch,
  < 200 ms. Fail: SVG stays refused and only PNG, JPEG and WebP are accepted (Q33).
- [ ] **DST (V21).** Find the 2026 transition instants for `Africa/Cairo` **from the tz data**
  (loop `Intl.DateTimeFormat` offsets over the year in Node; never hard-code dates), and do the
  same in Postgres (`AT TIME ZONE`). Record both; T14's tests use the computed dates.
- [ ] **The device checklist:** the rows of "Needs the maintainer's devices" below.
- [ ] **Commit:** `docs(spikes): step-4 push, insurance report, claim-pack zip, svg logos and dst`.

### Task 1: Shared contracts

**Size:** 1.5 d. **Files:** create `packages/shared/src/{household,reminders}.ts` and tests; modify
`inventory.ts`, `list-views.ts`, `modules.ts`, `money.ts`, `sync.ts`, `errors.ts`, `index.ts`.

- [ ] **`household.ts`:**
  - `WARRANTY_KINDS = ['manufacturer','extended','store','credit_card','insurance']` (D53);
  - `CLAIM_STATUSES = ['open','in_repair','resolved','rejected']` and
    `CLAIM_TRANSITIONS = {open: ['in_repair','resolved','rejected'], in_repair: ['resolved','rejected','open'], resolved: [], rejected: []}`
    (a closed claim reopens only through undo; Q18);
  - `LOAN_DIRECTIONS = ['out','in']`; `VALUATION_SOURCES = ['purchase','appraisal','estimate','insurer']`;
    `INCIDENT_KINDS = ['burglary','fire','flood','loss','other']`;
    `DOCUMENT_KINDS = ['registration','insurance','licence','inspection','lease','contract','other']`;
    `SERVICE_LINE_KINDS = ['part','labour','fluid','other']`;
  - `addMonthsClamped('2026-01-31', 1)` → `'2026-02-28'` (the day clamps to the month's end);
  - `warrantyEnds({startsOn, endsOn, termMonths, lifetime})` → `'lifetime' | 'YYYY-MM-DD' | null`:
    a term ends the day before the same day `termMonths` later (a 24-month warranty from
    2026-10-01 covers through 2028-09-30, inclusive, L2);
  - `coverage(warranties, today)` → `{longestId, coveredUntil, boughtOn}` for the bar (D195);
  - `scheduleNext({everyMonths, everyUnits, dueOn, anchorOn, anchorValue, snoozedUntil, snoozedUntilValue, skipNext, leadDays, leadUnits}, {today, latestValue})`
    → `{dueOn, dueValue, state: 'upcoming'|'due'|'overdue', basis}`: whichever comes first; a
    snooze replaces the due point; `skipNext` adds one interval.
  - Table tests for every rule, including month ends, leap days and a meter-only schedule.
- [ ] **`reminders.ts`:**
  - `SOURCE_TYPES = ['schedule','warranty','registration','document','loan','thing_expiry','stock','reading_stale']`
    (§1.9; `stock` lands in step 7 and `reading_stale` in step 5: Q3);
  - `SOURCE_MODULE = {schedule: 'schedules', warranty: 'warranties', registration: 'warranties', document: 'paperwork', loan: 'lending', thing_expiry: 'schedules', stock: 'consumables', reading_stale: null}` (D113, D141; Q5);
  - `OCCURRENCE_KINDS = ['due','overdue','expiring']`, and `SOURCE_KINDS` (Q7): schedule →
    due, overdue; warranty → expiring; registration → due; document → expiring, overdue; loan →
    overdue; thing_expiry → expiring, overdue;
  - `duePeriod({dueOn} | {dueValue})` → `date:YYYY-MM-DD` | `meter:<canonical value>` (§7.13);
  - `NOTIFY_KINDS = [...step-4 source types, 'membership', 'ai_cap', 'ai_summary']`, with
    `ACCOUNT_LEVEL_KINDS = ['ai_summary']` (Q35);
  - `CHANNEL_KINDS = ['email','webpush','webhook','ntfy','telegram','apprise']` and
    `CHANNEL_KINDS_1_0 = ['email','webpush','webhook']` (D30, D130);
  - `defaultPreference({role, kind, recordedByMe})` → boolean (Q8);
  - `LEAD_DEFAULTS = {warranty: 30, document: 30, thing_expiry: 30, registration: 14, schedule_days: 14, schedule_units_ratio: 0.1}` (§3.4, Q9);
    `DEFAULT_DIGEST_TIME = '08:00'`.
- [ ] **`inventory.ts`:** `DERIVED_STATES = ['uncertain','draft','ended','lent','borrowed','in_repair']`.
- [ ] **`list-views.ts`:** new surfaces and their filter keys:
  - `schedules: ['location','state','subject','when']`;
  - `lending: ['location','direction','state','person']`;
  - `paperwork: ['location','role','subject','expiry']`;
  - `expiring: ['location','source','when']`;
  - `notifications: ['kind','location','unread']`;
  - `incidents: ['location','kind','when']`;
  - `ai-calls` (carry-over): the D206 call list's filters, read from `components/ai/usage-*.tsx`.
- [ ] **`modules.ts`:** each entry gains `reminderSources` (from `SOURCE_MODULE`) and `nav`
  (`schedules`, `lending`, `paperwork`, `notifications` is core). A test: every source type maps to
  one module or to core, and `effectiveModules` still passes every preset.
- [ ] **`money.ts`:** `convert(amount, from, to, on, rates)` uses the newest rate with
  `validFrom ≤ on` for the pair, or the inverse pair's `1/rate`; otherwise `{missing: {from, to}}`.
  Never chains through a third currency. Canonical output (§7.7).
- [ ] **`sync.ts`:** `SnapThing` gains `derived?: ('lent'|'borrowed'|'in_repair')[]` and
  `loan?: {direction, personName, dueOn: string | null}` (Q34). Additive: no payload version change.
- [ ] **`errors.ts`:** the codes in the file structure, each with its English message.
- [ ] **Commit:** `feat(shared): household records, reminder sources and kinds, derived loan states`.

### Task 2: Server scaffolding

**Size:** 1 d. **Files:** stub `routes.ts` in `src/{money,warranties,lending,schedules,paperwork,agenda,notify,calendar,incidents}/`,
each listed in `http/routes.ts`; `src/reminders/jobs.ts` and a new `jobs/household.ts` aggregator;
modify `jobs/policies.ts`, `jobs/system.ts`, `jobs/queue.ts`, `config/env.ts`, `.env.example`,
`compose.env.example`, `http/errors.ts`.

- [ ] **Job policies** (`JOB_POLICIES`, §3.1b):
  - `reminder-scan`: `{retryLimit: 4, retryDelay: 30, retryBackoff: true, expireInSeconds: 60}`
    (§3.1b "reminders scan: 5 attempts, 60 s");
  - `reminder-deliver`: MAIL (email and push, one delivery per job);
  - `reminder-digest`: `{retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 120}`;
  - `channel-webhook`: 10 attempts over about 24 h (§3.1b, §2.6): `retryLimit: 9`, backoff on,
    `retryDelay` chosen so the tenth attempt lands near 24 h **after reading pg-boss 12.34.0's
    backoff formula in its source** (write the arithmetic in the comment);
  - `claim-pack`: like `report` (no retry, the run shows `failed`), `expireInSeconds: 1800`;
  - `purge-exports`: MAINTENANCE.
- [ ] **System jobs** (`jobs/system.ts`): `reminder-scan` `*/15 * * * *`; `reminder-digest`
  `*/15 * * * *`; `purge-exports` `23 * * * *`. `REQUEST_QUEUES` gains `reminder-deliver` and
  `channel-webhook` (sent from requests: a test send); `TENANT_REQUEST_QUEUES` gains `claim-pack`.
- [ ] **Env** (§7.11 rows in T30): `KEPT_VAPID_PUBLIC_KEY`, `KEPT_VAPID_PRIVATE_KEY` (both or
  neither; never logged), `KEPT_VAPID_SUBJECT` (a `mailto:` or `https:` URL, as `web-push` requires;
  default: `KEPT_PUBLIC_URL` when it is https, else `mailto:` + `KEPT_SMTP_FROM`'s address, else
  unset and push reports "unavailable": Q11).
- [ ] **Errors:** `MESSAGES` for T1's codes; `CONFLICT_HINTS` for T4–T7's constraint names.
- [ ] **Public routes** registered now so the route catalogue sees them: `GET /cal/:token` and
  `GET /x/:token` (`config.auth: 'none'`), each on the catalogue's `ALLOWLIST` as a GET.
- [ ] Tests: `jobs/registry.test.ts` (policies), `config/env.test.ts` (VAPID pair validation).
- [ ] **Commit:** `feat(server): step-4 route stubs, job policies and VAPID settings`.

### Task 3: Web scaffolding

**Size:** 1.5 d. **Files:** the route stubs in the file structure (each `<Page title>` +
`ComingLater`), so `routeTree.gen.ts` changes once, here; `apps/web/src/api/household/{paths,types,queries}.ts`
and `mock/{money,warranties,lending,schedules,paperwork,agenda,notify,calendar,incidents}.ts`,
composed in `api/mock/server.ts`; modify `components/app-shell.tsx`.

- [ ] **The contract:** `api/household/types.ts` from Phase B's route tables, verbatim. Mock
  fixtures use the sample cast: Ibrahim's Home with a TV under two warranties and an open claim at a
  service centre, Bruce's drill lent to Murdock and overdue, a ladder borrowed from Murdock, a
  boiler service schedule on the "Kitchen" place, a home-insurance document expiring in 20 days,
  Alfred's بيت العائلة with an Arabic lease, and notifications of every kind.
- [ ] **Nav:** Schedules, Lending and Paperwork get `to` (each shown when its module is on in any
  location, screens §1); Notifications gets `/notifications`; the header bell (screens §1) shows
  `unread` from `GET /api/v1/notifications/count`. Vehicles and Insights stay muted.
- [ ] **Commit:** `feat(web): step-4 route stubs, household API contract and mock`.

---

## Phase A: schema, RLS and the definer paths (T4–T7, sequential, one owner)

Each task ends with `pnpm test` green, **including `test/leak.test.ts`**, and `drizzle-kit
generate` producing nothing.

### Task 4: Money records, incidents, report kinds and export runs (0048 generated, 0049 custom)

**Size:** 1.5 d. **Files:** create `src/db/schema/money.ts` (`fx_rates`, `valuations`,
`incidents`, `incident_things`, `export_runs`); modify `schema/reports.ts` (`kind`); tests
`src/db/money.test.ts`; update `leak-household.ts`, `leak.test.ts`, `migrate.test.ts`.

- [ ] **`fx_rates`** (§1.4, §7.13, D136):

  ```sql
  CREATE TABLE fx_rates (
    owner_account_id uuid NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
    from_ccy char(3) NOT NULL REFERENCES currencies(code),
    to_ccy char(3) NOT NULL REFERENCES currencies(code),
    rate numeric(18,8) NOT NULL CHECK (rate > 0),
    valid_from date NOT NULL,
    created_by uuid NOT NULL, …mutable,
    PRIMARY KEY (owner_account_id, from_ccy, to_ccy, valid_from),
    CHECK (from_ccy <> to_ccy));
  ```

  Policies: copy `brands`' account-scope expressions from `0014_registries_rls.sql`: SELECT
  `kept.visible_account_ids()`, INSERT/UPDATE/DELETE `kept.admin_account_ids()`.
  `GRANT UPDATE (rate, updated_at, row_version)`.
- [ ] **`valuations`** (§1.4, D158):

  ```sql
  CREATE TABLE valuations (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    thing_id uuid NOT NULL,
    value numeric(16,4) NOT NULL CHECK (value >= 0),
    currency char(3) NOT NULL REFERENCES currencies(code),
    valued_on date NOT NULL,
    source text NOT NULL CHECK (source IN ('purchase','appraisal','estimate','insurer')),
    notes text CHECK (char_length(notes) <= 2000),
    created_by uuid NOT NULL, …mutable,
    UNIQUE (location_id, id),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  CREATE INDEX valuations_thing_idx ON valuations (thing_id, valued_on DESC, created_at DESC);
  ```

  Policies: SELECT visible; INSERT/UPDATE/DELETE writable. Money is gated at serialisation.
- [ ] **`incidents`, `incident_things`** (§1.4, §7.13):

  ```sql
  CREATE TABLE incidents (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('burglary','fire','flood','loss','other')),
    occurred_on date NOT NULL,
    police_reference text CHECK (char_length(police_reference) <= 100),
    insurer_reference text CHECK (char_length(insurer_reference) <= 100),
    notes text CHECK (char_length(notes) <= 5000),
    created_by uuid NOT NULL, …mutable,
    UNIQUE (location_id, id));
  CREATE TABLE incident_things (
    location_id uuid NOT NULL, incident_id uuid NOT NULL, thing_id uuid NOT NULL,
    PRIMARY KEY (incident_id, thing_id),
    FOREIGN KEY (location_id, incident_id) REFERENCES incidents(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  ```

  Policies: SELECT visible; writes for `kept.admin_location_ids()` only (§7.1 "Incidents; claim
  packs": owner and admin).
- [ ] **`report_runs.kind`** `text NOT NULL DEFAULT 'inventory' CHECK (kind IN ('inventory','insurance'))`.
  The existing rows stay inventory.
- [ ] **`export_runs`** (§1.10, D158, D180; Q19):

  ```sql
  CREATE TABLE export_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('claim_pack')),       -- step 7 adds its exports
    include_secrets boolean NOT NULL DEFAULT false CHECK (NOT include_secrets OR kind <> 'claim_pack'),
    incident_id uuid, thing_ids uuid[],
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','expired')),
    progress_done int NOT NULL DEFAULT 0, progress_total int NOT NULL DEFAULT 0,
    storage_key text, bytes bigint, error text CHECK (error ~ '^[a-z_]{1,32}$'),
    created_by uuid REFERENCES auth."user"(id) ON DELETE SET NULL,
    token_hash text UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    token_expires_at timestamptz, revoked_at timestamptz,
    downloads int NOT NULL DEFAULT 0, last_downloaded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
    CHECK (num_nonnulls(incident_id, thing_ids) = 1),
    FOREIGN KEY (location_id, incident_id) REFERENCES incidents(location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (incident_id));
  ```

  No `row_version`: the job's own bookkeeping, like `report_runs`. Policies: SELECT and INSERT for
  `created_by = me AND location_id IN admin locations`; no UPDATE for kept_app except
  `GRANT UPDATE (token_hash, token_expires_at, revoked_at)` behind a USING on the same predicate.
  The job and the download go through definers:
  - `kept.export_run_claim(p_id)` (SYS): marks running, returns the scope;
  - `kept.export_run_finish(p_id, p_key, p_bytes, p_status, p_error)` (SYS);
  - `kept.export_download(p_token_hash) RETURNS TABLE(storage_key, bytes, location_id)` (SYS):
    refuses a revoked, expired or unknown token **and** a creator who no longer holds owner or admin
    on the location (D180: "downloads re-check the current role"), counts the download, and raises
    `42501` otherwise.
- [ ] **The AI money caps through exchange rates** (step-3 carry-over). Read the current
  definition of the cap check inside `kept.ai_reserve` (0039, 0040 and 0045; the newest `CREATE OR
  REPLACE` wins) and `CREATE OR REPLACE` it so a cost in another currency counts through the
  account's newest rate on or before today for that pair (or the inverse), and is left out and
  listed as "not counted" when no rate exists (D76: never estimated). Write the test the step-3 plan
  named: a USD cap, an EGP cost and a USD→EGP rate.
- [ ] **Leak:** `fillTenant()` adds a rate on the tenant account, a valuation, an incident with one
  thing, an export run. Assert an export run is invisible to a member **and** to another admin of
  the same location (created-by only).
- [ ] **Commit:** `feat(db): exchange rates, valuations, incidents, report kinds and export runs`.

### Task 5: Warranties, claims, loans, service records, typed attachments and the state bump (0050 generated, 0051 custom)

**Size:** 2.5 d. **Files:** create `src/db/schema/{warranties,lending,services}.ts`; modify
`schema/things.ts` (`state_version`), `schema/files.ts` (attachment subjects),
`schema/registries.ts` (`brands.logo_file_id`); tests `src/db/household-records.test.ts`.

- [ ] **`warranties`** (§1.7, §7.13, D53, D55):

  ```sql
  CREATE TABLE warranties (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    thing_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('manufacturer','extended','store','credit_card','insurance')),
    provider text CHECK (char_length(provider) <= 120),
    starts_on date NOT NULL,
    ends_on date, term_months int CHECK (term_months BETWEEN 1 AND 600),
    lifetime boolean NOT NULL DEFAULT false,
    effective_ends_on date GENERATED ALWAYS AS (
      CASE WHEN lifetime THEN NULL
           WHEN ends_on IS NOT NULL THEN ends_on
           ELSE (starts_on + make_interval(months => term_months) - 1)::date END) STORED,
    lead_days int NOT NULL DEFAULT 30 CHECK (lead_days BETWEEN 0 AND 365),
    claim_contact text CHECK (char_length(claim_contact) <= 300),
    registered boolean NOT NULL DEFAULT false,
    registration_deadline date,
    created_by uuid NOT NULL, …mutable,
    UNIQUE (location_id, id),
    CHECK (num_nonnulls(ends_on, term_months) + lifetime::int = 1),
    CHECK (ends_on IS NULL OR ends_on >= starts_on),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  CREATE INDEX warranties_thing_idx ON warranties (thing_id);
  CREATE INDEX warranties_ends_idx ON warranties (effective_ends_on);
  ```

  `make_interval` on a date gives a timestamp; the migration test pins that `effective_ends_on`
  equals `household.ts` `warrantyEnds()` for the same table of cases (month ends, leap years).
  Postgres rejects a non-immutable generated expression: if `date + interval` is refused as not
  immutable, the column becomes a plain column kept by a BEFORE trigger instead, with the same test.
- [ ] **D10 (step-2 Q11): "has a warranty record" forces quantity 1.** `CREATE OR REPLACE
  kept.guard_thing_quantity()` (0016) to also refuse `quantity <> 1` when a warranty exists, and a
  BEFORE INSERT trigger on `warranties` refuses a thing with `quantity <> 1` as 23514
  `warranties_quantity_one` (→ 409 `quantity_not_one`, hint "Split it first").
- [ ] **`claims`** (§1.7, D54, D158, D195; Q18):

  ```sql
  CREATE TABLE claims (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    thing_id uuid NOT NULL, warranty_id uuid, incident_id uuid,
    opened_on date NOT NULL,
    reference text CHECK (char_length(reference) <= 100),
    vendor_id uuid,                                   -- account registry, D11
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_repair','resolved','rejected')),
    cost numeric(16,4) CHECK (cost >= 0), currency char(3) REFERENCES currencies(code),
    covered_amount numeric(16,4) CHECK (covered_amount >= 0),     -- Q18
    notes text CHECK (char_length(notes) <= 5000),
    closed_on date,
    created_by uuid NOT NULL, …mutable,
    UNIQUE (location_id, id),
    CHECK ((cost IS NULL AND covered_amount IS NULL) OR currency IS NOT NULL),
    CHECK ((status IN ('resolved','rejected')) = (closed_on IS NOT NULL)),
    CHECK (closed_on IS NULL OR closed_on >= opened_on),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, warranty_id) REFERENCES warranties(location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (warranty_id),
    FOREIGN KEY (location_id, incident_id) REFERENCES incidents(location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (incident_id));
  CREATE UNIQUE INDEX claims_one_repair_uq ON claims (thing_id) WHERE status = 'in_repair';
  ```

  - `vendor_id` → `vendors` through the account guard trigger used for `things.brand_id` (the one
    D183's "a registry's owner_account_id matches the location's owner account" describes; find it
    in 0016 and reuse it).
  - A trigger refuses a status change not in `CLAIM_TRANSITIONS` (23514 `claims_transition`), except
    for `kept_owner` and the undo path (a session flag set by the undo handler inside its
    transaction; name it in the comment).
- [ ] **`loans`** (§1.7, §7.13, D56, D57, D172):

  ```sql
  CREATE TABLE loans (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    thing_id uuid NOT NULL,
    direction text NOT NULL CHECK (direction IN ('out','in')),
    person_id uuid NOT NULL,                          -- account registry (people)
    started_at timestamptz NOT NULL,
    due_on date,
    returned_at timestamptz,
    return_place_id uuid,
    previous_place_id uuid, previous_container_id uuid,   -- where it was, for "return to previous"
    split_from_thing_id uuid,                              -- the row a partial lend split off (D172)
    lead_days int NOT NULL DEFAULT 0 CHECK (lead_days BETWEEN 0 AND 60),
    notes text CHECK (char_length(notes) <= 2000),
    created_by uuid NOT NULL, …mutable,
    UNIQUE (location_id, id),
    -- "Due ≥ start" (screens §7) is checked by the route in the location's zone; the table only
    -- refuses a due date more than a day before the start (zone slack).
    CHECK (due_on IS NULL OR due_on >= (started_at AT TIME ZONE 'UTC')::date - 1),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, return_place_id) REFERENCES places(location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (return_place_id),
    FOREIGN KEY (location_id, split_from_thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (split_from_thing_id));
  CREATE UNIQUE INDEX loans_one_open_uq ON loans (thing_id) WHERE returned_at IS NULL;   -- §7.13
  CREATE INDEX loans_due_idx ON loans (due_on) WHERE returned_at IS NULL;
  CREATE INDEX loans_person_idx ON loans (person_id);
  ```

  - `person_id` → `people` through the same account guard as `things.belongs_to_person_id`.
  - `previous_*` are kept loosely (no FK: the place may be gone by the return; the route falls back
    to Unplaced).
  - Update `kept.person_contact_visible()` so "used in a location" (step-2 Q5, D177) also counts a
    loan there.
- [ ] **`service_records`, `service_lines`, `service_completions`** (§1.6, §7.13, D26, D29, D113; Q1):

  ```sql
  CREATE TABLE service_records (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    thing_id uuid, place_id uuid,
    serviced_on date NOT NULL,
    meter_reading_id uuid,
    vendor_id uuid,
    total numeric(16,4) CHECK (total >= 0), currency char(3) REFERENCES currencies(code),
    notes text CHECK (char_length(notes) <= 5000),
    logged_by uuid NOT NULL, …mutable,
    UNIQUE (location_id, id),
    CHECK (num_nonnulls(thing_id, place_id) = 1),
    CHECK ((total IS NULL) = (currency IS NULL)),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, place_id) REFERENCES places(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, meter_reading_id) REFERENCES meter_readings(location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (meter_reading_id));
  CREATE TABLE service_lines (
    id uuid PRIMARY KEY DEFAULT uuidv7(), location_id uuid NOT NULL, service_record_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('part','labour','fluid','other')),
    description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
    quantity numeric(12,3) CHECK (quantity > 0), unit_cost numeric(16,4) CHECK (unit_cost >= 0),
    sort int NOT NULL DEFAULT 0, …mutable,
    FOREIGN KEY (location_id, service_record_id) REFERENCES service_records(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  ```

  `service_completions` needs `schedules`, so it is created in T6. `consumable_thing_id` and
  `consumed_quantity` (D170) wait for step 7's consumables. Check first that `meter_readings`
  exposes `UNIQUE (location_id, id)` (0017); add it here if not.
  Policies (§7.1 "Readings, services, fuel: add · edit or delete others'"): SELECT visible; INSERT
  writable with `logged_by = me`; UPDATE/DELETE writable when `logged_by = me`, admin locations for
  anyone's.
- [ ] **Typed attachment subjects** (§7.13): `attachments` gains `warranty_id`, `claim_id`,
  `loan_id`, `incident_id`, `valuation_id`, `service_record_id` (and T6 adds
  `expiring_document_id`), each a composite FK ON UPDATE CASCADE ON DELETE CASCADE, each indexed.
  `attachments_one_subject_chk` becomes `num_nonnulls(thing_id, place_id, purchase_id,
  meter_reading_id, warranty_id, claim_id, loan_id, incident_id, valuation_id, service_record_id) <= 1`
  (T6 adds its column to the list).
- [ ] **`brands.logo_file_id`** (§1.3, D172: uploads only): a nullable FK to `files`, set only by
  the logo route's definer in T9 (no column grant).
- [ ] **`things.state_version`**, the 0047 pattern: `int NOT NULL DEFAULT 0`, added to
  `kept.touch_row`'s second argument (bumps `change_seq` only, never `row_version`), bumped by the
  definer `kept.touch_thing_state()` AFTER INSERT, DELETE and UPDATE OF `returned_at`, `status`,
  `vendor_id`, `person_id`, `due_on` on `loans` and `claims`, **only when a value really changed**
  (the 0047 comment explains why a cascade must not fire it). Revoked from everyone.
- [ ] **`kept.move_things()`** (Q17): `CREATE OR REPLACE` from the newest definition (0047):
  - a thing with an **open loan** or a claim **in repair** leaving its location → 23514
    `things_move_open_loan` / `things_move_in_repair` (409 `open_loan` / `open_claim`);
  - across accounts: closed loans' `person_id` and claims' and service records' `vendor_id` map
    through the same person and vendor maps the function already builds (`map_person` exists;
    add a vendor map the same way);
  - `incident_things` rows of a thing leaving its location are deleted and returned with the
    dropped links; `claims.incident_id` of those things is set null.
  - Tests: each refusal; a closed loan to Murdock survives a move to Alfred's account with Murdock
    copied into it; an incident loses the moved thing.
- [ ] **Leak:** `fillTenant()` adds a warranty, a claim with a vendor, an open loan to a person, a
  service record with one line, and an attachment on each new subject. Assert that a loan's person
  and a claim's vendor in another account can't be referenced (the guard), and B's `claims` →
  none visible.
- [ ] **Commit:** `feat(db): warranties, claims, loans, service records, typed attachments and the state bump`.

### Task 6: Schedules, expiring documents, module state and the agenda view (0052 generated, 0053 custom)

**Size:** 2.5 d. **Files:** create `src/db/schema/schedules.ts` (`schedules`,
`service_completions`, `expiring_documents`); modify `schema/files.ts`; tests
`src/db/agenda.test.ts`, `src/db/schedules.test.ts`.

- [ ] **`schedules`** (§1.6, §7.13, D29, D39, D146, D162):

  ```sql
  CREATE TABLE schedules (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    thing_id uuid, place_id uuid,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    every_months int CHECK (every_months BETWEEN 1 AND 600),
    every_units numeric(14,3) CHECK (every_units > 0),
    meter_id uuid,
    due_on date,                                  -- one-off when no interval (D146)
    lead_days int NOT NULL DEFAULT 14 CHECK (lead_days BETWEEN 0 AND 365),
    lead_units numeric(14,3) CHECK (lead_units >= 0),
    anchor_on date NOT NULL,                      -- §7.13: a date
    anchor_value numeric(14,3),
    snoozed_until date, snoozed_until_value numeric(14,3),
    skip_next boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,
    created_by uuid NOT NULL, …mutable,
    UNIQUE (location_id, id),
    CHECK (num_nonnulls(thing_id, place_id) = 1),
    CHECK (num_nonnulls(every_months, every_units, due_on) >= 1),               -- screens §7
    CHECK ((every_units IS NULL) = (meter_id IS NULL)),
    CHECK (meter_id IS NULL OR thing_id IS NOT NULL),
    CHECK (due_on IS NULL OR (every_months IS NULL AND every_units IS NULL)),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, place_id) REFERENCES places(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, meter_id) REFERENCES meters(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  CREATE TABLE service_completions (
    location_id uuid NOT NULL, service_record_id uuid NOT NULL, schedule_id uuid NOT NULL,
    PRIMARY KEY (service_record_id, schedule_id),
    FOREIGN KEY (location_id, service_record_id) REFERENCES service_records(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, schedule_id) REFERENCES schedules(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  ```

  Check first that `meters` exposes `UNIQUE (location_id, id)` (0017); add it if not. Policies
  (§7.1 "Manage schedules"): SELECT visible; writes writable (members and above).
- [ ] **Anchors recomputed (D162).** `kept.recompute_schedule_anchor(p_schedule uuid)`, a definer
  called by AFTER triggers on `service_completions` (insert, delete) and on `service_records`
  (UPDATE OF `serviced_on`, `meter_reading_id`; delete through the cascade): the anchor is the
  latest completing service's date and its reading's value, else the schedule's creation date and
  `anchor_value` as created; completing clears `snoozed_*` and `skip_next`. Tests: add, back-date,
  edit and delete a completion; the anchor follows each time.
- [ ] **`expiring_documents`** (§1.6, §7.13, D26, D155, D172):

  ```sql
  CREATE TABLE expiring_documents (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    thing_id uuid, place_id uuid,                -- both null: the location itself (D155)
    kind text NOT NULL CHECK (kind IN ('registration','insurance','licence','inspection','lease','contract','other')),
    title text CHECK (char_length(title) BETWEEN 1 AND 120),   -- Q31: needed for 'other'
    expires_on date NOT NULL,
    lead_days int NOT NULL DEFAULT 30 CHECK (lead_days BETWEEN 0 AND 365),
    superseded_by_id uuid,
    created_by uuid NOT NULL, …mutable,
    UNIQUE (location_id, id),
    CHECK (num_nonnulls(thing_id, place_id) <= 1),
    CHECK (kind <> 'other' OR title IS NOT NULL),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, place_id) REFERENCES places(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, superseded_by_id) REFERENCES expiring_documents(location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (superseded_by_id));
  CREATE INDEX expiring_documents_expires_idx ON expiring_documents (expires_on) WHERE superseded_by_id IS NULL;
  ```

  `attachments.expiring_document_id` joins T5's subjects and `attachments_one_subject_chk`.
- [ ] **Module state in SQL.** `kept.module_on(p_location uuid, p_module text) RETURNS boolean`,
  STABLE, **invoker** (it reads `locations.preset` and `location_modules` under the caller's
  policies), granted to `kept_app` and `kept_system`: the preset's set (a `CASE` over the three
  presets, written from `packages/shared/src/modules.ts`), then `location_modules` rows on top,
  then dependencies (`fuel` needs `vehicles`, `moving` needs `labels`). The AI modules are never
  asked here. **Drift test:** for every preset and every module, with and without an override row,
  the function equals `effectiveModules()`; the test fails when the TS registry changes without
  the SQL.
- [ ] **The agenda view** (`public.agenda_items`, `WITH (security_invoker = on)`; Q24):

  ```sql
  -- One row per (source, kind) whose due point exists, whatever its state; callers filter by
  -- state. "today" is the location's local date; ends are inclusive (L2).
  CREATE VIEW public.agenda_items WITH (security_invoker = on) AS
  WITH loc AS (
    SELECT l.id, (now() AT TIME ZONE l.timezone)::date AS today FROM public.locations l
     WHERE l.deleted_at IS NULL)
  -- schedules: due at the lead, overdue after the due point
  SELECT 'schedule'::text AS source_type, s.id AS source_id, s.location_id,
         s.thing_id, s.place_id, k.kind, n.due_on, n.due_value, n.state, …
    FROM public.schedules s JOIN loc ON loc.id = s.location_id
    CROSS JOIN LATERAL kept.schedule_next(s.id, loc.today) n
    CROSS JOIN LATERAL (VALUES ('due'), ('overdue')) k(kind)
   WHERE s.active AND kept.module_on(s.location_id, 'schedules') AND <subject live>
  UNION ALL
  -- warranties: expiring at effective_ends_on - lead_days; lifetime has none
  …
  UNION ALL
  -- registration: warranties with registered = false and a deadline
  …
  UNION ALL
  -- documents: current (superseded_by_id IS NULL); expiring at the lead, overdue after
  …
  UNION ALL
  -- loans: open, with a due date; overdue from due_on + 1
  …
  UNION ALL
  -- thing expiries (D141): things.expires_on, expiry_lead_days (default 30)
  …;
  ```

  - **Columns:** `source_type, source_id, location_id, thing_id, place_id, kind, due_on,
    due_value, meter_id, state ('upcoming'|'due'|'overdue'|'expiring'|'expired'), due_period,
    module, title`. `due_period` comes from `duePeriod()`'s SQL twin (`date:` or `meter:`).
  - **`<subject live>`** (D162, §7.13): the thing and its place are not trashed, the thing's
    lifecycle is `in_use` (terminal lifecycles pause its sources), and the source's module is on
    in the location. A location-level document has no subject clause.
  - **`kept.schedule_next(p_schedule, p_today)`**, STABLE invoker, the SQL twin of
    `scheduleNext()`: months from `anchor_on`, units from `anchor_value` against the meter's newest
    **accepted** reading (with the meter's offset, D52), snooze and skip applied. **No distance
    estimate in step 4** (Q2): a unit schedule is due when the reading reaches `due_value -
    lead_units`, with `due_on` null for its units side. A **twin test** runs the same 40 cases
    through both.
  - Loans with `direction = 'in'` and `due_on` count too (borrowed things to give back, D56).
  - The view never exposes money, secrets or contact details. Grant SELECT to `kept_app` and
    `kept_system`; the leak test checks it's `security_invoker`.
- [ ] **kept_system reads for the scan** (T14): `system_select` policies (`USING (true)`, SELECT
  only) on `locations`, `location_modules`, `places`, `things`, `meters`, `meter_readings`,
  `schedules`, `warranties`, `loans`, `expiring_documents`, `people`, each with a comment "the
  reminder scan (T14) reads every location's agenda". `memberships` and `user_profiles` already
  have `system_all` (0006).
- [ ] **Leak:** a schedule on a place, a one-off schedule, a document on the location, a
  service completion. Assert: the agenda under B's scope has none of A's rows; under a viewer of A
  it has A's rows (viewers see what's due; they can't act); with Warranties off in A, no warranty
  rows; with the thing trashed, none of its rows.
- [ ] **Commit:** `feat(db): schedules, expiring documents, module state in SQL and the agenda view`.

### Task 7: Reminders, notifications, channels, push subscriptions and calendar feeds (0054 generated, 0055 custom)

**Size:** 2 d. **Files:** create `src/db/schema/{reminders,notify}.ts`; modify
`schema/alerts.ts` (`ADMIN_ALERT_KINDS`); tests `src/db/reminders.test.ts`.

- [ ] **`reminder_occurrences`** (§1.9, §7.13, D111):

  ```sql
  CREATE TABLE reminder_occurrences (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    thing_id uuid, place_id uuid,                -- both null: the location
    source_type text NOT NULL CHECK (source_type IN ('schedule','warranty','registration','document','loan','thing_expiry','stock','reading_stale')),
    source_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('due','overdue','expiring')),
    due_period text NOT NULL CHECK (due_period ~ '^(date:\d{4}-\d{2}-\d{2}|meter:\d+(\.\d{1,3})?)$'),
    due_on date,
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','superseded','cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
    UNIQUE (location_id, id),
    CHECK (num_nonnulls(thing_id, place_id) <= 1),
    FOREIGN KEY (location_id, thing_id) REFERENCES things(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (location_id, place_id) REFERENCES places(location_id, id) ON UPDATE CASCADE ON DELETE CASCADE);
  CREATE UNIQUE INDEX reminder_occurrences_key_uq ON reminder_occurrences
    (thing_id, place_id, location_id, source_type, source_id, kind, due_period) NULLS NOT DISTINCT;  -- §7.13
  CREATE INDEX reminder_occurrences_open_idx ON reminder_occurrences (location_id) WHERE state = 'open';
  ```

  No `row_version` (the scan's bookkeeping). `source_id` has no FK (six source tables): the scan
  cancels an occurrence whose source is gone. Policies: kept_app SELECT visible; kept_system
  SELECT, INSERT, and `UPDATE (state, closed_at)`.
- [ ] **`notification_channels`** (§1.9, §7.13, D30; Q13):

  ```sql
  CREATE TABLE notification_channels (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('email','webpush','webhook')),   -- 1.x widens (D130)
    label text CHECK (char_length(label) <= 60),
    display_host text CHECK (char_length(display_host) <= 255),   -- webhook: the URL's host, shown
    config_ciphertext jsonb,                      -- webhook: {url, secret}; sealed (§7.3)
    key_version int,
    verified_at timestamptz, failing_since timestamptz,
    …mutable,
    CHECK ((kind = 'webhook') = (config_ciphertext IS NOT NULL)));
  CREATE UNIQUE INDEX notification_channels_email_uq ON notification_channels (user_id) WHERE kind = 'email';
  CREATE UNIQUE INDEX notification_channels_webpush_uq ON notification_channels (user_id) WHERE kind = 'webpush';
  ```

  One email and one web-push channel per user (push has many **subscriptions**, below); webhooks
  up to 5 (a trigger). The ciphertext is sealed with `table: 'notification_channels', rowId: id,
  fieldKey: 'config'`, and the table joins `src/secrets/rotate.ts`'s registry in T15.
  Policies: user scope (`user_id = me`) for SELECT, INSERT, DELETE; `GRANT UPDATE (label,
  verified_at, updated_at, row_version)`; kept_system SELECT and `UPDATE (failing_since,
  verified_at)`. kept_app **has no SELECT on `config_ciphertext`**: `REVOKE SELECT` on the table, then
  `GRANT SELECT` on every other column, as for `ai_providers.key_ciphertext`; only
  `notify/webhook.ts` on the system side opens it.
- [ ] **`push_subscriptions`** (§1.9, L112): `id, user_id, endpoint text UNIQUE CHECK (endpoint ~
  '^https://' AND char_length(endpoint) <= 1000), p256dh text, auth text, label text, created_at,
  last_success_at, failures int`. User scope for kept_app; kept_system SELECT, DELETE (404/410)
  and `UPDATE (last_success_at, failures)`.
- [ ] **`notification_preferences`** (§1.9, D29; Q35):

  ```sql
  CREATE TABLE notification_preferences (
    user_id uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE CASCADE,     -- null: account-level kinds
    kind text NOT NULL CHECK (kind IN ('schedule','warranty','registration','document','loan','thing_expiry','membership','ai_cap','ai_summary')),
    channel text NOT NULL CHECK (channel IN ('inapp','email','webpush','webhook')),
    enabled boolean NOT NULL, …mutable,
    UNIQUE NULLS NOT DISTINCT (user_id, location_id, kind, channel),
    CHECK ((kind = 'ai_summary') = (location_id IS NULL)));
  ```

  **A row only where the person chose**; no row means `defaultPreference()` (T1), so a change to
  the defaults reaches everyone who never chose. Policies: user scope, and INSERT/UPDATE only for a
  `location_id` in `kept.visible_location_ids()` (or null); kept_system SELECT.
- [ ] **`reminder_deliveries`** (§1.9, §7.13, D111):

  ```sql
  CREATE TABLE reminder_deliveries (
    occurrence_id uuid NOT NULL REFERENCES reminder_occurrences(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('digest','queued','sending','sent','failed','skipped')),
    not_before timestamptz,                        -- quiet hours
    sent_at timestamptz, error text CHECK (error ~ '^[a-z_0-9]{1,40}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (occurrence_id, user_id, channel_id));
  CREATE INDEX reminder_deliveries_digest_idx ON reminder_deliveries (user_id) WHERE status = 'digest';
  ```

  The unique delivery is per (occurrence, user, **channel row**) (§7.13 "channel references
  notification_channels.id"). Append-only apart from its status. kept_app SELECT own; kept_system
  all but DELETE (the prune does it as owner, below).
- [ ] **`notifications`** (§1.9, D39; Q10):

  ```sql
  CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
    occurrence_id uuid REFERENCES reminder_occurrences(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('reminder','membership_added','membership_ended','ai_cap','ai_summary','export_ready')),
    payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
    read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, occurrence_id));
  CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
  ```

  `payload` holds ids and codes only (the web renders the words): never money, secrets or contact
  details. kept_app SELECT own and `UPDATE (read_at)`; kept_system INSERT. A reminder's
  notification is also invisible once the user loses the location (policy: `location_id IS NULL OR
  location_id IN visible`).
- [ ] **`notification_digests`** `(user_id, digest_on date, channel_id, sent_at)` PRIMARY KEY
  `(user_id, digest_on, channel_id)`: one digest per user, local day and channel, exactly once.
  kept_system only.
- [ ] **`calendar_feeds`** (§1.9, D142, D181): `id, user_id, token_hash text UNIQUE, created_at,
  revoked_at, last_fetched_at, fetches int`. At most 3 unrevoked per user (a trigger). kept_app:
  user scope, `GRANT UPDATE (revoked_at)`. The public fetch goes through
  `kept.calendar_feed_user(p_token_hash) RETURNS uuid` (SYS: a definer that returns the user only
  if the feed is unrevoked **and the user isn't disabled**, records `last_fetched_at` at most once a
  minute (L35) and bumps `fetches`). The feed's content is then built in that user's scope (T17).
- [ ] **VAPID keys at rest** (Q11): `instance_settings` key `vapid` holds `{publicKey,
  privateKeySealed}`, sealed with `table: 'instance_settings', rowId: 'vapid', fieldKey:
  'private_key'`. kept_system already has `system_all` on `instance_settings`; kept_app never reads
  this key (a check in the instance-settings reader, and a test).
- [ ] **Scan status:** `instance_settings` key `reminder_scan` holds `{lastRunAt, lastOkAt,
  occurrences, durationMs}`, written by the scan.
- [ ] **`ADMIN_ALERT_KINDS`** gains `reminders_not_scanned` (D166, §3.4: after 2 hours); the
  `admin_alerts_kind_chk` CHECK is replaced in 0055 (a constraint change, as the file's comment
  says).
- [ ] **Retention** (§3.3): `CREATE OR REPLACE kept.prune_stale_rows()`, keeping every existing
  clause, adding: `notifications` older than 90 days; `reminder_deliveries` older than 1 year;
  occurrences `superseded`/`cancelled`/`done` older than 1 year with no delivery left;
  `notification_digests` older than 1 year. The existing test grows by one case per clause.
- [ ] **Leak:** a channel of each kind, a push subscription, a preference, a notification and a
  delivery for the tenant user. Assert the user-scope tables are invisible **across users of the
  same location**; kept_app can't select `notification_channels.config_ciphertext` or the
  `vapid` setting.
- [ ] **Commit:** `feat(db): reminder occurrences and deliveries, notifications, channels, push and calendar feeds`.

---

## Phase B: services and routes (T8–T19, parallel; each owns `src/<area>/`)

All routes follow step 2 and 3's rules: `scopedRead`/`scopedWrite` (`http/write.ts`) with
`requireMembership` + `requireCan`; `config.module` + `moduleLocation`; responses through
`serialize/gates.ts`; `audited()` with `requestId: req.id`; a route-catalogue marker; lists as
`{items, next_cursor}`, 20 per page, 200 maximum.

Shared shapes (in `api/household/types.ts` and each server `view.ts`):

```ts
type SubjectRef = { type: 'thing' | 'place' | 'location'; id: string; name: string; path: string; shortCode?: string | null };
type PersonRef  = { id: string; name: string; isMember: boolean };            // never contact details
type Money      = { amount: string; currency: string } | { moneyHidden: true };
type AttachmentRef = AttachmentView;                                           // step 2's, unchanged
```

### Task 8: Money: exchange rates, valuations, conversions

**Size:** 2 d. **Files:** `src/money/{routes,fx,valuations,convert,undo}.ts`; modify
`things/view.ts` (`currentValue`); tests `money/*.test.ts`.

| Method and path | Body → Response |
|---|---|
| `GET /api/v1/accounts/:accountId/fx-rates?from&to` | → `{items: FxRate[]}`; `FxRate = {fromCcy, toCcy, rate, validFrom, rowVersion, updatedBy: ActorRef, updatedAt}` (members of the account's locations read) |
| `PUT /api/v1/accounts/:accountId/fx-rates` | `{fromCcy, toCcy, rate (decimal string, > 0), validFrom}` → `FxRate`. Upsert on the key; replacing an existing row needs `If-Match`. Account admins. Audited `fx_rate.set`, account-level; undoable (the previous rate back, or deleted) |
| `DELETE /api/v1/accounts/:accountId/fx-rates/:from/:to/:validFrom` | `If-Match` → 204. Audited `fx_rate.delete`, undoable |
| `GET /api/v1/things/:id/valuations` | → `{items: Valuation[], current: Valuation \| null}`; `Valuation = {id, value: Money, valuedOn, source, notes, documents: AttachmentRef[], rowVersion, createdBy}`. Module `money` |
| `POST /api/v1/things/:id/valuations` | `{id?, value, currency, valuedOn (not in the future), source, notes?}` → 201 `Valuation`. `things.edit` + `money.view` (a viewer never; a member of an Essentials location: module off, 409) |
| `PATCH /api/v1/valuations/:id` · `DELETE /api/v1/valuations/:id` | `If-Match` → `Valuation` · 204. Audited `valuation.update` (money class) · `valuation.delete`; both undoable |

- [ ] **The thing view** gains `currentValue?: {amount, currency, valuedOn, source} |
  {moneyHidden: true}` (latest `valued_on`, then latest `created_at`), and `ThingRow` gains it
  behind the gate. History renders `valuation.*` events with the money class (D110).
- [ ] **`convert.ts`:** the server's call into `@kept/shared` `convert()` with the account's rates
  read once per request. Used by T18's report and by the AI cap display (T4 converted in SQL).
- [ ] **Tests:** a rate and its inverse; no chaining through a third currency; a missing pair
  is `{missing}`; a viewer of Home sees `moneyHidden` on valuations (Home hides money from viewers);
  Talia can't POST (403); Garage with Money off → 409 `module_off`; undo of a delete restores the
  row and its document attachment.
- [ ] **Commit:** `feat(money): exchange rates, valuations and current value`.

### Task 9: Warranties and claims (and brand logos)

**Size:** 2.5 d. **Files:** `src/warranties/{routes,service,claims,defaults,logo,view,undo}.ts`;
modify `files/routes.ts` (`OWNERS` and `CreateAttachmentBody` gain `warranty`, `claim`),
`things/view.ts` (`in_repair`, `repairAt`), `registries/view.ts` (`logoUrl`); tests.

| Method and path | Body → Response |
|---|---|
| `GET /api/v1/things/:id/warranties` | → `{items: Warranty[], coverage: {longestId: string \| null, boughtOn: string \| null, coveredUntil: string \| 'lifetime' \| null}}`; `Warranty = {id, thingId, kind, provider, startsOn, endsOn, termMonths, lifetime, effectiveEndsOn, leadDays, claimContact, registered, registrationDeadline, state: 'active'\|'expiring'\|'ended', documents: AttachmentRef[], rowVersion, createdBy}`, the longest cover first (D53) |
| `GET /api/v1/things/:id/warranty-defaults` | → `{termMonths: number \| null, from: {kind: 'brand'\|'type', id, name} \| null, startsOn: string \| null}`: the brand's `default_warranty_months`, else the nearest type up the chain with one (D55, D92), and the purchase date (D55). Never an AI guess |
| `POST /api/v1/things/:id/warranties` | `{id?, kind, provider?, startsOn, endsOn? \| termMonths? \| lifetime: true, leadDays?, claimContact?, registered?, registrationDeadline?}` → 201. Module `warranties`, `things.edit`. 409 `quantity_not_one` (D10) |
| `PATCH /api/v1/warranties/:id` · `DELETE /api/v1/warranties/:id` | `If-Match`. Audited `warranty.update` · `warranty.delete`; undoable |
| `GET /api/v1/things/:id/claims` | → `{items: Claim[]}`; `Claim = {id, thingId, warranty: {id, kind, provider} \| null, incident: {id, kind, occurredOn} \| null, openedOn, reference, vendor: {id, name, kind} \| null, status, cost: Money \| null, coveredAmount: Money \| null, notes, closedOn, savedYou: Money \| null, documents, rowVersion}` |
| `GET /api/v1/things/:id/claim-prefill` | → `{warrantyId: string \| null, claimUrl: string \| null, supportPhone: string \| null, claimContact: string \| null}`: the longest **active** warranty and its brand's contacts (screens §5 "A claim prefills the longest active warranty") |
| `POST /api/v1/things/:id/claims` | `{id?, warrantyId?, incidentId?, openedOn, reference?, vendor?: {id} \| {name}, status?: 'open'\|'in_repair', notes?}` → 201. `schedules-claims.manage`. A vendor by name is created inline (D11, `people-vendors.create-inline`). 409 `thing_in_repair` when another claim is in repair |
| `PATCH /api/v1/claims/:id` | `If-Match`; `{status?, reference?, vendor?, cost?, currency?, coveredAmount?, closedOn?, notes?}` → `Claim`. A status outside `CLAIM_TRANSITIONS` → 409 `invalid_transition`. Closing sets `closedOn` (default today in the location's zone). Audited `claim.update` / `claim.status` (money class on amounts); undoable |
| `DELETE /api/v1/claims/:id` | `If-Match` → 204; undoable |
| `PUT /api/v1/brands/:id/logo` | multipart, one image (PNG, JPEG, WebP; SVG only if T0 passed, rasterised to PNG and the SVG discarded) ≤ 2 MB → `Brand` with `logoUrl`. Account admins. Goes through step 2's upload pipeline (derivatives, GPS strip) into a file row owned by the account; `kept.set_brand_logo(p_brand, p_file)` definer sets the column |
| `DELETE /api/v1/brands/:id/logo` | → 204 |

- [ ] **Derived states** (D54, D119): `things/view.ts` `derivedStateOf()` adds `in_repair` when a
  claim is `in_repair`, with `repairAt: {vendorName}`; the path line reads "at <vendor>" and the
  header shows "Usually in <place>" (screens §8). `savedYou` = `coveredAmount` when the claim
  resolved with `cost` null or 0 (D195; Q18).
- [ ] **Search** (`search/query.ts`): `STATE_SQL.in_repair = EXISTS (SELECT 1 FROM claims c WHERE
  c.thing_id = t.id AND c.status = 'in_repair')`.
- [ ] **Tests:** the defaults (brand beats type; inherited type); a warranty on a quantity-3 thing
  → 409; the coverage bar picks the longest, lifetime first; the claim prefill; `in_repair` shows
  in the thing view, search and `derivedState`; an invalid transition → 409; `savedYou`; a viewer
  sees claims but `cost` as `moneyHidden`; Warranties off in Garage → 409 on POST and 404 on GET;
  an SVG upload refused (unless T0 passed); undo of `claim.status` puts the thing back in repair.
- [ ] **Commit:** `feat(warranties): warranties with defaults and coverage, claims and repairs, brand logos`.

### Task 10: Lending and borrowing

**Size:** 2.5 d. **Files:** `src/lending/{routes,service,return,view,undo}.ts`; modify
`files/routes.ts` (`loan` subject), `things/view.ts`, `search/query.ts`, `sync/snapshot.ts`,
`registries/` (the person page's data); tests.

| Method and path | Body → Response |
|---|---|
| `POST /api/v1/things/:id/lend` | `{loanId?, person: {id} \| {name} \| {memberUserId}, startedAt?, dueOn?, quantity?, notes?}` → 201 `{loan: Loan, thing: ThingRow, splitFrom?: ThingRow}`. Module `lending`, `things.edit`. A partial quantity splits (step 2's split), and the loan is on the new row with `split_from_thing_id` (D10, D57). A container takes its contents (D45: nothing to do, they stay inside). 409 `already_on_loan`, `thing_in_repair` (screens §8: Lend hidden while in repair) |
| `POST /api/v1/locations/:id/borrow` | `{thingId?, loanId?, name, typeId?, target: {placeId} \| {containerId}, person, dueOn?, notes?}` → 201 `{loan, thing}`: creates the thing with `belongs_to_person_id = person` and a loan `in` (D56) |
| `POST /api/v1/loans/:id/return` | `If-Match`; `{returnedAt?, to?: 'previous' \| {placeId} \| {containerId}, mergeBack?: boolean (default true), notes?}` → `{loan, thing, mergedInto?: ThingRow}`. **Out:** the thing moves to `to` (default: the place it left, else Unplaced) and, when it was split off and `mergeBack`, merges back into `split_from_thing_id` if that row is live, in the same place, same type (D172); otherwise it stays its own row. **In:** the thing's lifecycle becomes `returned_to_owner`, `ended_on` today, so it leaves counts and totals (D56) |
| `PATCH /api/v1/loans/:id` | `If-Match`; `{dueOn?, notes?, person?}` → `Loan`. Audited `loan.update`; undoable |
| `DELETE /api/v1/loans/:id` | `If-Match` → 204: a loan recorded by mistake. Undoable |
| `GET /api/v1/loans?direction&state=open\|overdue\|returned&locationId&personId&q&cursor` | → `{items: LoanRow[], counts: {out, in, overdue}, next_cursor}` (Lending screen; global with a location filter, screens §1) |
| `GET /api/v1/things/:id/loans` | → `{items: Loan[]}` (the thing's loan history) |
| `GET /api/v1/people/:id/loans` | → `{has: LoanRow[] (open, out, to them), lentUs: LoanRow[] (open, in, from them), history: LoanRow[] (20, cursor)}` for the person page (D57) |

```ts
type Loan = {
  id; thingId; direction: 'out' | 'in'; person: PersonRef;
  startedAt; dueOn: string | null; returnedAt: string | null; overdue: boolean;
  quantity: string; splitFromThingId: string | null;
  returnPlace: SubjectRef | null; previousPlace: SubjectRef | null;
  notes: string | null; conditionOut: AttachmentRef[]; conditionIn: AttachmentRef[];
  rowVersion: number; createdBy: ActorRef;
};
type LoanRow = Loan & { thing: ThingRow };
```

- [ ] **Condition photos:** `POST /api/v1/loans/:id/attachments` (the `OWNERS` table) with
  `role: 'condition_out' | 'condition_in'` only.
- [ ] **Derived states** (D57, D119): `lent` (open out), `borrowed` (open in); the path reads "with
  Murdock since 3 Oct · due 17 Oct" through a `loanLine` in the thing view (the web formats it);
  `STATE_SQL.lent`, `STATE_SQL.borrowed`.
- [ ] **The snapshot** (`sync/snapshot.ts`, Q34): each `SnapThing` gets `derived` and `loan:
  {direction, personName, dueOn}` from the open loan and an in-repair claim. `things.state_version`
  (T5) makes the delta resend the thing when a loan or claim changes. Test: lend → the next delta
  carries the thing with `derived: ['lent']`; return → cleared; a person's phone or email never
  appears in any snapshot field.
- [ ] **Recipients hint:** a loan to a person with `member_user_id` in the same location records
  it (T14 sends that member the overdue reminder too; Q16).
- [ ] **Tests:** partial lend of 3 of 5 splits and the return merges back; a return after the
  original moved stays separate; borrow then return ends the thing as `returned_to_owner` and it
  leaves Home's counts; one open loan per thing (409); Lend while in repair → 409; a viewer can
  read loans, not write; a person in another account → 404; undo of a return reopens the loan
  and moves the thing back (and un-merges when it merged).
- [ ] **Commit:** `feat(lending): loans out and in, partial returns that merge back, derived lent and borrowed`.

### Task 11: Schedules and service records

**Size:** 3 d. **Files:** `src/schedules/{routes,service,services,anchor,view,undo}.ts`; modify
`files/routes.ts` (`service_record` subject); tests.

| Method and path | Body → Response |
|---|---|
| `GET /api/v1/schedules?locationId&state=upcoming\|due\|overdue&subjectType&q&cursor` | → `{items: Schedule[], counts: {due, overdue}, next_cursor}` (Schedules screen, global; module `schedules` per row's location) |
| `GET /api/v1/things/:id/schedules` · `GET /api/v1/places/:id/schedules` | → `{items: Schedule[]}` |
| `POST /api/v1/schedules` | `{id?, subject: {thingId} \| {placeId}, name, everyMonths?, everyUnits?, meterId?, dueOn?, leadDays?, leadUnits?, anchorOn?, anchorValue?}` → 201 `Schedule`. `schedules-claims.manage`. Missing all three intervals → 400 `schedule_interval_required` (screens §7). `anchorOn` defaults to today (location zone); `anchorValue` to the meter's latest accepted reading; `leadUnits` to 10% of `everyUnits` (Q9) |
| `PATCH /api/v1/schedules/:id` · `DELETE /api/v1/schedules/:id` | `If-Match`. Audited `schedule.update` · `schedule.delete`; undoable |
| `POST /api/v1/schedules/:id/complete` | `If-Match`; `{servicedOn?, reading?: {value, takenAt?}, vendor?: {id} \| {name}, total?, currency?, notes?}` → `{serviceRecord: ServiceRecord, schedule: Schedule}`. Creates a service record that completes it (D29), which re-anchors it (T6's trigger). Undo deletes the record (and its reading) and the anchor falls back |
| `POST /api/v1/schedules/:id/snooze` | `If-Match`; `{untilDate} \| {untilValue}` → `Schedule`. `untilValue` defaults to +10% of the interval (screens §8). Audited `schedule.snooze`; undoable |
| `POST /api/v1/schedules/:id/skip` · `POST /api/v1/schedules/:id/unsnooze` | `If-Match` → `Schedule`. Skip once: `skip_next = true` (Q28). Undoable |
| `GET /api/v1/things/:id/service-records` · `GET /api/v1/places/:id/service-records` | → `{items: ServiceRecord[], next_cursor}` |
| `POST /api/v1/service-records` | `{id?, subject, servicedOn (not in the future), reading?: {meterId, value, proofFileId?}, vendor?, total?, currency?, lines?: [{kind, description, quantity?, unitCost?}] (≤ 50), completes?: scheduleId[], notes?}` → 201 `ServiceRecord`. `logs.add`. Core (no module; D113), but `completes` needs Schedules on. The reading goes through step 2's readings service with `taken_at` = the service date at 12:00 in the location's zone (§7.13), and a reading that doesn't fit is **refused at entry** with the reason (D112, screens §5) |
| `PATCH /api/v1/service-records/:id` · `DELETE /api/v1/service-records/:id` | `If-Match`. `logs.edit-own` for your own, `logs.edit-delete-others` for anyone's. Undoable |

```ts
type Schedule = {
  id; locationId; subject: SubjectRef; name;
  everyMonths: number | null; everyUnits: string | null; meter: {id, label, unit} | null; dueOn: string | null;
  leadDays: number; leadUnits: string | null; anchorOn: string; anchorValue: string | null;
  next: { dueOn: string | null; dueValue: string | null; state: 'upcoming' | 'due' | 'overdue'; basis: 'months' | 'units' | 'both' | 'once' };
  snoozedUntil: string | null; snoozedUntilValue: string | null; skipNext: boolean; active: boolean;
  lastService: { id; servicedOn } | null; rowVersion: number;
};
type ServiceRecord = {
  id; subject: SubjectRef; servicedOn; reading: {id, value, unit} | null; vendor: {id, name} | null;
  total: Money | null; lines: Array<{id, kind, description, quantity: string | null, unitCost: Money | null}>;
  completes: Array<{scheduleId, name}>; notes; invoices: AttachmentRef[]; loggedBy: ActorRef; rowVersion;
};
```

- [ ] `next` is read from `agenda_items` (never recomputed in TS), so the list and the scan agree;
  the TS `scheduleNext()` is only the twin in the test.
- [ ] **Tests:** "every 10,000 km or 12 months" due by months first, then by units; a one-off;
  snooze to a value then complete clears it; skip moves one interval; a back-dated service
  re-anchors (D162); deleting the completing service puts the previous anchor back; a place
  schedule (D39); a reading that doesn't fit refuses the service with the neighbours' values;
  money gated on `total` for a viewer; a member edits their own service but not Bruce's (403).
- [ ] **Commit:** `feat(schedules): schedules on things and places, completion through service records, snooze and skip`.

### Task 12: The paperwork library and expiring documents

**Size:** 2 d. **Files:** `src/paperwork/{routes,library,documents,view,undo}.ts`; modify
`files/routes.ts` (`document` subject); tests.

| Method and path | Body → Response |
|---|---|
| `GET /api/v1/paperwork?q&locationId&role&subjectType&expiry=any\|expiring\|expired&cursor` | → `{items: PaperworkRow[], next_cursor}`; `PaperworkRow = {attachment: AttachmentRef, subject: SubjectRef, expiring?: {id, kind, expiresOn, state}, snippet?: string}`. Every invoice, receipt, manual, warranty document, and location or place document across the caller's locations with Paperwork on (D39, D155). `q` searches file text (`file_text`, step 3), the file name and the subject's name. **Receipt and invoice snippets need the money gate** (step-3 Q19); originals stay members-and-above (D117) |
| `GET /api/v1/documents?locationId&kind&subjectType&state&includeSuperseded&cursor` | → `{items: ExpiringDocument[], next_cursor}` |
| `POST /api/v1/documents` | `{id?, subject: {thingId} \| {placeId} \| {locationId}, kind, title?, expiresOn, leadDays?}` → 201. Module `paperwork`, `things.edit` |
| `PATCH /api/v1/documents/:id` · `DELETE /api/v1/documents/:id` | `If-Match`. Undoable |
| `POST /api/v1/documents/:id/renew` | `If-Match`; `{id?, expiresOn, leadDays?}` → `{renewed: ExpiringDocument, previous: ExpiringDocument}`: a new row, the old one `superseded_by_id` (D172: "renewing keeps the old one"). The old one's open occurrences are superseded at the next scan |

```ts
type ExpiringDocument = {
  id; locationId; subject: SubjectRef; kind; title: string | null; expiresOn: string; leadDays: number;
  state: 'ok' | 'expiring' | 'expired'; supersededById: string | null; history: Array<{id, expiresOn}>;
  documents: AttachmentRef[]; rowVersion;
};
```

- [ ] **Tests:** the library finds a lease PDF by a word of its text; a viewer of Home sees the
  row but not a receipt's snippet; Paperwork off in Garage hides Garage's rows; renew keeps the old
  one in `history`; a document on the location (no subject) (D155); undo of a renew removes the
  new row and un-supersedes.
- [ ] **Commit:** `feat(paperwork): the paperwork library, location and place documents, expiring documents that renew`.

### Task 13: The agenda, Home's attention rows and search states

**Size:** 1.5 d (after T10–T12). **Files:** `src/agenda/{routes,query,view}.ts`; modify
`home/service.ts`, `search/query.ts`; tests.

| Method and path | Body → Response |
|---|---|
| `GET /api/v1/agenda?state=due\|overdue\|expiring\|upcoming&sourceType&locationId&from&to&cursor` | → `{items: AgendaItem[], counts: {overdue, due, expiring}, next_cursor}`; the Expiring screen reads `sourceType=warranty,document,thing_expiry` (screens §5 "Expiring: things, documents and warranties by date") |

```ts
type AgendaItem = {
  key: string;                   // `${sourceType}:${sourceId}:${kind}:${duePeriod}`, stable
  sourceType; sourceId; kind: 'due' | 'overdue' | 'expiring'; state; locationId;
  subject: SubjectRef; title: string;         // schedule name, warranty provider/kind, document title/kind
  dueOn: string | null; dueValue: string | null; unit: string | null;
  actions: Array<'complete' | 'snooze' | 'mark_returned' | 'renew' | 'open'>;   // by source and role
};
```

- [ ] **Home** (screens §5 and §8 order: to review · overdue · due · expiring · lent out · borrowed
  in · uncertain · long unseen · Unplaced · low stock): `HomeResponse.attention` gains `overdue`,
  `due`, `expiring` (from `agenda_items`), `lentOut`, `borrowedIn` (open loans). Low stock waits
  for step 7. Each row opens its list: overdue and due → `/schedules?f.state=…` when every item is a
  schedule, otherwise `/expiring?f.state=…`; lent out and borrowed in → `/lending?f.direction=…`.
- [ ] **Search states:** `STATE_SQL` gains `lent`, `borrowed` (T10) and `in_repair` (T9) if not
  already merged, and `SEARCH_STATES` follows `DERIVED_STATES`.
- [ ] **Tests:** every count equals the length of the list it opens (like step 3's home test
  against search); counts respect RLS and modules; a trashed thing's warranty disappears from both;
  the location's zone decides "overdue" (a Cairo location at 23:30 local on the due date is still
  "due").
- [ ] **Commit:** `feat(agenda): one agenda for every source, Home's overdue, due, expiring and loan rows`.

### Task 14: The reminder engine

**Size:** 3 d (after T13). **Files:** `src/reminders/{scan,recipients,deliver,digest,quiet,jobs,status}.ts`;
modify `jobs/system.ts`, `alerts/` (the new kind's check), `admin/routes.ts` (status);
tests `reminders/*.test.ts`.

- [ ] **The scan** (`reminder-scan`, every 15 minutes, `kept_system`; §3.4, D111, D162):
  1. `SELECT … FROM agenda_items WHERE state IN ('due','overdue','expiring')`, in pages of 2,000.
  2. `INSERT INTO reminder_occurrences (…) VALUES … ON CONFLICT ON CONSTRAINT reminder_occurrences_key_uq DO NOTHING RETURNING *`: only **new** occurrences go on. A snooze or a skip changes the due period, so it makes a new occurrence (the old one is superseded in step 3).
  3. Open occurrences not in this pass's agenda: `superseded` when the same source has an open
     occurrence of a later period, `done` when the source completed (a completing service, a
     returned loan, a renewed document), else `cancelled` (source gone, module off, subject
     trashed, lifecycle ended; §7.13). **Resuming never floods** (§7.6): only the current due
     period exists.
  4. For each new occurrence, `recipients.ts` (below) gives `(user, channels)`. In **one
     transaction per occurrence**: insert a `notifications` row per recipient (in-app), then
     `reminder_deliveries`: `overdue` → `queued` (`not_before` at the end of quiet hours when inside
     them), and a `reminder-deliver` job per delivery (`startAfter = not_before`); `due` and
     `expiring` → `digest`.
  5. Write `instance_settings.reminder_scan`. A pass over 10,000 things stays well under the 60 s
     limit (T30 measures it).
- [ ] **`recipients.ts`** (D29, D57, D113, D122; Q8, Q16):
  - members of the location whose membership is active (unexpired) and whose role is not viewer;
  - minus users who hid the source's module (`user_hidden_modules`, §7.6);
  - `enabled` = the preference row, else `defaultPreference({role, kind, recordedByMe})`:
    owner and admin → every kind; member → `loan` for loans they recorded, otherwise off;
  - plus, for a loan to a person linked to a member of the location (`people.member_user_id`), that
    member (their own household, D57);
  - channels per user: in-app always (if the kind is enabled at all); email when the user has a
    verified address, isn't managed (`…@managed.invalid`), SMTP is configured and the channel
    preference is on (default on); web push when they have a subscription and the preference is
    on (default on once they subscribed); webhook channels only when chosen (default off).
  - `ensureEmailChannel(user)` creates the user's email channel row lazily (Q13).
- [ ] **`deliver.ts`** (`reminder-deliver`, one delivery a job; L112): claim the row `queued →
  sending` (`UPDATE … WHERE status = 'queued' RETURNING`, so a duplicate job does nothing), render in
  the user's locale (`kept.mail_locale()`), send through `notify/email.ts`, `notify/push.ts` or
  `notify/webhook.ts` (T15), then `sent` or `failed` with an error code. A retry re-claims
  `failed` rows only. A push 404/410 deletes the subscription and marks `skipped`.
- [ ] **`digest.ts`** (`reminder-digest`, every 15 minutes): users whose local time
  (`user_profiles.timezone`) has passed `digest_time` (default 08:00, Q9) and who have `digest`
  deliveries and no `notification_digests` row for today (their local date) and that channel:
  insert the digest row, send **one** message per channel listing every item (all locations, each
  with its local due date, D122), mark those deliveries `sent`. Quiet hours don't delay a digest
  (the user chose its time).
- [ ] **`quiet.ts`:** `notBefore(now, userTz, quietFrom, quietTo)` handling a window across
  midnight and DST.
- [ ] **Membership notices** (D46, D180): `expireMemberships()` (`locations/membership-jobs.ts`)
  and `notifyOwnerNewMember()` also insert `notifications` rows (`membership_ended`,
  `membership_added`) for the owner, in the same transaction, and mail as before.
- [ ] **Admin side** (D66, D166): `check-admin-alerts` raises `reminders_not_scanned` when
  `lastOkAt` is older than 2 hours and resolves it after the next good pass; the admin status route
  gains `reminders: {lastRunAt, lastOkAt, occurrences, durationMs}`; admin alerts also go to the
  instance admins' push subscriptions (step-1 carry-over "Admin alerts reach email only"), through
  `notify/push.ts`.
- [ ] **Tests:**
  - **exactly once:** two scans in a row, and two concurrent scans (two connections), make one
    occurrence and one delivery per (user, channel);
  - **D111:** two schedules on one thing both remind; a second warranty on the same TV reminds
    separately;
  - **superseded:** snooze then scan → the old occurrence superseded, the new one open;
  - **pausing:** Warranties turned off → the open warranty occurrence cancelled at the next scan and
    none created; turned back on → exactly one for the current period (no flood);
  - **trash:** trashing the thing cancels; restoring creates the current period only (D162);
  - **recipients:** Bruce (admin) gets everything; Louis (member) gets only his own loan by default
    and Murdock **never** appears as a recipient; Talia (viewer) nothing; a user who hid Lending gets
    no loan reminder; Peter (managed) has no email channel;
  - **V21 DST:** with T0's computed 2026 Cairo transition dates, an item due on the transition day
    becomes `due` at the right local midnight, and a digest set for 08:00 goes out at 08:00 local on
    both sides of the change;
  - **timezones:** a location in `Africa/Cairo` and a user in `Europe/Berlin`: due and overdue by
    Cairo's date, the digest by Berlin's clock (D122);
  - **quiet hours** 22:00–07:00 defer an overdue push to 07:00 local;
  - **L113:** every template (immediate, digest) names the thing, its path, the location and the
    local date, in all five languages (a snapshot per language);
  - the admin alert after 2 hours without a scan (faked clock).
- [ ] **Commit:** `feat(reminders): the scan, occurrences exactly once, recipients, deliveries, digests and quiet hours`.

### Task 15: Channels: email, web push, the webhook channel, preferences

**Size:** 3 d (after T7). **Files:** `src/notify/{routes,prefs,channels,email,push,vapid,webhook}.ts`,
`src/mail/messages*.ts` (templates); modify `src/secrets/rotate.ts` (registry:
`notification_channels.config_ciphertext`, the VAPID private key), `http/app.ts` (boot: VAPID);
tests.

- [ ] **VAPID** (`vapid.ts`, D81; Q11): at web boot as `kept_system`, under an advisory lock (the
  setup code's pattern, §7.14): env keys win; otherwise read `instance_settings.vapid`, or generate
  with `generateVAPIDKeys()` and seal the private key. `subject` per T2. The private key never
  reaches a log (pino redaction test).
- [ ] **`push.ts`:** `sendPush(sub, payload, {urgency, topic, ttl})` over `web-push`'s
  `sendNotification()` with `vapidDetails` passed per call (no global `setVapidDetails`), `TTL:
  86400`, `urgency: 'high'` for overdue and `'normal'` for digests, `topic` = the first 32 URL-safe
  characters of the occurrence key's SHA-256 (so a re-send replaces rather than stacks), and an
  **`agent`: an `https.Agent` whose `lookup` refuses private addresses with `isPrivateAddress()`**
  (always, whatever `ssrf_allow_private` says: push services are public; Q12). Payload JSON: `{title,
  body, url, tag}`, text only, no money or contact details, under 3 KB.
- [ ] **`email.ts`:** the reminder and digest messages through `mail/render.tsx`, in `en`, `ar`,
  `fr`, `de`, `it` (D204), each naming the thing, path, location and local date (L113), amounts
  never (money isn't in a reminder), a deep link to the item, and a footer link to Settings → Me →
  Notifications. Also `membership-ended` (D46) for the owner, and a channel test message.
- [ ] **`webhook.ts`** (D30, D110, §2.6; Q6): POST JSON through `guardedFetch({allowPrivate:
  instance ssrf_allow_private})`, redirects refused:

  ```json
  { "id": "evt_…", "event": "reminder.due", "occurred_at": "2026-10-01T09:12:00Z",
    "location_id": "…", "occurrence": { "id": "…", "kind": "overdue", "source_type": "loan", "due_on": "2026-10-17" },
    "entity": { "type": "thing", "id": "…" }, "url": "https://…/t/2HX9RB" }
  ```

  No names or values (D110). Signed `Kept-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256 over
  `<t>.<raw body>` with the channel's secret. Sent by the `channel-webhook` job (10 attempts over
  about 24 h); after the last failure the channel gets `failing_since` and the user a notification.
- [ ] **Routes:**

  | Method and path | Body → Response |
  |---|---|
  | `GET /api/v1/me/notification-settings` | → `{timezone, digestTime, quietFrom, quietTo, smtpConfigured, push: {available, publicKey \| null, reason?: 'no_https' \| 'no_subject'}, channels: Channel[], locations: Array<{locationId, name, role, kinds: Record<NotifyKind, {inapp, email, webpush, webhook: boolean, isDefault: boolean}>}>, account: {aiSummary: {email: boolean}}}`. Viewers' locations list only `membership` (Q8) |
  | `PUT /api/v1/me/notification-settings` | `{digestTime?, quietFrom?, quietTo?}` (both quiet ends or neither) → the same. Audited `me.notifications` |
  | `PUT /api/v1/me/notification-preferences` | `{items: [{locationId \| null, kind, channel, enabled}] (≤ 200)}` → the same settings. Setting a value equal to the default deletes the row. Audited once |
  | `POST /api/v1/me/channels` | `{kind: 'webhook', url, label?}` → 201 `{channel: Channel, secret}` (the secret shown **once**). Max 5 |
  | `DELETE /api/v1/me/channels/:id` | → 204 (email: 400; turn its preferences off instead) |
  | `POST /api/v1/me/channels/:id/test` | → `{ok: boolean, status?: number, error?: string}`. 5 an hour per user |
  | `POST /api/v1/me/push-subscriptions` | `{endpoint, keys: {p256dh, auth}, label?}` → 201 `{id}`; the same endpoint again updates it. Creates the user's webpush channel row if missing |
  | `DELETE /api/v1/me/push-subscriptions/:id` | → 204 |
  | `POST /api/v1/me/push-subscriptions/:id/test` | → `{ok, status?}` |

  `Channel = {id, kind, label, displayHost, verifiedAt, failingSince, subscriptions?: Array<{id, label, createdAt, lastSuccessAt}>}`.
  The webhook URL is never returned after creation, only `displayHost`.
- [ ] **Tests:** VAPID generated once across two booting processes (the lock); env keys win; a push
  endpoint resolving to `10.0.0.5` refused even with `ssrf_allow_private` on; a 410 deletes the
  subscription; the webhook signature verifies with the secret; a redirect is refused; a failing
  webhook marks `failing_since` after the last attempt, never failing the scan; the preference
  default-deletion; `rotate-key` re-wraps the channel config and the VAPID key; email templates in
  five languages (Mailpit in the integration test).
- [ ] **Commit:** `feat(notify): email, web push and webhook channels, VAPID keys and notification preferences`.

### Task 16: The notification centre, AI notices and the monthly-summary opt-out

**Size:** 1.5 d (after T14, T15). **Files:** `src/notify/{centre,notices}.ts`; modify
`src/ai/notices.ts` (the in-app side), the AI monthly summary sender; tests.

| Method and path | Body → Response |
|---|---|
| `GET /api/v1/notifications?unread&kind&locationId&cursor` | → `{items: Notification[], unread: number, next_cursor}` |
| `GET /api/v1/notifications/count` | → `{unread}` (the bell; cheap: one index scan) |
| `POST /api/v1/notifications/read` | `{ids?: string[] (≤ 200), all?: true}` → `{unread}`. Not audited: a read receipt is the user's own bookkeeping; `ALLOWLIST` with that reason |

```ts
type Notification = {
  id; kind: 'reminder' | 'membership_added' | 'membership_ended' | 'ai_cap' | 'ai_summary' | 'export_ready';
  createdAt; readAt: string | null; locationId: string | null;
  reminder?: { occurrenceId; sourceType; sourceId; kind; dueOn: string | null; dueValue: string | null;
               state: 'open' | 'done' | 'superseded' | 'cancelled'; subject: SubjectRef; title: string;
               actions: AgendaItem['actions'] };
  membership?: { userName: string; role: Role; locationName: string };
  aiCap?: { scope; level: 80 | 100; month: string };
  exportReady?: { runId; kind: 'claim_pack' | 'insurance_report' };
};
```

- [ ] **Actions stay on their own routes** (complete, snooze, return, renew): the centre links
  to them and re-reads; nothing is duplicated.
- [ ] **AI:** `ai.cap_notice` also writes an `ai_cap` notification for each recipient (D206's
  "notification centre from step 4"); `ai.monthly_summary` honours the `ai_summary` preference
  (account-level, Q35).
- [ ] **Tests:** a notification of a location the user left disappears (RLS); a done reminder shows
  `state: 'done'` and no actions; the count matches the list; AI cap at 80% makes one notification
  per recipient; opting out of the summary stops its email.
- [ ] **Commit:** `feat(notify): the notification centre, AI notices in-app and the summary opt-out`.

### Task 17: The calendar feed (a 1.x candidate; built last in its wave)

**Size:** 2 d. **Files:** `src/calendar/{routes,ical,feed}.ts`; tests with
`test/fixtures/ical/*.ics`.

| Method and path | Body → Response |
|---|---|
| `GET /api/v1/me/calendar-feeds` | → `{items: Array<{id, createdAt, lastFetchedAt, fetches, revokedAt}>}` |
| `POST /api/v1/me/calendar-feeds` | → 201 `{id, url}`: `url = <public URL>/cal/<token>.ics`, the token (32 random bytes, base64url) shown **once**, stored as SHA-256. At most 3 live. Audited |
| `DELETE /api/v1/me/calendar-feeds/:id` | → 204 (revoked). Audited |
| `GET /cal/:token.ics` (public) | → `200 text/calendar; charset=utf-8`, `Cache-Control: private, max-age=900`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`. Unknown, revoked or a disabled user → **404** (never says which). 60 a minute per feed (§3.2's share-link rate, reused) |

- [ ] **Content** (D142, D110, D116): the user's agenda (`agenda_items` read **in the user's own
  scope**, `withScope(user)`, after `kept.calendar_feed_user()` returned them), states upcoming,
  due, overdue and expiring, 13 months ahead and 1 month back, filtered by their enabled kinds
  (Q23). One all-day `VEVENT` per item: `UID` = `<source_type>-<source_id>-<due_period>@<host>`;
  `DTSTART;VALUE=DATE`; `SUMMARY` the title and the thing or place name ("Boiler service · Kitchen",
  in the user's locale); `URL` the deep link; `DESCRIPTION` the path and location. **No money,
  secrets, people's contact details or notes.** Meter-only schedules without a date are left out.
- [ ] **`ical.ts`:** RFC 5545 writing: CRLF line ends, folding at 75 octets **without splitting a
  UTF-8 sequence**, escaping of `\`, `;`, `,` and newlines, `VCALENDAR` with `PRODID`, `VERSION:2.0`,
  `CALSCALE:GREGORIAN`, `X-WR-CALNAME`. Tests against fixtures, including Arabic titles (folding
  inside multi-byte characters).
- [ ] **Logs:** the token is redacted from request logs (D181: tokens in URLs), a test with a pino
  capture.
- [ ] **Commit:** `feat(calendar): a private, revocable iCal feed of what's due`.

### Task 18: Incidents, the insurance report and claim packs

**Size:** 4 d (after T8, T9; the incident and claim-pack half is a 1.x candidate). **Files:**
`src/incidents/{routes,service,report,claim-pack,download,undo}.ts`,
`src/reports/template/insurance.typ`; modify `reports/{service,jobs,routes}.ts` (the `kind`),
`jobs/household.ts`; tests.

| Method and path | Body → Response |
|---|---|
| `GET /api/v1/incidents?locationId&kind&cursor` · `GET /api/v1/incidents/:id` | → `{items: IncidentRow[]}` · `Incident` |
| `POST /api/v1/locations/:id/incidents` | `{id?, kind, occurredOn, policeReference?, insurerReference?, notes?, thingIds?: string[] (≤ 200), lifecycle?: 'stolen'\|'destroyed'\|'lost'}` → 201 `Incident`. `incidents.manage` (owner, admin). With `lifecycle`, the listed things end with it (D158), one audit event each plus the incident's |
| `PATCH /api/v1/incidents/:id` · `DELETE /api/v1/incidents/:id` | `If-Match`. Undoable |
| `POST /api/v1/incidents/:id/things` | `If-Match`; `{add?: string[], remove?: string[], lifecycle?}` → `Incident`. Undoable |
| `POST /api/v1/reports/insurance` | `{scope: {locationId} \| {incidentId}, asOf?: date (default today; Q20), reportCurrency?: string, include?: {photos? = true}, locale?, digits?}` → 202 `{id, status: 'queued', expiresAt}` (as the inventory report, 5 an hour). `reportCurrency` without rates for every pair → 409 `rate_missing` with `missing: [{from, to}]` (Q21). Admins and owner for an incident; members and above for a location (they see money: D13), viewers only where money is shown to them |
| `GET /api/v1/reports/:id` | unchanged (the step-2 route), now for either kind |
| `GET /api/v1/reports/insurance.csv?locationId\|incidentId&asOf` | streamed CSV, one row per thing, formula-safe cells (D169), money columns only when the gate shows money |
| `POST /api/v1/claim-packs` | `{scope: {incidentId} \| {locationId, thingIds: string[] (≤ 500)}, locale?, digits?, acknowledged: true}` → 202 `{id, status}`. `incidents.manage`. Without `acknowledged` → 400: the "this includes prices and documents" warning must have been shown (D158) |
| `GET /api/v1/claim-packs/:id` | → `{id, status, progress, bytes?, error?, link: {expiresAt, downloads, lastDownloadedAt} \| null, expiresAt}` (the creator only) |
| `POST /api/v1/claim-packs/:id/link` | `{days?: 1..7 (default 7)}` → `{url, expiresAt}`: a new token, the previous one revoked. The URL is `<public URL>/x/<token>`; shown once. Audited `claim_pack.link` |
| `DELETE /api/v1/claim-packs/:id/link` | → 204 (revoked). Audited |
| `GET /x/:token` (public) | → the ZIP, `Content-Disposition: attachment; filename="kept-claim-<date>.zip"`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`; expired, revoked, unknown, or a creator who lost the role (D180) → **410** with a small page "This link has expired" (engineering spec §5) in the Accept-Language's language |

- [ ] **The report** (§2.8, D158, D201): `report.ts` gathers per place (the tree order), each
  thing's thumbnail, name, brand, model, serial, purchase date and price, current value (latest
  valuation on or before `asOf`), and receipt count with the receipts listed as links into Kept
  (not files: a PDF can't open a signed URL later). Totals per place and location **per currency**;
  with `reportCurrency`, a converted total beside them, labelled with the rates' dates. Header: as
  of, location, owner, incident reference. Rendered by `insurance.typ` through the step-2 engine.
- [ ] **The claim pack** (`claim-pack` tenant job): the report PDF for the scope, then every
  referenced receipt and invoice **original** and each thing's photos (display derivatives), plus
  `serials.csv` (formula-safe), streamed through `yazl` into the blob store under the export run's
  key; progress updated every 20 files; `export_ready` notification to the creator when done; the
  blob purged by `purge-exports` at `expires_at`. Secrets are never included.
- [ ] **Tests:** an incident with 3 things marks them stolen and the report lists them; totals per
  currency and a converted total only with rates; a report for a member of an Essentials location
  → module off; the claim pack contains the originals byte-identical (SHA-256), and never a secret;
  the link works without a session, then 410 after revoke, after expiry, and after the creator is
  demoted to member; downloads counted; the token is redacted from logs; Arabic report renders
  (the V34 checks: shaping, digits).
- [ ] **Commit:** `feat(incidents): incidents, the insurance report and claim packs behind an expiring link`.

### Task 19: Server carry-over from step 3

**Size:** 1.5 d. **Files:** as each item names; tests beside each.

- [ ] **Codes** (T17a): `POST /things/:id/duplicate` returns `ownCodes`; `PathStep` gains
  `shortCode` so breadcrumbs link by short ID (D208); a `code` tombstone is written when a code
  moves from one thing to another, so A's phone drops it. The tombstone needs a `sync_tombstones`
  entity type: **if it needs a CHECK change, hand it to the Phase-A owner** (a migration).
- [ ] **Sync ops** (T14): a `location_revoked` answer without a prior op in that location (a small
  definer: "is this location one I was a member of", returning only a boolean; also a migration →
  Phase-A owner); a queued `mark_seen` stamps `takenAt`, not the apply time.
- [ ] **`/me`** gains `suggestLocation` (read and PATCH `user_profiles.suggest_location`).
- [ ] **AI usage:** the `ai-calls` saved-view surface (server validation in
  `search/saved-views.ts` reads `SURFACE_FILTER_KEYS`), the call list's history filter, and an
  accounts list for the instance-cap override picker (`GET /api/v1/admin/accounts?q` → `{items:
  [{id, ownerName, locations: number}]}`, instance admins; names only, D33: no location data).
- [ ] **Commit(s):** one per item, e.g. `fix(codes): …`, `fix(sync): …`, `feat(me): …`, `feat(ai): …`.

---

## Phase C: web (T20–T28, parallel by area; each starts on the mock)

Shared rules: build to screens §5 and the frames named per task; controls follow screens §3
(hidden for the role, "Off in this location" for a module, disabled with the reason offline:
"Needs a connection"); user text bidi-isolated; tests with Vitest and Testing Library against the
mock: keyboard, RTL, the viewer variant, the module-off variant, and the offline variant; 375, 768
and 1280 px, both themes. Every date picker is `components/ui/date-picker.tsx`; every choice list
`combobox.tsx` or `select.tsx`; every destructive confirm `components/ui/confirm.tsx`; every
undoable write shows the Undo toast from `X-Kept-Audit-Event`.

### Task 20: Thing detail: warranties, claims, value, loans, schedules; the derived states

**Size:** 3 d. **Frames:** "Thing detail · phone · Samsung TV" (top, scrolled, action menu) and
"Thing detail · desktop · Bosch drill on the Loans tab". **Files:**
`components/{warranties,claims,lending,money}/*`, modify `components/things/{thing-screen,header,paperwork,action-menu}.tsx`.

- [ ] **Paperwork and warranties:** the list, longest cover first; each active warranty's
  **coverage bar** (bought → today → covered until; lifetime reads "Lifetime"); add/edit sheet with
  the defaults prefilled and labelled "Samsung TVs: 2 years (from the brand)"; the registration flag
  and deadline; documents attached in the sheet.
- [ ] **Claims:** the claim card (status stepper, vendor, reference, cost), prefilled from the
  longest active warranty with the brand's claim URL and phone; "Warranty saved you <amount>" on a
  resolved no-cost claim (D195).
- [ ] **Value:** current value with its date and source; the valuations list and sheet (money
  hidden → the section shows "Hidden in this location").
- [ ] **Loans tab and sheets:** Lend (person picker: members first, then contacts, "+ New person";
  partial quantity; due date; condition photos), Mark returned (to previous place / choose; merge
  back switch shown only for a split), Borrow (from the location's action menu and "+ Borrowed
  thing").
- [ ] **Schedules section:** the thing's schedules with next due and Complete/Snooze (T21's sheets).
- [ ] **Header and path:** derived chips lent, borrowed, in repair; "with Murdock since 3 Oct · due
  17 Oct"; "at <service centre>" and "Usually in <place>"; Lend hidden while in repair or lent,
  Split hidden on quantity 1 (screens §8).
- [ ] **Commit:** `feat(web): warranties, claims, value, loans and schedules on the thing page`.

### Task 21: Schedules screen, Log a service and the Complete and Snooze sheets

**Size:** 2.5 d. **Frame:** "Log a service · phone · light". **Files:**
`components/{schedules,services}/*`, `routes/_app/schedules.tsx`.

- [ ] **`/schedules`:** global list (location chip), filter strip surface `schedules`, Display
  (sort by due, name; group by location, subject), rows with subject path, next due ("in 12 days",
  "at 60,000 km", "3 days overdue"); empty state "Nothing scheduled" (engineering spec §5). The
  "Starter schedules" action of §5 belongs to vehicles (D52): not offered in step 4.
- [ ] **New/edit schedule sheet** on a thing or a place: every N months and/or every N units on a
  meter, or a one-off date; lead time; validation per screens §7.
- [ ] **Complete** (one sheet from the list, the thing page and the notification centre): date,
  optional reading (with the neighbour check message), vendor, total with currency, notes;
  **Log a service** (the full screen of screens §5 without AI line items): lines, "Completes" with
  the thing's schedules ticked, invoice attach.
- [ ] **Snooze** to a date or to a reading (+10% default), Skip once, Unsnooze.
- [ ] **Commit:** `feat(web): schedules, complete and snooze, and Log a service`.

### Task 22: The Lending screen and the person page

**Size:** 1.5 d. **Files:** `components/lending/*`, `routes/_app/lending.tsx`, modify
`routes/_app/people.$id.tsx`.

- [ ] **`/lending`:** Out · In (tabs as a filter value, not a second toolbar: D211), overdue first,
  filter strip surface `lending`; each row: thing, person, since, due, overdue badge, Mark returned;
  "Copy a polite reminder" (D57: the text in the user's language, copied to the clipboard; **Kept
  never sends it**).
- [ ] **Person page:** "Has from us" and "Lent to us", then what belongs to them (D57).
- [ ] **Commit:** `feat(web): the Lending screen and loans on the person page`.

### Task 23: Paperwork library, Expiring screen, location and place documents

**Size:** 2 d. **Files:** `components/{paperwork,documents,agenda}/*`,
`routes/_app/{paperwork,expiring}.tsx`, modify the location and place pages
(`routes/_app/{loc.$id,p.$id}.tsx` sections).

- [ ] **`/paperwork`:** search box over file text, filter strip surface `paperwork` (location, role,
  subject kind, expiry), grid or list layout through Display (D211); each row opens the file (the
  signed URL route) and its subject.
- [ ] **Documents on a location or place** (D155): a Paperwork section on the location and place
  pages with "Add document" and "Add expiring document" (lease, home insurance…), and Renew.
- [ ] **`/expiring`:** things, documents and warranties by date (screens §5), from `/agenda`.
- [ ] **Commit:** `feat(web): the paperwork library, expiring documents and the Expiring screen`.

### Task 24: The notification centre, the bell and the service worker's push

**Size:** 2 d. **Frame:** "7 · Notification centre · phone · light". **Files:**
`components/notifications/*`, `routes/_app/notifications.tsx`, `src/sw.ts`, `src/pwa/push.ts`.

- [ ] **`/notifications`:** grouped by kind, each naming the thing, place, location and local date;
  inline Complete, Snooze (to a date or a reading) and Mark returned; Mark all read; filter strip
  surface `notifications`; pull to refresh.
- [ ] **The bell** in the header: the unread count (polled with the other counts, and refetched on
  focus); a badge on the rail (D198).
- [ ] **`sw.ts`:** `push` → `self.registration.showNotification(title, {body, tag, data: {url}})`;
  `notificationclick` → focus an open Kept window and navigate it, else `clients.openWindow(url)`
  (same-origin URLs only). Unit tests with a synthetic event; the CDP path from T0 in e2e.
- [ ] **Commit:** `feat(web): the notification centre, the bell, and push in the service worker`.

### Task 25: Settings → Me → Notifications, channels and the calendar feed

**Size:** 2 d. **Frame:** "Settings · Me · phone · light" (the notifications part). **Files:**
`components/notifications/settings/*`, `routes/_app/settings.me.notifications.tsx`,
`src/pwa/push.ts`.

- [ ] **Channels:** email (address, "Mail isn't configured on this server" when SMTP is off),
  **This device** push (Enable → the permission prompt **only on this tap**, D139), other devices'
  subscriptions with Remove and Test, webhook channels (add: URL + label → the secret shown once
  with Copy; Test; Remove).
- [ ] **The iPhone rule** (D139, V8): on iOS and not installed (`lib/user-agent.ts` + display mode),
  the push row says plainly that iPhone notifications work only from the installed app, links the
  install sheet (`components/home/install-sheet.tsx`), and offers email. Over plain HTTP: "Push
  needs HTTPS" (D193).
- [ ] **Kinds per location:** a table of kinds × channels per location (phone: one card per
  location), with the defaults marked; viewers' locations show only Membership.
- [ ] **Digest time and quiet hours** (time fields, not native pickers), the timezone shown.
- [ ] **Calendar feed:** Create link (shown once, Copy), the list with last fetched, Revoke; a note
  that Google Calendar fetches from Google's servers and needs Kept reachable from the internet.
- [ ] **Account:** the AI monthly summary switch.
- [ ] **Commit:** `feat(web): notification settings, push on this device, webhook channels and the calendar feed`.

### Task 26: Exchange rates, incidents, the insurance report and claim packs

**Size:** 2.5 d. **Files:** `components/{money,incidents,reports}/*`,
`routes/_app/{settings.account.exchange-rates,incidents,incidents.$id,reports.$kind}.tsx`.

- [ ] **Settings → Account → Exchange rates:** pairs by date, add/edit/delete with undo, a note
  that totals are never estimated.
- [ ] **`/incidents` and the incident page:** list, create from a multi-select of things ("Add to
  incident", screens §5), references, documents, the claims under it, "Mark these stolen".
- [ ] **`/reports/insurance`:** scope (location or incident), as-of date, optional report currency
  (with the missing pairs listed when refused), progress, download; the CSV link.
- [ ] **`/reports/claim-pack`:** the warning "This includes prices and documents" with a checkbox
  that must be ticked, progress, then Create link (shown once, Copy, expiry), downloads count,
  Revoke.
- [ ] **Commit:** `feat(web): exchange rates, incidents, the insurance report and claim packs`.

### Task 27: Home's attention rows, navigation and pull to refresh

**Size:** 1 d. **Files:** `components/home/attention.tsx`, `components/app-shell.tsx`,
the new routes' `PullToRefresh` wrappers.

- [ ] Rows overdue · due · expiring · lent out · borrowed in in the §8 order, zero rows hidden,
  each opening its list (T13's rule).
- [ ] Nav entries live per module (screens §1); Notifications live for everyone.
- [ ] Pull to refresh (D212) on Schedules, Lending, Paperwork, Expiring, Notifications, Incidents
  and the thing page's new sections, never costing a tap (its tests from `pull-to-refresh.test.tsx`
  reused per page).
- [ ] **Commit:** `feat(web): Home's due, overdue, expiring and loan rows, and the step-4 nav`.

### Task 28: Web carry-over from step 3

**Size:** 2 d. **Files:** as each item names.

- [ ] **Offline thing and place pages:** `/t/$id` and `/p/$id` render from `OfflineStore` when the
  server can't be reached ("as of last sync"), with derived states and the loan line from the
  snapshot, and "Details need a connection" for the rest.
- [ ] **UI audit lows L1–L11** (`docs/audits/ui-2026-09-29.md`), including the filter-strip test at
  375 px in all five languages for every list's longest sort word (L11), now covering the step-4
  lists too.
- [ ] **Toasts:** the dangling live-region node (axe `role-img-alt` after a toast).
- [ ] **Wording:** a queued label claim isn't "1 capture waiting"; the capture live region clears
  after sync.
- [ ] **Settings → Me:** "Suggest where I am" reads and writes the server (T19).
- [ ] **AI usage:** the `ai-calls` saved views, the history filter strip, and the per-account
  override picker on Admin → AI (T19's accounts list).
- [ ] **Home's unprinted-labels row:** decide with the maintainer (screens §8 has no row); until
  then the Labels page keeps its count.
- [ ] **Commits:** one per item.

---

## Phase D: finish

### Task 29: A review pass over step 4's screens

**Size:** 1 d. Not the second UI audit (that is before 1.0): a reviewer pass over the step-4
screens only, against the frames that exist and screens §3, §5 and §8, at 375, 768 and 1280, both
themes and Arabic, with axe on every new route. Fix every high and medium; carry the lows.
**Commit:** `fix(web): step-4 screens review`.

### Task 30: i18n, e2e, leak, perf, CI, docs and the device checklist

**Size:** 2.5 d. **Files:** `apps/web/src/locales/{en,ar,fr,de,it}/messages.po`;
`apps/web/e2e/step4.spec.ts`; `apps/server/test/perf/step4.perf.test.ts`; `scripts/ci-local.sh`;
`README.md`; engineering spec §7.11 (the VAPID rows) and §7.13 (Q13, Q35); product design §19
(V8, V21); `docs/plans/step-4-carryover.md`.

- [ ] **i18n:** extract once (in a temporary worktree at HEAD plus the step-4 files, so other
  agents' strings stay out) and write every new string in all five languages, Arabic in the house
  style; `check-i18n` passes. Mail templates are already five-language (T15).
- [ ] **Playwright** on the `households` seed (extended in T30 with the T3 fixtures through the
  service layer), 375×780 and 1280×800:
  1. Bruce lends the drill to Murdock due yesterday; the scan runs (`kept admin` job trigger or a
     test hook); the notification centre shows it overdue; Mark returned from the centre; the thing
     is back in its place; Undo from the toast re-opens the loan.
  2. Partial lend of 2 of 5 cables, return, merged back to 5.
  3. A TV with two warranties: the coverage bar; open a claim, set it in repair: the path reads "at
     <service centre>" and Lend is hidden; resolve at no cost with a covered amount: "Warranty saved
     you".
  4. A boiler schedule on the Kitchen, due: Complete from Home's "due" row; the next due moves by
     the interval; Undo puts it back.
  5. A lease on Alfred's بيت العائلة expiring: Renew; the Expiring screen shows the new date; the
     old one is in its history (Arabic RTL, Eastern digits).
  6. Settings → Me → Notifications: turn on email for warranties; Mailpit receives the digest at the
     faked digest time with the thing, path, location and local date; enable push in Chromium where
     T0 says it can (else the CDP path) and the notification opens the thing.
  7. Create a calendar feed; fetch it without a session: valid iCal with the boiler service; revoke:
     404.
  8. An incident of 2 things, stolen; the insurance report PDF downloads; a claim pack builds; its
     link downloads without a session; revoked: 410.
  9. Talia (viewer): sees warranties and loans, no actions, no money; no reminder settings but
     Membership.
  10. Module off: turn Lending off in Garage: the nav entry hides if off everywhere, the thing's Lend
      reads "Off in this location", and Garage's loan reminders stop.
  11. axe on every page visited.
- [ ] **Leak:** `leak-household.ts` fixtures, plus the agenda, notification, preference, channel,
  feed and export-run cases; the claim-pack link after the creator's demotion; the snapshot never
  carries a contact detail.
- [ ] **Perf** (`test/perf`, full mode): the agenda for Home's counts at 10,000 things with 2,000
  warranties, 500 schedules, 300 loans and 200 documents (provisional p95 < 150 ms); a full scan
  pass at that size (< 20 s, well inside 60 s); the notification count (< 20 ms). Record them in
  `docs/perf/2026-xx-step4.md` and set the limits from the measurement.
- [ ] **CI** (`scripts/ci-local.sh`): `licences` passes with `web-push` (MPL-2.0) and `yazl`; the
  e2e step starts a worker so the scan and digest run; `prod-boot` asserts the VAPID key is
  generated once and never logged.
- [ ] **Docs:** README: SMTP for reminders (Mailpit in development, a real SMTP URL in
  production), push needs HTTPS and on iPhone the installed app, the calendar feed and Google;
  engineering spec §7.11 gains `KEPT_VAPID_*`; §19 V8 and V21 get their results or "device check
  pending"; `docs/plans/step-4-carryover.md`.
- [ ] **Gate:** `bash scripts/ci-local.sh` exits 0. **Commit:** `chore: step-4 i18n, e2e, leak and perf checks, CI and docs`.

---

## Needs the maintainer's devices and outside setup, and how the build proceeds without them

The checklist is `docs/spikes/2026-xx-step4-devices.md` (T0). Test over HTTPS (mkcert or a
Tailscale cert). The build **never waits** for a device result: every task ships the fallback.

| # | Check | Needs | Built meanwhile | If it fails |
|---|---|---|---|---|
| **V8** | iPhone web push works **only from the installed app** (iOS 16.4+): subscribe from Settings → Me in the installed app, receive an overdue reminder, tap it and land on the thing | the maintainer's iPhone, Kept installed to the home screen, HTTPS | The iOS rule in T25: not installed → told plainly, offered email; e2e covers push in Chromium | Email stays the iPhone path; Settings says push isn't available on this device |
| — | The permission prompt appears from the tap on "Enable" (a user gesture) in the installed iPhone app and in Safari desktop | iPhone, a Mac | The prompt is only ever asked from that tap (D139) | Help explains how to allow notifications in iOS Settings |
| — | Android Chrome: push installed and in the browser; the notification opens the installed app | an Android phone | Same code path as desktop Chrome | — |
| — | A notification's tap opens the right page in the **installed** app, not Safari | iPhone | `notificationclick` focuses or opens same-origin URLs | The notification opens Kept's Home and the centre lists the item |
| — | The calendar feed subscribes in Apple Calendar on the iPhone (over Tailscale) | iPhone | The feed and its fixtures | Settings shows "Download .ics" as a one-off import |
| — | **Google Calendar** subscribes to the feed: Google fetches it from its own servers, so Kept must be reachable from the internet; the homelab alpha is LAN and Tailscale only | a public URL (not planned now) | The note in T25 | Apple Calendar or Thunderbird, which fetch from the device |
| — | Reminder and digest mail renders correctly (RTL Arabic, digits) in Gmail on iOS and Apple Mail | **SMTP credentials** for the alpha (`KEPT_SMTP_URL`, `KEPT_SMTP_FROM`) and the maintainer's mailbox | Mailpit in dev and e2e | Adjust the React mail templates; the in-app centre carries every reminder anyway |
| — | The webhook channel reaches a real receiver (for example the maintainer's own n8n) and the signature verifies | a receiving URL | A local receiver in tests | — |
| — | The claim-pack ZIP downloads on iPhone Safari into Files, and the insurance PDF opens there | iPhone | — | — |
| **V21** | Reminders at the right local time across Egypt's DST | none (tests) | T14's DST tests with T0's computed dates | — |

**Not needed in step 4:** Apprise, ntfy and Telegram (1.x, D130; V22 stays 1.x) and email-in or
IMAP receipts (D21, 1.x).

---

## Definition of done for step 4

- `bash scripts/ci-local.sh` exits 0, including `drift`, `licences`, `perf` and `e2e`.
- The leak test covers every new table (with `fillTenant` rows), the agenda view (security
  invoker), every new function, and the user-scope tables across users of one location. kept_app
  can't read `notification_channels.config_ciphertext` or the VAPID key.
- Every non-GET route writes an audit row or is on the catalogue's allowlist with a reason
  (`/cal/:token`, `/x/:token` are GETs; `POST /notifications/read` is allowlisted).
- On a fresh `docker compose up` with the `households` seed, over HTTPS, with Mailpit:
  - add two warranties to the TV (defaults from the brand), see the coverage bar, open a claim and
    set it in repair: the path reads "at <service centre>";
  - lend the drill to Murdock with a due date in the past: after the next scan it is in the
    notification centre and Home's overdue row, and Bruce's digest (at his digest time) and
    immediate overdue mail arrive in Mailpit, naming the thing, path, location and local date;
    Murdock is never contacted; mark it returned from the centre;
  - lend 2 of 5 cables and return them: one row of 5 again;
  - borrow Murdock's ladder and return it: it leaves the counts;
  - schedule the boiler service on the Kitchen, complete it with a cost, snooze and skip;
  - renew the home-insurance document on the location and see the old one kept;
  - find the lease by a word of its text in the paperwork library;
  - enter a USD→EGP rate and get an insurance report with totals per currency and a converted total;
    create an incident, build a claim pack, download it through its link without a session, revoke
    it;
  - subscribe the calendar feed, fetch it, revoke it;
  - turn Lending off in Garage: its screens say "Off in this location" and its loan reminders stop,
    then turn it on: exactly one reminder for the current period.
- Exactly once is proven by test (two scans, concurrent scans); a failed push or webhook never
  fails a write or a scan; the DST tests pass.
- Web push works in desktop Chromium end to end (or through the CDP path T0 records); the device
  checklist is filled in, or each open row names the fallback in use; §19 V8 and V21 are updated.
- No money, secret or contact detail reaches a reminder, a push payload, a webhook, the calendar
  feed or the offline snapshot.
- `docs/plans/step-4-carryover.md` lists anything deferred, each with the step that takes it.

---

## Spec questions that are genuinely ambiguous, with proposed answers (adopt these)

1. **Service records: step 4 or step 5?** D29 says completing a schedule "creates a service record
   (for any thing, not only vehicles)", D113 makes service records core, and screens §5's "Log a
   service" is for any metered thing, but §17 lists "services" under step 5.
   **Proposal:** step 4 builds the core tables, the API and the Log a service screen without AI
   line items; step 5 adds the vehicle Services tab, invoice extraction into lines, fuel and cost
   reports.
2. **Unit-based schedules without estimates.** D52's distance estimates are step 5. **Proposal:** a
   unit schedule is due when the latest accepted reading reaches `due_value - lead_units`, shown as
   "at 60,000 km"; step 5 adds the estimated date and "unknown — reading needed" after 60 days
   (D188).
3. **Which reminder sources ship now.** **Proposal:** schedule, warranty, registration, document,
   loan, thing_expiry. `stock` lands with consumables (step 7); `reading_stale` with the vehicle
   work (step 5, D52). The engine's source table already has both slots.
4. **`registration` in §1.9's source types is undefined.** Vehicle registration is a document kind
   (§1.6). **Proposal (inferred):** `registration` is D55's warranty-registration deadline.
5. **Which module a document reminder belongs to.** D113 names only warranties, loans and stock.
   **Proposal:** Paperwork; step 5 widens it to "Paperwork or Vehicles" for a vehicle's documents.
6. **"Webhook" as a 1.0 channel (D30, §10, §17) vs outbound webhooks in step 6 (§2.6) and the
   scope advice's "webhooks and Shortcuts" as a 1.x candidate.** **Proposal:** step 4's webhook is
   a **personal notification channel** only: the §2.6 envelope and signature, event
   `reminder.due`, IDs, the due date and a deep link, no names (D110). Location webhooks stay in
   step 6 and reuse `notify/webhook.ts`'s signer.
7. **Which kinds each source produces** (§1.9 has due, overdue, expiring). **Proposal:** schedules
   due and overdue; warranties expiring only (an ended warranty isn't actionable); a registration
   deadline due; documents and thing expiries expiring and overdue (an expired lease or
   extinguisher matters); loans overdue only (D57: "a reminder when overdue"), with the due date on
   the Lending screen and Home's rows.
8. **Default recipients** (D29: "admins get everything by default, viewers nothing"; members
   unstated). **Proposal:** owner and admin, every kind on; member, only loans they recorded (D57
   "reminders go to the user"), everything else opt-in; viewer, no reminder kinds at all (they can't
   act on them), only their own membership notices.
9. **Unstated defaults.** **Proposal:** digest at 08:00 in the user's zone; no quiet hours; an
   overdue item inside quiet hours waits for their end; schedule lead 14 days and 10% of a unit
   interval; warranty, document and thing-expiry lead 30 days (§3.4); registration deadline 14
   days; loans no lead.
10. **The in-app centre vs channels.** **Proposal:** the centre isn't a channel: every enabled kind
    lands there; channels (email, push, webhook) are extra. `notification_preferences.channel`
    includes `inapp` so a person can silence a kind entirely.
11. **Where VAPID keys live.** D81 says "generated at first run", but §7.11 says the config volume
    holds only `KEPT_SECRET_KEY` and `KEPT_AUTH_SECRET`. **Proposal:** in `instance_settings`, the
    private key sealed with the envelope key, generated under the setup code's advisory lock;
    `KEPT_VAPID_*` override; `rotate-key` re-wraps it. Losing the keys only means phones
    re-subscribe.
12. **Push endpoints and SSRF.** An endpoint is browser-supplied, so a crafted subscription could
    aim the server at the LAN. **Proposal:** HTTPS only, and a connect-time private-address refusal
    that ignores `ssrf_allow_private`.
13. **Email as a channel row.** §7.13 has `reminder_deliveries.channel` referencing
    `notification_channels.id`. **Proposal:** each user's email channel is a row created lazily;
    managed accounts never get one.
14. **Partial loans' return.** **Proposal:** the lent part is split at lending; at return it merges
    back into the row it came from when that row is live, in the same place and of the same type
    (D172 "by default"); otherwise it stays its own row, and the person can switch merging off.
15. **Borrowed things at return.** **Proposal:** lifecycle `returned_to_owner` with `ended_on`, so
    they leave counts and value totals (D56) and stay in history.
16. **Lending to a member.** D57 allows lending to a member. **Proposal:** the member is a `people`
    row with `member_user_id`; if they're a member of that location, they receive the overdue
    reminder too (their own household). Nobody outside Kept's users is ever messaged.
17. **Moving a thing that is lent or in repair to another location.** **Proposal:** refused (409
    `open_loan`, `open_claim`); history rows move, their people and vendors mapped across accounts
    as `move_things()` already maps owners; a thing leaving leaves its incidents.
18. **"Warranty saved you <amount>" (D195)** needs an amount Kept doesn't hold (a claim has only
    `cost`). **Proposal:** an optional `covered_amount` ("what it would have cost") on the claim;
    the sentence shows the amount only when it's set, otherwise "Covered by the warranty". A closed
    claim reopens only through undo.
19. **The claim pack's link.** **Proposal:** `/x/<token>`, no session, 7 days (the §3.3 export
    retention) or fewer, revocable, re-created on demand, counting downloads, re-checking the
    creator's role on every download (D180); stored as a blob keyed by the run, not a `files` row
    (§1.10 says `file_id`, but a `files` row is readable only through an attachment, D177).
20. **"As of a date" for the insurance report (§2.8).** Rebuilding the past would need history
    replay. **Proposal:** the report lists things as they are now; `asOf` picks the valuation (the
    latest on or before it) and labels the report; an incident report includes its things even
    though they're ended.
21. **A report currency.** **Proposal:** totals per currency always; a converted total only when
    every pair has a rate on or before `asOf` (direct or inverse, never chained); otherwise 409
    listing the missing pairs. Never estimated (D76).
22. **The optional exchange-rate provider (D76, D136).** No provider is named, and it must cover
    EGP. **Proposal:** not built in step 4 (it's off by default anyway); rates are entered by hand.
    Choosing a provider is the maintainer's call, verified against its terms first.
23. **The calendar feed's range and filter.** **Proposal:** 1 month back to 13 months ahead, the
    kinds the person enabled (any channel), all-day events, at most 3 live links, 404 for anything
    wrong, title and deep link only.
24. **One agenda for counts, lists, the scan and the feed.** **Proposal:** a `security_invoker` view
    over every source, pausing in its `WHERE`; the stored occurrences are only the "sent once"
    ledger. Home's counts never depend on the scan having run.
25. **Deleting step-4 records.** Trash is for things and places (D82). **Proposal:** warranties,
    claims, loans, valuations, schedules, services, documents, incidents and rates are hard-deleted,
    with the full before-image in the audit event and a 7-day undo that re-inserts the row.
26. **A warranty on a quantity above 1 (D10, step-2 Q11).** **Proposal:** 409 `quantity_not_one`
    with "Split it first"; the quantity trigger also refuses raising the quantity while a warranty
    exists.
27. **Month arithmetic.** **Proposal:** add months and clamp to the month's end (31 Jan + 1 month =
    28 or 29 Feb); a term ends the day before the anniversary, inclusive (L2).
28. **Skip once and snooze.** **Proposal:** snooze replaces the due point until completion; skip
    moves the next due point by one interval without a service record, audited `schedule.skip`;
    completing clears both.
29. **The session-bound "confirm your address" flow** (step-1 carry-over, "step 4, with the
    notification work"). It isn't notification work. **Proposal:** not in step 4; the current copy
    stays; revisit in the pre-1.0 security pass if anyone hits it.
30. **Membership notices in-app.** Step 1 recorded them "for the notification centre, which comes in
    step 4". **Proposal:** new members and ended memberships become `notifications` for the owner,
    in the same transaction as today's mail.
31. **A title for "other" documents.** §1.6 has no name column, so "Building inspection" or "Gym
    contract" would read as "Other". **Proposal:** an optional `title`, required for `other`.
32. **The notification centre's actions.** **Proposal:** Complete opens the Complete sheet (a
    reading or cost may be wanted), Snooze offers a date or a reading, Mark returned is one tap with
    Undo; all go through the source's own route.
33. **Brand logos (step-2 Q9).** **Proposal:** PNG, JPEG and WebP uploads now; SVG only if T0's
    spike shows `sharp` rasterises it without any network access, and then only the PNG is kept.
34. **What the offline snapshot says about a loan.** Contact details are banned from the phone
    (D36); a name isn't a contact detail. **Proposal:** the derived states plus `{direction,
    personName, dueOn}`, so the offline path reads "with Murdock · due 17 Oct"; no phone, email or
    notes.
35. **Account-level kinds in preferences.** §1.9's key (user, location, kind, channel) can't express
    the AI monthly summary's opt-out ("in Notifications from step 4"). **Proposal:** `location_id`
    nullable with `UNIQUE NULLS NOT DISTINCT`, null only for `ai_summary`.

---

### Critical files for implementation
- `apps/server/migrations/` (`meta/_journal.json`: step 4 starts at 0048; `0006_rls.sql` for the
  kept_system policy pattern; `0014_registries_rls.sql` for account scope; `0016_things_rls.sql`
  for `guard_thing_quantity`; `0047_thing_meter_version.sql` for the quiet bump and the newest
  `kept.move_things()`; `0039`/`0040`/`0045` for `kept.ai_reserve`'s cap check)
- `apps/server/test/leak.test.ts`, `src/db/migrate.test.ts` (`fillTenant`, `FUNCTIONS`)
- `apps/server/src/audit/undo.ts`, `src/undo/registry.ts`, `src/http/write.ts`
  (`AUDIT_EVENT_HEADER`), `src/serialize/gates.ts`
- `apps/server/src/files/routes.ts` (`OWNERS`, `CreateAttachmentBody`), `src/things/view.ts`
  (`derivedStateOf`), `src/search/query.ts` (`STATE_SQL`, `SEARCH_STATES`), `src/home/service.ts`
  (`HomeResponse`), `src/sync/snapshot.ts`
- `apps/server/src/jobs/{policies,system,queue}.ts`, `src/alerts/alerts.ts`,
  `src/locations/membership-jobs.ts`, `src/mail/messages*.ts`, `src/net/ssrf.ts`,
  `src/secrets/rotate.ts`, `src/reports/*`
- `packages/shared/src/{modules,inventory,list-views,money,sync,roles}.ts`
- `apps/web/src/components/{app-shell,list-surface,pull-to-refresh}.tsx`,
  `components/filters/*`, `components/home/attention.tsx`, `components/things/*`, `src/sw.ts`,
  `src/api/mock/server.ts`, `src/offline/*`
