-- Custom SQL migration file, put your code below! --
-- Review findings (2026-10-14): tokens outlived the account events that should end them.
--   1. A disabled user (Admin → Disable, Better Auth's `banned`) kept every personal token and
--      OAuth connector: neither door checked the ban, so /api/v1 and /mcp still answered. Both
--      doors now answer nothing while the ban stands, as the calendar feed already did (0055);
--      enabling the user gives the tokens back, as it gives back sign-in (D210: a banned account
--      sees a plain 401).
--   2. D197's claim (a reset or a first magic link proving the mailbox of an unverified account)
--      removed passkeys, TOTP and sessions but not tokens, so whoever signed up with the address
--      first kept a working token. kept.revoke_user_tokens() ends every live token of a user;
--      only kept_system may open it, and the claim calls it before it commits.
-- test/leak.test.ts and src/db/migrate.test.ts list the new function.

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
                   AND (u.ban_expires IS NULL OR u.ban_expires > now())) THEN
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
                AND (u.ban_expires IS NULL OR u.ban_expires > now())) THEN
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
CREATE FUNCTION kept.revoke_user_tokens(p_user uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n integer;
BEGIN
  IF p_reason IS NULL OR p_reason <> 'account_claimed' THEN
    RAISE EXCEPTION 'unknown reason %', p_reason USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.api_tokens t SET revoked_at = now(), revoked_reason = p_reason
   WHERE t.user_id = p_user AND t.revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.revoke_user_tokens(uuid, text) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.revoke_user_tokens(uuid, text) TO kept_system;
