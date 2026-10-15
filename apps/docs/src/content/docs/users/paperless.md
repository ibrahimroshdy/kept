---
title: Paperless-ngx
description: Link a thing or a place to its receipts, invoices, manuals and warranty cards in Paperless-ngx. Kept stores the link and a title, not the file, unless you copy a document in.
---

If you keep your paperwork in [Paperless-ngx](https://docs.paperless-ngx.com/), Kept can link a
thing to its documents there instead of you uploading them twice. The drill shows its receipt and
its manual; the kitchen shows the fridge's invoice.

Optional: only if you already run Paperless-ngx. Kept works the same without it.

## Before you start

| You need | Why |
|---|---|
| **Paperless-ngx 2.16 or later** | Kept asks for Paperless's API version 9, which 2.16 added and 3.x still serves |
| **An API token** | In Paperless: **My Profile**, then the circular arrow by the API token. Kept sees what that Paperless user sees, so a user who can only view your documents is enough |
| **Kept can reach Paperless** | From the machine Kept runs on, not from your phone |
| **`https`**, or your own network | Over plain `http` the token travels unencrypted, so Kept takes `http` only for an address on your own network. Such an address needs **Admin → Settings → Allow private addresses** ([outbound requests](/admin/security-model/#outbound-requests-ssrf)) |

## Connect

An owner or admin of the location:

1. **Location settings → Paperless**.
2. **Paperless address**: the address you open Paperless at, such as
   `https://paperless.example.com` (a path such as `/paperless` is fine).
3. **API token**, then **Connect**. Kept signs in first and says why if it can't: a refused
   token, an address that doesn't answer like Paperless, a version that is too old.

Once connected the page shows Paperless's version and how many documents are linked. **Test
connection** asks Paperless again. To change the token, type a new one and **Save**; leave it
empty to keep the saved one.

## Link documents

On a thing's page, under **Paperwork**, or on a place's page, **Link from Paperless** opens a
search of your Paperless: words from the title or the text, a correspondent, a type or a tag, as
Paperless's own search finds them. Tick one or more and **Link**.

Each linked document shows its thumbnail, its title, its kind, Paperless's type and
correspondent, and its date, with:

- **Open in Paperless**: the document's page in Paperless, in a new tab.
- **Download**: the document, through Kept. Members and up.
- **Copy into Kept**: see below.
- **Unlink**: it comes off the thing. Paperless keeps it.

The kind comes from the document's type in Paperless, then its tags: *Receipt*, *Invoice*,
*Manual* and *Warranty* (and the same words in French, German, Italian and Arabic) are
recognised, anything else is a document. The **Kind** filter in Paperwork narrows these too.

## Linked or copied

| | Linked | Copied into Kept |
|---|---|---|
| What Kept stores | The document's number in Paperless, its title, kind, type, correspondent and date | The file itself, as an attachment on the thing |
| If Paperless is down | The titles still show, with a note that Paperless can't be reached | Nothing changes |
| In Kept's backups and exports | No: a link needs this server's Paperless | Yes, like any other file |
| If the document changes in Paperless | Its title updates when you copy it | The copy stays as it was |

**Copy into Kept** is per document and explicit: use it for what must survive without Paperless,
such as a receipt you'll need for a warranty claim. The copy is the file Paperless serves for
download (its archived PDF when it made one), checked and sized like an upload.

## Who can do what

| | Viewer | Member | Admin, owner |
|---|---|---|---|
| See linked documents and thumbnails | ✓ | ✓ | ✓ |
| Search Paperless, link, copy, download | | ✓ | ✓ |
| Unlink | | Their own | Any |
| Connect, change, disconnect | | | ✓ |

Receipts and invoices are money: where money is hidden for you in a location, linked receipts and
invoices are hidden too.

A [personal token](/users/mcp-clients/#make-a-personal-token) reads a thing's or place's links
(`GET /api/v1/paperless-links?thingId=…`), never the connection, a search, a thumbnail or a
document. The MCP tool `get_thing` lists a thing's linked documents by title.

## Privacy

- The token is sealed with Kept's secret key, like a mailbox password. Kept never shows it, logs
  it, or puts it in an audit entry or an export.
- Your browser never talks to Paperless with the token. Searches, thumbnails and downloads go
  through Kept, which checks first that you may see the thing. Thumbnails are re-encoded by Kept
  and kept for five minutes.
- **Open in Paperless** is an ordinary link: you sign in to Paperless as yourself.
- Moving a thing to another location removes its links: they name documents in the old
  location's Paperless, which the new location's members may not see.

## Disconnect

**Location settings → Paperless → Disconnect** removes the connection and every link to its
documents. Documents copied into Kept stay.

## Not done yet

- Two-way sync: Kept doesn't change anything in Paperless.
- Matching receipts to things automatically.
- Sending Kept's own files to Paperless.
