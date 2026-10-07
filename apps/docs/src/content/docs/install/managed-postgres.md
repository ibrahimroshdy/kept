---
title: Managed Postgres
description: Run Kept on a provider's PostgreSQL 18 - which providers work, and the SQL that creates Kept's roles and extensions.
sidebar:
  order: 5
---

Kept can use a managed PostgreSQL instead of the bundled one. It needs **PostgreSQL 18** and three
extensions in the `public` schema: `pg_trgm`, `unaccent` and `vector` (pgvector).

## Which providers work

Read from each provider's documentation on 2026-10-06; none has been run against Kept yet.

| Provider | PostgreSQL 18 | Notes |
|---|---|---|
| AWS RDS for PostgreSQL | yes | The master user creates the extensions. If an admin has narrowed `rds.allowed_extensions`, list all three. |
| Google Cloud SQL | yes | The default `postgres` user (a member of `cloudsqlsuperuser`) creates them. |
| Azure Database for PostgreSQL, flexible server | yes | **Allow-list first:** add `pg_trgm,unaccent,vector` to the `azure.extensions` server parameter, then run the SQL as the server admin. |
| DigitalOcean Managed PostgreSQL | yes | **Standard Edition only**, as `doadmin`. Advanced Edition can't create extensions, so it can't run Kept. |
| Neon | yes | The project's own role (a member of `neon_superuser`) creates them. |
| Supabase | **no** | It doesn't offer PostgreSQL 18, and it puts extensions in an `extensions` schema, not `public`. |

## The SQL

`pg_trgm` and `unaccent` are trusted extensions, but pgvector's `vector` is not, so a plain
non-superuser can't create it. Run this **as the provider's admin user**, connected to the database
Kept will use, with your own passwords in place of `…` and the database's name in place of
`<database>`:

```sql
-- Azure: allow-list pg_trgm,unaccent,vector in azure.extensions first.
CREATE ROLE kept_owner  LOGIN PASSWORD '…' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE kept_app    LOGIN PASSWORD '…' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE kept_auth   LOGIN PASSWORD '…' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE kept_system LOGIN PASSWORD '…' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
-- A request can't run away or sit idle inside a transaction.
ALTER ROLE kept_app SET statement_timeout = '15s';
ALTER ROLE kept_app SET idle_in_transaction_session_timeout = '30s';
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector   WITH SCHEMA public;
-- A non-superuser admin may hand ownership to a role only while it is a member of that role.
GRANT kept_owner TO CURRENT_USER;
ALTER DATABASE <database> OWNER TO kept_owner;
ALTER SCHEMA public OWNER TO kept_owner;
REVOKE kept_owner FROM CURRENT_USER;
```

Every statement was run locally on PostgreSQL 18.6 as a non-superuser with the attributes Azure
documents for its admin; only `CREATE EXTENSION vector` needed more, which is what the provider's
admin role gives.

The two timeouts on `kept_app` matter: Kept's own Compose setup sets the same, and its migrations
can't (the owner role may not change other roles).

## The four logins

| Variable | Login | Used for |
|---|---|---|
| `KEPT_DATABASE_URL` | `kept_app` | every request, under row-level security |
| `KEPT_AUTH_DATABASE_URL` | `kept_auth` | sign-in |
| `KEPT_SYSTEM_DATABASE_URL` | `kept_system` | background jobs and first-run setup |
| `KEPT_OWNER_DATABASE_URL` | `kept_owner` | `kept migrate`, `kept admin`, and the backup's dump |

**Never point any of them at the provider's admin user.** Several providers give it `BYPASSRLS`
(DigitalOcean's `doadmin`, Neon's `neon_superuser`), which would switch off the row-level security
that keeps one household's data from another's. Kept's four roles are all `NOBYPASSRLS`.

Most providers require TLS: add the `sslmode` their documentation gives to each URL.
