---
title: Migrations
description: How a schema change is made, how kept migrate applies it, and what else must change with a new table or route.
---

The schema lives in two places that must agree: the Drizzle table definitions in
[`apps/server/src/db/schema/`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/src/db/schema)
and the SQL files in
[`apps/server/migrations/`](https://github.com/ibrahimroshdy/kept/tree/main/apps/server/migrations).
The rules are the engineering spec's §7.12
([engineering spec](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md))
and the "Migrations are additive" section of
[CONTRIBUTING.md](https://github.com/ibrahimroshdy/kept/blob/main/CONTRIBUTING.md).

## Two kinds of migration

| Kind | Made by | Holds |
|---|---|---|
| Generated | `drizzle-kit generate` from the schema files | Tables, columns, indexes, constraints Drizzle can express |
| Custom | `drizzle-kit generate --custom --name=<name>`, then written by hand | Functions, triggers, row-level-security policies, grants, data changes |

A custom file starts with drizzle-kit's `-- Custom SQL migration file, put your code below! --`
line. A feature usually lands as a pair: the generated table, then a custom migration with its
policies, grants and triggers (`0069_tokens.sql` then `0070_tokens_rls.sql`, for instance).
Files are numbered and listed in `migrations/meta/_journal.json`; drizzle-kit keeps a snapshot
per migration beside it. Statements in one file are separated by `--> statement-breakpoint`.

The configuration is
[`apps/server/drizzle.config.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/drizzle.config.ts):
dialect `postgresql`, schema `./src/db/schema/index.ts`, output `./migrations`, schemas `public`,
`kept` and `auth`, and the applied-migrations table `kept_meta.migrations`.

## Making a change

1. Change or add the table in `src/db/schema/<area>.ts`, and export it from `index.ts`.
2. Generate the migration, from `apps/server`:
   ```sh
   pnpm exec drizzle-kit generate
   ```
3. For policies, grants, functions or triggers, add a custom migration:
   ```sh
   pnpm exec drizzle-kit generate --custom --name=<area>_rls
   ```
4. Apply it to your development database and run the tests:
   ```sh
   pnpm --filter @kept/server kept migrate
   pnpm test apps/server/test/leak.test.ts
   ```

ci-local's `drift` step runs `drizzle-kit generate` into a scratch copy of the migrations and
fails unless it reports `No schema changes`, then runs `drizzle-kit check`. A schema edit without
its migration, or a migration edited after the fact, fails there.

## What a new table needs

The default privileges set in `0000_foundation_schemas.sql` give `kept_app` and `kept_system`
SELECT, INSERT, UPDATE and DELETE on every new table in `public`. That is a starting point, not
permission: nothing is reachable until a policy allows it. In the custom migration:

- **Enable and force RLS**, and give `kept_owner` its `owner_all` policy.
- **`kept_app` policies** in the shape of the table's scope, on `USING` and `WITH CHECK`
  ([row-level security](/developers/rls/#policy-shapes)).
- **Narrow UPDATE**: `REVOKE UPDATE` on the table from `kept_app`, then `GRANT UPDATE (<columns>)`
  for the columns a request may change. The leak test fails if `kept_app` may update an id, key
  or scope column.
- **`kept_system`** gets a policy only if a job needs the table, with a comment naming the job, and
  the table goes on the matching list in the leak test.
- **The `touch_row` trigger** for a mutable table:
  `CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.<table> FOR EACH ROW EXECUTE FUNCTION kept.touch_row();`
- **A new function** in schema `kept` is executable by `kept_app` and `kept_system` through
  0000's default privileges, and by nobody else. Revoke it from a role that shouldn't call it, and
  add it to the function inventory in `test/leak.test.ts` (and to `src/db/migrate.test.ts`, which
  checks the grants too). A `SECURITY DEFINER` function must be owned by `kept_owner` with a fixed
  `search_path`; the leak test checks both.

Then add fixture rows for the table in the leak-test fixture file for its area. Until it has
policies, a scope and rows, `test/leak.test.ts` fails.

## What a new route needs

Every non-GET route must leave an audit row, and a test must prove it.
[`apps/server/test/route-catalogue.test.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/test/route-catalogue.test.ts)
builds the app, collects each non-GET route as it is added, and requires either a
`// catalogue: <METHOD> <url>` marker directly above an `it(` case that asserts the audit row, or
an entry on its `ALLOWLIST` with the reason no audit row is right (a read-only preview, a
sign-in). A route a personal token may call also goes in `TOKEN_ROUTES` in
[`tokens/access.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/tokens/access.ts);
routes are closed to tokens unless listed.

## Additive only

Kept supports rolling back one release, so a release must run on the database the next release
leaves behind:

- Add tables and columns. **Never drop or rename one in the release that stops using it**: stop
  reading it in one release, remove it in the next.
- Enumerations are `text` with a `CHECK`, never Postgres enums; unknown values parse to a fallback
  in zod.

## How `kept migrate` runs

[`db/migrate.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/db/migrate.ts),
started by `kept migrate`
([`cli/index.ts`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/src/cli/index.ts)):

1. Connects once as **`kept_owner`** with `KEPT_OWNER_DATABASE_URL`.
2. Takes the advisory lock (`pg_try_advisory_lock`, polled, 60 s by default), so two migrators
   never race. A timeout fails with `migrate_lock_timeout`.
3. **Release guard.** If the database has migrations this image doesn't know, a database one
   release ahead is a logged rollback; more than one is refused (`downgrade_refused`) unless
   `--allow-downgrade` or `KEPT_ALLOW_DOWNGRADE=1`, which is audited.
4. **Pre-upgrade snapshot.** On a populated database with migrations pending, a database-only
   restic snapshot first, when a backup target is configured. A failed snapshot stops the
   migration; `--skip-snapshot` or `KEPT_UPGRADE_SNAPSHOT=off` skips it.
5. Applies the pending migrations with Drizzle's migrator into `kept_meta.migrations`.
6. Installs pg-boss's schema at the version the package expects (the runtime roles run pg-boss
   with its own migrations off).
7. Upserts the reference rows: currencies and the built-in type library.
8. Records the release in `release_history`, except for a development build.

The serving process never migrates. Compose runs `kept migrate` as the one-shot `migrate`
service before Kept starts, and the Helm chart as a hook Job; see [upgrades](/admin/upgrades/).
