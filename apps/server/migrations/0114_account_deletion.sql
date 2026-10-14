-- Custom SQL migration file, put your code below! --
-- 1.2, D225: deleting your own account (D49's rule, with D114 and D149's grace).
--   1. kept.account_deletion_blockers() says why the signed-in person's account can't go yet:
--      the locations it owns besides its Personal one (not already deleted), being the instance's
--      last admin, or being a managed account (D47: its location's owner removes it).
--   2. kept.request_account_deletion() starts the 30 days (auth.user_deletion, made by the
--      previous migration); kept.cancel_account_deletion() ends them. Both for a signed-in person
--      only, never a token.
--   3. While an account waits, its personal tokens, OAuth connectors and calendar feed answer
--      nothing, as for a disabled account (0109, 0055); keeping the account gives them back. The
--      session gate (auth/session.ts) refuses everything but /me and keeping it.
--   4. kept.purge_deleted_accounts(limit), for the daily purge job (kept_system): an account past
--      its date loses its locations (the Personal one, and any of its own still in their grace)
--      with the storage keys nothing else references, its account-level audit events, and then
--      the sign-in user, whose rows go by ON DELETE CASCADE (memberships, tokens, sessions,
--      preferences, profile). An account that came to own a live location meanwhile (an
--      operator's transfer) waits.
-- test/leak.test.ts and src/db/migrate.test.ts list the four new functions.

CREATE FUNCTION kept.account_deletion_blockers()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
BEGIN
  IF uid IS NULL OR kept.current_token_id() IS NOT NULL THEN
    RAISE EXCEPTION 'only the signed-in person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN jsonb_build_object(
    'locations', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name) ORDER BY l.name, l.id)
        FROM public.locations l
        JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
       WHERE oa.user_id = uid AND l.kind <> 'personal' AND l.deleted_at IS NULL), '[]'::jsonb),
    'lastInstanceAdmin',
      EXISTS (SELECT 1 FROM public.instance_admins a WHERE a.user_id = uid)
      AND NOT EXISTS (SELECT 1 FROM public.instance_admins a
                       WHERE a.user_id <> uid
                         AND NOT EXISTS (SELECT 1 FROM auth.user_deletion d
                                          WHERE d.user_id = a.user_id)),
    'managed', coalesce((SELECT p.managed FROM public.user_profiles p WHERE p.user_id = uid),
                        false));
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.request_account_deletion()
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  b jsonb;
  due timestamptz;
BEGIN
  -- Two last admins asking at once would each see the other stay.
  PERFORM pg_advisory_xact_lock(hashtext('kept.request_account_deletion'));
  b := kept.account_deletion_blockers();
  IF jsonb_array_length(b -> 'locations') > 0 OR (b ->> 'lastInstanceAdmin')::boolean
     OR (b ->> 'managed')::boolean THEN
    RAISE EXCEPTION 'this account can''t be deleted yet'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_deletion_blocked';
  END IF;
  INSERT INTO auth.user_deletion (user_id, purge_after)
  VALUES (uid, now() + interval '30 days')
  ON CONFLICT (user_id) DO NOTHING;
  SELECT d.purge_after INTO due FROM auth.user_deletion d WHERE d.user_id = uid;
  RETURN due;
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.cancel_account_deletion()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF kept.current_user_id() IS NULL OR kept.current_token_id() IS NOT NULL THEN
    RAISE EXCEPTION 'only the signed-in person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM auth.user_deletion d WHERE d.user_id = kept.current_user_id();
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.account_deletion_blockers(), kept.request_account_deletion(),
  kept.cancel_account_deletion() FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.account_deletion_blockers(), kept.request_account_deletion(),
  kept.cancel_account_deletion() TO kept_app;
--> statement-breakpoint

CREATE FUNCTION kept.purge_deleted_accounts(p_limit integer)
RETURNS TABLE (user_id uuid, storage_keys text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  uid uuid;
  acct uuid;
  locs uuid[];
  keys text[];
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'purging needs a positive limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR uid IN
    SELECT d.user_id FROM auth.user_deletion d
     WHERE d.purge_after < now()
       AND NOT EXISTS (SELECT 1 FROM public.locations l
                         JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
                        WHERE oa.user_id = d.user_id AND l.kind <> 'personal'
                          AND l.deleted_at IS NULL)
     ORDER BY d.purge_after, d.user_id
     LIMIT p_limit
     FOR UPDATE OF d SKIP LOCKED
  LOOP
    SELECT oa.id INTO acct FROM public.owner_accounts oa WHERE oa.user_id = uid;
    SELECT coalesce(array_agg(l.id), '{}'::uuid[]) INTO locs
      FROM public.locations l WHERE l.owner_account_id = acct;
    SELECT coalesce(array_agg(DISTINCT k.storage_key), '{}'::text[]) INTO keys
      FROM (SELECT f.storage_key FROM public.files f WHERE f.location_id = ANY (locs)
            UNION
            SELECT dv.storage_key FROM public.file_derivatives dv
             WHERE dv.location_id = ANY (locs)) k
     WHERE NOT EXISTS (SELECT 1 FROM public.files f
                        WHERE f.storage_key = k.storage_key AND NOT (f.location_id = ANY (locs)))
       AND NOT EXISTS (SELECT 1 FROM public.file_derivatives dv
                        WHERE dv.storage_key = k.storage_key
                          AND NOT (dv.location_id = ANY (locs)));
    DELETE FROM public.locations l WHERE l.id = ANY (locs);
    IF acct IS NOT NULL THEN
      DELETE FROM public.audit_events e WHERE e.owner_account_id = acct AND e.location_id IS NULL;
    END IF;
    DELETE FROM auth."user" u WHERE u.id = uid;
    user_id := uid;
    storage_keys := keys;
    RETURN NEXT;
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.purge_deleted_accounts(integer) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.purge_deleted_accounts(integer) TO kept_system;
--> statement-breakpoint

-- 3. The doors answer nothing for an account waiting to be deleted -----------------------------
CREATE OR REPLACE FUNCTION kept.token_verify(p_lookup text, p_hash text)
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
     OR (tok.expires_at IS NOT NULL AND tok.expires_at <= now())
     OR EXISTS (SELECT 1 FROM auth."user" u
                 WHERE u.id = tok.user_id AND coalesce(u.banned, false)
                   AND (u.ban_expires IS NULL OR u.ban_expires > now()))
     OR EXISTS (SELECT 1 FROM auth.user_deletion d WHERE d.user_id = tok.user_id) THEN
    RETURN;
  END IF;
  IF tok.last_used_at IS NULL OR tok.last_used_at < now() - interval '1 minute' THEN
    UPDATE public.api_tokens t SET last_used_at = now() WHERE t.id = tok.id;
  END IF;
  RETURN QUERY SELECT tok.id, tok.user_id, tok.scope, tok.kind, tok.created_with_mfa,
                      tok.expires_at;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.token_oauth_for(p_user uuid, p_client text)
RETURNS TABLE (token_id uuid, scope text, mfa boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  tok public.api_tokens%ROWTYPE;
BEGIN
  IF kept.current_user_id() IS NOT NULL AND kept.current_user_id() IS DISTINCT FROM p_user THEN
    RAISE EXCEPTION 'not your grant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM auth."user" u
              WHERE u.id = p_user AND coalesce(u.banned, false)
                AND (u.ban_expires IS NULL OR u.ban_expires > now()))
     OR EXISTS (SELECT 1 FROM auth.user_deletion d WHERE d.user_id = p_user) THEN
    RETURN;
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
CREATE OR REPLACE FUNCTION kept.calendar_feed_user(p_token_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  f public.calendar_feeds%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.calendar_feeds x
   WHERE x.token_hash = p_token_hash AND p_token_hash ~ '^[0-9a-f]{64}$' AND x.revoked_at IS NULL;
  IF f.id IS NULL
     OR EXISTS (SELECT 1 FROM auth."user" u
                 WHERE u.id = f.user_id AND coalesce(u.banned, false))
     OR EXISTS (SELECT 1 FROM auth.user_deletion d WHERE d.user_id = f.user_id) THEN
    RETURN NULL;
  END IF;
  UPDATE public.calendar_feeds x SET fetches = x.fetches + 1, last_fetched_at = now()
   WHERE x.id = f.id
     AND (x.last_fetched_at IS NULL OR x.last_fetched_at < now() - interval '1 minute');
  RETURN f.user_id;
END $$;
