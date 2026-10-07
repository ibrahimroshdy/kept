---
title: Read your inventory with restic alone
description: The server is gone. With restic, the backup's password and any computer, open the readable copy of everything you owned - no Kept, no network.
sidebar:
  order: 3
---

Every nightly snapshot holds a **readable copy** of each location: an `index.html` you open in a
browser, a spreadsheet (CSV) of the things, thumbnails, and the receipts and documents the pages
link to. It is written for the day Kept can't run: the server burned, the disk died, or Kept is
long gone. All you need is:

- **restic**, the backup program, on any computer (Windows, macOS or Linux). Its documentation lists
  a package or a download for each. Use version 0.19.1, the one Kept uses, or newer.
- **The repository and its password**, from [the recovery kit](/admin/recovery-kit/), and for an S3
  bucket or an SFTP server, the credentials the kit lists with them.
- The backup itself: the disk, the bucket or the SFTP server it was sent to.

## 1. Point restic at the backup

The recovery kit's backup section gives the repository's location and password, and, for S3, the
two keys. In a terminal:

```sh
export RESTIC_REPOSITORY='<the repository line from the kit>'
export RESTIC_PASSWORD='<the backup password from the kit>'
# S3 only:
export AWS_ACCESS_KEY_ID='<from the kit>'
export AWS_SECRET_ACCESS_KEY='<from the kit>'
```

On Windows PowerShell, `$env:RESTIC_REPOSITORY = '…'` and so on. A directory backup copied onto a
laptop is just its path: the `restic` folder inside the backup directory.

## 2. Pick a snapshot

```sh
restic snapshots
```

lists every snapshot with its time and tags. Take the newest one tagged `nightly` (or
`manual`); a `pre_upgrade` snapshot holds only the database, not the readable copy. Note its ID.

## 3. Restore the readable copy

```sh
restic restore <snapshot ID> --target ./kept-readable --include /backup/readable
```

This restores only the readable copy, not the database dump or the full-size files, into a new
folder `kept-readable`.

## 4. Open it

Open `kept-readable/backup/readable/index.html` in a browser. It lists every location, with its
owner and when the copy was made; each location's own `index.html` lists its places and things, with
their photos, purchase details and documents. `README.txt` beside it says the same.

The pages need no network and load nothing from anywhere else. Each location's CSV opens in a
spreadsheet.

Each location's copy is what its **owner** could see in Kept: money appears as the owner saw it,
and secret values (the Wi-Fi password you stored on the router) are never in it. A location whose
copy failed that night is listed as "not included tonight"; take the snapshot before it.

## Browse without restoring

On Linux, and on macOS with macFUSE, `restic mount ./mnt` shows every snapshot as folders you can
open in place. It needs FUSE, which Windows doesn't have; `restore` works everywhere.
