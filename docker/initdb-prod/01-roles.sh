#!/usr/bin/env bash
# Kept's production database bootstrap (D186), run once by the pgvector/postgres image's
# entrypoint when the data directory is empty (compose.yaml mounts this directory at
# /docker-entrypoint-initdb.d).
#
# It creates the four logins and the extensions. Everything else (schemas, tables, grants,
# policies) is `kept migrate`'s job, as kept_owner. Passwords come from the environment and are
# passed to psql as variables (:'name' quotes them as SQL literals), so no password is ever
# spliced into SQL text or written to a file. They are required: an unset one stops the init.
#
# Unlike docker/initdb/01-roles.sql (dev), kept_owner gets no CREATEDB: that is for the test
# suite's per-worker databases only.
set -euo pipefail

: "${KEPT_DB_OWNER_PASSWORD:?KEPT_DB_OWNER_PASSWORD is required}"
: "${KEPT_DB_APP_PASSWORD:?KEPT_DB_APP_PASSWORD is required}"
: "${KEPT_DB_AUTH_PASSWORD:?KEPT_DB_AUTH_PASSWORD is required}"
: "${KEPT_DB_SYSTEM_PASSWORD:?KEPT_DB_SYSTEM_PASSWORD is required}"

db=${POSTGRES_DB:-kept}

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
  -v owner_pw="$KEPT_DB_OWNER_PASSWORD" \
  -v app_pw="$KEPT_DB_APP_PASSWORD" \
  -v auth_pw="$KEPT_DB_AUTH_PASSWORD" \
  -v system_pw="$KEPT_DB_SYSTEM_PASSWORD" \
  -v db="$db" <<'SQL'
CREATE ROLE kept_owner  LOGIN PASSWORD :'owner_pw'  NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE kept_app    LOGIN PASSWORD :'app_pw'    NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE kept_auth   LOGIN PASSWORD :'auth_pw'   NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
CREATE ROLE kept_system LOGIN PASSWORD :'system_pw' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
-- Request connections can't run away or idle inside a transaction. kept_owner can't set these
-- from a migration (no CREATEROLE), so they live with the roles, as in docker/initdb (dev).
ALTER ROLE kept_app SET statement_timeout = '15s';
ALTER ROLE kept_app SET idle_in_transaction_session_timeout = '30s';

ALTER DATABASE :"db" OWNER TO kept_owner;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO kept_owner;
SQL
