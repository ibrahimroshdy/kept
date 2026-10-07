-- Dev only. Passwords are dev values; never used outside compose.dev.yaml.
CREATE ROLE kept_owner  LOGIN PASSWORD 'kept_owner'  NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE kept_app    LOGIN PASSWORD 'kept_app'    NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE kept_auth   LOGIN PASSWORD 'kept_auth'   NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE kept_system LOGIN PASSWORD 'kept_system' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
-- Request connections can't run away or idle inside a transaction (RLS review; the pool sets
-- the same, apps/server/src/db/pools.ts APP_TIMEOUTS). kept_owner can't set these from a
-- migration (it has no CREATEROLE), so they live with the roles, here and in the managed-Postgres SQL.
ALTER ROLE kept_app SET statement_timeout = '15s';
ALTER ROLE kept_app SET idle_in_transaction_session_timeout = '30s';
-- Tests create a database per worker from a template; only the owner needs CREATEDB, and only in dev.
ALTER ROLE kept_owner CREATEDB;
ALTER DATABASE kept OWNER TO kept_owner;

\connect kept
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO kept_owner;
-- Privileges on schema public (REVOKE from PUBLIC, USAGE for kept_app/kept_system) and on
-- functions are set by migration 0000, so cloned test databases and managed Postgres get them
-- too. The migrations create schemas kept, auth and pgboss as kept_owner.

-- Extensions are also created in template1, so every cloned test database has them.
\connect template1
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;
