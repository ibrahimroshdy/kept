# Restore drill, and restoring for real

**Status (2026-10-07):** restic restore, `kept admin backup drill` and `verify` (step 8 T7) are
built; the commands below match `apps/server/src/cli/index.ts`. Taking backups, the pre-upgrade
rollback and the alpha's runs are in `docs/runbooks/backup-restore.md`. The public version is the docs site's "Restore and the
drill" page (`apps/docs/src/content/docs/admin/restore.md`); keep the two in step.

Every command below runs the CLI in a one-off `kept` container (`--no-deps --entrypoint kept`),
which has the data volume and the keys; `compose.override.yaml` gives it `KEPT_OWNER_DATABASE_URL`
and the backup settings (docs site, "Backups"). Load `.env` into the shell first:

```sh
set -a; . ./.env; set +a
```

## The monthly drill (D66, L78)

Admin → Status raises `restore_drill_due` after 30 days without one.

1. A scratch database, as the superuser:

   ```sh
   docker compose exec db psql -U postgres -c "CREATE DATABASE kept_drill OWNER kept_owner"
   docker compose exec db psql -U postgres -d kept_drill -c \
     "CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent; CREATE EXTENSION vector; ALTER SCHEMA public OWNER TO kept_owner;"
   ```

2. The drill:

   ```sh
   docker compose run --rm --no-deps --entrypoint kept kept admin backup drill \
     --into "postgres://kept_owner:${KEPT_DB_OWNER_PASSWORD}@db:5432/kept_drill"
   ```

   It restores the latest `ok` snapshot, compares every table's row count **and data digest** with
   the manifest, checks 50 files' SHA-256 (`--all-files`: every file), records a `drill` run in the
   **live** database and resolves `restore_drill_due`.
3. Verify: the command exits 0; Admin → Status shows today's drill.
4. Clean up: `docker compose exec db psql -U postgres -c "DROP DATABASE kept_drill"` (the drill
   prints this command).

A failed drill is an incident: the backups can't be trusted until a drill passes. Check the
repository (`kept admin backup verify --read-data 5%`), then take a manual backup and drill again.

## Restore for real

1. List: `docker compose run --rm --no-deps --entrypoint kept kept admin backup --list`.
2. An empty database `kept_restored` (as in the drill, step 1; on a new server the empty `kept`
   database the init script made will do, and there is no swap).
3. Restore:

   ```sh
   docker compose run --rm --no-deps --entrypoint kept \
     -e KEPT_OWNER_DATABASE_URL="postgres://kept_owner:${KEPT_DB_OWNER_PASSWORD}@db:5432/kept_restored" \
     kept admin restore <snapshot>
   ```

   It refuses a non-empty database; checks the dump against the manifest, `pg_restore`'s major
   version and the extensions; restores in one transaction; compares counts and digests; puts the
   files back into the store `KEPT_STORAGE` names, each SHA-256 checked; and prints the swap.
   `--legacy <runId>` restores an alpha run instead (one release only).
4. Swap (Q13: renaming needs the superuser, which Kept never has):

   ```sh
   docker compose stop kept
   docker compose exec db psql -U postgres -c "ALTER DATABASE kept RENAME TO kept_before_restore"
   docker compose exec db psql -U postgres -c "ALTER DATABASE kept_restored RENAME TO kept"
   docker compose up -d
   ```

5. Verify: `/readyz` 200, Admin → Status clean, a few things and their photos open. Drop
   `kept_before_restore` once satisfied.

On a new server, the recovery kit's keys go into `.env` before the first start; without them,
secret values and AI keys stay unreadable. If the kit lists retired keys, run
`kept admin rotate-key --resume` once Kept is up.
