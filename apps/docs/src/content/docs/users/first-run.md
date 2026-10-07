---
title: Your first minutes
description: Claim a new Kept with its setup code, create your first home, add things, invite people and choose a language and theme.
---

This page starts once Kept is running and you can open its address. Installing it is covered in
[Install with Docker Compose](/install/compose/).

## 1. Claim the server with the setup code

The first time Kept starts with no admin, it prints a one-time setup code in its logs, as
`KEPT SETUP CODE: K7Q-2M9`. Opening Kept's address takes you to **Set up this Kept**, three steps:

1. **Setup code.** Type the six characters. The dash is optional and case doesn't matter. The code
   stops working once it's used. Lost the logs? `kept admin setup-code` issues a new one
   ([how, under Compose](/install/compose/#3-finish-setup)).
2. **First account.** Your name, email and a password of at least 8 characters. This account is the
   **instance admin**: it runs the server (users, sign-up, backups). It can't see inside anyone's
   home unless they invite it.
3. **Instance options.** One switch: **Let anyone with the address create an account**. Leave it
   off for a household: people join through an invite, or you add them. You can change it later in
   Settings → Admin.

**Finish setup** takes you to Home.

:::caution[Finish it straight away]
Until setup is finished, anyone who can open the address could try to claim the server.
:::

AI and barcode lookup aren't part of setup. Kept works without them, and you can connect AI later
([AI providers](/users/ai-providers/)).

## 2. Read Home's Get-started checklist

Home opens with a **Get-started** checklist, worked out from what you've really done, so steps
tick themselves:

| Step | What it asks |
|---|---|
| **Put Kept on HTTPS** | Shown to the instance admin while Kept is served over plain HTTP. Phones block the camera, installing Kept, push notifications and location over HTTP. See [HTTPS](/install/https/). |
| **Create your first home** | A location, below. |
| **Add 3 things** | A few you'd hate to lose track of. |
| **Print your first label** | When Labels is on in a location. |
| **Invite someone** | A link or a QR code; nobody needs email. |
| **Connect an AI provider** | Not shown to invited members, or in a location on the Essentials preset. |
| **Install on your phone** | Ticks itself the first time you open Kept from its home-screen icon. |

You can hide the checklist; **Help → Get-started checklist → Bring it back** shows it again. It
goes away by itself when every step is done.

## 3. Create your first home

Everyone has a **Personal** location from the start: it's yours alone (no members, invites or
share links) and it's where a capture with no location lands. Shared things belong in a location of
their own. Choose **Create your first home** (or **New location** on Home):

1. **What's this place called?** A name, like Home or Garage, and its kind: House, Apartment,
   Garage, Storage unit, Office, Vacation home or Other.
2. **Rooms.** The kind's template fills in rooms and spots; rename, remove or **Add room or spot**.
   Every location also has **Unplaced**, for things that don't have a place yet. **Skip** keeps only
   Unplaced.
3. **What to track.** Three presets:
   - **Essentials**: finding things: rooms, boxes, labels and search.
   - **Household**: adds receipts and warranties, reminders, lending, paperwork and vehicles.
   - **Complete**: adds fuel, things you run out of, passwords and codes, moving house, and
     "Connect ChatGPT or Claude".

The timezone and currency come from your browser. Change them, and switch single modules on or off,
in the location's **Location settings** (**General** and **What to track**). Turning a module off
hides it; nothing is deleted.

## 4. Add your first thing

The fastest way is **Capture**, the middle tab on a phone: point the camera, press the shutter, and
the thing is saved where the place chip at the top says. A name is optional while you capture:
with an AI provider connected, Kept names it from the photo; without one, unnamed things wait in
the **Inbox** for a name. On a computer, **Add here** on a room or box adds a thing with a form.
[Everyday use](/users/everyday-use/) covers capture, labels and the rest.

## 5. Invite people

Sharing happens per location: someone you invite to Home sees Home, and nothing else of yours.
After you create a location, Home shows an **Invite people to …** card; the same page is under
**Location settings → Members → Invite**.

1. Choose the **Role** and, under **Access**, **No end date** or **Until a date**. Their access, and
   any tokens they make, stop on that date.
2. **Create invite link.** You get the link with **Copy link** and a QR code to **Scan with their
   phone**. The link works once, for 7 days, and shows under Members as a pending invite until it's
   used, where you can revoke it.
3. **Send by email** works only when the server has email set up (`KEPT_SMTP_URL`).

The person opens the link, then joins with their account or creates one; while sign-up is closed,
the invite is the only way to make an account.

### The roles

| Role | What they can do in that location |
|---|---|
| **Owner** | Everything, including two-factor rules, transfer and deletion. There is one owner. |
| **Admin** | Invite and remove members and viewers, settings and modules, import and export, share claim packs, delete permanently. Only the owner grants or removes admins. |
| **Member** | Add, edit, move, lend and trash things; log readings and services; print labels; use AI capture. Money is visible. |
| **Viewer** | Look and search only. Money is hidden unless the location allows viewers to see it; the assistant answers but can't change anything. |

The full matrix is in the
[product design](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md#71-role-matrix-per-location).

### People without email

For a child or a parent with no email, an owner or admin uses **Add someone without email** on the
Members page. Kept makes a **managed account** with a username and shows a one-time code (it works
once, for 30 minutes). The person signs in with **I have a one-time code**, their username and the
code, and chooses their own password; you never see it. Whoever created the account (while still
an owner or admin there), or that location's owner, can issue a new code later, which signs the
account out everywhere. The person can add an email to take the account over. A managed account can't own a location, and a location
holds at most 20 of them.

## 6. Language and theme

**Settings → Me → Display** holds the device's display choices, applied before the page draws:

- **Language**: English, العربية, Français, Deutsch or Italiano. Arabic lays the whole app out
  right to left. The sign-in pages have the same picker.
- **Digits in Arabic**: Western (0123) or Eastern (٠١٢٣), shown only while the language is Arabic.
  Short IDs and serial numbers always stay in Western digits.
- **Theme**: **System** (follows the device's light or dark setting), **Light** or **Dark**.
- **Content width**: **Centered** or **Full width**, on screens 768 px and wider.

## 7. Take the tour

**Help → Show me around** is a short look at Home, Capture, Inbox and Search. It never starts by
itself, and you can replay it any time. A few one-time hints also appear the first time you use
Capture, Scan, the Inbox's suggested values or Labels.

:::tip[Keep the keys]
Before the first AI key, secret value or backup, Kept waits until the instance admin has saved the
[recovery kit](/admin/recovery-kit/) (Admin → Status asks for it). Without the kit, a backup can't
bring back AI keys or stored passwords on a new server.
:::
