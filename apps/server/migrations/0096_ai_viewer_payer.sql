-- Custom SQL migration file, put your code below! --
-- Step 6: a viewer's assistant turn (and the semantic search query it embeds) is paid by the
-- location's owner account's key, as kept.ai_provider_for() already resolves it (0040: only
-- extraction asks for a writable location). The two checks behind the gate admitted writers'
-- accounts only, so the call was refused:
--   - kept.ai_payer_reachable(): an account payer is also reachable for a viewer when the call's
--     budget task is `assistant` or `embeddings`, and the call is in a location of that account
--     the caller sees. Extraction (and anything else) still needs a writer;
--   - kept.ai_provider_reachable(), the pacer's and breaker's check (rate-limit bookkeeping, no
--     spending): an account's key is reachable from any location of the account the caller sees.
-- Both stay owner-only (0040's grants are kept by CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION kept.ai_provider_reachable(p_provider uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT session_user = 'kept_system' OR EXISTS (
    SELECT 1 FROM public.ai_providers p
     WHERE p.id = p_provider AND kept.current_user_id() IS NOT NULL
       AND (p.scope = 'instance'
            OR (p.scope = 'account'
                AND (p.owner_account_id IN (SELECT kept.visible_account_ids())
                     OR p.owner_account_id = kept.current_owner_account_id()))
            OR (p.scope = 'user' AND p.user_id = kept.current_user_id())))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.ai_payer_reachable(p_ctx jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT session_user = 'kept_system' OR coalesce(
    kept.current_user_id() IS NOT NULL
    AND CASE p_ctx->>'paying_scope'
          WHEN 'instance' THEN true
          WHEN 'account' THEN (p_ctx->>'paying_account_id')::uuid IN (SELECT kept.writable_account_ids())
                              OR (p_ctx->>'paying_account_id')::uuid = kept.current_owner_account_id()
                              OR (p_ctx->>'budget_task' IN ('assistant', 'embeddings')
                                  AND EXISTS (
                                    SELECT 1 FROM public.locations l
                                     WHERE l.id = (p_ctx->>'location_id')::uuid
                                       AND l.owner_account_id = (p_ctx->>'paying_account_id')::uuid
                                       AND l.id IN (SELECT kept.visible_location_ids())))
          WHEN 'user' THEN (p_ctx->>'paying_user_id')::uuid = kept.current_user_id()
          ELSE false END
    AND (p_ctx->>'location_id' IS NULL
         OR (p_ctx->>'location_id')::uuid IN (SELECT kept.visible_location_ids())), false)
$$;
