-- Custom SQL migration file, put your code below! --
-- Runs as kept_owner, which must own the database (it does in dev, in the test clones and on
-- managed Postgres). Nothing here relies on docker/initdb, so every database gets the same
-- privileges whichever way it was created.

-- Schema public: no CREATE (or anything else) for PUBLIC; the runtime roles that read tables
-- there get USAGE explicitly. kept_auth lives in schema auth and gets nothing here.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kept_app, kept_system;

-- Functions kept_owner creates, in any schema, are not executable by PUBLIC: each schema's
-- grants below (and pgboss's, in jobs/install.ts) name the roles that may call them.
ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS kept; -- functions
CREATE SCHEMA IF NOT EXISTS auth; -- Better Auth tables
-- Schema kept: kept_app and kept_system only. kept_auth (Better Auth) needs nothing outside
-- schema auth, so it can't even resolve names in kept (Phase B review, item 3).
GRANT USAGE ON SCHEMA kept TO kept_app, kept_system;
GRANT USAGE, CREATE ON SCHEMA auth TO kept_owner;
GRANT USAGE ON SCHEMA auth TO kept_auth;
ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kept_app, kept_system;
ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kept_app, kept_system;
ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kept_auth;
ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA kept
  GRANT EXECUTE ON FUNCTIONS TO kept_app, kept_system;
CREATE SEQUENCE IF NOT EXISTS kept.change_seq;
GRANT USAGE ON SEQUENCE kept.change_seq TO kept_app, kept_system;

-- Row bookkeeping for every mutable table (§1, §7.4). Cache columns are excluded by the caller.
CREATE FUNCTION kept.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.change_seq := nextval('kept.change_seq');
  IF TG_OP = 'UPDATE' THEN
    NEW.row_version := OLD.row_version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION kept.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION kept.current_mfa() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.mfa', true), '') = 'true' $$;

-- Belt and braces for the functions above: PUBLIC loses EXECUTE even if the default privilege
-- was not in effect when they were created; kept_app and kept_system (not kept_auth) get it.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kept FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kept TO kept_app, kept_system;
