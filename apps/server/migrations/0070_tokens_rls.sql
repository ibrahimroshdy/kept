-- Custom SQL migration file, put your code below! --
-- Step 6, task 4: tokens as principals, OAuth grants and the token rate windows (engineering spec
-- §1.10, §3.2, §7.3, §7.13; D15, D60, D63, D179, D180, D190; plan Q6, Q7, Q19). Above, in 0069,
-- drizzle's part: api_tokens, token_locations and token_rate_windows (src/db/schema/tokens.ts).
-- Below:
--   1. The token principal. withScope() sets `app.token_id` beside `app.user_id` (db/scope.ts);
--      kept.current_token_id() reads it. kept.visible_location_ids(), writable_location_ids() and
--      admin_location_ids() (0006's, every clause kept) intersect the creator's memberships with
--      the token's locations while the token is live (not revoked, not expired, the current
--      user's), and a read token has nothing writable or administered. Roles are therefore
--      evaluated on every call (D180): a creator who loses a membership or a role loses it through
--      their tokens at the next statement, with no job. A token's require_2fa locations need its
--      created_with_mfa as well as `app.mfa`. kept.is_instance_admin() is false for a token
--      (D180: never admin), added here.
--   2. Row-level security. api_tokens and token_locations are their user's own and never a
--      token's (D180: tokens never manage tokens): every kept_app policy requires no
--      `app.token_id`. kept_app can't SELECT api_tokens.hash (the column grant, as
--      ai_providers.key_ciphertext); a revoked token stays revoked (23514
--      api_tokens_revoked_final). A kept_app INSERT is a personal token only (OAuth grants come
--      through kept.token_oauth_grant) and claims created_with_mfa only with a second factor.
--      token_rate_windows is definer-only.
--   3. kept.guard_token_location(): a token's location is one its creator belongs to (42501
--      token_locations_member), never a location where they are a viewer for a write token (42501
--      token_locations_role), and a require_2fa location only for a token made with a second
--      factor (42501 token_locations_mfa). A token whose last location row goes is revoked
--      (§7.13; kept.token_last_location()).
--   4. The audit actor (step-1 carry-over): a token-scoped transaction writes `token` events
--      pinned to its token, never `user` ones, and a user-scoped one never a `token` event.
--   5. The doors: kept.token_verify() and kept.token_oauth_for() (before a scope exists: how a
--      request gets one), kept.token_oauth_grant() (T12's consent step), kept.token_rate_hit()
--      (T10's limiter, Q19) and kept.revoke_tokens_for() (T10's membership routes, and the jobs).
--   6. Tokens die with access (D180, step-1 carry-over "membership expiry revokes tokens"): a
--      trigger on memberships, kept.membership_access_ended(), revokes on every path that ends a
--      membership (expire-memberships, member removal, leaving) and on a role dropping to viewer
--      (a write token loses that location, Q6), in the same transaction. T5 and T7 extend it
--      (assistant redaction, webhooks). A location's purge needs nothing: its rows cascade.
--   7. kept.prune_stale_rows() (0055's, every clause kept) drops rate windows past 2 hours.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-assistant.ts fills
-- the tables; src/db/tokens.test.ts tests them.

-- 1. The token principal ------------------------------------------------------------------------------
CREATE FUNCTION kept.current_token_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.token_id', true), '')::uuid $$;
--> statement-breakpoint
-- The locations the current token may reach, as its creator (for_write: a write token's only).
-- Invoker, called only by the definers below (kept_owner).
CREATE FUNCTION kept.token_location_ids(p_for_write boolean) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT tl.location_id
    FROM public.api_tokens t
    JOIN public.token_locations tl ON tl.token_id = t.id
    JOIN public.locations l ON l.id = tl.location_id
   WHERE t.id = kept.current_token_id()
     AND t.user_id = kept.current_user_id()
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > now())
     AND (NOT p_for_write OR t.scope = 'write')
     AND (NOT l.require_2fa OR t.created_with_mfa)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.visible_location_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.location_id FROM public.memberships m
  JOIN public.locations l ON l.id = m.location_id
  WHERE m.user_id = kept.current_user_id()
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND l.deleted_at IS NULL
    AND (NOT l.require_2fa OR kept.current_mfa())
    AND (kept.current_token_id() IS NULL
         OR m.location_id IN (SELECT kept.token_location_ids(false)))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.writable_location_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.location_id FROM public.memberships m
  JOIN public.locations l ON l.id = m.location_id
  WHERE m.user_id = kept.current_user_id()
    AND m.role IN ('owner', 'admin', 'member')
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND l.deleted_at IS NULL
    AND (NOT l.require_2fa OR kept.current_mfa())
    AND (kept.current_token_id() IS NULL
         OR m.location_id IN (SELECT kept.token_location_ids(true)))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.admin_location_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.location_id FROM public.memberships m
  JOIN public.locations l ON l.id = m.location_id
  WHERE m.user_id = kept.current_user_id()
    AND m.role IN ('owner', 'admin')
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND l.deleted_at IS NULL
    AND (NOT l.require_2fa OR kept.current_mfa())
    AND (kept.current_token_id() IS NULL
         OR m.location_id IN (SELECT kept.token_location_ids(true)))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.is_instance_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT kept.current_token_id() IS NULL AND EXISTS (
    SELECT 1 FROM public.instance_admins ia WHERE ia.user_id = kept.current_user_id()
  )
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.token_location_ids(boolean) FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.current_token_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.current_token_id() TO kept_app, kept_system;
--> statement-breakpoint

-- 2. Row-level security -------------------------------------------------------------------------------
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.api_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.api_tokens FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.api_tokens
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE POLICY app_select ON public.api_tokens FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_insert ON public.api_tokens FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL
              AND kind = 'personal' AND revoked_at IS NULL AND last_used_at IS NULL
              AND (NOT created_with_mfa OR (SELECT kept.current_mfa())));
--> statement-breakpoint
CREATE POLICY app_update ON public.api_tokens FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL)
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
-- kept_app reads every column but the secret's HMAC: verification is kept.token_verify()'s.
REVOKE SELECT, UPDATE, DELETE ON public.api_tokens FROM kept_app, kept_system;
--> statement-breakpoint
GRANT SELECT (id, user_id, kind, name, lookup, oauth_client_id, scope, created_with_mfa,
              expires_at, last_used_at, revoked_at, revoked_reason, created_at, updated_at,
              row_version, change_seq)
  ON public.api_tokens TO kept_app;
--> statement-breakpoint
-- Not granted: the id, user_id, kind, the lookup and hash, the client, the scope (a new token is a
-- new row), created_with_mfa, expires_at and last_used_at (kept.token_verify stamps it).
GRANT UPDATE (name, revoked_at, revoked_reason, updated_at, row_version)
  ON public.api_tokens TO kept_app;
--> statement-breakpoint
CREATE FUNCTION kept.guard_token_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
    RAISE EXCEPTION 'a revoked token stays revoked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'api_tokens_revoked_final';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER api_tokens_guard_revoked BEFORE UPDATE OF revoked_at, revoked_reason
  ON public.api_tokens FOR EACH ROW EXECUTE FUNCTION kept.guard_token_revoked();
--> statement-breakpoint

ALTER TABLE public.token_locations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.token_locations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.token_locations FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
-- Through a token the caller owns, in a location they see as themselves (no token set, so
-- visible_location_ids() is their plain memberships: a token can't widen itself).
CREATE POLICY app_select ON public.token_locations FOR SELECT TO kept_app
  USING ((SELECT kept.current_token_id()) IS NULL
         AND token_id IN (SELECT t.id FROM public.api_tokens t
                           WHERE t.user_id = (SELECT kept.current_user_id()))
         AND location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.token_locations FOR INSERT TO kept_app
  WITH CHECK ((SELECT kept.current_token_id()) IS NULL
              AND token_id IN (SELECT t.id FROM public.api_tokens t
                                WHERE t.user_id = (SELECT kept.current_user_id()))
              AND location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.token_locations FOR DELETE TO kept_app
  USING ((SELECT kept.current_token_id()) IS NULL
         AND token_id IN (SELECT t.id FROM public.api_tokens t
                           WHERE t.user_id = (SELECT kept.current_user_id()))
         AND location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
REVOKE UPDATE ON public.token_locations FROM kept_app, kept_system;
--> statement-breakpoint

-- Definer-only: per-token counters, only kept.token_rate_hit() touches them.
ALTER TABLE public.token_rate_windows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.token_rate_windows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.token_rate_windows FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON public.token_rate_windows FROM kept_app, kept_system, kept_auth;
--> statement-breakpoint

-- 3. A token's locations -------------------------------------------------------------------------------
-- Definer: it reads the creator's membership past the caller's policies. The token's own row is
-- the caller's (the insert policy, or the grant door).
CREATE FUNCTION kept.guard_token_location() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tok public.api_tokens%ROWTYPE;
  member_role text;
  needs_2fa boolean;
BEGIN
  SELECT * INTO tok FROM public.api_tokens t WHERE t.id = NEW.token_id;
  SELECT m.role, l.require_2fa INTO member_role, needs_2fa
    FROM public.memberships m JOIN public.locations l ON l.id = m.location_id
   WHERE m.location_id = NEW.location_id AND m.user_id = tok.user_id
     AND (m.expires_at IS NULL OR m.expires_at > now()) AND l.deleted_at IS NULL;
  IF tok.id IS NULL OR tok.revoked_at IS NOT NULL OR member_role IS NULL THEN
    RAISE EXCEPTION 'not a location of this token''s creator'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'token_locations_member';
  END IF;
  IF tok.scope = 'write' AND member_role = 'viewer' THEN
    RAISE EXCEPTION 'a viewer''s token only reads'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'token_locations_role';
  END IF;
  IF needs_2fa AND NOT tok.created_with_mfa THEN
    RAISE EXCEPTION 'this location needs a token made with a second factor'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'token_locations_mfa';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER token_locations_guard BEFORE INSERT ON public.token_locations
  FOR EACH ROW EXECUTE FUNCTION kept.guard_token_location();
--> statement-breakpoint
-- A token left with no location is revoked (§7.13): by its user ('user'), or because the
-- location itself went ('membership_ended'). A token being deleted has no row to update.
CREATE FUNCTION kept.token_last_location() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.token_locations tl WHERE tl.token_id = OLD.token_id) THEN
    UPDATE public.api_tokens t
       SET revoked_at = now(),
           revoked_reason = CASE WHEN EXISTS (SELECT 1 FROM public.locations l
                                               WHERE l.id = OLD.location_id)
                                 THEN 'user' ELSE 'membership_ended' END
     WHERE t.id = OLD.token_id AND t.revoked_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER token_locations_last AFTER DELETE ON public.token_locations
  FOR EACH ROW EXECUTE FUNCTION kept.token_last_location();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_token_revoked(), kept.guard_token_location(),
  kept.token_last_location()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 4. The audit actor ----------------------------------------------------------------------------------
-- 0056's policy, every branch kept; the actor is the user, or the token acting for them.
DROP POLICY app_insert ON public.audit_events;
--> statement-breakpoint
CREATE POLICY app_insert ON public.audit_events FOR INSERT TO kept_app
  WITH CHECK (
    ((actor_type = 'user'
      AND actor_id = (SELECT kept.current_user_id())
      AND (SELECT kept.current_token_id()) IS NULL)
     OR (actor_type = 'token'
         AND actor_id = (SELECT kept.current_token_id())
         AND (SELECT kept.current_user_id()) IS NOT NULL))
    AND (
      (location_id IN (SELECT kept.visible_location_ids())
       AND (owner_account_id IS NULL
            OR owner_account_id = (SELECT l.owner_account_id FROM public.locations l
                                    WHERE l.id = audit_events.location_id)))
      OR (location_id IS NULL
          AND owner_account_id = (SELECT kept.current_owner_account_id()))
      OR (location_id IS NULL AND owner_account_id IS NULL
          AND (SELECT kept.is_instance_admin()))
      OR (location_id IS NULL
          AND entity_type = ANY (ARRAY['type', 'type_field', 'place_kind', 'brand', 'vendor',
                                       'person', 'tag'])
          AND owner_account_id IN (SELECT kept.writable_account_ids()))
      OR (location_id IS NULL
          AND entity_type = ANY (ARRAY['template', 'fx_rate'])
          AND owner_account_id IN (SELECT kept.admin_account_ids()))
    )
  );
--> statement-breakpoint

-- 5. The doors ------------------------------------------------------------------------------------------
-- How a request with a personal token gets its scope: by lookup, the caller having computed the
-- HMAC of the secret (the key never reaches the database). The comparison is on a unique lookup,
-- so no other row is ever compared. Revoked, expired or no such token: no row. Stamps
-- last_used_at at most once a minute. Callable with no scope (it is how one is made); a scoped
-- caller learns nothing it couldn't learn by presenting the token.
CREATE FUNCTION kept.token_verify(p_lookup text, p_hash text)
RETURNS TABLE (token_id uuid, user_id uuid, scope text, kind text, mfa boolean,
               expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  tok public.api_tokens%ROWTYPE;
BEGIN
  SELECT * INTO tok FROM public.api_tokens t
   WHERE t.lookup = p_lookup AND t.kind = 'personal';
  IF tok.id IS NULL OR tok.hash IS DISTINCT FROM p_hash OR tok.revoked_at IS NOT NULL
     OR (tok.expires_at IS NOT NULL AND tok.expires_at <= now()) THEN
    RETURN;
  END IF;
  IF tok.last_used_at IS NULL OR tok.last_used_at < now() - interval '1 minute' THEN
    UPDATE public.api_tokens t SET last_used_at = now() WHERE t.id = tok.id;
  END IF;
  RETURN QUERY SELECT tok.id, tok.user_id, tok.scope, tok.kind, tok.created_with_mfa,
                      tok.expires_at;
END $$;
--> statement-breakpoint
-- An OAuth access token's grant (Q7): Better Auth verified the JWT (user and client); this is the
-- scope and locations it may use, checked on every call so a revocation in Connections works at
-- once. Before a scope exists, or for the scope's own user only.
CREATE FUNCTION kept.token_oauth_for(p_user uuid, p_client text)
RETURNS TABLE (token_id uuid, scope text, mfa boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  tok public.api_tokens%ROWTYPE;
BEGIN
  IF kept.current_user_id() IS NOT NULL AND kept.current_user_id() IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'not your grant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO tok FROM public.api_tokens t
   WHERE t.user_id = p_user AND t.oauth_client_id = p_client AND t.kind = 'oauth'
     AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now());
  IF tok.id IS NULL THEN
    RETURN;
  END IF;
  IF tok.last_used_at IS NULL OR tok.last_used_at < now() - interval '1 minute' THEN
    UPDATE public.api_tokens t SET last_used_at = now() WHERE t.id = tok.id;
  END IF;
  RETURN QUERY SELECT tok.id, tok.scope, tok.created_with_mfa;
END $$;
--> statement-breakpoint
-- The consent step (T12): the signed-in user grants a client a scope in some of their locations.
-- One live grant per user and client, updated in place (its locations replaced); the location
-- guard above applies to each. created_with_mfa is this session's second factor.
CREATE FUNCTION kept.token_oauth_grant(p_user uuid, p_client text, p_scope text,
                                       p_locations uuid[], p_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  tid uuid;
  locs uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(p_locations) AS x WHERE x IS NOT NULL);
BEGIN
  IF uid IS NULL OR uid IS DISTINCT FROM p_user OR kept.current_token_id() IS NOT NULL THEN
    RAISE EXCEPTION 'only the signed-in user grants' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cardinality(locs) = 0 THEN
    RAISE EXCEPTION 'a grant needs a location'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'token_locations_none';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(locs) AS x
              WHERE x NOT IN (SELECT kept.visible_location_ids())) THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.id INTO tid FROM public.api_tokens t
   WHERE t.user_id = uid AND t.oauth_client_id = p_client AND t.kind = 'oauth'
     AND t.revoked_at IS NULL
   FOR UPDATE;
  IF tid IS NULL THEN
    INSERT INTO public.api_tokens (user_id, kind, name, oauth_client_id, scope, created_with_mfa)
    VALUES (uid, 'oauth', p_name, p_client, p_scope, kept.current_mfa())
    RETURNING id INTO tid;
  ELSE
    UPDATE public.api_tokens t
       SET name = p_name, scope = p_scope, created_with_mfa = kept.current_mfa()
     WHERE t.id = tid;
  END IF;
  -- The new locations first, then the ones no longer granted, so the grant never passes through
  -- having none (which would revoke it).
  INSERT INTO public.token_locations (token_id, location_id)
  SELECT tid, x FROM unnest(locs) AS x
  ON CONFLICT DO NOTHING;
  DELETE FROM public.token_locations tl
   WHERE tl.token_id = tid AND NOT (tl.location_id = ANY (locs));
  RETURN tid;
END $$;
--> statement-breakpoint
-- The per-token limiter (Q19): one statement per request, counting this minute's reads or writes.
-- A scoped caller counts only its own token (or, as the user, one of its own); before a scope
-- exists, any token the request presented.
CREATE FUNCTION kept.token_rate_hit(p_token uuid, p_kind text, p_limit integer)
RETURNS TABLE (ok boolean, retry_after integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  win timestamptz := date_trunc('minute', now());
  n integer;
BEGIN
  IF (kept.current_token_id() IS NOT NULL AND kept.current_token_id() IS DISTINCT FROM p_token)
     OR (kept.current_token_id() IS NULL AND kept.current_user_id() IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.api_tokens t
                          WHERE t.id = p_token AND t.user_id = kept.current_user_id())) THEN
    RAISE EXCEPTION 'not your token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'a limit is at least 1' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.token_rate_windows AS w (token_id, minute, kind, count)
  VALUES (p_token, win, p_kind, 1)
  ON CONFLICT (token_id, minute, kind) DO UPDATE SET count = w.count + 1
  RETURNING w.count INTO n;
  ok := n <= p_limit;
  retry_after := CASE WHEN ok THEN 0
                      ELSE greatest(1, ceil(extract(epoch FROM win + interval '1 minute' - now())))::int
                 END;
  RETURN NEXT;
END $$;
--> statement-breakpoint
-- The work of revoking: a user's tokens whose only location is p_location are revoked; the others
-- lose that location. 'role_lost' (a role dropping to viewer) touches write tokens only (Q6).
-- Owner-only: called by kept.revoke_tokens_for() and the membership trigger.
CREATE FUNCTION kept.revoke_tokens_in(p_user uuid, p_location uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  n integer;
  m integer;
BEGIN
  UPDATE public.api_tokens t SET revoked_at = now(), revoked_reason = p_reason
   WHERE t.user_id = p_user AND t.revoked_at IS NULL
     AND (p_reason <> 'role_lost' OR t.scope = 'write')
     AND EXISTS (SELECT 1 FROM public.token_locations tl
                  WHERE tl.token_id = t.id AND tl.location_id = p_location)
     AND NOT EXISTS (SELECT 1 FROM public.token_locations tl
                      WHERE tl.token_id = t.id AND tl.location_id <> p_location);
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM public.token_locations tl USING public.api_tokens t
   WHERE tl.token_id = t.id AND tl.location_id = p_location
     AND t.user_id = p_user AND t.revoked_at IS NULL
     AND (p_reason <> 'role_lost' OR t.scope = 'write');
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END $$;
--> statement-breakpoint
-- The door (SYS for the jobs; APP for the membership routes): the user themself, or an admin of
-- the location. Never a token. Returns the number of tokens touched.
CREATE FUNCTION kept.revoke_tokens_for(p_user uuid, p_location uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'kept_system'
     AND (kept.current_user_id() IS NULL OR kept.current_token_id() IS NOT NULL
          OR (p_user IS DISTINCT FROM kept.current_user_id()
              AND NOT coalesce(p_location IN (SELECT kept.admin_location_ids()), false))) THEN
    RAISE EXCEPTION 'not a location you administer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL
     OR NOT (p_reason = ANY (ARRAY['membership_ended', 'role_lost', 'admin'])) THEN
    RAISE EXCEPTION 'unknown reason %', p_reason USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN kept.revoke_tokens_in(p_user, p_location, p_reason);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.token_verify(text, text), kept.token_oauth_for(uuid, text),
  kept.token_oauth_grant(uuid, text, text, uuid[], text), kept.token_rate_hit(uuid, text, integer),
  kept.revoke_tokens_in(uuid, uuid, text), kept.revoke_tokens_for(uuid, uuid, text)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.token_verify(text, text), kept.token_oauth_for(uuid, text),
  kept.token_oauth_grant(uuid, text, text, uuid[], text), kept.token_rate_hit(uuid, text, integer)
  TO kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.revoke_tokens_for(uuid, uuid, text) TO kept_app, kept_system;
--> statement-breakpoint

-- 6. Tokens die with access -----------------------------------------------------------------------------
-- On every path that ends a membership or drops a role, in its transaction. Definer: the rows are
-- another user's. A location being purged is already gone here (its rows cascade), so it is
-- skipped.
CREATE FUNCTION kept.membership_access_ended() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = OLD.location_id) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM kept.revoke_tokens_in(OLD.user_id, OLD.location_id, 'membership_ended');
  ELSIF NEW.role = 'viewer' AND OLD.role <> 'viewer' THEN
    PERFORM kept.revoke_tokens_in(OLD.user_id, OLD.location_id, 'role_lost');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER memberships_access_ended AFTER DELETE OR UPDATE OF role ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION kept.membership_access_ended();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.membership_access_ended() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 7. Maintenance --------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kept.prune_stale_rows()
RETURNS TABLE (what text, removed bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM auth.sign_in_failures f
   WHERE greatest(f.window_start, f.last_failure_at) < now() - interval '25 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'auth.sign_in_failures'; removed := n; RETURN NEXT;

  DELETE FROM auth.session_mfa m USING auth.session s
   WHERE s.id = m.session_id AND s.expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'auth.session_mfa'; removed := n; RETURN NEXT;

  DELETE FROM public.idempotency_keys k WHERE k.created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'idempotency_keys'; removed := n; RETURN NEXT;

  DELETE FROM public.sync_ops o WHERE o.received_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'sync_ops'; removed := n; RETURN NEXT;

  DELETE FROM public.inbox_items i WHERE i.resolved_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'inbox_items'; removed := n; RETURN NEXT;

  -- 0055 (step 4, §3.3): the centre keeps 90 days; the reminder ledger a year.
  DELETE FROM public.notifications x WHERE x.created_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'notifications'; removed := n; RETURN NEXT;

  DELETE FROM public.reminder_deliveries d WHERE d.created_at < now() - interval '1 year';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'reminder_deliveries'; removed := n; RETURN NEXT;

  DELETE FROM public.reminder_occurrences o
   WHERE o.state <> 'open' AND o.closed_at < now() - interval '1 year'
     AND NOT EXISTS (SELECT 1 FROM public.reminder_deliveries d WHERE d.occurrence_id = o.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'reminder_occurrences'; removed := n; RETURN NEXT;

  DELETE FROM public.notification_digests g WHERE g.digest_on < current_date - 365;
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'notification_digests'; removed := n; RETURN NEXT;

  -- 0070 (step 6, Q19): a rate window is a minute; two hours is plenty for Retry-After.
  DELETE FROM public.token_rate_windows w WHERE w.minute < now() - interval '2 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'token_rate_windows'; removed := n; RETURN NEXT;
END $$;
