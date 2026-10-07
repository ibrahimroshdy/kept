---
title: Everyday use
description: Places and boxes, things and their labels, paperwork, search, moving things, vehicles and machines, reminders, sharing and the insurance report.
---

Kept answers three questions about everything you own: where it is, what paperwork it has, and
what it needs next. This page walks through the screens that do that. Which of them you see
depends on your role and on what each location tracks
([presets and roles](/users/first-run/#3-create-your-first-home)).

## Locations, rooms and boxes

Everything sits in a tree: a **location** (Home, Garage, a storage unit) holds **rooms and
spots** ("room or spot" is Kept's word for any place), which hold **things**. A thing can be a
**box or container** that holds other things, as deep as you like. Each location also has
**Unplaced**, for things that don't have a place yet.

- On a location, room or box, **Add here** adds a **Thing**, a **Box / container** or a **Room or
  spot**.
- Lists have a search box, **+ Filter**, saved **Views**, and a **Display** button for sort order
  and grouping. Filters live in the address, so a filtered list can be bookmarked or shared.
- On a location, **Sort them** goes through Unplaced one thing at a time with a place picker.
- A box opened from its label shows a photo grid of what's inside.

Links use IDs, never the path, so moving a thing never breaks a link to it.

## Things

A thing's page has its photos, its name and **ID**, its full path, and sections for what it
tracks: **Details**, **Paperwork and warranties**, **Value**, **Meters**, **Loans**, **Claims**,
**Links**, **Schedules** and **History**. Sections whose module is off in the location don't show.

- **Edit** opens the fields in place. If someone else changed the same field since you opened it,
  Kept shows both values and asks: **Keep mine**, **Keep theirs** or **Edit**. Fields only one of
  you changed merge without asking.
- **Actions** has Move, Lend, Label, Split, Duplicate, Save as template, Mark seen, Not here,
  Change lifecycle (sold, given away, thrown out), Re-type, Convert to a room or spot, and Move to
  Trash.
- **History** lists every change with who made it; most changes can be undone from there or from
  the toast that follows them. **Activity** in the menu is the same across your locations.
- **Trash** keeps trashed things for 30 days; members and above restore, admins delete for good.
- **Passwords and codes** (the Complete preset) are secret fields: hidden until someone allowed
  to reveals one, which is logged.

Viewers see the same page with no actions except **Copy link**.

## Short IDs and labels

When a new thing reaches the server it gets a short ID: six letters and digits, like `7KQ-4MZ`,
never reused. Until then it shows **ID pending**. A label carries the ID as text and in a QR code
that opens the thing. A label keeps its code for good, so a lost one reprints the same.

**Printing** (Labels in the menu, or **Label** on a thing): choose what to print (a selection,
**Label everything unprinted** in a location or place, or a **Blank sheet**), choose the **Label
stock**, pick where to start on a partly used sheet, and print from the browser. Stocks include A4
sheets of 24 and 65 labels, a Letter sheet in the Avery 5160 layout, and 50 × 30, 40 × 30 and
62 × 29 mm rolls for label printers. Afterwards, **Printed OK?** records the batch; **Recent
batches** reprints one with the same codes. Things whose ID is still pending can't be printed yet.

**Scanning**: **Scan** on Home and Search opens the camera.

| You scan | Kept |
|---|---|
| A Kept label for something you can see | Opens it and marks it seen just now |
| A blank label | Offers **New box here** or **Attach to an existing thing** |
| A product barcode | Offers to add it as a new thing; with barcode lookup turned on by the admin, it's named from Open Food Facts, Open Products Facts or Open Beauty Facts |
| A Homebox label, after a [Homebox import](/users/import-export/) | Opens the imported thing |
| Anything else | Says it isn't a Kept label |

A worn label, or no camera: **Type the code**. The Capture camera recognises Kept labels too, and
offers to open that box or capture into it.

## Photos, receipts, manuals and warranties

Photos go on the thing; everything else goes under **Paperwork**, kept as the original file:
**Add a file**, then say what it is (Receipt, Invoice, Manual, Warranty, Registration, Proof,
Document). A file Kept can't preview yet is kept anyway and marked **Preview unavailable**.

- **Capture's modes** (Thing, Receipt, Label, Reading): with AI connected, a receipt fills in the
  purchase, a label fills in brand, model and serial, and suggested values wait in the **Inbox**
  for you to accept. Prices, dates and serials are never accepted for you.
- **Warranties** (Household and Complete) show a coverage bar from purchase to the end date. A
  **claim** records a repair or replacement, and a claim that cost nothing shows "Warranty saved
  you".
- **Paperwork** in the menu is the location's own documents (the lease, the home insurance), and
  **Expiring** lists things, documents and warranties by date. Text in PDFs is searchable.

## Search

**Search** finds things by name, brand, serial, ID, place, or the words AI added as aliases, and
groups results into things, places, people, shops and documents (with a snippet of the receipt
text). Filters narrow by location, place, type, tag and state; **Saved searches** keep a filter
set for you or a whole location. On a computer, ⌘K or Ctrl+K opens the same search from anywhere.

On a phone, Search also works offline from the phone's copy, labelled **On this phone · as of
last sync**. With an embeddings model, results "matched by meaning" join the keyword ones
([AI providers](/users/ai-providers/#search-and-embeddings)).

## Moving things

- **Move** on a thing picks the new place. Moving into another location you belong to warns who
  will lose sight of it.
- **The tray**: **Pick up** several things (from their menu, or by scanning), then open the
  destination and **Move here**, or **Scan destination**. The tray stays with you offline.
- **Box check** on a box: tick what's there (with a count for "found 4 of 6"), add **Found
  something else**, and anything left unticked becomes *not here*.
- **Mark seen** and **Not here** keep "last seen" honest, so a thing nobody has seen for a while
  shows up on Home.

## Vehicles and machines

Any thing whose type is metered (a car, a generator, a boiler) has **Meters**: log a reading,
log a service, and set schedules by date or by reading. **Vehicles** (Household and Complete)
gathers the vehicles in one place, each with tabs for its overview, readings, services, documents,
costs and, on Complete, fuel.

- **Log a reading** works from Home, the vehicle, and offline. A reading that doesn't fit between
  its neighbours is refused with the reason. A dashboard photo joins the vehicle's proof photos.
- **Log a service**: date, the reading, the shop, the invoice (AI can fill the line items), the
  line items with costs, and which schedules it completes; saving restarts their count.
- **Add starter schedules** adds the usual ones: oil change, tyre rotation, brake fluid, air filter.
- **Read the card** reads a registration card in Label mode: VIN, plate and licence expiry.
- **History report** makes a PDF for a period: odometer history with proof photos, services with
  their invoices, fuel and documents, and costs only where you can see money.

## Reminders and notifications

Kept reminds you of schedules due, warranties running out and registration deadlines, documents
and things that expire, overdue loans, meters not read lately, low stock, members joining and
leaving, and AI spending caps. Home's attention panel shows what's due or overdue; the bell opens
the notification centre, where **Complete**, **Snooze**, **Renew** and **Mark returned** act in
place.

**Settings → Me → Notifications** chooses how each location reaches you (in Kept, email, push,
webhook), a **Daily digest**, **Quiet hours**, and a private **Calendar feed** link for your
calendar app. Push on a phone is covered in [the phone app](/users/phone-app/#notifications).

**Lending**: **Lend** a thing (or part of a quantity) to a member or a contact, with a due date and
condition photos. Kept never messages the borrower; **Copy a reminder** gives you the text to send
yourself.

## Sharing a location

A location is shared by inviting people to it, each with a role and an optional end date
([invites and roles](/users/first-run/#5-invite-people)). Owners and admins manage the
**Members** page in Location settings; anyone but the owner can **Leave this location**. Your
Personal location is never shared. Kept has no public share links: to show someone a list who
doesn't use Kept, print it (below).

## Reports: the inventory, insurance and claims

- **Print inventory** on a location makes a PDF of its things grouped by place, with photos and
  short IDs, optionally QR codes, ended things and the Trash. Prices appear only for people who can
  see money. Anyone who can see the location can make one.
- **Insurance report** (where you can see money): every thing with its photo, brand, model,
  serial, purchase date, price, current value and receipts, with totals per place and per currency,
  as a PDF and a CSV. **Also total in** adds one converted total when your exchange rates cover
  every currency.
- **Incidents** record a burglary, fire, flood or loss: select things on a location's list, then
  add them to an incident. A **claim pack** is a ZIP of the insurance report with every receipt,
  invoice, photo and serial for the incident, shared with the insurer by a download link that
  lasts 1 to 7 days, is shown once and can be revoked. Owners and admins make them.
