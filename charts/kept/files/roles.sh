#!/usr/bin/env bash
# Kept's four logins and its extensions (D186), for the chart. The same statements as the
# managed-Postgres page's SQL (apps/docs/src/content/docs/install/managed-postgres.md), so they run
# as a superuser (the bundled Postgres, at its first start, from /docker-entrypoint-initdb.d) or
# as a provider's admin (the roles Job, external Postgres with roles.create). Unlike
# docker/initdb-prod/01-roles.sh it is idempotent: a login that exists gets its password reset to
# the secret's, so a re-install over a kept database converges instead of failing.
#
# Connection: libpq's PG* variables (the Job sets PGHOST, PGPORT, PGPASSWORD, PGSSLMODE); unset,
# the local socket (initdb). Passwords reach psql as variables (:'name' quotes them as literals),
# never spliced into SQL text.
set -euo pipefail

: "${KEPT_DB_OWNER_PASSWORD:?KEPT_DB_OWNER_PASSWORD is required}"
: "${KEPT_DB_APP_PASSWORD:?KEPT_DB_APP_PASSWORD is required}"
: "${KEPT_DB_AUTH_PASSWORD:?KEPT_DB_AUTH_PASSWORD is required}"
: "${KEPT_DB_SYSTEM_PASSWORD:?KEPT_DB_SYSTEM_PASSWORD is required}"

db=${POSTGRES_DB:-kept}

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "${POSTGRES_USER:-postgres}" --dbname "$db" \
  -v owner_pw="$KEPT_DB_OWNER_PASSWORD" \
  -v app_pw="$KEPT_DB_APP_PASSWORD" \
  -v auth_pw="$KEPT_DB_AUTH_PASSWORD" \
  -v system_pw="$KEPT_DB_SYSTEM_PASSWORD" \
  -v db="$db" <<'SQL'
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kept_owner')  AS make_owner,
       NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kept_app')    AS make_app,
       NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kept_auth')   AS make_auth,
       NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kept_system') AS make_system
\gset
\if :make_owner
CREATE ROLE kept_owner  LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
\endif
\if :make_app
CREATE ROLE kept_app    LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
\endif
\if :make_auth
CREATE ROLE kept_auth   LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
\endif
\if :make_system
CREATE ROLE kept_system LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
\endif
ALTER ROLE kept_owner  PASSWORD :'owner_pw';
ALTER ROLE kept_app    PASSWORD :'app_pw';
ALTER ROLE kept_auth   PASSWORD :'auth_pw';
ALTER ROLE kept_system PASSWORD :'system_pw';
-- A request can't run away or sit idle inside a transaction.
ALTER ROLE kept_app SET statement_timeout = '15s';
ALTER ROLE kept_app SET idle_in_transaction_session_timeout = '30s';
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector   WITH SCHEMA public;
-- A non-superuser admin may hand ownership to a role only while it is a member of that role.
GRANT kept_owner TO CURRENT_USER;
ALTER DATABASE :"db" OWNER TO kept_owner;
ALTER SCHEMA public OWNER TO kept_owner;
REVOKE kept_owner FROM CURRENT_USER;
SQL
echo "kept: the four logins and the extensions are in place in $db"
