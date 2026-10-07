# Step 5: the device and real-data checklist

Written 2026-09-30 (step-5 plan, Task 0). **Step 5 is built (T25, 2026-10-06), and no row has
been run on a device: every Result reads "maintainer check pending", with the fallback in use.**
The rows need the maintainer's phones and his own photos, invoices and fill-ups. No agent runs
them.

The build never waits for these. Every row ships its fallback first (the "In use now" column). A
result either confirms the preferred path or keeps the fallback. Where a spike already checked
something in an emulator, the Notes column says so. That is not a device result.

## Before you start

Use the step-3 setup ([2026-09-26-step3-devices.md](2026-09-26-step3-devices.md), "Before you
start"):
1. Kept over HTTPS on the LAN or tailnet;
2. seeded with `households`, signed in as Ibrahim;
3. a Groq key in Settings → AI for the AI rows;
4. each phone both **in the browser** (Safari; Chrome on Android) and **installed**.

Paste each phone's Diagnostics "Copy report" under Reports at the end, labelled
`<phone>, <OS>, browser|installed`.

## The checks

| # | Device, way | What to do | Pass when | In use now (the fallback) | If it fails | Notes | Result |
|---|---|---|---|---|---|---|---|
| V1 | Laptop (the eval runner) | Run the evaluation set on 30 or more of your own photos of the Corolla's odometer, per provider (`apps/server/eval/README.md`) | The provider reads value and unit reliably enough to pre-fill READING | READING always waits for review (D19); a typed value is one tap away (T19) | A per-provider note, "readings: confirm by hand"; the typed value becomes READING's default field | Synthetic set fails (§19 V1, 2026-09-29) | Maintainer check pending (2026-10-06): the "In use now" fallback ships |
| V3 | Laptop (the eval runner), then a phone | Read real Egyptian registration cards in LABEL mode (VIN, plate, licence expiry) | The inbox suggests the licence document with the right expiry, VIN and plate | The document suggestion waits in the inbox (T10); the VIN checksum drops a wrong VIN | Manual entry on the Documents tab | Synthetic card came back empty (§19 V3) | Maintainer check pending (2026-10-06): the "In use now" fallback ships |
| — | Phone, installed | Log a service from photos of real service invoices, one Arabic and one English | AI suggests the lines, with amounts, as Suggested values | Suggestions only, never applied (T10) | Lines typed by hand, as step 4 ships | | Maintainer check pending (2026-10-06): the "In use now" fallback ships |
| — | iPhone, installed | In any numeric field (Log a reading, a fill's litres), switch the keyboard to Arabic and type Arabic-Indic digits with a decimal separator | The value is accepted and saved as the same number | `westernNumber` on every numeric field | A Western-keypad hint under the field in Arabic | | Maintainer check pending (2026-10-06): the "In use now" fallback ships |
| — | iPhone and Android, installed | On a vehicle's Costs, Readings and Fuel tabs: tap a bar or point; drag sideways across a chart; with VoiceOver on, open "Show as table" and read it | A tap opens the tooltip; a sideways drag scrolls or does nothing and never starts pull to refresh; VoiceOver reads the table's headers and numbers | "Show as table" on every chart | Charts become the table on phones | Passed in Chromium's touch emulation at 375 px (V38, [2026-09-30-step5-charts.md](2026-09-30-step5-charts.md)): 0 pull events for three sideways drags; tap opens the tooltip | Maintainer check pending (2026-10-06): the "In use now" fallback ships |
| — | iPhone, installed | Turn on airplane mode. Home → Log a reading, take the photo with the system camera, save. Turn airplane mode off and open Kept | The reading syncs, fits the series and shows in the vehicle's proof strip with its photo | The step-3 queue and uploader | Offline readings without a photo; the photo is added online | | Maintainer check pending (2026-10-06): the "In use now" fallback ships |
| — | iPhone, installed | On a vehicle, generate the history report (English, then Arabic) and download it | The PDF opens from the installed app through the signed link | The step-2 download path | An "Open in Safari" link in the sheet | Renders in 1–11 s, about 300 MB (V39, [2026-09-30-step5-vehicle-report.md](2026-09-30-step5-vehicle-report.md)) | Maintainer check pending (2026-10-06): the "In use now" fallback ships |
| V21 | iPhone, installed | Leave a stale-reading nudge and a distance schedule due across an Egyptian DST change (step 4's check, reused for nudges) | The nudge arrives at the right local time on both sides of the change | DST-date tests (T14) | Step 4's fallback | | Maintainer check pending (2026-10-06): the "In use now" fallback ships |
| — | Any | Enter a few months of your own fill-ups (full and partial, one missed fill) | L/100 km and cost per km look right against what you know of the car | The consumption tests (T1, T11) | Adjust the interval rules and record it as a decision | | Maintainer check pending (2026-10-06): the "In use now" fallback ships |

## Reports

*(Diagnostics "Copy report" per phone and way, pasted here.)*
