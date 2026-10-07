# Spike V31: managed Postgres providers, PostgreSQL 18 and Kept's extensions

Date: 2026-10-06 (every page below was read on this date). Step-8 plan, Task 0b (it feeds T19;
§19 V31, D178, D186). Result: **PASS for four of six providers.**
- **Four providers work:** AWS RDS, Google Cloud SQL, Azure flexible server and Neon offer
  PostgreSQL 18 and let their admin role create all three extensions. On Azure the three must be
  allow-listed in `azure.extensions` first.
- **DigitalOcean** works on its **Standard** Edition only. Advanced Edition can't `CREATE EXTENSION`,
  and neither `pg_trgm` nor `unaccent` is pre-installed there.
- **Supabase** doesn't offer PostgreSQL 18 (it offers 15 and 17), so it's out for Kept 1.0. Its
  extensions also default to an `extensions` schema, while Kept's migrations name `public.*`.
- **Measured locally:** `pg_trgm` and `unaccent` are *trusted*, but `vector` (pgvector 0.8.6) is
  **not**. Kept's own `kept_owner` can create the first two. `vector` always needs the provider's admin
  role. In a scratch database a CREATEROLE/CREATEDB non-superuser got
  `ERROR: permission denied to create extension "vector"` / `HINT: Must be superuser to create this extension.`
  So the managed-Postgres SQL is run **by the provider's admin user**, not by `kept_owner`.

## What Kept needs (read from the repo)

- **Extensions:** `CREATE EXTENSION IF NOT EXISTS pg_trgm; unaccent; vector;` (in
  `docker/initdb-prod/01-roles.sh` lines 38–40 and `docker/initdb/01-roles.sql`). No migration
  creates an extension; migrations only use them, schema-qualified as `public.unaccent(...)`
  (`0012_inventory_foundations.sql` line 58) and `public.gin_trgm_ops` (`0014`, `0016`). The
  `vector` type is used unqualified (`0075_embeddings.sql` line 21). So the extensions must live in
  `public`.
- **Roles:** four logins (`kept_owner`, `kept_app`, `kept_auth`, `kept_system`), all `NOSUPERUSER
  NOCREATEROLE NOCREATEDB NOBYPASSRLS`. Also `ALTER ROLE kept_app SET statement_timeout = '15s'` and
  `idle_in_transaction_session_timeout = '30s'`, `ALTER DATABASE … OWNER TO kept_owner` and
  `ALTER SCHEMA public OWNER TO kept_owner` (`01-roles.sh` lines 28–41; engineering spec §7.1).
- **PostgreSQL 18:** the image ships `postgresql-client-18` (Dockerfile line 79) and the stack is
  Postgres 18 (D186).

## T19's provider table

| Provider | PostgreSQL 18 | Who can create extensions | `pg_trgm` / `unaccent` / `vector` on 18 | Allow-list step | Pages read (2026-10-06) |
|---|---|---|---|---|---|
| **AWS RDS for PostgreSQL** | **Yes, GA**: RDS release 14 Nov 2025; minors 18.1–18.6 listed, 18.6 released 25 Aug 2026 | Master user, which has `CREATE EXTENSION` and the `RDS_SUPERUSER` role. Since v13, any role with `CREATE` on the database can create *trusted* extensions, and `pg_trgm` and `unaccent` are on RDS's trusted list. `vector` isn't, so the master user creates it | 1.6 / 1.1 / 0.8.2 (18.3–18.6; 0.8.1 on 18.1–18.2) | None by default: `rds.allowed_extensions` defaults to `*`. If an admin has narrowed it, all three must be listed | https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html · https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Extensions.html · https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.Extensions.html · https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html · https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.MasterAccounts.html |
| **Google Cloud SQL** | **Yes, GA, and the default**: "PostgreSQL 18 (default) \| 18.6 \| September 25, 2025" | "Extensions can only be created by users that are part of the `cloudsqlsuperuser` role." The default `postgres` user is a member | 1.6 (14+) / 1.1 / 0.8.5 ("PostgreSQL versions 13 and later") | None | https://docs.cloud.google.com/sql/docs/postgres/db-versions · https://docs.cloud.google.com/sql/docs/postgres/extensions |
| **Azure Database for PostgreSQL flexible server** | **Yes, GA**: "The current minor release is 18.6". Noted limits: some extensions aren't supported on 18, and `io_method = io_uring` can't be set | Server admin: "NOSUPERUSER, INHERIT, CREATEDB, CREATEROLE", a member of `azure_pg_admin`. "To create untrusted extensions, you must be a member of the `azure_pg_admin` role. Any user with `CREATE` privilege can create any trusted extension listed in `azure.extensions`" | 1.6 / 1.1 / 0.8.2 | **Yes**: add `pg_trgm,unaccent,vector` to the `azure.extensions` server parameter (Portal → Parameters, or `az postgres flexible-server parameter set --name azure.extensions --value "…"`) before `CREATE EXTENSION`. None of the three needs `shared_preload_libraries` (none is starred in the version list) | https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-supported-versions · https://learn.microsoft.com/en-us/azure/postgresql/extensions/how-to-create-extensions · https://learn.microsoft.com/en-us/azure/postgresql/extensions/how-to-allow-extensions · https://learn.microsoft.com/en-us/azure/postgresql/extensions/concepts-extensions-versions · https://learn.microsoft.com/en-us/azure/postgresql/security/security-manage-database-users |
| **DigitalOcean Managed PostgreSQL** | **Yes**: "We currently support PostgreSQL major versions 14, 15, 16, 17, and 18 on Standard Edition clusters"; "Advanced Edition supports v16, v17, and v18 and defaults to v18". No preview wording | `doadmin`: "Create role, Create DB, Replication, Bypass RLS"; "Managed PostgreSQL does not allow superuser access". To enable pgvector: "Use a database role with permission to enable extensions. The `doadmin` user has this permission by default." | **Standard:** all three listed for 18. **Advanced:** only `vector` (with `pg_repack`, `pg_stat_statements`, `pgaudit`, `plpgsql`) pre-installed, and "You can't install additional extensions on Advanced Edition clusters with `CREATE EXTENSION`" | None on Standard. **Advanced Edition is unsupported for Kept** | https://docs.digitalocean.com/products/databases/postgresql/how-to/create/ · https://docs.digitalocean.com/products/databases/postgresql/details/supported-extensions/ · https://docs.digitalocean.com/products/databases/postgresql/how-to/modify-user-privileges/ · https://docs.digitalocean.com/products/vector-databases/postgresql/how-to/enable-pgvector/ |
| **Supabase** | **No.** I found no Supabase documentation page listing 18 for hosted projects. A Supabase maintainer wrote on 4 May 2026: "For CLI & self-hosted we have to wait for the Postgres team to work on Pg 18 and add it to the platform first. My understanding would be - it's not very soon, but eventually in 2026." | `postgres` is not a superuser: "Superuser access is not given as it allows destructive operations to be performed on the database." A web-search snippet said creation is gated by `supautils.privileged_extensions`. I didn't find that on any page I read, so it is unverified | All three are offered; its pgvector page shows `create extension vector with schema extensions;`. "Most extensions are installed under the `extensions` schema", which conflicts with Kept's `public.` references | n/a (no 18) | https://github.com/orgs/supabase/discussions/42681 · https://supabase.com/docs/guides/platform/upgrading (says nothing about 18) · https://supabase.com/docs/guides/database/extensions · https://supabase.com/docs/guides/database/extensions/pgvector · https://supabase.com/docs/guides/database/postgres/roles-superuser |
| **Neon** | **Yes, GA**: "Neon runs the latest community minor release for every supported major version: 18.6, …"; no preview label | Console/API-created roles, including the project's own role, are members of `neon_superuser` (`CREATEDB`, `CREATEROLE`, `BYPASSRLS`, `pg_read_all_data`, `pg_write_all_data`, …). "Unless otherwise noted, supported extensions can be installed using CREATE EXTENSION syntax" | 1.6 / 1.1 / 0.8.6 | None | https://neon.com/docs/postgresql/postgres-version-support · https://neon.com/docs/extensions/pg-extensions · https://neon.com/docs/manage/roles |

The Supabase row's version answer comes from a Supabase-org GitHub discussion, not a docs page. No
docs page read today says 18 is offered.

## The local measurement (the role SQL, as a non-superuser admin would run it)

On Kept's dev database (`pgvector/pgvector:0.8.6-pg18-bookworm`, PostgreSQL 18.6) I created a
scratch role `v31_admin LOGIN NOSUPERUSER CREATEROLE CREATEDB NOBYPASSRLS`, the attribute set Azure
documents for its admin, and ran the SQL as that role through `SET ROLE`. Scratch database
`v31_kept` and roles `v31_*` were dropped afterwards (0 left).

| Step (as `v31_admin`) | Result |
|---|---|
| `pg_available_extension_versions` | `pg_trgm 1.6 trusted=t`, `unaccent 1.1 trusted=t`, **`vector 0.8.6 trusted=f`** |
| `CREATE DATABASE v31_kept TEMPLATE template0` | ok |
| `CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent;` | ok (owner `v31_admin`) |
| `CREATE EXTENSION vector;` | **ERROR: permission denied to create extension "vector". HINT: Must be superuser to create this extension.** (A provider's admin role is what makes it work there.) |
| `CREATE ROLE v31_owner/v31_app … NOBYPASSRLS`; `ALTER ROLE v31_app SET statement_timeout …` | ok; `rolconfig` = `{statement_timeout=15s,idle_in_transaction_session_timeout=30s}` |
| `ALTER DATABASE v31_kept OWNER TO v31_owner` before any grant | **ERROR: must be able to SET ROLE "v31_owner"** |
| `GRANT v31_owner TO v31_admin;` then the same `ALTER DATABASE` | ok |
| `ALTER SCHEMA public OWNER TO v31_owner;` then `REVOKE v31_owner FROM v31_admin;` | ok; `public` and the database owned by `v31_owner` |
| A further run of the ownership part of the SQL below (with `GRANT … TO CURRENT_USER` / `REVOKE … FROM CURRENT_USER`, `ON_ERROR_STOP 1`) | every statement ok. Afterwards the admin's only membership in the owner role is the implicit one from creating it: `pg_auth_members` = `admin true / inherit false / set false`, so `pg_has_role(…,'SET')` = f and `'USAGE'` = f |

PostgreSQL 18's own docs explain the `GRANT` step:
- `ALTER DATABASE`: "you must be able to `SET ROLE` to the new owning role, and you must have the
  `CREATEDB` privilege".
- `ALTER SCHEMA`: the same, plus "that role must have the `CREATE` privilege for the database".
- `createrole_self_grant` "defaults to an empty string", so a CREATEROLE non-superuser gets ADMIN
  OPTION on roles it creates but not SET.
- `GRANT`'s SET option "defaults to `TRUE`".

Pages read: https://www.postgresql.org/docs/18/sql-alterdatabase.html ·
https://www.postgresql.org/docs/18/sql-alterschema.html ·
https://www.postgresql.org/docs/18/runtime-config-client.html ·
https://www.postgresql.org/docs/18/sql-grant.html.

**The managed SQL T19 publishes.** It is derived from the run above. Every statement except the `vector`
line ran without error, with scratch names, across the local non-superuser runs above. It has not
been run against any real provider. Run it as the provider's admin user,
connected to the database Kept will use:

```sql
-- As the provider's admin user (RDS master user, Cloud SQL `postgres`, Azure server admin,
-- DigitalOcean `doadmin`, Neon project role). Azure: allow-list pg_trgm,unaccent,vector first.
CREATE ROLE kept_owner  LOGIN PASSWORD '…' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE kept_app    LOGIN PASSWORD '…' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE kept_auth   LOGIN PASSWORD '…' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE kept_system LOGIN PASSWORD '…' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
ALTER ROLE kept_app SET statement_timeout = '15s';
ALTER ROLE kept_app SET idle_in_transaction_session_timeout = '30s';
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector   WITH SCHEMA public;
GRANT kept_owner TO CURRENT_USER;          -- needed to hand ownership over (PG 16+ rules)
ALTER DATABASE <db> OWNER TO kept_owner;
ALTER SCHEMA public OWNER TO kept_owner;
REVOKE kept_owner FROM CURRENT_USER;
```

## Changes to the plan

- **T19:** publish the table above. Kept supports RDS, Cloud SQL, Azure flexible server (allow-list
  first), DigitalOcean **Standard** Edition and Neon. Supabase isn't supported until it offers 18.
  DigitalOcean Advanced Edition isn't supported at all.
- **T19:** publish the SQL above. It must be run **by the provider's admin user** (pgvector 0.8.6's
  `vector` is untrusted), with `WITH SCHEMA public` on each extension, and with the
  `GRANT … TO CURRENT_USER` / `REVOKE` around the ownership changes. Without them a non-superuser
  admin gets "must be able to SET ROLE".
- **T16 (Helm pre-install Job) and Q18:** with a managed database, the "superuser secret" is the
  provider admin's login, not a true superuser. The Job's SQL needs the same `GRANT`/`REVOKE`
  wrapping. `docker/initdb-prod/01-roles.sh` runs as the real superuser and is fine as is.
- **Note for T19:** DigitalOcean's `doadmin` and Neon's `neon_superuser` both have `BYPASSRLS`. Kept
  never connects as them; its four roles are `NOBYPASSRLS`. The docs should say not to point
  `KEPT_DATABASE_URL` at the admin user.

**§19 V31 result line:** *Verified 2026-10-06 (`docs/spikes/2026-10-06-step8-managed-postgres.md`):*
- *Where it works:* PostgreSQL 18 is GA on RDS, Cloud SQL, Azure flexible server, DigitalOcean and
  Neon, and each provider's admin role (RDS master/`rds_superuser`, `cloudsqlsuperuser`,
  `azure_pg_admin` after allow-listing in `azure.extensions`, `doadmin`, `neon_superuser`) can
  create `pg_trgm`, `unaccent` and `vector`.
- *Where it doesn't:* DigitalOcean Advanced Edition can't create extensions. Supabase doesn't offer
  18.
- *The non-superuser case:* `pg_trgm` and `unaccent` are trusted, but `vector` 0.8.6 isn't (measured),
  so a non-superuser such as `kept_owner` can't create it. The documented SQL runs as the provider
  admin and grants itself `kept_owner` around the ownership changes.
