-- Custom SQL migration file, put your code below! --
-- Account creation, step two (task 18; D114, D190, D191, §7.10, §7.14).
--
-- Better Auth (kept_auth) creates the user; kept.ensure_account() then makes everything Kept
-- needs for them, idempotently, in the caller's transaction: the owner account, the Personal
-- location (preset household, D191) with its owner membership and Unplaced area, and the
-- profile. Insert order: owner_accounts → locations → owner membership → Unplaced → profile, so
-- the deferred ownership check (0005) holds at commit.
--
-- One SECURITY DEFINER function for both paths, rather than kept_app policies plus new
-- kept_system policies on locations and places:
-- - it always ensures *the scope's own user* (kept.current_user_id()), so there is no user
--   argument to abuse. kept_app calls it inside the request's withScope(); the repair job
--   (kept_system) calls it inside withScope() on the system pool, scoped to the orphan it found.
--   Neither can use it to touch anyone but the scoped user;
-- - kept_system gets no policy on locations or places: its only way in is this one door;
-- - a per-user advisory lock serialises concurrent calls (a sign-up hook racing a first request,
--   two first requests, the repair job), so the checks below never race their inserts, and ON
--   CONFLICT / RETURNING under RLS never come into it.
-- It writes no audit event: the caller does (ensureAccount() as the user, the repair job as
-- `system`), after the membership exists, when `created` is true.
CREATE FUNCTION kept.ensure_account(p_timezone text, p_locale text, p_currency text)
RETURNS TABLE (owner_account_id uuid, location_id uuid, created boolean, timezone text,
               currency text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  uid uuid := kept.current_user_id();
  u record;
  acct uuid;
  loc uuid;
  tz text;
  cur text;
  loc_tz text;
  loc_cur text;
  loc_created boolean := false;
  lang text;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'ensuring an account needs a user scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT au.name, au.email INTO u FROM auth."user" au WHERE au.id = uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such user' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('kept.ensure_account'), hashtext(uid::text));

  -- 1. The owner account (D114).
  SELECT oa.id INTO acct FROM public.owner_accounts oa WHERE oa.user_id = uid;
  IF acct IS NULL THEN
    acct := uuidv7();
    INSERT INTO public.owner_accounts (id, user_id) VALUES (acct, uid);
  END IF;

  -- Defaults: an existing profile's time zone wins (a managed profile made first, task 21);
  -- otherwise the caller's, if Postgres knows it; otherwise UTC. A currency Kept doesn't have
  -- falls back to USD, a malformed locale to en.
  SELECT p.timezone INTO tz FROM public.user_profiles p WHERE p.user_id = uid;
  IF tz IS NULL THEN
    tz := CASE WHEN p_timezone IS NOT NULL
                    AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = p_timezone)
               THEN p_timezone ELSE 'UTC' END;
  END IF;
  cur := CASE WHEN EXISTS (SELECT 1 FROM public.currencies c WHERE c.code = p_currency AND c.enabled)
              THEN p_currency ELSE 'USD' END;
  lang := CASE WHEN p_locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$' THEN p_locale ELSE 'en' END;

  -- 2–4. The Personal location, its owner membership and its Unplaced area.
  SELECT l.id, l.timezone, l.currency INTO loc, loc_tz, loc_cur
    FROM public.locations l WHERE l.owner_account_id = acct AND l.kind = 'personal';
  IF loc IS NULL THEN
    loc := uuidv7();
    INSERT INTO public.locations (id, owner_account_id, kind, name, timezone, currency, preset)
    VALUES (loc, acct, 'personal', 'Personal', tz, cur, 'household');
    INSERT INTO public.memberships (location_id, user_id, role) VALUES (loc, uid, 'owner');
    loc_tz := tz;
    loc_cur := cur;
    loc_created := true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.places pl WHERE pl.location_id = loc AND pl.is_unplaced) THEN
    INSERT INTO public.places (location_id, name, is_unplaced) VALUES (loc, 'Unplaced', true);
  END IF;

  -- 5. The profile, named after the auth user (the part of the address before @ if unnamed).
  INSERT INTO public.user_profiles (user_id, display_name, timezone, locale)
  VALUES (uid, coalesce(nullif(btrim(u.name), ''), split_part(u.email, '@', 1)), tz, lang)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY SELECT acct, loc, loc_created, loc_tz, loc_cur::text;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ensure_account(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ensure_account(text, text, text) TO kept_app, kept_system;
--> statement-breakpoint
-- The repair job (task 18) finds auth users with no owner account. It needs their ids and
-- creation times, nothing else of schema auth: a column grant, so SELECT * (and email, name,
-- anything Better Auth adds later) stays refused.
GRANT USAGE ON SCHEMA auth TO kept_system;
--> statement-breakpoint
GRANT SELECT (id, created_at) ON auth."user" TO kept_system;
