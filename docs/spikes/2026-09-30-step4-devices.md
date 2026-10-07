# Step 4: the device and outside-setup checklist

Written 2026-09-30 (step-4 plan, Task 0); statuses set by T30 the same day. Step 4's screens and
senders are built, so every row can be run now. **None has been run on a device yet: each device
row's Result is "maintainer check pending"**, with the fallback in use named in its row. They
need the maintainer's phones, a Mac, SMTP credentials or a receiving URL. No agent runs them.
V21 needs no device and passes by test.

The build never waits for these. Every row ships its fallback first (the "In use now" column). A
result either confirms the preferred path or keeps the fallback. Where a spike already checked
something in an emulator or a local stand-in, the Notes column says so. That is not a device
result.

## Before you start

Use the step-3 setup ([2026-09-26-step3-devices.md](2026-09-26-step3-devices.md), "Before you
start"):

1. **Kept over HTTPS on the LAN or tailnet** (mkcert or a Tailscale certificate). Web push,
   install and notifications need HTTPS; `KEPT_PUBLIC_URL` is the HTTPS address the phones open.
2. **Seeded with `households`**, signed in as Ibrahim.
3. **Each phone both in the browser** (Safari; Chrome on Android) **and installed.**
4. **For the mail rows,** `KEPT_SMTP_URL` and `KEPT_SMTP_FROM` set to a real sender.
5. **For the push rows,** a VAPID subject: an https `KEPT_PUBLIC_URL`, `KEPT_SMTP_FROM`, or
   `KEPT_VAPID_SUBJECT`. With none of them, Settings says push is unavailable.

Paste each phone's Diagnostics "Copy report" under Reports at the end, labelled
`<phone>, <OS>, browser|installed`.

## The checks

| # | Device, way | What to do | Pass when | In use now (the fallback) | If it fails | Notes | Result |
|---|---|---|---|---|---|---|---|
| V8 | iPhone (iOS 16.4+), installed | Settings → Me → Notifications → Enable push, from the installed app. Lend the drill to Murdock with a due date in the past, wait for the next scan (≤ 15 min), then tap the notification | The overdue reminder arrives as a push; the tap opens the drill's page in the installed app | The iOS rule in T25: not installed → told plainly and offered email; the in-app centre always has the item | Email stays the iPhone path; Settings says push isn't available on this device | Push checked end to end only in Chromium, through CDP `ServiceWorker.deliverPushMessage`; headless Chromium can't subscribe ([2026-09-30-step4-push.md](2026-09-30-step4-push.md)) | Maintainer check pending |
| — | iPhone, installed; a Mac in Safari | Tap "Enable" for push | The permission prompt appears from that tap (a user gesture), and nowhere else | The prompt is only ever asked from that tap (D139) | Help explains how to allow notifications in iOS Settings | | Maintainer check pending |
| — | Android, installed and in Chrome | Enable push; receive the drill's overdue reminder; tap it | The notification arrives in both ways; the tap opens the installed app | The same code path as desktop Chrome | — | | Maintainer check pending |
| — | iPhone, installed | Tap a reminder's notification with the app closed, then with it open on another page | Kept opens (or focuses) on the right page, in the installed app, not Safari | `notificationclick` focuses or opens same-origin URLs | The notification opens Kept's Home, and the centre lists the item | No CDP command clicks a notification; the handler's URL rule is unit-tested | Maintainer check pending |
| — | iPhone | Settings → Me → Notifications → Calendar → copy the link; in Apple Calendar, Add Subscribed Calendar with it (over Tailscale) | The due dates appear as all-day events; titles and a deep link only | The feed and its fixtures (T17) | Settings offers "Download .ics" as a one-off import | | Maintainer check pending |
| — | Google Calendar | Subscribe to the feed by URL | — (not possible now) | Apple Calendar or Thunderbird, which fetch from the device | — | Google fetches from its own servers, so Kept would have to be reachable from the internet; the homelab alpha is LAN and Tailscale only. Not planned | Not possible now (no public URL); not planned |
| — | Gmail on iOS, and Apple Mail | Receive a reminder mail and a daily digest, in English and in Arabic | Both render correctly: RTL Arabic, the reader's digits, the thing, path, location and local date named | Mailpit in dev and e2e; the in-app centre carries every reminder anyway | Adjust the React mail templates | Needs the alpha's SMTP credentials | Maintainer check pending |
| — | Any, with a receiving URL (e.g. your own n8n) | Settings → Me → Notifications → add a webhook; send a test; then let a reminder fire | The receiver gets the §2.6 envelope (`reminder.due`, ids, the due date, a deep link, no names) and the signature verifies | A local receiver in the tests (T15) | — | | Maintainer check pending |
| — | iPhone, Safari | Build a claim pack for an incident; open its link without signing in; save the ZIP to Files and open the insurance PDF inside | The ZIP downloads into Files, and the PDF opens there | — | — | The ZIP streams correctly (`unzip -t` clean) on the local and S3 drivers ([2026-09-30-step4-claim-pack-zip.md](2026-09-30-step4-claim-pack-zip.md)). In desktop Chromium, `e2e/step4.spec.ts` makes a claim pack from an incident, downloads the ZIP from its link with no session, and gets 410 once it is revoked | Maintainer check pending |
| — | iPhone, installed | Open a thing with a receipt photo and a PDF manual, and a place with an attachment; tap Share (or Open PDF) on each | The share sheet offers the original file (Save to Files, Mail), and the PDF opens | Uploaded originals are fetched ahead once their button nears the screen, then shared as files; where that can't work, Kept says so plainly (2e3d8a6, fb74410) | — | An installed iPhone app can't follow a download link, which is why originals are shared as files; only a device shows it | Maintainer check pending |
| V21 | None (tests) | Reminders at the right local time across Egypt's DST | T14's DST tests pass with the computed instants | T14's tests | — | Transitions computed in Node and Postgres: 2026-04-23 22:00Z and 2026-10-29 21:00Z ([2026-09-30-step4-dst.md](2026-09-30-step4-dst.md)) | **Passes by test (2026-09-30):** `reminders/quiet.test.ts` "wall clocks (V21)", `reminders/deliver.test.ts` (an 08:00 digest at 08:00 local on both sides of each change; a time in the gap or the overlap goes once) |

**Not needed in step 4:**

- Apprise, ntfy and Telegram (1.x, D130; V22 stays 1.x);
- email-in or IMAP receipts (D21, 1.x).

## Reports

*(Diagnostics "Copy report" per phone and way, pasted here.)*
