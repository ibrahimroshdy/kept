# Upgrade, roll back one version, and upgrade Postgres

**Status (2026-10-06):** steps 1–2 work today. The pre-upgrade snapshot, the release history and
the rollback guard (step 8 T8) and the `migrate` service's keys and backup settings (step 8 T15)
**land with step 8**; T25 checks this runbook against them. The public version is the docs site's
"Upgrades and rollback" page (`apps/docs/src/content/docs/admin/upgrades.md`); keep the two in step.

## Upgrade (Compose)

1. Read the release notes. A major version (`1.x` → `2.0`) may need a step of its own.
2. Check the last backup is good: Admin → Status, or
   `docker compose run --rm --no-deps --entrypoint kept kept admin backup --list`.
3. Point `KEPT_IMAGE` in `.env` at the new tag (`X.Y.Z`; never `latest`), then:

   ```sh
   docker compose pull
   docker compose up -d
   ```

4. `migrate` runs `kept migrate` once, under the advisory lock, before `kept` starts. *(Step 8:)*
   on a populated database with pending migrations and a backup target, it first takes a
   database-only snapshot tagged `pre_upgrade`; if that fails, nothing is migrated and `migrate`
   exits non-zero with the reason. `KEPT_UPGRADE_SNAPSHOT=off` or `kept migrate --skip-snapshot`
   skips it deliberately.
5. Verify: `curl -s <KEPT_PUBLIC_URL>/version` answers the new version; Admin → Status is clean.

## Roll back one version

Migrations are additive (D82), so the previous release runs on the newer schema. There are no down
migrations.

1. Set `KEPT_IMAGE` back to the previous tag; `docker compose up -d`.
2. *(Step 8:)* the boot logs one line, and `/version` and Admin → Status say "rolled back from X".
3. If Kept refuses to start with `downgrade_refused` (the database is more than one recorded
   release ahead, or ahead by migrations no recorded release made): don't force it. Restore the
   `pre_upgrade` snapshot instead (`docs/runbooks/restore-drill.md`, "Restore for real").
   `KEPT_ALLOW_DOWNGRADE=1` (or `kept migrate --allow-downgrade`) forces the start, audited as
   `instance.downgrade_forced`; use it only under a restore procedure that says so.

## Postgres major upgrade (D186)

A major version is a dump and restore through Kept's own backup, never an image tag bump on the
existing volume. Renovate never proposes one.

1. `docker compose run --rm --no-deps --entrypoint kept kept admin backup`; wait for it to finish.
2. `docker compose stop kept`.
3. In `compose.yaml`, set the `db` image to the new major version, pinned by digest (read the tag
   and digest from the registry; never assume one), and point it at a **new** volume. Keep the old
   volume until the end.
4. `docker compose up -d db`: the init script creates the roles and extensions.
5. Restore the backup into the empty `kept` database (`restore-drill.md`, "Restore for real",
   from step 2 of that procedure: the database already exists and is empty).
6. `docker compose up -d`; verify `/readyz` and Admin → Status; then remove the old volume.

The image's `pg_dump`/`pg_restore` must match the server's major version; a Postgres major upgrade
therefore also needs a Kept image whose client tools are that version.
