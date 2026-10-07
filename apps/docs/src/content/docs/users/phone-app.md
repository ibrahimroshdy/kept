---
title: Kept on your phone
description: Install Kept to the home screen, what works without a connection, how syncing and conflicts look, the camera, the app lock and notifications.
---

Kept has no app-store app. It is a web app you install from the browser (a PWA): it opens from its
own icon, full screen, keeps a copy of your inventory on the phone, and works offline. Everything
on this page needs Kept on **HTTPS**: over plain HTTP, phones block the camera, installing,
push notifications and location ([HTTPS](/install/https/)).

## Install it

**Install on your phone** on Home's checklist, and **Help → Install on your phone**, show the
steps for your device:

| Device | Steps |
|---|---|
| iPhone, iPad | In Safari, tap **Share**, then **Add to Home Screen**, then **Add**. Open Kept from its new icon. |
| Android | Open the browser's menu (the three dots), tap **Install app** or **Add to Home screen**, and open Kept from its new icon. |
| Computer | In Chrome or Edge, the install icon at the end of the address bar, or **Install Kept** in the menu. In Safari on a Mac, **File › Add to Dock**. |

The checklist step ticks itself the first time you open Kept from its icon. When a new version is
ready, Kept shows **A new version is ready** with **Reload**; it never reloads by itself while
something is uploading or a capture is open.

## What works offline

The phone keeps a copy of every location you belong to, refreshed each time it syncs. Offline
answers say **as of last sync** and the time.

| Works offline | Needs a connection |
|---|---|
| Browsing locations, rooms, boxes and things | Editing a thing's details, settings, admin |
| Search, labelled **On this phone** | The assistant and AI naming |
| Capture, move, mark seen, not here | Imports, exports and reports |
| Logging a reading, adding a room or spot | Logging a service (it carries money) |
| Box check, for a box opened once while online | Anything with money or secret values |
| Scanning a label, claiming a blank label | |

The copy never holds secret values or people's contact details. Money and documents stay off the
phone unless you keep a location offline behind the app lock (below). Signing out removes this
person's copy from the phone.

## Syncing, as you see it

What you do offline goes into a queue and is sent when the phone is back online. A line under the
header appears only when there's something to say:

- **Offline · 12 waiting to sync**, or **Offline · as of last sync, 14:02**.
- New things show **ID pending** until the server gives them their short ID; labels for them can
  be printed once it arrives (Labels offers **Print pending labels**).
- **On iPhone, the queue moves only while Kept is open**: the line says **Open to finish syncing
  (12)**. Leave Kept open on screen for a moment when you're back online.
- **Update Kept to finish syncing** means the server is newer than the app: reload. The queue is
  kept.
- **This browser may clear Kept's offline copy after weeks unused**: the phone refused Kept
  permanent storage. Open Kept now and then so it syncs.

**When a change can't apply.** If someone else trashed, moved or removed a thing while you were
offline, your change to it is dropped and the line says so, for example "A change couldn't apply:
the drill was trashed by Alfred", with **Restore** to try it again. Other changes that need a
decision go to the **Inbox** ("2 changes need a look").

**When you both edit the same thing online**, Kept merges the fields only one of you changed and
asks about the rest: **Keep mine**, **Keep theirs** or **Edit**.

**Signing out with unsent captures** warns you first: signing out deletes captures that haven't
synced. If your session expires, the phone drops its copy of your inventory but keeps your
unsent captures, locked, until you sign back in. If someone else signs in on that phone, Kept says
how many captures are waiting from another account and deletes them only when that person agrees.

## Camera, gallery and scanning

- **Capture** keeps the camera open for one shot after another. **Gallery** picks several photos
  at once; each becomes a draft. If the camera is blocked, Kept says how to allow it, and over
  plain HTTP Capture falls back to choosing files.
- iPhone photos in HEIC are kept as originals; if one can't be previewed, it says **Preview
  unavailable** and is never refused.
- **Share into Kept**: on Android and desktop Chrome, the installed app appears in the share
  sheet, so a receipt or PDF from another app lands in Capture. iPhone doesn't let web apps appear
  in the Share sheet: save the file, then use **Gallery** in Capture.
- **Scan** reads Kept labels and product barcodes, offline too, from the phone's copy.
- **Suggest where I am**, a switch in Capture's place picker, compares your position with your
  locations on the phone itself and suggests the nearby one. Your position is never sent or kept.
- **Dictate** fills the name by voice where the browser supports it.

**Settings → Diagnostics** checks the camera, offline support and storage, and copies a report of
what it found.

## The app lock

**Settings → This device → App lock** locks Kept on this phone with a PIN of 6 to 12 digits, and
with **Use Face ID or fingerprint** where the phone can verify you. With the lock on, Kept asks on
a cold start and after 5 minutes hidden or idle, online or offline.

- Ten wrong PINs in a row remove Kept's copy from this phone and sign you out, keeping your own
  unsent captures. **Forgot it? Sign out and sign in again** does the same.
- The lock keeps out someone holding the phone. It doesn't stop someone who has copied the
  browser's storage from trying PINs; the settings page says so.

**Keep available offline**, on the same page, adds one location's prices and documents to the
phone's copy, encrypted behind the lock. It needs the app lock on, shows the download size first,
and warns that whoever unlocks Kept on the phone sees them. A device keeps at most 250 MB this way,
with files up to 25 MB each.

## Notifications

In **Settings → Me → Notifications**, under **This device**, **Enable** turns on push: reminders
pop up even when Kept is closed. **Test** sends one to check.

- **iPhone and iPad** deliver push only to the installed app: add Kept to the Home Screen, open it
  from there, and enable it. Until then, reminders can come by email.
- Push needs HTTPS. If the server has no way to send push, or the browser can't receive it, the
  page says so; email and the notification centre still work.
- Quiet hours hold push and email until they end. What each location sends, and how, is covered in
  [everyday use](/users/everyday-use/#reminders-and-notifications).
