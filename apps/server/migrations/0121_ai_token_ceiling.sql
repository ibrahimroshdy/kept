-- 1.4.1: the most tokens one request to a provider may hold, so the assistant can size a request
-- under it instead of sending one the provider refuses outright (Groq's 413 "Request too large …
-- on tokens per minute"). It is the per-minute limit the provider's own headers last named
-- (ai_provider_limits.limit_tokens, written by kept.ai_observe), or null while none is known.
-- A door like kept.ai_key_admit: the caller must be able to use the provider.
CREATE FUNCTION kept.ai_token_ceiling(p_provider uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT kept.ai_provider_reachable(p_provider) THEN
    RAISE EXCEPTION 'no such provider of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT l.limit_tokens FROM public.ai_provider_limits l WHERE l.provider_id = p_provider);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_token_ceiling(uuid) FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ai_token_ceiling(uuid) TO kept_app, kept_system;
