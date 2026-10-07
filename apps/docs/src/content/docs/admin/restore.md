---
title: Restore and the drill
description: Bring a backup back into a new, empty database, prove it matches, swap it in - and rehearse it monthly.
sidebar:
  order: 2
---

Kept restores **into a new, empty database only**, checks it, and leaves the swap to you. It
refuses a database that has anything in it, so it can't be pointed at the live one by mistake.

## Restore

1. **List the snapshots:**

   ```sh
   docker compose run --rm --no-deps --entrypoint kept kept admin backup --list
   ```

   This runs the CLI in a one-off `kept` container, which has the data volume, the keys, the owner
   login from your `compose.override.yaml`, and the backup settings (`.env`'s, or those saved in
   Admin → Backups; see [backups](/admin/backups/#turning-it-on)).

2. **Make an empty database** beside the live one, as the database superuser:

   ```sh
   docker compose exec db psql -U postgres -c "CREATE DATABASE kept_restored OWNER kept_owner"
   docker compose exec db psql -U postgres -d kept_restored -c \
     "CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent; CREATE EXTENSION vector; ALTER SCHEMA public OWNER TO kept_owner;"
   ```

   On managed Postgres, run [the provider SQL's](/install/managed-postgres/#the-sql) extension and
   ownership lines for the new database instead.

3. **Restore into it**, with `.env` loaded into the shell first (`set -a; . ./.env; set +a`):

   ```sh
   docker compose run --rm --no-deps --entrypoint kept \
     -e KEPT_OWNER_DATABASE_URL="postgres://kept_owner:${KEPT_DB_OWNER_PASSWORD}@db:5432/kept_restored" \
     kept admin restore <snapshot>
   ```

   Kept takes the database and the files out of the snapshot, checks the dump against its manifest,
   checks `pg_restore` matches the server's major version and the extensions exist, restores in
   one transaction, then compares **every table's row count and data digest** with the manifest:
   any table whose data differs, even with the same number of rows, fails the restore. Files go
   back into the store `KEPT_STORAGE` names, each one's SHA-256 checked. It ends by printing the
   swap.

4. **Swap**, with Kept stopped, as the superuser:

   ```sh
   docker compose stop kept
   docker compose exec db psql -U postgres -c "ALTER DATABASE kept RENAME TO kept_before_restore"
   docker compose exec db psql -U postgres -c "ALTER DATABASE kept_restored RENAME TO kept"
   docker compose up -d
   ```

   Keep `kept_before_restore` until you are sure, then drop it.

Renaming a database needs the superuser, which none of Kept's logins is: that is why Kept prints
these commands rather than running them.

## After losing the server

On the new machine: install Kept as in [Install with Docker Compose](/install/compose/), and before
the first start put the **recovery kit's keys** in `.env` (`KEPT_SECRET_KEY`, `KEPT_AUTH_SECRET`,
and `KEPT_SECRET_KEY_VERSION` and `KEPT_SECRET_KEYS_RETIRED` if the kit lists them), with the
backup target and its password in `compose.override.yaml`. Then:

```sh
docker compose up -d db
docker compose run --rm --no-deps --entrypoint kept kept admin backup --list
docker compose run --rm --no-deps --entrypoint kept kept admin restore <snapshot>
docker compose up -d
```

The new install's `kept` database is still empty (the `migrate` service hasn't run yet), so it
takes the restore directly; there is nothing to swap.
Without the keys, everything comes back except secret values and AI keys, which stay unreadable.

## The monthly drill

A backup nobody has restored is a hope, not a backup. Once a month, restore the latest snapshot
into a scratch database and let Kept compare it (with `.env` loaded, as above):

```sh
docker compose exec db psql -U postgres -c "CREATE DATABASE kept_drill OWNER kept_owner"
docker compose exec db psql -U postgres -d kept_drill -c \
  "CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent; CREATE EXTENSION vector; ALTER SCHEMA public OWNER TO kept_owner;"
docker compose run --rm --no-deps --entrypoint kept kept admin backup drill \
  --into "postgres://kept_owner:${KEPT_DB_OWNER_PASSWORD}@db:5432/kept_drill"
docker compose exec db psql -U postgres -c "DROP DATABASE kept_drill"
```

The drill restores the latest good snapshot, compares counts and digests, checks the SHA-256 of 50
files (`--all-files` checks them all), and records the drill in the **live** database, which clears
the "restore drill due" alert on Admin → Status. It never touches the live data.

## Checking the repository

The worker checks the repository weekly (`restic check`). To check now, or to read back part of the
data as well:

```sh
docker compose run --rm --no-deps --entrypoint kept kept admin backup verify --read-data 5%
```

With S3 file storage, verify also checks every file in the manifest against the bucket. If a crash
left a stale lock on the repository, `kept admin backup unlock` removes it; it refuses while a
backup is running.
