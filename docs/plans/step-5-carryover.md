# Step 5 carry-over

T25 wrote this on 2026-10-07. It lists the work left open in build step 5 and where each piece
goes. An item marked "proposed" has no plan that takes it yet, and the maintainer decides. The UI
review (T24, [docs/audits/ui-step5-2026-10-06.md](../audits/ui-step5-2026-10-06.md)) keeps its own
list of lows.

## Performance

- [x] **Step 5's agenda branches make Home and the agenda about 2–3× slower, and the Vehicles list
  is about 5× over its limit.** Source: [docs/perf/2026-10-06-step5.md](../perf/2026-10-06-step5.md),
  `test/perf/vehicles.perf.test.ts`. With 49 cars and 150 unit schedules added to step 4's
  household:
  - Home p95 went from 392 to 849 ms in the same run. The limit is step 4's 92 ms plus 20%,
    which is 110 ms.
  - The agenda's first page went from 467 to 758 ms (limit 146.5 ms).
  - The Vehicles list was 1,026 ms p95 for 50 vehicles (limit 200 ms).

  The likely cause is inferred, not measured query by query. `kept.schedule_due` runs
  `kept.meter_eta` → `kept.meter_estimate` once per unit schedule. These are SQL functions with
  `SET search_path`, so Postgres never inlines them. `meter_estimate` also reads every reading of
  the meter, with a correlated `meter_events` lookup for each one, before it narrows to the 90-day
  window.

  The fix is a migration that replaces 0089's view and 0066's functions:
  - bound the window by the index;
  - work out each meter's estimate once per read, not once per schedule.

  The perf test keeps its limits, so `ci-local.sh perf` fails until the fix lands. **Proposed:** a
  step-5 follow-up, before step 8's release work. Step 4's Home figure (its own carry-over) is
  part of the same work.

  **Done 2026-10-07** (0100, JIT off on Kept's connections, Home's facts, one agenda read): the
  measured causes were JIT compilation on every request and the schedule branch's uninlined
  calls; every limit in both perf files passes, figures in the perf doc's "After the fix".
- [ ] Load-sensitive results in the same doc: on the first run (load 16–26), the costs over five
  years (560 ms) and the fuel summary (193 ms) missed their limits. On the second run (load 4–18)
  both passed. Neither run was on a quiet machine.

## End-to-end

`apps/web/e2e/step5.spec.ts` has 9 journeys, on a new `vehicles` instance (port 8189,
`households` seed, AI mock, a fixture invoice). `apps/web/e2e/step4.spec.ts` gains the seven
step-4 journeys that were not in a browser. Neither file has had one clean full run (see
[step-5-done.md](step-5-done.md) §1). The shared Postgres was starved by other agents' runs: it
had 49–83 s checkpoints from their `DROP DATABASE`s, statement timeouts while seeding, and a crash
and recovery at 21:47 UTC on 2026-10-06.

- [ ] **Run both specs once on a quiet machine:** `KEPT_E2E_INSTANCES=vehicles` and
  `KEPT_E2E_INSTANCES=household`. The step-5 spec's last fixes (the new car's wait for the phone's
  copy, a 30 s wait, the service total's shape, the estimate as a range) have not run in a
  browser. **Proposed: the step-5 gate rerun, the first quiet window.**
- [ ] Step 5's plan names four journeys that are not in the spec:
  - (3) READING with a typed value queues `log_reading`. Covered by
    `test/screens/readings.test.tsx` and the T19 component tests.
  - (6) the registration card read in LABEL mode, then the inbox's document suggestion, then
    Accept. Covered by `documents-tab.test.tsx` and the server's `extraction.test.ts`; T24 ran it
    by hand on the real server.
  - (5, imperial) mpg. No route or screen sets `user_profiles.units`: `PATCH /api/v1/me` takes
    only `suggestLocation`, and nothing in `apps/web/src` offers Imperial. So a person can't get
    mpg at all. Only `components/fuel/fuel.test.tsx` shows it. **Proposed: add Units to Settings →
    Me in the pre-1.0 settings pass**, then add the e2e.
  - (1, the second half) a reading's proof photo in the strip after sync. The spec checks it
    through the API (`proof.fileId`) and the "Proof photos" list.
- [ ] Push opening the installed app from a tap stays a device check. `step4.spec.ts` delivers a
  push to the service worker over CDP and checks the notification, but it can't tap it.
- [ ] Two journeys work around the instance, not the app (`step4.spec.ts`):
  - The `household` instance runs without `KEPT_SMTP_URL`, so the digest pass runs in a child
    process with the server's own mailer pointed at Mailpit.
  - That pass marks Louis's address verified, because invited members' addresses aren't
    verified.

  **Proposed:** let `e2e/serve.mjs` take `--smtp` (Mailpit) and have the seed verify the cast's
  addresses. Then the test can drop both workarounds.

## The gate

- [ ] `bash scripts/ci-local.sh` has not exited 0 in step 5 (step-5-done §1). Rerun it on a quiet
  machine. `perf` will fail on the item above until that is fixed.
- [ ] From about 18:00 to 00:30 on 2026-10-06, HEAD's `pnpm-lock.yaml` didn't match
  `package.json` (the OpenTelemetry and Sentry dependencies), so `install` failed. 17e03d8 fixed
  it.

## Devices and real data

Every row of [docs/spikes/2026-09-30-step5-devices.md](../spikes/2026-09-30-step5-devices.md) is
"maintainer check pending", with its fallback in use:
- V1 (his odometer photos);
- V3 (real registration cards);
- real service invoices in Arabic and English;
- Arabic-Indic digits on the iPhone keypad;
- chart taps, drags and VoiceOver;
- an offline reading with a photo in the installed app;
- the report downloading from the installed app;
- V21 for nudges across a DST change;
- his own fill-ups giving a sensible L/100 km.

## Small things seen on the way

- [x] The "client is already executing a query" warning: 9ec67d9 serialises `serviceImage`, the
  service list, a reading's placement, the readings page and an incident's read. The `Promise.all`
  calls left in `apps/server/src` (outside tests) end pools or load modules, none queries one
  client twice (checked with grep).
- [ ] A viewer's History shows a cost's currency code (for example "Currency → EGP"), but never
  its amount. That's within the money gate. The e2e checks that no figure appears next to a
  currency.
- [ ] `check-i18n` used to read a one-word plural branch like `{thing}` as a placeholder. 24e3d92
  fixed that (an ICU walk), so c010b55's workaround wording isn't needed any more, though it can
  stay.
