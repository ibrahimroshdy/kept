---
title: Questions and answers
description: Short answers to the questions people ask before and after installing Kept, each with a link to the page that has the detail.
---

## Does Kept send anything about me or my server anywhere?

No. There is no telemetry of any kind, not even an opt-in install count. The update check is off
until an admin turns it on, and then sends only the request for the latest release. Barcode lookup
and AI are also off until someone connects them. See [observability](/admin/observability/) and
[upgrades](/admin/upgrades/).

## Where is my data stored?

On your server: the database in Postgres, and the files (photos, receipts, documents) on Kept's
data volume or in an S3 bucket you choose. Your phone keeps a copy for offline use, without
secret values. See [file storage](/admin/storage/) and [the phone app](/users/phone-app/).

## Can I use it without AI?

Yes. Everything works except naming things from photos, reading receipts, the assistant and search
by meaning. Without a provider, captured things wait in the Inbox for a name, and search uses
keywords. See [AI providers](/users/ai-providers/).

## Which AI providers work, and who pays?

Groq (recommended), OpenAI, Anthropic, Google, OpenRouter, or any OpenAI-compatible server such as
Ollama. You use your own key; work in a location is paid by that location's owner's key, and you
can cap the spend. See [AI providers](/users/ai-providers/).

## Does it work offline?

On a phone with Kept installed, yes for finding and capturing: browsing, search, capture, moving
things, readings, box checks and scanning labels. Edits to details, reports, imports and exports
need a connection. What you do offline syncs when you're back. See
[Kept on your phone](/users/phone-app/#what-works-offline).

## Is there an app in the App Store or Google Play?

No. Kept is a web app you add to the home screen from the browser. It needs Kept to be on HTTPS.
See [Kept on your phone](/users/phone-app/#install-it) and [HTTPS](/install/https/).

## Does it run on arm64, or a Raspberry Pi?

The images are built for amd64 and arm64, so ARM servers and Docker on Apple Silicon run them. A
Raspberry Pi with 2 GB or more will probably work, but it isn't tested or promised. The floor is
2 GB of RAM and 2 CPU cores. See [what it needs](/install/hardware/).

## How many people can use one Kept?

Kept is sized by things rather than people: its targets are 10,000 things in a location and
50,000 in an instance on the 2 GB floor. People join a location by invite, and each location can
also hold up to 20 managed accounts for people without email. See [what it needs](/install/hardware/) and
[inviting people](/users/first-run/#5-invite-people).

## Can I keep more than one household, or share only part of my things?

Yes. Each location (a home, a garage, a storage unit, a parent's house) is shared on its own, with
its own members and roles; sharing the garage shares nothing else. One person can belong to many
locations, and everyone has a private Personal location. See
[your first minutes](/users/first-run/#5-invite-people).

## Can I move from Homebox?

Yes, from Homebox v0.26 or newer: import its export ZIP, check what will happen, then import.
Photos, receipts, warranties, maintenance and tags come over, and old Homebox labels still scan.
See [import and export](/users/import-export/#a-homebox-export).

## How do I back it up?

The server takes a nightly encrypted restic snapshot of the database, the files and a readable copy
of every location, to another disk, an S3 bucket or an SFTP server. Keep the recovery kit somewhere
else. To take one location away, export it. See [backups](/admin/backups/),
[the recovery kit](/admin/recovery-kit/) and [import and export](/users/import-export/#exporting).

## What if the server is lost with the house?

The backup's readable copy opens in any browser with restic, the backup's password and a laptop,
no Kept needed. To bring Kept itself back on a new machine you also need the recovery kit. See
[read your inventory with restic alone](/admin/read-with-restic/) and [restore](/admin/restore/).

## Which languages does it speak?

English, Arabic (laid out right to left), French, German and Italian, chosen per device. See
[language and theme](/users/first-run/#6-language-and-theme).

## What licence is it under?

The GNU Affero General Public License, version 3 (AGPL-3.0). You can run, change and share it; if
you run a changed version for other people over a network, you must offer them its source. The
text is in the repository's
[LICENSE](https://github.com/ibrahimroshdy/kept/blob/main/LICENSE).

## Is there a release?

Yes: `1.0.0` is the first signed release, on GHCR as `ghcr.io/ibrahimroshdy/kept`. Its images stay
private until the repository is public, so until then Compose builds the image from a checkout of
the repository. Upgrades run their migrations once, take a snapshot of the database first, and can
go back one version. See [install with Docker Compose](/install/compose/) and
[upgrades](/admin/upgrades/).
