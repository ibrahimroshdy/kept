-- Custom SQL migration file, put your code below! --
-- Step 6 (S6.4 finding 5): a provider that reports no token counts (Google's embeddings). Above,
-- in 0092, llm_calls.usage_estimated. Below, 0040's kept.ai_insert_call() writes it from the
-- usage's `usage_estimated` (only for a sent call), so the row carries Kept's estimate in
-- input_tokens, flagged, instead of a null that stood in for "unknown". Unchanged otherwise;
-- its grants stay (CREATE OR REPLACE keeps them).

CREATE OR REPLACE FUNCTION kept.ai_insert_call(p_ctx jsonb, p_usage jsonb, p_outcome text, p_cost jsonb)
RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  sent boolean := coalesce((p_usage->>'sent')::boolean, false);
  at timestamptz := coalesce((p_ctx->>'at')::timestamptz, now());
  new_id uuid;
BEGIN
  IF at > now() + interval '5 minutes' OR at < now() - interval '1 day' THEN
    at := now();
  END IF;
  INSERT INTO public.llm_calls (
    at, request_id, attempt, task, location_id, owner_account_id, user_id, paying_scope,
    paying_account_id, paying_user_id, fell_back, provider_id, provider_kind, model, reasoning,
    prompt_version, sent, estimate_tokens, input_tokens, output_tokens, reasoning_tokens,
    cached_input_tokens, usage_estimated, image_count, image_tokens_each, image_bytes, attachment_ids, latency_ms,
    finish_reason, outcome, error_code, http_status, cost_amount, cost_currency, cost_source,
    price_id, extraction_id, thread_id, thing_id, rl_remaining_tokens, rl_reset_at)
  VALUES (
    date_trunc('milliseconds', at), p_ctx->>'request_id',
    coalesce((p_ctx->>'attempt')::smallint, 1), p_ctx->>'task',
    (p_ctx->>'location_id')::uuid, (p_ctx->>'owner_account_id')::uuid, (p_ctx->>'user_id')::uuid,
    p_ctx->>'paying_scope', (p_ctx->>'paying_account_id')::uuid,
    (p_ctx->>'paying_user_id')::uuid, coalesce((p_ctx->>'fell_back')::boolean, false),
    (p_ctx->>'provider_id')::uuid, p_ctx->>'provider_kind', p_ctx->>'model', p_ctx->>'reasoning',
    p_ctx->>'prompt_version', sent, (p_ctx->>'estimate_tokens')::int,
    CASE WHEN sent THEN (p_usage->>'input_tokens')::int END,
    CASE WHEN sent THEN (p_usage->>'output_tokens')::int END,
    CASE WHEN sent THEN (p_usage->>'reasoning_tokens')::int END,
    CASE WHEN sent THEN (p_usage->>'cached_input_tokens')::int END,
    sent AND coalesce((p_usage->>'usage_estimated')::boolean, false),
    coalesce((p_ctx->>'image_count')::smallint, 0), (p_ctx->>'image_tokens_each')::int,
    (p_ctx->>'image_bytes')::int,
    CASE WHEN jsonb_typeof(p_ctx->'attachment_ids') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(p_ctx->'attachment_ids')::uuid) END,
    (p_usage->>'latency_ms')::int, left(p_usage->>'finish_reason', 40), p_outcome,
    p_usage->>'error_code', (p_usage->>'http_status')::smallint,
    CASE WHEN sent THEN (p_cost->>'amount')::numeric END,
    CASE WHEN sent AND p_cost->>'amount' IS NOT NULL THEN p_cost->>'currency' END,
    CASE WHEN NOT sent THEN 'not_sent' ELSE coalesce(p_cost->>'source', 'unknown') END,
    CASE WHEN sent THEN (p_cost->>'price_id')::uuid END,
    (p_ctx->>'extraction_id')::uuid, (p_ctx->>'thread_id')::uuid, (p_ctx->>'thing_id')::uuid,
    (p_usage->>'rl_remaining_tokens')::int, (p_usage->>'rl_reset_at')::timestamptz)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;
