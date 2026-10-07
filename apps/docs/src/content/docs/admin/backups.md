---
title: Backups
description: Nightly encrypted restic snapshots of the database, the files and a readable copy, to another disk, an S3 bucket or an SFTP server.
sidebar:
  order: 1
---

Every night Kept takes one **restic snapshot**: encrypted with a password you choose,
deduplicated (a night with nothing new adds almost nothing), and sent to a place that isn't the
server's own disk.

## What a snapshot holds

- **The database**, dumped from one consistent moment, with a manifest of every table's row count
  and a digest of its data, so a restore can prove it brought back exactly what was there.
- **The files** (photos, receipts, documents), when they are stored on the server's disk. With
  S3 file storage they aren't: see [below](#when-files-live-in-s3).
- **A readable copy of every location**: web pages, spreadsheets, thumbnails and receipts that open
  in a browser with nothing but restic. See
  [read your inventory with restic alone](/admin/read-with-restic/).

The keys are **not** in the backup. Keep [the recovery kit](/admin/recovery-kit/) somewhere else.

## Where it can go

| Target | Set with | The restic repository |
|---|---|---|
| A directory: another disk, or a NAS share mounted on the server | `KEPT_BACKUP_DIR` (absolute, outside `KEPT_DATA_DIR`) | `<directory>/restic` |
| An S3-compatible bucket: AWS, or another provider's S3 endpoint | `KEPT_BACKUP_S3_BUCKET` and the other `KEPT_BACKUP_S3_*` | `restic/` under `KEPT_BACKUP_S3_PREFIX` |
| An SFTP server | `KEPT_BACKUP_SFTP` (restic's `sftp:` syntax), `KEPT_BACKUP_SFTP_KEY_FILE`, `KEPT_BACKUP_SFTP_KNOWN_HOSTS` | the location you give |

Set one target. Prefer another machine or another site: a directory on the same disk as Kept's
data is refused, and the status page warns when the target shares a disk with it. Backblaze B2's and
Cloudflare R2's S3 endpoints are expected to work but haven't been tested. SFTP pins the server's
host key from the known-hosts file and connects only if it matches.

## Turning it on

Instance admins set the target and the password in **Admin → Backups**, over HTTPS, after
acknowledging the recovery kit. "Test" checks Kept can open (or create) the repository; "Back up
now" runs one at once. An environment variable beats the screen and shows there as locked, so an
operator can fix the target in the deployment.

**The password** is at least 12 characters (`KEPT_BACKUP_PASSWORD`, or set on the screen).
**No password, no backup:** Kept never writes an unencrypted backup. Lose the password and the
backup is unreadable, which is why it is in the recovery kit.

The backup runs in the worker as the database owner, so the worker needs `KEPT_OWNER_DATABASE_URL`
as well. With Compose, `compose.yaml` already passes every `KEPT_BACKUP_*` variable from `.env`
to Kept and to `migrate` (which takes a snapshot before an upgrade); a `compose.override.yaml`
next to it adds the owner login and, for a directory target, the mount on both:

```yaml
services:
  kept:
    environment:
      KEPT_OWNER_DATABASE_URL: postgres://kept_owner:${KEPT_DB_OWNER_PASSWORD}@db:5432/kept
    volumes:
      - /mnt/backup/kept:/backups
  migrate:
    volumes:
      - /mnt/backup/kept:/backups
```

Then either set the target and the password on the screen, or lock them in `.env`
(`KEPT_BACKUP_DIR=/backups`, `KEPT_BACKUP_PASSWORD=…`).

The directory must belong to Kept's user:

```sh
sudo mkdir -p /mnt/backup/kept
sudo chown 10001:10001 /mnt/backup/kept
sudo chmod 700 /mnt/backup/kept
```

## When and how long

- **When:** every night at the time set in Admin → Backups, `HH:MM` in UTC (default `02:30`).
  A new time applies from the next night, with no restart; `KEPT_BACKUP_TIME` fixes it instead.
- **Back up now** runs one at once; pressing it again while that one waits or runs is refused
  ("A backup is already running") rather than queued twice.
- **How long they're kept:** the newest snapshot of each of the last **7 days, 4 weeks and 6
  months** (`KEPT_BACKUP_KEEP_DAILY`, `_WEEKLY`, `_MONTHLY`). The alpha's `KEPT_BACKUP_KEEP` is
  read as the daily count for one release. Snapshots taken before an upgrade keep their last 3.
- **A suspiciously small backup** (a dump under half the last good one's size, or far fewer
  things, places or files) is still taken, but nothing old is removed that night and admins are
  alerted, so a bad night can never push the good snapshots out.

## Watching it

Admin → Status shows the last backup and its age, the number of snapshots, the repository's size,
the last restore drill, and the disks. Admins are alerted by mail and push when:

| Alert | When |
|---|---|
| Backup failed | a run fails |
| Backup stale | no good backup for 36 hours with a target set |
| Suspicious size | a run was much smaller than the last good one |
| Disk space low | the data disk or a directory target is 85 % full |
| Bucket versioning off | files are in S3 and the bucket keeps no old versions |
| Restore drill due | no [restore drill](/admin/restore/#the-monthly-drill) for 30 days |

`/metrics` (with `KEPT_METRICS_TOKEN`) adds the last good backup's time and the disks' use. See
[monitoring](/admin/observability/).

## When files live in S3

restic backs up files on disk, not objects in a bucket. With `KEPT_STORAGE=s3`, the snapshot holds
the database, the manifest and the readable copy, and **the bucket keeps the files safe itself**:
turn on **bucket versioning** (and, if your provider has it, replication to another region). Kept
checks versioning on every run and alerts while it is off. The weekly check and the restore drill
compare every file's hash in the manifest with the bucket.

## The alpha's backups

Backups made before restic, by the alpha (`runs/` and `blobs/` beside the new `restic/` directory), are never
written again, and stay restorable with `kept admin restore --legacy <id>` for one release. Delete
them once a restic snapshot has passed a restore drill.
