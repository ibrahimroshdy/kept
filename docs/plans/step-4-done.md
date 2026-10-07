# Step 4: the definition of done, item by item

T30, 2026-09-30. Each item of "Definition of done for step 4"
([2026-09-30-step-4-household.md](2026-09-30-step-4-household.md)) is **met**, **met with a
note**, **not met**, or **maintainer check pending** (it needs the maintainer's phone, mailbox or
a fresh install; the fallback in use is named). The evidence is a test (file and title), a commit
or a document. What is left open, and where it goes, is
[step-4-carryover.md](step-4-carryover.md).

**Summary:** 4 met or met with a note, 2 not met (the one-run gate, and push end to end in a
browser), and the walkthrough on a fresh install is a maintainer check, with most of its steps
covered by the e2e or by server and component tests.

## 1. `bash scripts/ci-local.sh` exits 0, including `drift`, `licences`, `perf` and `e2e`: **not met in one run**

Run in a clean worktree of HEAD (other agents' uncommitted work in the main tree includes new
migrations, which fail the leak test's function inventory), at 557d7b5 and then 8a86ef2 (the
precache trim), 2026-09-30 16:32–17:26. The machine was shared: other agents' suites ran on the
same Postgres, and the load average swung between 4 and 47. `compose` was brought up from the
main tree (from a worktree its relative bind mount would recreate the shared database container).

| Step | Result |
|---|---|
| install, lint, catalogues, typecheck | ok |
| test (`pnpm test`, every project) | **fails.** Best run, 17:18–17:25 at load 11–25: 4,791 passed, 7 failed, 2 skipped. One failure is real and not step 4's: `http/errors.test.ts` "answers every one a request can hit with 409 conflict and a hint, not 400" lists step 5's `fuel_entries_reading_thing` and `service_records_review_state`. The other six pass when run alone (checked): three wall-clock checks (`dexie-store.test.ts` 10,000 things under 1.5 s, `things/move.test.ts` 200 things under 1 s, `pdf-text.test.ts` bomb at the memory limit) and three 15 s timeouts (`conflict.test.tsx` ×2, `incidents.test.tsx` exchange rates). At load 20–47 the earlier runs had 9–20 files fail on 30 s hook timeouts, all passing alone. |
| drift, licences (`web-push` MPL-2.0 and `yazl` allowed), attribution, eval | ok |
| perf | **passes on a quieter machine, fails under load.** At 17:15 (load 8–9) all six checks pass, Home's p95 at 144 ms against 150. Under load 35–37 (the gate's own run) Home's p95 was 217 ms and step 3's 50-op batch 2,060 ms (limit 1,500). [docs/perf/2026-09-30-step4.md](../perf/2026-09-30-step4.md) |
| e2e | **passes, once step 3's spec follows the app.** At 8a86ef2: 49 passed, 3 failed, 18 skipped (the specs' own per-project skips). The three were `step3.spec.ts` looking for words and places the app no longer has (8140e77 "waiting to sync", 128585b Select by the search); bbc2cc1 updates it, and then `step3.spec.ts` 9/9, `step4.spec.ts` 4/4 and `step3-update.spec.ts` 1/1 pass. |
| prod-boot | **not run:** port 8080 is held by an orphaned `prod-boot` server from an earlier run (pid 77450, parent pid 1), which no agent may stop. e963ff4 finds the cause (the step's kill hit a subshell, not the server) and adds the VAPID checks; the changed step passed against a spare port through `startKept`. |
| images | not run (disk; not T30's to build) |

## 2. The leak test covers every new table, the agenda view, every new function and the user-scope tables; kept_app can't read a webhook's config or the VAPID key: **met**

`apps/server/test/leak.test.ts`, passing in the gate's `test` runs:
- `test/leak-household.ts` gives every step-4 table `fillTenant` rows for both tenants; "has
  fixture rows for B in every scoped table, so nothing below passes vacuously", "classifies every
  public table: a scope column, its own id, or a listed exception (L15)".
- The agenda view: "has only security_invoker views, and no materialized views (L28)".
- Functions: "lets the runtime roles EXECUTE exactly the listed functions, definers deliberately"
  and "definer doors: every kept_app door is probed, or listed with its reason" (the claim pack's
  doors, 0049, included).
- User scope within one location: "keeps a person's channels, devices, choices, centre and links
  from the other members of the same location (step-4 T7)"; "keeps an export run from everyone
  but its creator, even another admin (step-4 T4, D180)".
- "never lets kept_app read a webhook's sealed config or the VAPID key (step-4 T7)".
- The claim-pack link after the creator's demotion: `incidents/incidents.test.ts` ("The creator
  demoted to member: the link stops working (D180)", 410).

## 3. Every non-GET route writes an audit row, or is allowlisted with a reason: **met**

`test/route-catalogue.test.ts` "has a marked, audit-asserting test for every non-GET route, or an
allowlisted reason". `POST /api/v1/notifications/read` and the channel and push tests are on
`ALLOWLIST` with their reasons; `/cal/:token` and `/x/:token` are GETs.

## 4. The walkthrough on a fresh `docker compose up`, over HTTPS, with Mailpit: **maintainer check pending**

Not run on a fresh install. The `households` seed has no step-4 rows yet (carry-over). What covers
each step now:

| Step | Covered by |
|---|---|
| Two warranties on the TV, the coverage bar, a claim in repair "at <service centre>" | `warranties/warranties.test.ts` "opens a claim in repair with a service centre made inline: the thing reads "at" it…"; `thing-household.test.tsx` "lists the warranties longest first, each with its coverage bar" |
| The drill lent to Murdock, overdue: the centre, Home's overdue row, the digest and the immediate mail, Murdock never contacted, returned from the centre | **e2e** `step4.spec.ts` "lending: an overdue loan reaches the centre, is marked returned there and undone from the toast; the centre marks read"; `reminders/deliver.test.ts` "sends once, naming the thing, its path, the location and the local date (L113)" (Murdock not in it), "goes at the person's own 08:00, once, listing every waiting item"; `reminders/scan.test.ts` "Bruce gets everything, Louis only his own loan, Talia nothing, Murdock never". Mail into a real Mailpit in e2e: not run |
| 2 of 5 cables lent and returned: one row of 5 | `lending/lending.test.ts` "lending 3 of 5 splits; the return merges back; undo un-merges" |
| Murdock's ladder borrowed and returned: it leaves the counts | `lending/lending.test.ts` "borrows a thing that belongs to the person; its return ends it and it leaves Home's counts"; 97f9695 (and the location card's count) |
| The boiler service on the Kitchen: complete with a cost, snooze, skip | **e2e** `step4.spec.ts` "schedules: Complete from Home's Due row moves the next due by the interval, Undo puts it back, and Snooze holds it" (no cost, no skip in the browser); `schedules` server tests |
| Renew the home insurance on the location, the old one kept | **e2e** `step4.spec.ts` "documents: a lease on بيت العائلة is renewed from Expiring in Arabic, and the old term stays in its history" (a lease, the same path) |
| Find the lease by a word of its text | `paperwork/paperwork.test.ts` "finds a lease PDF by a word of its text, with a snippet and its expiry" |
| A USD→EGP rate, an insurance report with per-currency and converted totals, an incident, a claim pack downloaded without a session, revoked | **e2e** `step4.spec.ts` "incidents: two things stolen, a claim pack whose link downloads without a session, then revoked (410)"; `reports/reports.test.ts` "renders an English report with prices, per-currency totals, a photo and QR codes"; `incidents.test.ts` "queues an insurance run, audits report.generate and sends the report job" |
| The calendar feed: subscribe, fetch, revoke | `calendar/calendar.test.ts` "serves the owner's agenda as all-day events…", "revokes a link (audited): it answers 404 after, and the list says so"; Apple Calendar: device row |
| Lending off in Garage: "Off in this location", reminders stop; on again: one reminder for the current period | `thing-household.test.tsx` "with the modules off, the step-4 tabs are gone and Lend says "Off in this location""; `reminders/scan.test.ts` "turning Warranties off cancels, and back on reopens the one period: no flood" |

## 5. Exactly once by test, a failed push or webhook never fails a write or a scan, the DST tests pass: **met**

- `reminders/scan.test.ts` "two scans in a row, and two at once, write one occurrence and one
  delivery per user and channel"; `deliver.test.ts` "a failed digest is sent by a later pass, still
  once".
- The scan only queues deliveries; each send is its own `reminder-deliver` job, so a failed push
  or webhook fails that job alone: `deliver.test.ts` "a failed send fails the job, and the retry
  claims it again", "a push whose devices are all gone ends skipped".
- DST (V21): `reminders/quiet.test.ts` "wall clocks (V21)", `deliver.test.ts` "a digest at 08:00
  goes at 08:00 local on both sides of each change", "…inside the spring gap goes at the first
  minute after it, once", "…inside the autumn overlap goes once". §19 V21 is updated (c368962).

## 6. Web push in desktop Chromium end to end, the device checklist, §19 V8 and V21: **not met for push; met for the rest**

- **Push end to end in a browser is not in the e2e.** T0's spike ran it once through CDP
  `ServiceWorker.deliverPushMessage` ([2026-09-30-step4-push.md](../spikes/2026-09-30-step4-push.md);
  headless Chromium can't subscribe). What runs now: the worker's handlers
  (`pwa/push-worker.test.ts` "shows the notification, with its tag, icon and URL", "focuses the
  open Kept window and takes it to the URL", "never leaves Kept: another origin, a scheme or
  nothing opens the centre") and the server's sender (`notify/push.test.ts`,
  `notify/senders.test.ts`). Carried over.
- The device checklist ([2026-09-30-step4-devices.md](../spikes/2026-09-30-step4-devices.md),
  ab653f2): every device row is "maintainer check pending" with its fallback; V21 passes by test;
  a row for sharing uploaded originals on the installed iPhone app was added.
- §19: V8 "device check pending" with the fallback in use, V21 verified by tests (c368962).

## 7. No money, secret or contact detail reaches a reminder, a push payload, a webhook, the calendar feed or the offline snapshot: **met with a note**

- By construction: every channel writes from `ReminderFacts` (`notify/words.ts`), which has no
  money or contact field; the webhook envelope carries ids, the due date and a link.
- Tests: `deliver.test.ts` (the mailed item never names Murdock), `notify/webhook.test.ts` (the
  envelope has neither the thing's nor the location's name), `calendar.test.ts` "keeps to the
  kinds its owner gets…", `sync/snapshot.leak.test.ts` "has no money, secret, document, note or
  contact field" (with the loan fixtures of `leak-household.ts`).
- **Note:** no single test asserts "no money" across all four channels at once; each is checked
  on its own.

## 8. `docs/plans/step-4-carryover.md` lists what is deferred, each with its step: **met**

[step-4-carryover.md](step-4-carryover.md): Home's view cost, the e2e journeys not yet in a
browser, the seed, the gate's open steps, the load-sensitive checks, the device rows, and small
things seen on the way. Items with no step yet are marked "proposed".

## Found and fixed by T30

- a242eb0: `jobs/registry.test.ts` checks the `ai-rollover` and `ai-summary` schedules.
- f7afddf: step 4's mails named Settings → Me as "Réglages → Moi", "Einstellungen → Ich" and
  "Impostazioni → Io"; the app says Paramètres, Profil and Profilo. The AI summary's German used
  "Sie" where every other Kept mail says "du".
- e375f21: step 4's Arabic had Western digits in prose ("خلال 7 أيام" ×4, "من 1 إلى 600",
  "قيمة 1"); the catalogue writes "٧ أيام".
- 4913da8: Home read the agenda view twice; now once (p50 −90 ms at 10,000 things).
- e963ff4: `prod-boot` left its server running after every run (the orphans on 8080 in this gate
  and in step 3's); it now checks that the VAPID pair is made once at boot and never logged.
- bbc2cc1: `step3.spec.ts` followed two UI changes it predated.
- 89be44f: `e2e/step4.spec.ts` and the `household` instance.
- c368962, 557d7b5, ab653f2: the README, §7.11, §7.13, §19 and the device checklist.

The i18n check itself: `check-i18n` "3651 messages; every one is in the catalogues",
`check-i18n-extract` "extracting adds nothing to ar, de, en, fr, it; no empty translation"
(ci-local's `lint` and `catalogues`, ok).
