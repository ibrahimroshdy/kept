-- Custom SQL migration file, put your code below! --
-- Row-level security (engineering spec §1.1, §7.1, §7.2, §7.14; D178, D183, D190).
--
-- How it fits together:
-- - Every table in public has RLS ENABLEd and FORCEd (FORCE: the table owner, kept_owner, is
--   held to policies too, and reaches rows through its own `owner_all` policy).
-- - kept_app reaches rows only through the policies below, which read the request's user from
--   `app.user_id` (set by withScope(), db/scope.ts). Unset, kept.current_user_id() is NULL,
--   every membership function returns nothing, and every policy denies: fail closed.
-- - kept_system has `system_*` policies only on the tables its step-1 jobs need (membership
--   expiry, the orphaned-user repair, the setup code, audit). Any other table shows it nothing.
-- - What a policy can't express goes through a SECURITY DEFINER function in section 5 (joining
--   by invite, managed accounts, deleting and restoring a location, owner-only settings): each
--   checks its caller itself and does one thing. test/leak.test.ts lists every one.
-- - kept_auth has no USAGE on schema public at all (0000).
-- - Policies call the membership functions as `IN (SELECT kept.f())` / `= (SELECT kept.f())`,
--   so Postgres evaluates each once per statement (an initPlan), not once per row.
-- - The functions are SECURITY DEFINER, owned by kept_owner, with a fixed search_path: they
--   read memberships and locations past those tables' own policies, which also avoids a policy
--   on memberships recursing into memberships (§7.2).
-- Catalogue-wide guarantees are tested in test/leak.test.ts; behaviour in src/db/rls.test.ts.

-- ---------------------------------------------------------------------------------------------
-- 1. Membership functions
-- ---------------------------------------------------------------------------------------------

-- Locations the user may read: active (unexpired) memberships, not in the deletion grace period
-- (D149), and not require_2fa unless this session passed a second factor (§7.14).
CREATE FUNCTION kept.visible_location_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.location_id FROM public.memberships m
  JOIN public.locations l ON l.id = m.location_id
  WHERE m.user_id = kept.current_user_id()
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND l.deleted_at IS NULL
    AND (NOT l.require_2fa OR kept.current_mfa())
$$;

-- ...and may write: the same, minus viewers (defence in depth; can() holds the finer rules).
CREATE FUNCTION kept.writable_location_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.location_id FROM public.memberships m
  JOIN public.locations l ON l.id = m.location_id
  WHERE m.user_id = kept.current_user_id()
    AND m.role IN ('owner', 'admin', 'member')
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND l.deleted_at IS NULL
    AND (NOT l.require_2fa OR kept.current_mfa())
$$;

-- ...and administer: owners and admins. The plan's draft joined writable_location_ids() back to
-- memberships through a column that set doesn't have; this states the same rule directly.
CREATE FUNCTION kept.admin_location_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.location_id FROM public.memberships m
  JOIN public.locations l ON l.id = m.location_id
  WHERE m.user_id = kept.current_user_id()
    AND m.role IN ('owner', 'admin')
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND l.deleted_at IS NULL
    AND (NOT l.require_2fa OR kept.current_mfa())
$$;

CREATE FUNCTION kept.current_owner_account_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT oa.id FROM public.owner_accounts oa WHERE oa.user_id = kept.current_user_id()
$$;

CREATE FUNCTION kept.is_instance_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.instance_admins ia WHERE ia.user_id = kept.current_user_id()
  )
$$;

-- Whether the user's own account owns `loc`. The owner-membership INSERT policy needs this for
-- a location created a statement earlier in the same transaction (ensureAccount, §7.14): that
-- location isn't visible yet, so a subselect under the locations SELECT policy would miss it.
CREATE FUNCTION kept.owns_location(loc uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.locations l
    JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
    WHERE l.id = loc AND oa.user_id = kept.current_user_id() AND l.deleted_at IS NULL
  )
$$;

-- Users who share a visible location with the current user (their profiles are readable).
CREATE FUNCTION kept.fellow_member_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT m.user_id FROM public.memberships m
  WHERE m.location_id IN (SELECT kept.visible_location_ids())
$$;

-- Only kept_app evaluates these (its policies call them). kept_system has no user scope and its
-- policies don't use them; 0000's default privileges granted it EXECUTE, so take that back.
REVOKE EXECUTE ON FUNCTION
  kept.visible_location_ids(), kept.writable_location_ids(), kept.admin_location_ids(),
  kept.current_owner_account_id(), kept.is_instance_admin(), kept.owns_location(uuid),
  kept.fellow_member_ids()
  FROM PUBLIC, kept_system;
GRANT EXECUTE ON FUNCTION
  kept.visible_location_ids(), kept.writable_location_ids(), kept.admin_location_ids(),
  kept.current_owner_account_id(), kept.is_instance_admin(), kept.owns_location(uuid),
  kept.fellow_member_ids()
  TO kept_app;

-- ---------------------------------------------------------------------------------------------
-- 2. Enable and force RLS, with kept_owner's own policy, on every table
-- ---------------------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'currencies', 'user_profiles', 'owner_accounts', 'locations', 'location_modules',
    'user_hidden_modules', 'memberships', 'invites', 'instance_settings', 'instance_admins',
    'idempotency_keys', 'sync_tombstones', 'places', 'audit_events', 'audit_event_subjects'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. kept_app
-- ---------------------------------------------------------------------------------------------

-- Reference data.
CREATE POLICY app_select ON public.currencies FOR SELECT TO kept_app USING (true);

-- locations: read if visible; create only under the user's own owner account; update if
-- owner/admin, and only the columns granted below. No DELETE: deletion is a soft `deleted_at`,
-- set and cleared only by kept.delete_location() / kept.restore_location() (section 5).
CREATE POLICY app_select ON public.locations FOR SELECT TO kept_app
  USING (id IN (SELECT kept.visible_location_ids()));
CREATE POLICY app_insert ON public.locations FOR INSERT TO kept_app
  WITH CHECK (owner_account_id = (SELECT kept.current_owner_account_id()));
CREATE POLICY app_update ON public.locations FOR UPDATE TO kept_app
  USING (id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (id IN (SELECT kept.admin_location_ids()));

-- Location-scoped rows: read if visible, write if writable (viewers can't).
CREATE POLICY app_select ON public.places FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
CREATE POLICY app_insert ON public.places FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
CREATE POLICY app_update ON public.places FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
CREATE POLICY app_delete ON public.places FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));

CREATE POLICY app_select ON public.location_modules FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
CREATE POLICY app_insert ON public.location_modules FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
CREATE POLICY app_update ON public.location_modules FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
CREATE POLICY app_delete ON public.location_modules FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));

CREATE POLICY app_select ON public.sync_tombstones FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
CREATE POLICY app_insert ON public.sync_tombstones FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
CREATE POLICY app_update ON public.sync_tombstones FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
CREATE POLICY app_delete ON public.sync_tombstones FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));

-- memberships: members of a location see its memberships. Owners and admins manage them, but
-- never an `owner` row: through kept_app nobody can demote, remove, expire or replace the
-- owner, and nobody can make themselves owner. Nor their own row: an admin can't lift their own
-- expiry (RLS review #4).
-- The only direct INSERT creates a location's owner membership, for the user whose own account
-- owns it (ensureAccount; creating a location). Everyone else joins through a definer that
-- inserts only for a checked user: kept.accept_invite() (the accepter themselves) or
-- kept.add_managed_member() (D47). An admin inserting a membership for any user id they liked
-- could read that user's profile before rolling back, and its foreign-key error told which ids
-- are users (RLS review #1).
-- Transferring ownership is a later, deliberate path (a definer function), not an UPDATE.
CREATE POLICY app_select ON public.memberships FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
CREATE POLICY app_insert ON public.memberships FOR INSERT TO kept_app
  WITH CHECK (
    role = 'owner'
    AND user_id = (SELECT kept.current_user_id())
    AND invited_by IS NULL
    AND kept.owns_location(location_id)
  );
CREATE POLICY app_update ON public.memberships FOR UPDATE TO kept_app
  USING (role <> 'owner' AND user_id <> (SELECT kept.current_user_id())
         AND location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (role <> 'owner' AND user_id <> (SELECT kept.current_user_id())
              AND location_id IN (SELECT kept.admin_location_ids()));
CREATE POLICY app_delete ON public.memberships FOR DELETE TO kept_app
  USING (role <> 'owner' AND location_id IN (SELECT kept.admin_location_ids()));

-- invites: owners and admins of the location. A new invite is the inserting admin's own and
-- unaccepted: accepting is kept.accept_invite()'s job, and it trusts `created_by` (D48, D180).
CREATE POLICY app_select ON public.invites FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
CREATE POLICY app_insert ON public.invites FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND created_by = (SELECT kept.current_user_id())
              AND accepted_by IS NULL AND accepted_at IS NULL);
CREATE POLICY app_update ON public.invites FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()));
CREATE POLICY app_delete ON public.invites FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));

-- user_profiles: the user's own (no DELETE: it goes with the auth user), plus read-only
-- profiles of fellow members. A user's own profile is never managed: managed profiles are made
-- by kept.create_managed_profile(), which records who made them (D47).
CREATE POLICY app_select_own ON public.user_profiles FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
CREATE POLICY app_insert_own ON public.user_profiles FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND NOT managed AND created_by_user_id IS NULL);
CREATE POLICY app_update_own ON public.user_profiles FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()))
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
CREATE POLICY app_select_fellows ON public.user_profiles FOR SELECT TO kept_app
  USING (user_id IN (SELECT kept.fellow_member_ids()));

-- owner_accounts: the user's own, read and create.
CREATE POLICY app_select ON public.owner_accounts FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
CREATE POLICY app_insert ON public.owner_accounts FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id()));

-- user_hidden_modules: the user's own, for locations they can see.
CREATE POLICY app_all ON public.user_hidden_modules FOR ALL TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
         AND location_id IN (SELECT kept.visible_location_ids()))
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND location_id IN (SELECT kept.visible_location_ids()));

-- idempotency_keys: the user's own (§7.13).
CREATE POLICY app_all ON public.idempotency_keys FOR ALL TO kept_app
  USING (user_id = (SELECT kept.current_user_id()))
  WITH CHECK (user_id = (SELECT kept.current_user_id()));

-- Instance scope (§7.14, D190): instance-admin routes run on kept_app behind
-- kept.is_instance_admin(). A user may also read their own instance_admins row.
CREATE POLICY app_admin ON public.instance_settings FOR ALL TO kept_app
  USING ((SELECT kept.is_instance_admin()))
  WITH CHECK ((SELECT kept.is_instance_admin()));
CREATE POLICY app_admin ON public.instance_admins FOR ALL TO kept_app
  USING ((SELECT kept.is_instance_admin()))
  WITH CHECK ((SELECT kept.is_instance_admin()));
CREATE POLICY app_select_own ON public.instance_admins FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));

-- audit_events: append-only for kept_app. Read a visible location's events, or the user's own
-- account-level events. Write only as the scoped user themselves (actor_type 'user', actor_id
-- the session's user: RLS review #3), and only: events of a visible location (viewers generate
-- some, e.g. reveals) whose owner_account_id, if set, is that location's; account-level events
-- for the user's own account; or, for instance admins, instance-level events (neither set;
-- kept_app never reads those back). Undo fields are held to their window by a trigger (0005).
-- System, import and token actors write through kept_system or later paths, not here.
CREATE POLICY app_select ON public.audit_events FOR SELECT TO kept_app
  USING (
    location_id IN (SELECT kept.visible_location_ids())
    OR (location_id IS NULL
        AND owner_account_id = (SELECT kept.current_owner_account_id()))
  );
CREATE POLICY app_insert ON public.audit_events FOR INSERT TO kept_app
  WITH CHECK (
    actor_type = 'user'
    AND actor_id = (SELECT kept.current_user_id())
    AND (
      (location_id IN (SELECT kept.visible_location_ids())
       AND (owner_account_id IS NULL
            OR owner_account_id = (SELECT l.owner_account_id FROM public.locations l
                                    WHERE l.id = audit_events.location_id)))
      OR (location_id IS NULL
          AND owner_account_id = (SELECT kept.current_owner_account_id()))
      OR (location_id IS NULL AND owner_account_id IS NULL
          AND (SELECT kept.is_instance_admin()))
    )
  );

-- The policy's account-level branch, indexed (in the Drizzle schema, schema/audit.ts).
CREATE INDEX "audit_events_account_at_idx" ON "audit_events" USING btree ("owner_account_id","at" DESC NULLS LAST) WHERE location_id IS NULL;

-- audit_event_subjects carry their event's location_id (a composite FK keeps them equal), and
-- kept_app adds them only to an event the same user wrote (audited() writes both in one
-- transaction), so nobody fans their own subjects out of someone else's event.
CREATE POLICY app_select ON public.audit_event_subjects FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
CREATE POLICY app_insert ON public.audit_event_subjects FOR INSERT TO kept_app
  WITH CHECK (
    location_id IN (SELECT kept.visible_location_ids())
    AND EXISTS (
      SELECT 1 FROM public.audit_events e
       WHERE e.id = audit_event_subjects.event_id AND e.at = audit_event_subjects.event_at
         AND e.actor_type = 'user' AND e.actor_id = (SELECT kept.current_user_id())
    )
  );

-- Column grants: RLS decides which rows kept_app may update; these decide which columns
-- (RLS review #5). No table grants UPDATE on a row's id, its primary key, or its scope
-- (location_id, owner_account_id, user_id): changing one would move the row to another tenant,
-- with its subtree through ON UPDATE CASCADE, for anyone who could write both. The leak test
-- checks this for every table. Beyond that:
-- - locations.owner_account_id: ownership moves only through a deliberate transfer path.
-- - locations.require_2fa, successor_user_id, deleted_at, purge_after: the owner's alone
--   (D149, D165, §7.14), through the definers in section 5; an admin could otherwise name
--   themselves successor, or delete the location out from under its owner.
-- - memberships.invited_by, invites.created_by / accepted_*: who invited whom is recorded by
--   the insert (or kept.accept_invite()), never edited.
-- - user_profiles.managed / created_by_user_id: set when a managed account is created (D47),
--   never by its user.
-- - places.is_unplaced: fixed at creation (D118).
-- - audit tables: append-only; the instance-admin and reference tables need no updates here.
-- A column added later is not updatable by kept_app until it is granted here (or in the
-- migration that adds it).
REVOKE UPDATE ON ALL TABLES IN SCHEMA public FROM kept_app;
GRANT UPDATE (kind, name, timezone, currency, languages, address, latitude, longitude,
              suggest_radius_m, preset, money_visible_to_viewers, long_unseen_months,
              updated_at, row_version)
  ON public.locations TO kept_app;
GRANT UPDATE (role, expires_at, updated_at, row_version)
  ON public.memberships TO kept_app;
GRANT UPDATE (display_name, timezone, locale, units, theme, digits, suggest_location,
              digest_time, quiet_from, quiet_to, updated_at, row_version)
  ON public.user_profiles TO kept_app;
GRANT UPDATE (parent_id, name, kind_key, deleted_at, updated_at, row_version)
  ON public.places TO kept_app;
GRANT UPDATE (enabled, enabled_at, updated_at, row_version)
  ON public.location_modules TO kept_app;
GRANT UPDATE (role, membership_expires_at, email, expires_at, updated_at, row_version)
  ON public.invites TO kept_app;
GRANT UPDATE (updated_at, row_version) ON public.sync_tombstones TO kept_app;
GRANT UPDATE (response) ON public.idempotency_keys TO kept_app;
GRANT UPDATE (value, updated_at, row_version) ON public.instance_settings TO kept_app;

-- ---------------------------------------------------------------------------------------------
-- 4. kept_system: only the tables the step-1 jobs need (§7.1). Handlers re-derive scope from
--    the database, never from job data (jobs/boss.ts).
-- ---------------------------------------------------------------------------------------------

CREATE POLICY system_all ON public.memberships FOR ALL TO kept_system USING (true) WITH CHECK (true);
CREATE POLICY system_all ON public.owner_accounts FOR ALL TO kept_system USING (true) WITH CHECK (true);
CREATE POLICY system_all ON public.user_profiles FOR ALL TO kept_system USING (true) WITH CHECK (true);
CREATE POLICY system_all ON public.instance_settings FOR ALL TO kept_system USING (true) WITH CHECK (true);
-- Audit rows are never changed, by anyone but kept_owner: kept_system reads them, writes system
-- events, and deletes them for retention.
CREATE POLICY system_select ON public.audit_events FOR SELECT TO kept_system USING (true);
CREATE POLICY system_insert ON public.audit_events FOR INSERT TO kept_system WITH CHECK (true);
CREATE POLICY system_delete ON public.audit_events FOR DELETE TO kept_system USING (true);
REVOKE UPDATE ON public.audit_events FROM kept_system;

-- ---------------------------------------------------------------------------------------------
-- 5. Paths past the policies (RLS review #1, #4; D46, D47, D48, D149, D165, D180)
--
-- Each is SECURITY DEFINER, owned by kept_owner, with a fixed search_path and schema-qualified
-- names; each checks its caller from app.user_id itself, does one thing, and returns no more
-- than its caller may know. Refusals are 42501 (a 404, like any row the caller can't see).
-- None writes an audit event: the route calls audited() in the same transaction, before
-- delete_location() (afterwards the location is no longer visible, so its event would be
-- refused) and after restore_location().
-- ---------------------------------------------------------------------------------------------

-- Joins the signed-in user to an invite's location (task 20, D33), consuming the invite. The
-- invite must be unexpired, unaccepted, for a live location, and still backed by its creator:
-- an unexpired owner or admin of that location, and the owner if it makes an admin (D48). An
-- email invite needs the accepter's verified address to match (§7.10). The membership gets the
-- invite's role and expiry, never later than the creator's own (D180), and is the accepter's
-- own: nobody else can be added this way. Any failure is the same `invite_invalid`, whatever
-- the reason. Returns the location's id.
CREATE FUNCTION kept.accept_invite(p_token_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  inv record;
  creator record;
  until timestamptz;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'accepting an invite needs a signed-in user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT i.id, i.location_id, i.role, i.membership_expires_at, i.email, i.created_by INTO inv
    FROM public.invites i JOIN public.locations l ON l.id = i.location_id
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL AND i.expires_at > now() AND l.deleted_at IS NULL
     FOR UPDATE OF i;
  -- No invite leaves `inv` all NULL, and then this finds no creator either.
  SELECT m.role, m.expires_at INTO creator FROM public.memberships m
   WHERE m.location_id = inv.location_id AND m.user_id = inv.created_by
     AND m.role IN ('owner', 'admin') AND (m.expires_at IS NULL OR m.expires_at > now());
  until := least(inv.membership_expires_at, creator.expires_at);
  IF inv.id IS NULL OR creator.role IS NULL
     OR (inv.role = 'admin' AND creator.role <> 'owner')
     OR (until IS NOT NULL AND until <= now())
     OR (inv.email IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM auth."user" u
            WHERE u.id = uid AND u.email_verified AND lower(u.email) = lower(inv.email))) THEN
    RAISE EXCEPTION 'the invite is not valid'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'invite_invalid';
  END IF;
  INSERT INTO public.memberships (location_id, user_id, role, expires_at, invited_by)
  VALUES (inv.location_id, uid, inv.role, until, inv.created_by);
  UPDATE public.invites SET accepted_by = uid, accepted_at = now() WHERE id = inv.id;
  RETURN inv.location_id;
END $$;

-- The public invite page (task 20): the location's name, the role, and the inviter's display
-- name, for an invite accept_invite() could still take (its email binding aside). Nothing for
-- anything else. Needs no user scope: holding the token is the permission.
CREATE FUNCTION kept.invite_preview(p_token_hash text)
RETURNS TABLE (location_name text, role text, inviter_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT l.name, i.role, p.display_name
    FROM public.invites i
    JOIN public.locations l ON l.id = i.location_id
    JOIN public.memberships m
      ON m.location_id = i.location_id AND m.user_id = i.created_by
     AND m.role IN ('owner', 'admin') AND (m.expires_at IS NULL OR m.expires_at > now())
    LEFT JOIN public.user_profiles p ON p.user_id = i.created_by
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL AND i.expires_at > now() AND l.deleted_at IS NULL
     AND (i.role <> 'admin' OR m.role = 'owner')
$$;

-- The profile of a managed account (task 21, D47), right after Better Auth created its user.
-- Only for a user with Kept's synthetic `@managed.invalid` address (auth/emails.ts), so no real
-- person's account can be claimed; only by someone who administers a location; marked managed
-- and made by the caller, which is what add_managed_member() trusts. Once: a second call hits
-- the primary key.
CREATE FUNCTION kept.create_managed_profile(p_user_id uuid, p_display_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
BEGIN
  IF uid IS NULL OR NOT EXISTS (SELECT 1 FROM kept.admin_location_ids())
     OR NOT EXISTS (SELECT 1 FROM auth."user" u
                     WHERE u.id = p_user_id AND lower(u.email) LIKE '%@managed.invalid') THEN
    RAISE EXCEPTION 'not a managed account this user may create'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.user_profiles (user_id, display_name, managed, created_by_user_id)
  VALUES (p_user_id, p_display_name, true, uid);
END $$;

-- Adds a managed account to a location (task 21, D47). The caller must be an unexpired owner or
-- admin of the location; the account must be managed, and either made by the caller or already
-- a member of a live location the caller owns. `admin` only from the owner (D48), never
-- `owner`; the expiry never later than the caller's own (D180). Returns the membership's id.
CREATE FUNCTION kept.add_managed_member(
  p_location_id uuid, p_user_id uuid, p_role text, p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  caller record;
  mid uuid := uuidv7();
BEGIN
  SELECT m.role, m.expires_at INTO caller FROM public.memberships m
   WHERE m.location_id = p_location_id AND m.user_id = uid
     AND p_location_id IN (SELECT kept.admin_location_ids());
  IF caller.role IS NULL
     OR p_role = 'owner' OR (p_role = 'admin' AND caller.role <> 'owner')
     OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles p
        WHERE p.user_id = p_user_id AND p.managed
          AND (p.created_by_user_id = uid
               OR EXISTS (SELECT 1 FROM public.memberships om
                            JOIN public.locations ol ON ol.id = om.location_id
                           WHERE om.user_id = p_user_id AND ol.deleted_at IS NULL
                             AND ol.owner_account_id = kept.current_owner_account_id()))) THEN
    RAISE EXCEPTION 'not a managed account this user may add here'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.memberships (id, location_id, user_id, role, expires_at, invited_by)
  VALUES (mid, p_location_id, p_user_id, p_role, least(p_expires_at, caller.expires_at), uid);
  RETURN mid;
END $$;

-- Deletes a location (task 19, D149): owner only, never the Personal one; it disappears for
-- everyone at once and is purged 30 days later unless restored. Returns purge_after.
CREATE FUNCTION kept.delete_location(p_location_id uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  loc record;
BEGIN
  SELECT l.id, l.kind INTO loc FROM public.locations l
   WHERE l.id = p_location_id AND l.deleted_at IS NULL
     AND l.owner_account_id = kept.current_owner_account_id()
     AND l.id IN (SELECT kept.visible_location_ids())
     FOR UPDATE;
  IF loc.id IS NULL THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF loc.kind = 'personal' THEN
    RAISE EXCEPTION 'a Personal location can''t be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'locations_personal_undeletable';
  END IF;
  UPDATE public.locations SET deleted_at = now(), purge_after = now() + interval '30 days'
   WHERE id = p_location_id;
  RETURN now() + interval '30 days';
END $$;

-- Restores a deleted location within its grace period (task 19, D149): owner only, and with a
-- second factor if the location requires one (as seeing it would).
CREATE FUNCTION kept.restore_location(p_location_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.locations l SET deleted_at = NULL, purge_after = NULL
   WHERE l.id = p_location_id AND l.deleted_at IS NOT NULL AND l.purge_after > now()
     AND l.owner_account_id = kept.current_owner_account_id()
     AND (NOT l.require_2fa OR kept.current_mfa());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such deleted location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- The owner's own locations in their grace period, for the restore screen: nothing of anyone
-- else's, and nothing past its purge date.
CREATE FUNCTION kept.deleted_locations()
RETURNS TABLE (id uuid, name text, kind text, deleted_at timestamptz, purge_after timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT l.id, l.name, l.kind, l.deleted_at, l.purge_after
    FROM public.locations l
   WHERE l.owner_account_id = kept.current_owner_account_id()
     AND l.deleted_at IS NOT NULL AND l.purge_after > now()
     AND (NOT l.require_2fa OR kept.current_mfa())
   ORDER BY l.deleted_at DESC
$$;

-- Turns "require two-factor" on or off (§7.14): owner only.
CREATE FUNCTION kept.set_location_require_2fa(p_location_id uuid, p_required boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.locations l SET require_2fa = p_required
   WHERE l.id = p_location_id AND l.deleted_at IS NULL
     AND l.owner_account_id = kept.current_owner_account_id()
     AND l.id IN (SELECT kept.visible_location_ids());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Names (or, with NULL, clears) the location's successor (D165): owner only, and the successor
-- must be one of the location's current members, so it can't probe which user ids exist.
CREATE FUNCTION kept.set_location_successor(p_location_id uuid, p_successor_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.locations l SET successor_user_id = p_successor_user_id
   WHERE l.id = p_location_id AND l.deleted_at IS NULL
     AND l.owner_account_id = kept.current_owner_account_id()
     AND l.id IN (SELECT kept.visible_location_ids())
     AND (p_successor_user_id IS NULL OR EXISTS (
           SELECT 1 FROM public.memberships m
            WHERE m.location_id = l.id AND m.user_id = p_successor_user_id
              AND m.role <> 'owner' AND (m.expires_at IS NULL OR m.expires_at > now())));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such location of yours, or no such member'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- kept_app's alone. 0000's default privileges also granted kept_system EXECUTE.
REVOKE EXECUTE ON FUNCTION
  kept.accept_invite(text), kept.invite_preview(text), kept.create_managed_profile(uuid, text),
  kept.add_managed_member(uuid, uuid, text, timestamptz), kept.delete_location(uuid),
  kept.restore_location(uuid), kept.deleted_locations(),
  kept.set_location_require_2fa(uuid, boolean), kept.set_location_successor(uuid, uuid)
  FROM PUBLIC, kept_system;
GRANT EXECUTE ON FUNCTION
  kept.accept_invite(text), kept.invite_preview(text), kept.create_managed_profile(uuid, text),
  kept.add_managed_member(uuid, uuid, text, timestamptz), kept.delete_location(uuid),
  kept.restore_location(uuid), kept.deleted_locations(),
  kept.set_location_require_2fa(uuid, boolean), kept.set_location_successor(uuid, uuid)
  TO kept_app;
