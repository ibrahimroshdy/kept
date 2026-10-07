# Homebox export fixtures

Two real export ZIPs from **Homebox v0.26.2** (image `ghcr.io/sysadminsmedia/homebox:0.26.2`,
commit e01dd737, SQLite, the image's default storage), made on 2026-09-30 for step 7's Task 0
(H1). Synthetic data only, with the Kept sample cast. The instance was thrown away afterwards.

| File | Collection | Currency on the server (not in the ZIP) | Members on the server (not in the ZIP) |
|---|---|---|---|
| `homebox-0.26.2-home.zip` | Home (`1d93892c-082a-4fb4-9645-b78321688b99`) | `SAR` | Ibrahim (owner), Bruce, Louis |
| `homebox-0.26.2-family.zip` | بيت العائلة (`19c07b70-405b-4503-9517-2c5d847718b2`) | `USD` (never changed) | ألفريد (owner), Ibrahim |

How they were made, what they hold and every format detail observed:
`docs/spikes/2026-09-30-step7-homebox.md`. The script is
`docs/spikes/code/step7/make_homebox_fixture.py`; a re-run makes new UUIDs, so tests must not
hard-code ids from anywhere but these files.

What the cases cover:

- **Home:** nested locations (Home › Kitchen, Home › Study › Top shelf); an item inside an item
  (Toolbox › Cordless drill); a location-type entity inside an item (Toolbox › Bits tray) with
  an item in it holding a **fractional quantity** (Wood screws, 2.5); an archived, **sold**
  item (Old phone, sold to Murdock); a **lifetime** warranty (Fridge) and a dated one (Espresso
  machine); one custom field of each kind (`text`, `number`, `boolean`, `time`); tags with a
  parent (Audio › Tech), hex and named colours, an Arabic tag with a description; attachments of
  every type (`photo` with a primary, a second photo, `manual`, `warranty`, `receipt`, two
  `attachment`s, one a `.docx` outside Kept's allow-list and one plain text), four generated
  `thumbnail`s, and a **link** attachment (no file); maintenance done with a cost and one only
  scheduled; a template with fields and an item made from it (Kettle); type icons from Homebox's
  set plus one unknown value; a disabled notifier (its URL is synthetic).
- **بيت العائلة:** Arabic names throughout, Arabic-Indic digits in a serial, a photo with an Arabic
  file name, an item inside an item (the remote inside the TV), maintenance with a cost.
- **Across both:** asset IDs repeat (Home numbers 1–21, بيت العائلة 1–13, so 1–13 exist in both;
  Espresso machine and ريموت are both `000-005`), and each collection carries Homebox's seeded
  places (Living Room, Garage, …) and tags (Appliances, IOT, …).

Not covered:

- a `time` field with a chosen date, and a template's number value: Homebox v0.26.2's API can't
  set either (it has no `timeValue` for entity fields, so the value is the row's creation time,
  and a template's `numberValue` is dropped on save);
- an entity with asset ID 0: the script ran Homebox's "Ensure asset IDs" action, so every row
  has one.
