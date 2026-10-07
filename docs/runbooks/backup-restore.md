# Backups (restic) and restore

**Status (2026-10-07):** built in step 8 (T5–T8, D64, D66, D144, D159). Every command below is
read from `apps/server/src/cli/index.ts` as it stands. The tests run on an in-memory fake restic
(`bash scripts/ci-local.sh`'s `backup` step); the real binary was exercised by spike R1
(`docs/spikes/2026-10-06-step8-restic.md`: directory, S3 on RustFS, SFTP) and runs the same tests
under `KEPT_TEST_RESTIC=1`, which no recorded run has done yet. The public versions are the docs
site's "Backups", "Restore and the drill" and "Read your inventory with restic alone" pages
(`apps/docs/src/content/docs/admin/`); keep them in step. The monthly drill and the full restore
with its swap are in [restore-drill.md](restore-drill.md).

Every command runs the CLI in a one-off `kept` container, which has the data volume, the keys, the
owner login from `compose.override.yaml` and the backup settings. Load `.env` into the shell first:

```sh
set -a; . ./.env; set +a
```

## What a snapshot holds

One restic snapshot a night (tags `kept`, the kind, `v<version>`), encrypted with the backup
password and deduplicated:

```
/backup/db/db.dump          pg_dump (custom format) of one consistent database snapshot
/backup/db/manifest.json    every table's row count and data digest, every file's key, size, SHA-256
/backup/readable/           the readable copy of every location (HTML, CSV, thumbnails, receipts)
/blobs/<key>                the files, with local storage only (KEPT_STORAGE=local)
```

- **Kinds:** `nightly`, `manual` (Back up now, or `kept admin backup`) and `pre_upgrade` (taken by
  `kept migrate` before it migrates; database only, no readable copy, no files).
- **Retention:** 7 daily, 4 weekly, 6 monthly for nightly and manual each
  (`KEPT_BACKUP_KEEP_DAILY`, `_WEEKLY`, `_MONTHLY`; the alpha's `KEPT_BACKUP_KEEP` is read as the
  daily count for one release); `pre_upgrade` keeps its last 3. A suspiciously small backup is
  taken but prunes nothing that night.
- **With S3 file storage** the files stay in the bucket, not the snapshot (D144): turn on bucket
  versioning. Kept checks it on every run and alerts while it is off.
- **Not in the backup:** `KEPT_SECRET_KEY`, `KEPT_AUTH_SECRET` and retired keys. They are in the
  recovery kit (`kept admin recovery-kit`); without them a restore brings back everything except
  secret values and AI keys.

## Where it goes

Set one target, preferably another machine or site.

| Target | Variables | The restic repository |
|---|---|---|
| A directory (another disk, a NAS mount) | `KEPT_BACKUP_DIR` (absolute, outside `KEPT_DATA_DIR`) | `<dir>/restic` |
| An S3 bucket | `KEPT_BACKUP_S3_BUCKET`, `_ENDPOINT`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_FORCE_PATH_STYLE`, `_PREFIX` | `restic` under the prefix |
| An SFTP server | `KEPT_BACKUP_SFTP` (restic's `sftp:` syntax), `KEPT_BACKUP_SFTP_KEY_FILE`, `KEPT_BACKUP_SFTP_KNOWN_HOSTS` | the path given |

Plus `KEPT_BACKUP_PASSWORD` (12 characters or more; no password, no backup) and
`KEPT_BACKUP_TIME` (`HH:MM` UTC, default `02:30`). Each can instead be set in **Admin → Backups**;
a variable that is set wins and shows there as locked.

## 1. Turn it on

1. The backup runs as `kept_owner`. In `compose.override.yaml`, give Kept the owner login and,
   for a directory target, mount it on both `kept` and `migrate` (`migrate` takes the pre-upgrade
   snapshot):

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

   The directory belongs to Kept's user:

   ```sh
   sudo mkdir -p /mnt/backup/kept
   sudo chown 10001:10001 /mnt/backup/kept
   sudo chmod 700 /mnt/backup/kept
   ```

2. Acknowledge the recovery kit (Admin → Status), then set the target and password in Admin →
   Backups and press **Test**, or put `KEPT_BACKUP_DIR=/backups` and `KEPT_BACKUP_PASSWORD=…` in
   `.env`. `docker compose up -d`.
3. Download the recovery kit again: it now holds the repository, its password and its
   credentials.

## 2. Back up now, and check it

```sh
docker compose run --rm --no-deps --entrypoint kept kept admin backup
docker compose run --rm --no-deps --entrypoint kept kept admin backup --list
```

`kept admin backup` prints `Backing up to …`, then
`Snapshot <id>: <n> files, <bytes> bytes added (<n> new files).` and, on their own lines, files
the database lists but the store lacks. It exits 1 on a warning: a suspiciously small backup
(`backup_suspicious_size`), files restic couldn't read (`files_unreadable`), a file whose SHA-256
doesn't match (`blob_checksum_mismatch`), or a location whose readable copy failed
(`readable_incomplete`). If the size check fired and the shrink is real (a lot was deleted on
purpose), accept the new size:

```sh
docker compose run --rm --no-deps --entrypoint kept kept admin backup --accept-size
```

`--list` prints each snapshot's short id, time, kind and version, newest first, then any alpha
runs from before restic.

**Verify:** Admin → Status shows the last backup, its age and the snapshot count; the command
exited 0.

## 3. Check the repository

The worker runs `restic check` weekly. To run it now, and read back a share of the data:

```sh
docker compose run --rm --no-deps --entrypoint kept kept admin backup verify --read-data 5%
```

`--read-data` takes a percentage with its `%` sign. With S3 file storage, `verify` also checks the
newest manifest's files against the bucket, one in 20 (`--all-files`: every one). It ends with
`Verified.` (exit 0) or `NOT verified: <reason>.` (exit 1).

A crash can leave a stale restic lock; remove it (refused while a backup runs):

```sh
docker compose run --rm --no-deps --entrypoint kept kept admin backup unlock
```

## 4. Restore

`kept admin restore <snapshot>` restores into the **empty** database `KEPT_OWNER_DATABASE_URL`
names, and the file store `KEPT_STORAGE` names, then verifies every table's row count and data
digest and every file's SHA-256. `<snapshot>` is an id from `--list` or `latest`. It never swaps
databases: it prints the superuser's commands. The full procedure (an empty database beside the
live one, the restore, the swap, the check) is [restore-drill.md](restore-drill.md), "Restore for
real"; the monthly drill (`kept admin backup drill --into <url>`) is in the same runbook.

### Rolling back past one release (`downgrade_refused`)

Kept refuses to start an image more than one release older than the database (the message names
this runbook). Don't force it; restore the newest `pre_upgrade` snapshot taken before the upgrade:

1. `docker compose stop kept`; set `KEPT_IMAGE` in `.env` back to the release that took the
   snapshot (its tag is in `--list`'s version column).
2. Find the snapshot: `kept admin backup --list` (as above), kind `pre_upgrade`.
3. Restore it into an empty `kept_restored`, then swap, as in restore-drill.md, "Restore for
   real", steps 2–4. A `pre_upgrade` snapshot holds the database only: the restore checks every
   file the manifest lists is still in the live store, unchanged, rather than putting files back
   (read from `apps/server/src/backup/restore.ts`, not yet run against a real upgrade).
4. **Verify:** `/version` answers the older release; Admin → Status is clean.

Anything written after the snapshot is lost. `KEPT_ALLOW_DOWNGRADE=1` (or
`kept migrate --allow-downgrade`) forces the start instead, audited as `instance.downgrade_forced`;
use it only when a release's notes say to.

### After losing the server

On the new machine, install Kept as the docs site's "Install with Docker Compose" says, and before
the first start put the recovery kit's keys in `.env` (`KEPT_SECRET_KEY`, `KEPT_AUTH_SECRET`, and
`KEPT_SECRET_KEY_VERSION` / `KEPT_SECRET_KEYS_RETIRED` if the kit lists them), with the backup
target and its password (`KEPT_BACKUP_*` from the kit) and the owner login. Then:

```sh
docker compose up -d db
docker compose run --rm --no-deps --entrypoint kept kept admin backup --list
docker compose run --rm --no-deps --entrypoint kept kept admin restore latest
docker compose up -d
```

The new `kept` database is still empty (`migrate` hasn't run), so it takes the restore and there
is nothing to swap. With an empty database the CLI reads the backup settings from the environment
alone. A directory backup copied off the dead server's disk: mount the copy and point
`KEPT_BACKUP_DIR` at the folder that holds `restic/`. If the kit lists retired keys, run
`docker compose exec kept kept admin rotate-key --resume` once Kept is up.

**Verify:** the restore ends with `Verified: every table and every file matches the backup.`;
`/readyz` answers 200; a few things and their photos open.

### The alpha's backups

Runs from before restic (`runs/` and `blobs/` beside `restic/` in a directory target, or the
bucket's `runs/`) are never written again and restore for one release:

```sh
docker compose run --rm --no-deps --entrypoint kept \
  -e KEPT_OWNER_DATABASE_URL="postgres://kept_owner:${KEPT_DB_OWNER_PASSWORD}@db:5432/kept_restored" \
  kept admin restore --legacy <run id>
```

`<run id>` is from the "Older backups" list under `--list`, or the path of a run's directory
(`<backup dir>/runs/<id>`) copied off a dead server's disk. Delete the alpha's runs once a restic
snapshot has passed a drill.

## 5. Without Kept

- **The readable copy, from restic alone:** the docs site's "Read your inventory with restic
  alone" page. In short, with `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` (and the S3 keys) from the
  kit:

  ```sh
  restic snapshots
  restic restore <snapshot ID> --target ./kept-readable --include /backup/readable
  ```

  then open `kept-readable/backup/readable/index.html`. Take a `nightly` or `manual` snapshot; a
  `pre_upgrade` one has no readable copy.
- **The readable copy, now, from a running Kept:**

  ```sh
  docker compose exec kept kept admin readable --out /data/readable-now
  ```

  (`--location <id>` for one location, `--no-pdf` to leave out the inventory PDFs.)
- **The raw export** (every row as stored, secrets sealed, and every file), into a new or empty
  directory:

  ```sh
  docker compose exec kept kept admin export --out /data/export-now
  ```

  Both are as sensitive as a backup: move them off the server and delete them from `/data`.

## pg_dump's version

`pg_dump` and `pg_restore` must be the database server's major version (18). The image installs
PGDG's `postgresql-client-18` and restic 0.19.1; every run checks the versions before it dumps.
Running the commands outside the image needs both on the `PATH` (`KEPT_RESTIC_BIN` names another
restic).
