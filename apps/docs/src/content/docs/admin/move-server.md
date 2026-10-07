---
title: Moving to a new server
description: Two ways to move Kept - the whole instance through a backup, or one location at a time through an export.
sidebar:
  order: 8
---

## The whole instance: through a backup

This moves everything (every account, location, file and setting) and is the same procedure as
recovering from a lost server:

1. On the old server, take a backup and let it finish, and print the
   [recovery kit](/admin/recovery-kit/).
2. On the new server, [install Kept](/install/compose/) with the kit's keys in `.env` and the same
   backup target, but **don't start Kept yet**.
3. [Restore](/admin/restore/#after-losing-the-server) the latest backup into the new, empty database.
4. Point the old address at the new server (DNS, or your proxy), keep `KEPT_PUBLIC_URL` the same,
   and start Kept. Labels and QR codes keep working because the address hasn't changed.
5. Stop the old server once the new one is checked, and keep its disk until the new one has had a
   good backup and a [restore drill](/admin/restore/#the-monthly-drill).

If the address does change, labels already printed still carry the old one: point the old hostname
at the new server too, and list it among the instance's former hostnames: Kept then redirects a
visit under the old name to the same page at the new address.

## One location at a time: through an export

An owner exports a location, with its files and, if they choose, its secret values under a
passphrase; on the new server they import it into a new location. This moves one household without
the rest of the instance, and works between two instances that run different versions.

1. On the old server, in **Settings → Export**, export the location. Choose whether to include
   secret values; if you do, set a passphrase. Exports are made over HTTPS only, and stay ready to
   download for 7 days.
2. On the new server, sign in, open **Settings → Import**, and choose the Kept export (the ZIP).
   Kept checks it first and shows what it will add before anything is written; give the passphrase
   to bring the secret values back.
3. The import makes a **new location** with the things, places, files and their history. Printed
   labels keep working: a label's short code is kept when it is free on the new server, and
   re-issued when it isn't, in which case scanning the old label still opens the thing.
4. Invite the people who shared the location; the import lists them, but doesn't invite anyone by
   itself.
