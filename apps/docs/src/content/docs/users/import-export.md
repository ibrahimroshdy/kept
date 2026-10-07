---
title: Import and export
description: Bring things in from a spreadsheet, Homebox or another Kept, and take a location out as a full export with a copy you can read without Kept.
---

Imports and exports live in **Settings → Import** and **Settings → Export**. Both are for a
location's **owners and admins**, run in the background on the server, and need a connection.
For moving a whole server, or a household between servers, see also
[moving to a new server](/admin/move-server/).

## Importing

**Settings → Import** asks where it comes from:

| Source | What it is |
|---|---|
| **A spreadsheet (CSV)** | One thing per row, with a header row naming the columns |
| **A Homebox export** | The ZIP from Homebox v0.26 or newer (Collection settings → Export) |
| **A Kept export** | A location exported from this Kept or another one |

Every import is checked before anything is written: **Check the import** shows **What the import
will do**, row by row, with the reason for anything it skips. Then it runs with a progress bar.
You can leave the page; the import carries on, and Settings → Import shows how far it got. If it
stops, **Resume** carries on from the last row. **Cancel the import** keeps what it already
imported.

Running the same import again skips what it already brought in, so a re-run never makes
duplicates. An archive (a ZIP) can be up to 5 GB. Imported things arrive confirmed, not in the Inbox.

### A spreadsheet (CSV)

1. **Choose the file**, and the location it goes into: one you own or administer. A file takes at
   most 10,000 rows (8 MB); split a bigger one.
2. **Match the columns.** For each column, choose the field it goes to, including **A type's
   field…** for your own type fields. One column must be the name: every thing needs one.
3. **A few choices:**
   - A place column like `Garage > Shelf A` makes the rooms and spots: choose the separator, and
     whether to **Make the places the file names that don't exist yet**.
   - Where rows without a place go (Unplaced by default).
   - How dates are written (worked out from the file where it can), and the currency for rows
     with none.
   - **Match the type column to your types by name**, in any of Kept's languages; off, the type
     is kept in the notes.
4. **Check the import**, read the report, and import.

### A Homebox export

Kept reads Homebox's own export ZIP, which holds everything, including the files. In Homebox, open
**Collection settings → Export** and download the ZIP; a Homebox older than v0.26 has no export,
so update it first.

:::tip[If Homebox says "Topic has been Shutdown"]
Homebox v0.26 makes one export each time it starts. Restart Homebox and export again.
:::

After the upload, Kept shows the collection and its export date. It goes into **A new location**
or **A location you run**, where things already there stay and a
re-run adds only what's new. **Connect to Homebox
(optional)** reads the collection's currency, which the ZIP doesn't carry: give Homebox's address
and an API key, or an email and password. They're used once and never stored. Then choose:

- **Prices are in**: the currency. Choosing one relabels the amounts; it doesn't convert them.
- **Archived items**: **Leave out**, or **Import, tagged "Archived in Homebox"**.
- **Add an "Insured" yes/no field**, and **Leave out Homebox's starter places and tags** (the
  eight rooms and six tags every new Homebox collection starts with, when they're unused).
- **Custom fields**: for each, **Add to the type** or **Keep in notes**.
- **Types**: match each Homebox type to a Kept type, or create it.

What comes over:

| Homebox | Kept |
|---|---|
| Collection | One location |
| Locations (nested) | Rooms and spots, keeping the tree |
| Items | Things; an item holding others becomes a box |
| Manufacturer, model, serial | Brand, model, serial |
| Purchase date, shop and price | A purchase with its shop |
| Warranty, lifetime warranty | A warranty |
| Sold details | The thing ended as sold, with its date, price, buyer and notes |
| Tags | Tags with their colours (nested tags flattened) |
| Photos, manuals, receipts, warranty files | Photos, manuals, the purchase's receipt, the warranty's document |
| Completed maintenance | Service records |
| Scheduled maintenance | One-off schedules |
| Templates | Account templates, as far as they map |

Notifiers, members and roles aren't imported. Where a module is off in the location, that
record's text is kept in the thing's notes.

**Old labels keep working.** Each Homebox asset ID (`000-001`) is remembered. Kept's scanner
recognises a Homebox label and opens the imported thing; if you point the old Homebox hostname at
Kept, scanning with the phone's own camera works too.

### A Kept export

A Kept export always comes in as **a new location**, with its things, places, files and history.
If it holds secret values, **Open the secrets** with the passphrase chosen when it was exported;
without it, everything else is imported. **People to invite** lists who shared the location;
nobody is invited by the import, so invite each person yourself.

### Search words after an import

When an AI provider is connected, the end of an import can offer **Add search words with AI?**,
with an estimate of the tokens it takes. It runs in the background and adds aliases in the
location's languages, the way captured things get them ([AI providers](/users/ai-providers/)).

## Exporting

**Settings → Export** has two kinds:

- **Export a location**, one you own or administer: every thing, place, photo and document is
  always in it.
- **Export my data**: your Personal location with its files, your profile and preferences, and
  your own AI calls.

**What goes in** besides: ended things (sold, given away, thrown out), the Trash, the history, the
AI calls, and **A copy you can read without Kept**: web pages, spreadsheets, thumbnails and
receipts that open in any browser, optionally with the inventory PDF, in a language of its own.

**Include secrets** is for the location's owner. Secret values are encrypted with a passphrase of
at least 12 characters, typed twice. Anyone with the file and the passphrase can read every secret
in it, and Kept can't recover a forgotten passphrase. The readable copy never holds secrets.

The export is built in the background; you're notified when it's ready. Each export stays in the
list, ready to **Download**, for seven days.

### Exports and backups

An export is something you take away: one location, readable anywhere, importable into any Kept.
The server's own nightly backup is separate and covers the whole instance; it also holds a readable
copy of every location ([backups](/admin/backups/)). Deleting a location offers **Export first**.

## Moving between instances

To move one household to another Kept server: export the location (with secrets if you need them),
then import the ZIP there as a Kept export. Printed labels keep working: a label keeps its code
when that code is free on the new server, and when it isn't, the old label still opens the thing.
To move a whole server with every account, use a backup instead. Both ways are in
[moving to a new server](/admin/move-server/).
