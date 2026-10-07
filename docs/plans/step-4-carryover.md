# Step 4 carry-over

Work left open in build step 4, with where each piece lands. Written by T30 on 2026-09-30.
Where a later step is named as "proposed", no plan has taken the item yet; the maintainer decides.
The review pass (T29) closes its own list of step-4 carry-overs; its report says which.

## Performance

- [ ] **Home's agenda counts sit at the provisional p95 of 150 ms at 10,000 things, with no
  margin.** 4913da8 made Home read `agenda_items` once instead of twice: p95 249 → 144 ms at load
  8–9 (passes by 6 ms), but 161–217 ms under load 13–37 (fails). What is left is the view itself: `kept.module_on()` is called for every source row (43
  of the 97 ms a read takes among 2,000 warranties), and Postgres never inlines a function with a
  `SET search_path` clause ([docs/perf/2026-09-30-step4.md](../perf/2026-09-30-step4.md)). The fix
  decides each location's module state once (a join on the locations' switches, or an inlinable
  `module_on`), in a migration that replaces 0053's view, which the scan, the agenda and the
  Schedules screen share. `test/perf/step4.perf.test.ts` keeps the 150 ms limit, so ci-local's
  `perf` step fails on any but a quiet machine until then. **Proposed: before step 5 widens document reminders to vehicles
  (step-4 Q5), since that touches the same view.**
- [ ] `GET /api/v1/agenda`'s first page (the Expiring screen) is about 200 ms p95 at the same
  size, for the same reason. The plan sets it no target; it is recorded, not gated.

## End-to-end coverage

`apps/web/e2e/step4.spec.ts` runs four of the plan's eleven journeys against the real server: an
overdue loan returned from the notification centre and undone (1), a schedule completed from
Home's Due row and snoozed (4), a lease renewed from Expiring in Arabic (5), and an incident's
claim pack downloaded through its link and revoked (8, without the insurance PDF). axe runs on
every page they visit (11). The rest are covered by server and component tests, not in a browser:

- [ ] (2) Partial lend of 2 of 5 cables, returned and merged back (`lending/lending.test.ts`
  "lending 3 of 5 splits; the return merges back; undo un-merges").
- [ ] (3) The TV's two warranties, the coverage bar, a claim in repair ("at <service centre>",
  Lend hidden) and "Warranty saved you" (`warranties/warranties.test.ts`, `thing-household.test.tsx`
  "lists the warranties longest first, each with its coverage bar").
- [ ] (6) Email for warranties turned on, the digest in Mailpit at a faked digest time, and push
  in Chromium through CDP (`reminders/deliver.test.ts`, `notify/senders.test.ts`,
  `notify/push.test.ts`; the push spike, docs/spikes/2026-09-30-step4-push.md).
- [ ] (7) The calendar feed fetched without a session, then revoked: 404
  (`calendar/calendar.test.ts`).
- [ ] (8, the rest) The insurance report PDF (`incidents/incidents.test.ts` "queues an insurance run,
  audits report.generate and sends the report job"; the claim pack's ZIP holds `report.pdf`).
- [ ] (9) Talia, a viewer: warranties and loans with no actions and no money, no reminder
  settings but Membership (`thing-household.test.tsx` "a viewer reads warranties and claims but gets
  no Add, New claim or Update, and no value"; `notification-settings.test.tsx` "a viewer's location
  lists only Membership (Q8)").
- [ ] (10) Lending off in Garage: the nav entry, "Off in this location", and the loan reminders
  stopping (`thing-household.test.tsx` "with the modules off, the step-4 tabs are gone and Lend says
  'Off in this location'"; `reminders/scan.test.ts` "turning Warranties off cancels, and back on
  reopens the one period: no flood").
- [ ] **The `households` seed has no step-4 rows yet** (the drill with Murdock, the TV's
  warranties, the boiler schedule, the lease). The plan had T30 extend it through the service
  layer; the e2e instead makes each test's rows through the API as the person would. Seeding them
  would also serve the maintainer's walkthrough on a fresh `docker compose up`.

**Proposed for all of the above: step 5's T25 (its e2e pass), on the same `household` instance.**

## The gate

- [ ] **`prod-boot` and `images` did not run in T30's gate.** Port 8080 is held by an orphaned
  `prod-boot` server from an earlier run (pid 77450, started 00:32, parent pid 1), and no agent may
  stop a process it didn't start. The orphans came from the step itself: it started the server as
  a backgrounded shell function, so `$!` was the subshell's pid and the kill left the server
  running. e963ff4 fixes that and adds the VAPID checks; the new step passed on a spare port
  through `startKept` (main.js always listens on 8080). `images` was left out because the disk is
  tight and T30's task isn't about the image. **To finish:** stop pid 77450, then
  `bash scripts/ci-local.sh --from prod-boot`.
- [ ] **`http/errors.test.ts` fails on step 5's constraints**, not step 4's: "answers every one a
  request can hit with 409 conflict and a hint" lists `fuel_entries_reading_thing` and
  `service_records_review_state` (ea5ad2e, 1211491) with no hint. Step 5's own tasks.
- [ ] Three wall-clock checks in the unit suite fail whenever the machine is loaded (load 20–47
  from other agents during T30) and pass alone: `offline/dexie-store.test.ts` (10,000 things in
  under 1.5 s, measured 2.0–3.0 s), `things/move.test.ts` (200 things in under 1 s, 1.15 s),
  `files/pdf-text.test.ts` (the bomb hits the time limit before the memory limit). The step-3
  gate moved one such check to `test/perf` (2f3f47a); these three are candidates for the same.
  **Proposed: step 5's T25.**

## Devices and outside setup

Every device row of [docs/spikes/2026-09-30-step4-devices.md](../spikes/2026-09-30-step4-devices.md)
is "maintainer check pending", each with the fallback in use: push on the installed iPhone (V8),
the permission prompt from a tap, Android, a notification opening the installed app, the calendar
in Apple Calendar, reminder mail in Gmail and Apple Mail (needs the alpha's SMTP credentials),
a webhook to a real receiver, the claim-pack ZIP into Files on iPhone, and sharing uploaded
originals from the installed iPhone app. Google Calendar needs a public URL and is not planned.

## Small things seen on the way

- [ ] In Arabic, the Renew sheet's "Remind me, days before" shows its value as `30` in Western
  digits, beside a date field in Eastern digits (the e2e's screenshot, 2026-09-30). Pre-filled
  numeric inputs across the step-4 sheets likely do the same (inferred, not checked one by one).
  **Proposed: the pre-1.0 UI audit.**
- [ ] Step 4's mail keeps Western digits in Arabic by design ("as all mail",
  `notify/words.ts`), while the app writes Eastern digits. Unchanged; the device row for Gmail and
  Apple Mail is where the maintainer sees it.
