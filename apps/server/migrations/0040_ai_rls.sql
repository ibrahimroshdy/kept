-- Custom SQL migration file, put your code below! --
-- Step 3, task 6: AI providers, caps and budgets, pacing and the call ledger (engineering spec
-- §1.8, §3.3, §3.5, §7.13, §7.15; D19, D121, D167, D202, D206; plan Q5–Q8, Q31). Above, in
-- 0039, drizzle's part: ai_providers, ai_budgets, the counters, ai_breakers, ai_provider_limits,
-- ai_model_prices, llm_calls (partitioned by hand) and ai_usage_months (src/db/schema/ai.ts), and
-- the four new admin alert kinds. Below:
--   1. llm_calls' monthly partitions: kept.create_llm_partition() (as 0005's audit partitions,
--      each locked by kept.lock_partition()), kept.ensure_llm_partitions() for kept_system, the
--      default partition, this month and three more, and kept.llm_default_partition_rows() for
--      the default-partition alert.
--   2. Row-level security and privileges:
--      - ai_providers: the same rule for all four commands (the instance's for instance admins,
--        an account's for its owner, a personal one for its person). The key is write-only:
--        kept_app has SELECT on every column but key_ciphertext and key_version, so `SELECT *`
--        and `SELECT key_ciphertext` are refused (42501). Only the doors hand a key out.
--      - ai_budgets: writers per scope (§7.15 "Who writes"); a location's admins read its row and
--        a person their own member row. The pause and the warnings change only through the doors.
--      - The counters (ai_usage_windows, ai_cost_windows, ai_leases, ai_breakers,
--        ai_provider_limits): no grant and no kept_app policy at all. Only the doors touch them.
--      - ai_model_prices: every signed-in request reads them; written only by the price doors.
--      - llm_calls and ai_usage_months: SELECT only, by the §7.15 visibility rule. **No INSERT,
--        UPDATE or DELETE for kept_app or kept_system**: rows are written by kept.ai_reserve and
--        kept.ai_settle alone, so application code can't forge or mis-attribute a call.
--   3. The doors. Each is SECURITY DEFINER, owned by kept_owner, checks its caller from
--      app.user_id (kept_system, which has no user, only where marked SYS), and raises 42501 for
--      anything the caller can't see. Money caps count only costs in their own currency: the
--      account exchange rates (fx_rates) the spec converts through don't exist yet.
--      - Resolution (plan Q5): ai_provider_resolved, ai_provider_for (the only way to a key for
--        a call), ai_provider_secret ("Test connection" and the model list).
--      - The gate: ai_reserve, ai_settle (the BudgetGate and Ledger ports, src/ai/db-gate.ts).
--      - The pacer: ai_key_admit, ai_key_release, ai_breaker_state, ai_observe, ai_trip,
--        ai_clear_trip (the Pacer port, src/ai/db-pacer.ts; ai/breaker.ts stays the one state
--        machine: ai_breaker_state locks the row, the caller computes, ai_observe stores).
--      - Caps and usage: ai_status, ai_cap_set, ai_cap_clear, ai_pause, ai_resume, ai_usage,
--        ai_instance_calls.
--      - Prices: ai_price_set, ai_price_remove, ai_recost_unknown (the ledger's only UPDATE).
--      - ai_ensure_brand (§7.8: a brand the model proposes, created with normalised dedupe).
--      - SYS: ai_rollover, ai_rollup_and_drop, prune_ai_windows.
-- test/leak.test.ts and src/db/migrate.test.ts list every function; test/leak-capture.ts fills
-- every table, the ledger through kept.ai_settle.

-- 1. Ledger partitions -----------------------------------------------------------------------------
CREATE FUNCTION kept.create_llm_partition(month date) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  first_day date := date_trunc('month', month)::date;
  part text := 'llm_calls_' || to_char(first_day, 'YYYY_MM');
BEGIN
  IF to_regclass('public.' || part) IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.llm_calls FOR VALUES FROM (%L) TO (%L)',
    part, first_day::text || ' 00:00:00+00',
    (first_day + interval '1 month')::date::text || ' 00:00:00+00');
  PERFORM kept.lock_partition(part);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.create_llm_partition(date) FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE FUNCTION kept.ensure_llm_partitions(p_months integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  this_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  month date;
  created integer := 0;
BEGIN
  IF p_months IS NULL OR p_months NOT BETWEEN 0 AND 24 THEN
    RAISE EXCEPTION 'p_months must be between 0 and 24' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR i IN 0..p_months LOOP
    month := (this_month + make_interval(months => i))::date;
    CONTINUE WHEN to_regclass('public.llm_calls_' || to_char(month, 'YYYY_MM')) IS NOT NULL;
    IF EXISTS (
      SELECT 1 FROM public.llm_calls_default d
       WHERE d.at >= (month::text || ' 00:00:00+00')::timestamptz
         AND d.at < ((month + interval '1 month')::date::text || ' 00:00:00+00')::timestamptz
    ) THEN
      RAISE EXCEPTION 'llm_calls_default holds rows for %; move them out before its partition can be created',
        to_char(month, 'YYYY-MM')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'llm_calls_default_has_rows';
    END IF;
    PERFORM kept.create_llm_partition(month);
    created := created + 1;
  END LOOP;
  RETURN created;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ensure_llm_partitions(integer) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ensure_llm_partitions(integer) TO kept_system;
--> statement-breakpoint
CREATE TABLE public.llm_calls_default PARTITION OF public.llm_calls DEFAULT;
--> statement-breakpoint
SELECT kept.lock_partition('llm_calls_default');
--> statement-breakpoint
SELECT kept.ensure_llm_partitions(3);
--> statement-breakpoint
CREATE FUNCTION kept.llm_default_partition_rows()
RETURNS TABLE (n bigint, oldest timestamptz, newest timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*), min(d.at), max(d.at) FROM public.llm_calls_default d
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.llm_default_partition_rows() FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.llm_default_partition_rows() TO kept_system;
--> statement-breakpoint

-- 2. Row-level security and privileges -----------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_providers', 'ai_budgets', 'ai_usage_windows', 'ai_cost_windows',
                           'ai_leases', 'ai_breakers', 'ai_provider_limits', 'ai_model_prices',
                           'llm_calls', 'ai_usage_months'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    -- kept_system reaches all of them through the doors only.
    EXECUTE format('REVOKE ALL ON public.%I FROM kept_system', t);
  END LOOP;
  -- The counters: only the doors, for everyone.
  FOREACH t IN ARRAY ARRAY['ai_usage_windows', 'ai_cost_windows', 'ai_leases', 'ai_breakers',
                           'ai_provider_limits'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM kept_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['ai_providers', 'ai_budgets'] LOOP
    EXECUTE format('CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION kept.touch_row()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ai_providers: write-only keys.
REVOKE SELECT, UPDATE ON public.ai_providers FROM kept_app;
--> statement-breakpoint
GRANT SELECT (id, scope, owner_account_id, user_id, kind, model_list, model_list_at, label,
              base_url, key_hint, models, capabilities, reasoning, disabled_at, created_by,
              created_at, updated_at, row_version, change_seq)
  ON public.ai_providers TO kept_app;
--> statement-breakpoint
GRANT UPDATE (model_list, model_list_at, label, base_url, key_ciphertext, key_version, key_hint,
              models, capabilities, reasoning, disabled_at, updated_at, row_version)
  ON public.ai_providers TO kept_app;
--> statement-breakpoint
CREATE POLICY app_all ON public.ai_providers FOR ALL TO kept_app
  USING ((scope = 'instance' AND (SELECT kept.is_instance_admin()))
         OR (scope = 'account' AND owner_account_id = (SELECT kept.current_owner_account_id()))
         OR (scope = 'user' AND user_id = (SELECT kept.current_user_id())))
  WITH CHECK (((scope = 'instance' AND (SELECT kept.is_instance_admin()))
               OR (scope = 'account' AND owner_account_id = (SELECT kept.current_owner_account_id()))
               OR (scope = 'user' AND user_id = (SELECT kept.current_user_id())))
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint

-- ai_budgets
REVOKE UPDATE ON public.ai_budgets FROM kept_app;
--> statement-breakpoint
GRANT UPDATE (tokens_per_minute, tokens_per_day, tokens_per_month, monthly_cap_amount,
              cap_currency, set_by, updated_at, row_version)
  ON public.ai_budgets TO kept_app;
--> statement-breakpoint
CREATE POLICY app_select ON public.ai_budgets FOR SELECT TO kept_app
  USING ((scope IN ('instance', 'instance_account') AND (SELECT kept.is_instance_admin()))
         OR (scope IN ('account', 'location', 'member')
             AND owner_account_id = (SELECT kept.current_owner_account_id()))
         OR (scope = 'user' AND user_id = (SELECT kept.current_user_id()))
         OR (scope = 'location' AND location_id IN (SELECT kept.admin_location_ids()))
         OR (scope = 'member' AND user_id = (SELECT kept.current_user_id())));
--> statement-breakpoint
-- Writers: a member cap names someone who shares a location with the owner; a location cap one
-- of the owner's own locations (the guard below also ties it to the account).
CREATE POLICY app_insert ON public.ai_budgets FOR INSERT TO kept_app
  WITH CHECK (set_by = (SELECT kept.current_user_id())
              AND ((scope IN ('instance', 'instance_account') AND (SELECT kept.is_instance_admin()))
                   OR (scope = 'account'
                       AND owner_account_id = (SELECT kept.current_owner_account_id()))
                   OR (scope = 'location'
                       AND owner_account_id = (SELECT kept.current_owner_account_id())
                       AND location_id IN (SELECT kept.visible_location_ids()))
                   OR (scope = 'member'
                       AND owner_account_id = (SELECT kept.current_owner_account_id())
                       AND user_id IN (SELECT kept.fellow_member_ids()))
                   OR (scope = 'user' AND user_id = (SELECT kept.current_user_id()))));
--> statement-breakpoint
CREATE POLICY app_update ON public.ai_budgets FOR UPDATE TO kept_app
  USING ((scope IN ('instance', 'instance_account') AND (SELECT kept.is_instance_admin()))
         OR (scope IN ('account', 'location', 'member')
             AND owner_account_id = (SELECT kept.current_owner_account_id()))
         OR (scope = 'user' AND user_id = (SELECT kept.current_user_id())))
  WITH CHECK (set_by = (SELECT kept.current_user_id())
              AND ((scope IN ('instance', 'instance_account') AND (SELECT kept.is_instance_admin()))
                   OR (scope IN ('account', 'location', 'member')
                       AND owner_account_id = (SELECT kept.current_owner_account_id()))
                   OR (scope = 'user' AND user_id = (SELECT kept.current_user_id()))));
--> statement-breakpoint
CREATE POLICY app_delete ON public.ai_budgets FOR DELETE TO kept_app
  USING ((scope IN ('instance', 'instance_account') AND (SELECT kept.is_instance_admin()))
         OR (scope IN ('account', 'location', 'member')
             AND owner_account_id = (SELECT kept.current_owner_account_id()))
         OR (scope = 'user' AND user_id = (SELECT kept.current_user_id())));
--> statement-breakpoint
CREATE FUNCTION kept.guard_ai_budget_location() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.scope = 'location' AND NOT EXISTS (
       SELECT 1 FROM public.locations l
        WHERE l.id = NEW.location_id AND l.owner_account_id = NEW.owner_account_id) THEN
    RAISE EXCEPTION 'a location cap belongs to the location''s own account'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'ai_budgets_location_account';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_ai_budget_location() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER ai_budgets_location BEFORE INSERT OR UPDATE ON public.ai_budgets
  FOR EACH ROW EXECUTE FUNCTION kept.guard_ai_budget_location();
--> statement-breakpoint

-- ai_model_prices: instance reference data, read by every signed-in request.
REVOKE INSERT, UPDATE, DELETE ON public.ai_model_prices FROM kept_app;
--> statement-breakpoint
CREATE POLICY app_select ON public.ai_model_prices FOR SELECT TO kept_app
  USING ((SELECT kept.current_user_id()) IS NOT NULL);
--> statement-breakpoint

-- The ledger and its monthly totals: read only; written only by the doors.
REVOKE INSERT, UPDATE, DELETE ON public.llm_calls, public.ai_usage_months FROM kept_app;
--> statement-breakpoint
CREATE POLICY app_select ON public.llm_calls FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
         OR paying_user_id = (SELECT kept.current_user_id())
         OR location_id IN (SELECT kept.admin_location_ids())
         OR owner_account_id = (SELECT kept.current_owner_account_id())
         OR paying_account_id = (SELECT kept.current_owner_account_id()));
--> statement-breakpoint
CREATE POLICY app_select ON public.ai_usage_months FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
         OR paying_user_id = (SELECT kept.current_user_id())
         OR location_id IN (SELECT kept.admin_location_ids())
         OR owner_account_id = (SELECT kept.current_owner_account_id())
         OR paying_account_id = (SELECT kept.current_owner_account_id()));
--> statement-breakpoint

-- 3. The doors -------------------------------------------------------------------------------------

-- 3a. Helpers. Invoker functions, owned by kept_owner and executable by nobody else: they run only
-- inside the definers below, as kept_owner.

-- Whether this call may use the gate at all: a signed-in person, or kept_system's own login.
CREATE FUNCTION kept.ai_caller_ok() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT kept.current_user_id() IS NOT NULL OR session_user = 'kept_system'
$$;
--> statement-breakpoint
-- Whether the caller manages a provider: the ai_providers policy's rule.
CREATE FUNCTION kept.ai_provider_managed(p_provider uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ai_providers p
     WHERE p.id = p_provider AND kept.current_user_id() IS NOT NULL
       AND ((p.scope = 'instance' AND kept.is_instance_admin())
            OR (p.scope = 'account' AND p.owner_account_id = kept.current_owner_account_id())
            OR (p.scope = 'user' AND p.user_id = kept.current_user_id())))
$$;
--> statement-breakpoint
-- Whether a call by the caller may be paid with this provider (or the caller manages it):
-- kept_system for background work; the instance key for anyone signed in; an account's key for
-- writers of its locations; a personal key for its person.
CREATE FUNCTION kept.ai_provider_reachable(p_provider uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT session_user = 'kept_system' OR EXISTS (
    SELECT 1 FROM public.ai_providers p
     WHERE p.id = p_provider AND kept.current_user_id() IS NOT NULL
       AND (p.scope = 'instance'
            OR (p.scope = 'account'
                AND (p.owner_account_id IN (SELECT kept.writable_account_ids())
                     OR p.owner_account_id = kept.current_owner_account_id()))
            OR (p.scope = 'user' AND p.user_id = kept.current_user_id())))
$$;
--> statement-breakpoint
-- The payer a context names is one the caller may charge (defence in depth: callers take the
-- payer from kept.ai_provider_for, never from input).
CREATE FUNCTION kept.ai_payer_reachable(p_ctx jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT session_user = 'kept_system' OR coalesce(
    kept.current_user_id() IS NOT NULL
    AND CASE p_ctx->>'paying_scope'
          WHEN 'instance' THEN true
          WHEN 'account' THEN (p_ctx->>'paying_account_id')::uuid IN (SELECT kept.writable_account_ids())
                              OR (p_ctx->>'paying_account_id')::uuid = kept.current_owner_account_id()
          WHEN 'user' THEN (p_ctx->>'paying_user_id')::uuid = kept.current_user_id()
          ELSE false END
    AND (p_ctx->>'location_id' IS NULL
         OR (p_ctx->>'location_id')::uuid IN (SELECT kept.visible_location_ids())), false)
$$;
--> statement-breakpoint
-- The buckets a call counts against (§7.15), sorted (the lock order).
CREATE FUNCTION kept.ai_buckets(p_ctx jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(b ORDER BY b COLLATE "C"), '{}') FROM (
    SELECT 'location:' || (p_ctx->>'location_id') AS b WHERE p_ctx->>'location_id' IS NOT NULL
    UNION ALL
    SELECT 'member:' || (p_ctx->>'owner_account_id') || ':' || (p_ctx->>'user_id')
     WHERE p_ctx->>'location_id' IS NOT NULL AND p_ctx->>'user_id' IS NOT NULL
       AND p_ctx->>'owner_account_id' IS NOT NULL
    UNION ALL
    SELECT unnest(CASE p_ctx->>'paying_scope'
      WHEN 'account' THEN ARRAY['account:' || (p_ctx->>'paying_account_id'),
                                'account:' || (p_ctx->>'paying_account_id') || ':'
                                           || (p_ctx->>'budget_task')]
      WHEN 'user' THEN ARRAY['user:' || (p_ctx->>'paying_user_id')]
      WHEN 'instance' THEN ARRAY['instance', 'instance:' || (p_ctx->>'budget_task')]
                           || CASE WHEN p_ctx->>'owner_account_id' IS NULL THEN '{}'::text[]
                                   ELSE ARRAY['instance_account:' || (p_ctx->>'owner_account_id')] END
      ELSE '{}'::text[] END)) x
$$;
--> statement-breakpoint
-- The cap and budget rows that govern a bucket. A per-task bucket with no row gets the default
-- budget the caller passes (`p_defaults`, DEFAULT_BUDGETS, Q7) as a row of its own, and an
-- account's instance allowance with no row of its own gets a copy of the default one: a pause
-- needs a row to live on, and it must pause that account only. Both are marked set_by the nil
-- uuid ("Kept"). The gate passes its defaults (at least '{}'); with p_defaults NULL nothing is
-- created (reads).
CREATE FUNCTION kept.ai_bucket_rows(p_bucket text, p_defaults jsonb)
RETURNS SETOF public.ai_budgets
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  kind text := split_part(p_bucket, ':', 1);
  a text := nullif(split_part(p_bucket, ':', 2), '');
  b text := nullif(split_part(p_bucket, ':', 3), '');
  d jsonb;
  nil constant uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  IF kind = 'location' THEN
    RETURN QUERY SELECT * FROM public.ai_budgets x
      WHERE x.scope = 'location' AND x.location_id = a::uuid AND x.task IS NULL;
  ELSIF kind = 'member' THEN
    RETURN QUERY SELECT * FROM public.ai_budgets x
      WHERE x.scope = 'member' AND x.owner_account_id = a::uuid AND x.user_id = b::uuid
        AND x.task IS NULL;
  ELSIF kind = 'user' THEN
    RETURN QUERY SELECT * FROM public.ai_budgets x
      WHERE x.scope = 'user' AND x.user_id = a::uuid AND x.task IS NULL;
  ELSIF kind = 'account' AND b IS NULL THEN
    RETURN QUERY SELECT * FROM public.ai_budgets x
      WHERE x.scope = 'account' AND x.owner_account_id = a::uuid AND x.task IS NULL;
  ELSIF kind = 'account' OR (kind = 'instance' AND a IS NOT NULL) THEN
    d := p_defaults -> coalesce(b, a);
    IF d IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.ai_budgets x
          WHERE x.scope = kind AND x.task = coalesce(b, a)
            AND x.owner_account_id IS NOT DISTINCT FROM (CASE WHEN kind = 'account' THEN a::uuid END)) THEN
      INSERT INTO public.ai_budgets (scope, owner_account_id, task, tokens_per_minute,
                                     tokens_per_day, tokens_per_month, set_by)
      VALUES (kind, CASE WHEN kind = 'account' THEN a::uuid END, coalesce(b, a),
              (d->>'tokens_per_minute')::int, (d->>'tokens_per_day')::int,
              (d->>'tokens_per_month')::bigint, nil)
      ON CONFLICT ON CONSTRAINT ai_budgets_scope_uq DO NOTHING;
    END IF;
    RETURN QUERY SELECT * FROM public.ai_budgets x
      WHERE x.scope = kind AND x.task = coalesce(b, a)
        AND x.owner_account_id IS NOT DISTINCT FROM (CASE WHEN kind = 'account' THEN a::uuid END);
  ELSIF kind = 'instance' THEN
    RETURN QUERY SELECT * FROM public.ai_budgets x WHERE x.scope = 'instance' AND x.task IS NULL;
  ELSIF kind = 'instance_account' THEN
    IF p_defaults IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.ai_budgets x
          WHERE x.scope = 'instance_account' AND x.owner_account_id = a::uuid AND x.task IS NULL) THEN
      INSERT INTO public.ai_budgets (scope, owner_account_id, tokens_per_month, monthly_cap_amount,
                                     cap_currency, set_by)
      SELECT 'instance_account', a::uuid, x.tokens_per_month, x.monthly_cap_amount, x.cap_currency,
             nil
        FROM public.ai_budgets x
       WHERE x.scope = 'instance_account' AND x.owner_account_id IS NULL AND x.task IS NULL
      ON CONFLICT ON CONSTRAINT ai_budgets_scope_uq DO NOTHING;
    END IF;
    RETURN QUERY SELECT * FROM public.ai_budgets x
      WHERE x.scope = 'instance_account' AND x.task IS NULL
        AND x.owner_account_id = a::uuid;
    IF NOT FOUND THEN
      RETURN QUERY SELECT * FROM public.ai_budgets x
        WHERE x.scope = 'instance_account' AND x.task IS NULL AND x.owner_account_id IS NULL;
    END IF;
  END IF;
END $$;
--> statement-breakpoint
-- The bucket a cap row governs (the reverse of the above).
CREATE FUNCTION kept.ai_row_bucket(r public.ai_budgets) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE r.scope
    WHEN 'location' THEN 'location:' || r.location_id
    WHEN 'member' THEN 'member:' || r.owner_account_id || ':' || r.user_id
    WHEN 'user' THEN 'user:' || r.user_id
    WHEN 'account' THEN 'account:' || r.owner_account_id || coalesce(':' || r.task, '')
    WHEN 'instance' THEN 'instance' || coalesce(':' || r.task, '')
    ELSE 'instance_account:' || coalesce(r.owner_account_id::text, '*') END
$$;
--> statement-breakpoint
-- Window starts (UTC, D188).
CREATE FUNCTION kept.ai_window_start(p_kind text) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT date_trunc(p_kind, now(), 'UTC')
$$;
--> statement-breakpoint
CREATE FUNCTION kept.ai_used(p_bucket text, p_kind text) RETURNS bigint
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT w.tokens FROM public.ai_usage_windows w
                    WHERE w.bucket = p_bucket AND w.window_kind = p_kind
                      AND w.window_start = kept.ai_window_start(p_kind)), 0)
$$;
--> statement-breakpoint
CREATE FUNCTION kept.ai_spent(p_bucket text, p_currency text) RETURNS numeric
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT c.amount FROM public.ai_cost_windows c
                    WHERE c.bucket = p_bucket AND c.currency = p_currency
                      AND c.month_start = kept.ai_window_start('month')::date), 0)
$$;
--> statement-breakpoint
CREATE FUNCTION kept.ai_tokens_add(p_bucket text, p_tokens bigint, p_calls integer) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, public AS $$
  INSERT INTO public.ai_usage_windows (bucket, window_kind, window_start, tokens, calls)
  SELECT p_bucket, k, kept.ai_window_start(k), p_tokens, p_calls
    FROM unnest(ARRAY['minute', 'day', 'month']) AS k
  ON CONFLICT (bucket, window_kind, window_start)
  DO UPDATE SET tokens = ai_usage_windows.tokens + EXCLUDED.tokens,
                calls = ai_usage_windows.calls + EXCLUDED.calls
$$;
--> statement-breakpoint
CREATE FUNCTION kept.ai_cost_add(p_bucket text, p_month date, p_currency text, p_amount numeric)
RETURNS void
LANGUAGE sql SET search_path = pg_catalog, public AS $$
  INSERT INTO public.ai_cost_windows (bucket, month_start, currency, amount)
  VALUES (p_bucket, p_month, p_currency, p_amount)
  ON CONFLICT (bucket, month_start, currency)
  DO UPDATE SET amount = ai_cost_windows.amount + EXCLUDED.amount
$$;
--> statement-breakpoint
-- One ledger row from a call context, its usage, outcome and cost (never a prompt, image, reply,
-- provider message or key: there is no field to put one in).
CREATE FUNCTION kept.ai_insert_call(p_ctx jsonb, p_usage jsonb, p_outcome text, p_cost jsonb)
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
    cached_input_tokens, image_count, image_tokens_each, image_bytes, attachment_ids, latency_ms,
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
--> statement-breakpoint
-- Who pays and with which key (plan Q5; ai/resolve.ts is the same order in TypeScript):
-- a Personal location: its owner's personal key, their account's, the instance's; any other
-- location: its owner account's, then the instance's; no location: the person's own key, their
-- account's, the instance's. Usable: not disabled, keyed (or openai_compatible with a base URL),
-- not rejected (`auth`), and with a model for the task. `fell_back`: not the first in the order.
CREATE FUNCTION kept.ai_cascade(p_location uuid, p_user uuid, p_task text)
RETURNS TABLE (provider_id uuid, scope text, kind text, base_url text, model text,
               reasoning text, structured boolean, key_ciphertext jsonb, key_version integer,
               paying_scope text, paying_account_id uuid, paying_user_id uuid,
               fell_back boolean, owner_account_id uuid, tripped_until timestamptz,
               trip_reason text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  mk text := CASE p_task WHEN 'extraction' THEN 'vision' WHEN 'assistant' THEN 'chat'
                         WHEN 'embeddings' THEN 'embeddings' END;
  acct uuid;
  owner_user uuid;
  personal boolean := false;
BEGIN
  IF mk IS NULL THEN
    RAISE EXCEPTION 'unknown AI task %', p_task USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_location IS NOT NULL THEN
    SELECT l.owner_account_id, l.kind = 'personal', oa.user_id INTO acct, personal, owner_user
      FROM public.locations l JOIN public.owner_accounts oa ON oa.id = l.owner_account_id
     WHERE l.id = p_location;
  ELSE
    SELECT oa.id INTO acct FROM public.owner_accounts oa WHERE oa.user_id = p_user;
    owner_user := p_user;
    personal := true;
  END IF;
  RETURN QUERY
    WITH ord(n, sc, who) AS (
      SELECT 1, 'user', owner_user WHERE personal
      UNION ALL SELECT 2, 'account', acct
      UNION ALL SELECT 3, 'instance', NULL::uuid)
    SELECT p.id, p.scope, p.kind, p.base_url, p.models->>mk, p.reasoning,
           coalesce((p.capabilities->>'structured')::boolean, false),
           p.key_ciphertext, p.key_version, p.scope,
           CASE WHEN p.scope = 'account' THEN p.owner_account_id END,
           CASE WHEN p.scope = 'user' THEN p.user_id END,
           o.n > (SELECT min(n) FROM ord), acct, br.until, br.reason
      FROM ord o
      JOIN public.ai_providers p
        ON p.scope = o.sc AND p.disabled_at IS NULL
       AND (o.sc = 'instance' OR (o.sc = 'account' AND p.owner_account_id = o.who)
            OR (o.sc = 'user' AND p.user_id = o.who))
      LEFT JOIN public.ai_breakers br ON br.provider_id = p.id
     WHERE (p.key_ciphertext IS NOT NULL OR (p.kind = 'openai_compatible' AND p.base_url IS NOT NULL))
       AND NOT coalesce(br.reason = 'auth' AND br.until > now(), false)
       AND coalesce(p.models->>mk, '') <> ''
     ORDER BY o.n
     LIMIT 1;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_caller_ok(), kept.ai_provider_managed(uuid),
  kept.ai_provider_reachable(uuid), kept.ai_payer_reachable(jsonb), kept.ai_buckets(jsonb),
  kept.ai_bucket_rows(text, jsonb), kept.ai_row_bucket(public.ai_budgets),
  kept.ai_window_start(text), kept.ai_used(text, text), kept.ai_spent(text, text),
  kept.ai_tokens_add(text, bigint, integer), kept.ai_cost_add(text, date, text, numeric),
  kept.ai_insert_call(jsonb, jsonb, text, jsonb), kept.ai_cascade(uuid, uuid, text)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 3b. Resolution ----------------------------------------------------------------------------------
-- Whether AI capture can run in a location for the caller (ProviderResolver, http/modules.ts):
-- false for a location the caller can't see.
CREATE FUNCTION kept.ai_provider_resolved(p_location uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT kept.current_user_id() IS NOT NULL
     AND coalesce(p_location IN (SELECT kept.visible_location_ids()), false)
     AND EXISTS (SELECT 1 FROM kept.ai_cascade(p_location, kept.current_user_id(), 'extraction'))
$$;
--> statement-breakpoint
-- The key and the payer for a call: the only way kept_app reaches a key (ai/db-keys.ts).
-- Extraction needs a writable location (ai.capture: owners, admins, members); the assistant and
-- embeddings a visible one; NULL is the caller's own work (their key, their account's, the
-- instance's). Anything else, 42501.
CREATE FUNCTION kept.ai_provider_for(p_location uuid, p_task text)
RETURNS TABLE (provider_id uuid, scope text, kind text, base_url text, model text,
               reasoning text, structured boolean, key_ciphertext jsonb, key_version integer,
               paying_scope text, paying_account_id uuid, paying_user_id uuid,
               fell_back boolean, owner_account_id uuid, tripped_until timestamptz,
               trip_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
BEGIN
  IF uid IS NULL OR (p_location IS NOT NULL AND NOT coalesce(
       CASE WHEN p_task = 'extraction' THEN p_location IN (SELECT kept.writable_location_ids())
            ELSE p_location IN (SELECT kept.visible_location_ids()) END, false)) THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT * FROM kept.ai_cascade(p_location, uid, p_task);
END $$;
--> statement-breakpoint
-- One provider the caller manages, with its key, for "Test connection" and the model list (T9).
CREATE FUNCTION kept.ai_provider_secret(p_provider uuid, p_task text)
RETURNS TABLE (kind text, base_url text, key_ciphertext jsonb, key_version integer, model text,
               scope text, owner_account_id uuid, user_id uuid, reasoning text,
               structured boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT kept.ai_provider_managed(p_provider) THEN
    RAISE EXCEPTION 'no such provider of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT p.kind, p.base_url, p.key_ciphertext, p.key_version,
           p.models->>(CASE p_task WHEN 'extraction' THEN 'vision' WHEN 'assistant' THEN 'chat'
                                   WHEN 'embeddings' THEN 'embeddings' END),
           p.scope, p.owner_account_id, p.user_id, p.reasoning,
           coalesce((p.capabilities->>'structured')::boolean, false)
      FROM public.ai_providers p WHERE p.id = p_provider;
END $$;
--> statement-breakpoint

-- 3c. The gate (the BudgetGate and Ledger ports; src/ai/db-gate.ts) ------------------------------
-- kept.ai_reserve(ctx): ctx carries the resolved payer (paying_scope, paying_account_id,
-- paying_user_id), the location and its owner account, the person (null: background),
-- budget_task, estimate_tokens, estimate_cost {amount, currency} (null without a price), job_id,
-- `defaults` (DEFAULT_BUDGETS by task, Q7), `payer_slots` (2), and optionally `call`: the ledger
-- fields of the call being held (kept.ai_insert_call's). In one statement, under advisory locks
-- taken per bucket in sorted order (two reservations never deadlock):
--   1. a paused row on any bucket refuses, with its reason;
--   2. the minute window over its budget is a short wait (`tpm`, no ledger row); the day window
--      over its budget pauses the row until tomorrow 00:00 UTC (`tokens_day`); the month's tokens
--      or money (its own currency) over the cap pause it until the 1st (`cap_tokens`,
--      `cap_money`), with warned_100_month;
--   3. the payer's slots (2) full is a short wait (`concurrency`, 15 s, no row);
--   4. otherwise the estimate is added to every bucket's windows (tokens) and cost windows, a
--      payer slot is leased for 5 minutes, and the reservation id comes back as call_id.
-- A refusal that pauses work (1, 2's pauses) writes one `sent = false` ledger row when `call` is
-- given (outcome over_budget, error_code `<bucket kind>_<reason>`) and returns its id.
-- It checks nothing about the caller beyond scope and the payer being one the caller may charge:
-- its callers take the payer from kept.ai_provider_for, never from input.
CREATE FUNCTION kept.ai_reserve(p_ctx jsonb)
RETURNS TABLE (ok boolean, retry_at timestamptz, reason text, bucket text, call_id uuid,
               buckets text[], slot integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  bs text[] := kept.ai_buckets(p_ctx);
  bk text;
  r public.ai_budgets%ROWTYPE;
  est bigint := greatest(coalesce((p_ctx->>'estimate_tokens')::bigint, 0), 0);
  est_amount numeric := (p_ctx->'estimate_cost'->>'amount')::numeric;
  est_currency text := p_ctx->'estimate_cost'->>'currency';
  month_date date := kept.ai_window_start('month')::date;
  lease text;
  slots integer := coalesce((p_ctx->>'payer_slots')::int, 2);
  s integer;
  took integer;
  res uuid := uuidv7();
  refuse_reason text;
  refuse_until timestamptz;
  refuse_bucket text;
  held uuid;
BEGIN
  IF NOT kept.ai_caller_ok() OR NOT kept.ai_payer_reachable(p_ctx) THEN
    RAISE EXCEPTION 'not a payer of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cardinality(bs) = 0 THEN
    RAISE EXCEPTION 'a reservation needs a payer' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOREACH bk IN ARRAY bs LOOP
    PERFORM pg_advisory_xact_lock(hashtext('kept.ai'), hashtext(bk));
  END LOOP;

  -- 1. Paused.
  <<paused>>
  FOREACH bk IN ARRAY bs LOOP
    FOR r IN SELECT * FROM kept.ai_bucket_rows(bk, coalesce(p_ctx->'defaults', '{}')) LOOP
      IF r.paused_until > now() THEN
        refuse_reason := r.paused_reason; refuse_until := r.paused_until; refuse_bucket := bk;
        EXIT paused;
      END IF;
    END LOOP;
  END LOOP;

  -- 2. Windows and caps.
  IF refuse_reason IS NULL THEN
    <<windows>>
    FOREACH bk IN ARRAY bs LOOP
      FOR r IN SELECT * FROM kept.ai_bucket_rows(bk, coalesce(p_ctx->'defaults', '{}')) LOOP
        IF r.tokens_per_minute IS NOT NULL
           AND kept.ai_used(bk, 'minute') + est > r.tokens_per_minute THEN
          RETURN QUERY SELECT false, kept.ai_window_start('minute') + interval '1 minute', 'tpm'::text,
                              bk, NULL::uuid, bs, NULL::integer;
          RETURN;
        END IF;
        IF r.tokens_per_day IS NOT NULL AND kept.ai_used(bk, 'day') + est > r.tokens_per_day THEN
          refuse_reason := 'tokens_day';
          refuse_until := kept.ai_window_start('day') + interval '1 day';
        ELSIF r.tokens_per_month IS NOT NULL
              AND kept.ai_used(bk, 'month') + est > r.tokens_per_month THEN
          refuse_reason := 'cap_tokens';
          refuse_until := kept.ai_window_start('month') + interval '1 month';
        ELSIF r.monthly_cap_amount IS NOT NULL
              AND kept.ai_spent(bk, r.cap_currency)
                  + (CASE WHEN est_currency = r.cap_currency THEN coalesce(est_amount, 0) ELSE 0 END)
                  > r.monthly_cap_amount THEN
          refuse_reason := 'cap_money';
          refuse_until := kept.ai_window_start('month') + interval '1 month';
        END IF;
        IF refuse_reason IS NOT NULL THEN
          UPDATE public.ai_budgets x
             SET paused_until = refuse_until, paused_reason = refuse_reason,
                 warned_100_month = CASE WHEN refuse_reason IN ('cap_tokens', 'cap_money')
                                         THEN month_date ELSE x.warned_100_month END
           WHERE x.id = r.id;
          refuse_bucket := bk;
          EXIT windows;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  IF refuse_reason IS NOT NULL THEN
    IF p_ctx ? 'call' THEN
      held := kept.ai_insert_call(
        p_ctx->'call', jsonb_build_object('sent', false, 'error_code',
          left(split_part(refuse_bucket, ':', 1) || '_' || refuse_reason, 40)),
        'over_budget', NULL);
    END IF;
    RETURN QUERY SELECT false, refuse_until, refuse_reason, refuse_bucket, held, bs, NULL::integer;
    RETURN;
  END IF;

  -- 3. The payer's slots.
  lease := 'payer:' || (p_ctx->>'paying_scope') || ':'
           || coalesce(p_ctx->>'paying_account_id', p_ctx->>'paying_user_id', 'instance');
  PERFORM pg_advisory_xact_lock(hashtext('kept.ai'), hashtext(lease));
  FOR s IN 1..least(greatest(slots, 1), 4) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.ai_leases l
                    WHERE l.lease_key = lease AND l.slot = s AND l.lease_until > now()) THEN
      took := s;
      EXIT;
    END IF;
  END LOOP;
  IF took IS NULL THEN
    RETURN QUERY SELECT false, now() + interval '15 seconds', 'concurrency'::text, NULL::text,
                        NULL::uuid, bs, NULL::integer;
    RETURN;
  END IF;
  INSERT INTO public.ai_leases (lease_key, slot, job_id, lease_until)
  VALUES (lease, took, res::text, now() + interval '5 minutes')
  ON CONFLICT ON CONSTRAINT ai_leases_pk DO UPDATE
    SET job_id = EXCLUDED.job_id, lease_until = EXCLUDED.lease_until;

  -- 4. The estimate, on every bucket.
  FOREACH bk IN ARRAY bs LOOP
    PERFORM kept.ai_tokens_add(bk, est, 1);
    IF est_amount IS NOT NULL THEN
      PERFORM kept.ai_cost_add(bk, month_date, est_currency, est_amount);
    END IF;
  END LOOP;
  RETURN QUERY SELECT true, NULL::timestamptz, NULL::text, NULL::text, res, bs, took;
END $$;
--> statement-breakpoint
-- kept.ai_settle(ctx, usage, outcome, cost): ctx is the call's (as ai_reserve's, with its ledger
-- fields at the top level), plus `reservation` {id, slot, estimate_tokens, estimate_cost} when it
-- settles one and `record` (default true) when it writes the ledger row. usage: sent, the token
-- counts, `tokens` (what counts against the buckets; default input + output), latency_ms,
-- finish_reason, error_code, http_status, rl_remaining_tokens, rl_reset_at, rl_limit_tokens.
-- cost: {amount, currency, source, price_id}. It writes the row, trues up every bucket (actual −
-- estimate tokens; the real cost replaces the estimated one), frees the payer slot, stores the
-- provider's rate-limit headers, and returns the monthly caps this call took past 80% or 100%
-- (once per cap per month; 100% pauses the cap until the 1st): [{budgetId, bucket, level, month}].
CREATE FUNCTION kept.ai_settle(p_ctx jsonb, p_usage jsonb, p_outcome text, p_cost jsonb)
RETURNS TABLE (call_id uuid, crossed jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  res jsonb := p_ctx->'reservation';
  new_call uuid;
  out_crossed jsonb := '[]';
  bs text[];
  bk text;
  r public.ai_budgets%ROWTYPE;
  est bigint := greatest(coalesce((res->>'estimate_tokens')::bigint, 0), 0);
  actual bigint := greatest(coalesce((p_usage->>'tokens')::bigint,
                                     coalesce((p_usage->>'input_tokens')::bigint, 0)
                                     + coalesce((p_usage->>'output_tokens')::bigint, 0)), 0);
  est_amount numeric := (res->'estimate_cost'->>'amount')::numeric;
  est_currency text := res->'estimate_cost'->>'currency';
  cost_amount numeric := (p_cost->>'amount')::numeric;
  cost_currency text := p_cost->>'currency';
  month_date date := kept.ai_window_start('month')::date;
  tok_before bigint;
  tok_after bigint;
  money_before numeric;
  money_after numeric;
  pb numeric;
  pa numeric;
  unit text;
  lease text;
BEGIN
  IF NOT kept.ai_caller_ok() OR NOT kept.ai_payer_reachable(p_ctx) THEN
    RAISE EXCEPTION 'not a payer of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce((p_ctx->>'record')::boolean, true) THEN
    new_call := kept.ai_insert_call(p_ctx, p_usage, p_outcome, p_cost);
  END IF;

  IF res IS NOT NULL THEN
    bs := kept.ai_buckets(p_ctx);
    FOREACH bk IN ARRAY bs LOOP
      PERFORM pg_advisory_xact_lock(hashtext('kept.ai'), hashtext(bk));
    END LOOP;
    lease := 'payer:' || (p_ctx->>'paying_scope') || ':'
             || coalesce(p_ctx->>'paying_account_id', p_ctx->>'paying_user_id', 'instance');
    DELETE FROM public.ai_leases l
     WHERE l.lease_key = lease AND l.job_id = res->>'id';
    -- Only a reservation still holding its slot is trued up: a second settle of it is a no-op.
    IF FOUND THEN
      FOREACH bk IN ARRAY bs LOOP
        tok_before := kept.ai_used(bk, 'month') - est;
        PERFORM kept.ai_tokens_add(bk, actual - est, 0);
        tok_after := kept.ai_used(bk, 'month');
        IF est_amount IS NOT NULL THEN
          PERFORM kept.ai_cost_add(bk, month_date, est_currency, -est_amount);
        END IF;
        money_before := CASE WHEN cost_currency IS NOT NULL THEN kept.ai_spent(bk, cost_currency) END;
        IF cost_amount IS NOT NULL THEN
          PERFORM kept.ai_cost_add(bk, month_date, cost_currency, cost_amount);
        END IF;
        money_after := CASE WHEN cost_currency IS NOT NULL THEN kept.ai_spent(bk, cost_currency) END;

        FOR r IN SELECT * FROM kept.ai_bucket_rows(bk, coalesce(p_ctx->'defaults', '{}')) LOOP
          unit := NULL; pb := 0; pa := 0;
          IF r.tokens_per_month IS NOT NULL THEN
            pb := tok_before * 100.0 / r.tokens_per_month;
            pa := tok_after * 100.0 / r.tokens_per_month;
            unit := 'tokens';
          END IF;
          IF r.monthly_cap_amount > 0 AND cost_currency = r.cap_currency
             AND money_after * 100.0 / r.monthly_cap_amount > pa THEN
            pb := money_before * 100.0 / r.monthly_cap_amount;
            pa := money_after * 100.0 / r.monthly_cap_amount;
            unit := 'money';
          END IF;
          CONTINUE WHEN unit IS NULL;
          IF pb < 80 AND pa >= 80 AND r.warned_80_month IS DISTINCT FROM month_date THEN
            UPDATE public.ai_budgets SET warned_80_month = month_date WHERE id = r.id;
            out_crossed := out_crossed || jsonb_build_object(
              'budgetId', r.id, 'bucket', bk, 'level', 80, 'month', month_date::text);
          END IF;
          IF pb < 100 AND pa >= 100 AND r.warned_100_month IS DISTINCT FROM month_date THEN
            UPDATE public.ai_budgets
               SET warned_100_month = month_date,
                   paused_until = kept.ai_window_start('month') + interval '1 month',
                   paused_reason = CASE unit WHEN 'money' THEN 'cap_money' ELSE 'cap_tokens' END
             WHERE id = r.id;
            out_crossed := out_crossed || jsonb_build_object(
              'budgetId', r.id, 'bucket', bk, 'level', 100, 'month', month_date::text);
          END IF;
        END LOOP;
      END LOOP;
    END IF;
  END IF;

  IF p_ctx->>'provider_id' IS NOT NULL
     AND (p_usage ? 'rl_remaining_tokens' OR p_usage ? 'rl_reset_at') THEN
    INSERT INTO public.ai_provider_limits (provider_id, limit_tokens, remaining_tokens, reset_at,
                                           updated_at)
    SELECT p.id, (p_usage->>'rl_limit_tokens')::int, (p_usage->>'rl_remaining_tokens')::int,
           (p_usage->>'rl_reset_at')::timestamptz, now()
      FROM public.ai_providers p WHERE p.id = (p_ctx->>'provider_id')::uuid
    ON CONFLICT (provider_id) DO UPDATE
      SET limit_tokens = coalesce(EXCLUDED.limit_tokens, ai_provider_limits.limit_tokens),
          remaining_tokens = EXCLUDED.remaining_tokens, reset_at = EXCLUDED.reset_at,
          updated_at = EXCLUDED.updated_at;
  END IF;
  RETURN QUERY SELECT new_call, out_crossed;
END $$;
--> statement-breakpoint

-- 3d. The pacer (the Pacer port; src/ai/db-pacer.ts) ----------------------------------------------
-- For a provider the caller may be charged with or manages (kept_system: any).
--
-- kept.ai_key_admit(provider, estimate, job): the breaker (a trip holds until it ends), then the
-- provider's own token window (remaining below the estimate before the reset: sleep up to 10 s in
-- place, else hold until the reset, `limits`), then the key's concurrency (1 for groq, else 2;
-- a slot leased for 5 minutes; none free holds 15 s, `concurrency`). kind: ok · sleep · hold.
CREATE FUNCTION kept.ai_key_admit(p_provider uuid, p_estimate integer, p_job text)
RETURNS TABLE (ok boolean, kind text, until timestamptz, reason text, slot integer,
               wait_ms integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  pkind text;
  br public.ai_breakers%ROWTYPE;
  lim public.ai_provider_limits%ROWTYPE;
  lease text := 'key:' || p_provider;
  n integer;
  took integer;
  ms integer;
BEGIN
  IF p_job IS NULL OR NOT kept.ai_provider_reachable(p_provider) THEN
    RAISE EXCEPTION 'no such provider of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.kind INTO pkind FROM public.ai_providers p WHERE p.id = p_provider;
  PERFORM pg_advisory_xact_lock(hashtext('kept.ai'), hashtext(lease));
  SELECT * INTO br FROM public.ai_breakers b WHERE b.provider_id = p_provider;
  IF br.reason IS NOT NULL AND br.until > now() THEN
    RETURN QUERY SELECT false, 'hold'::text, br.until, br.reason, NULL::integer, NULL::integer;
    RETURN;
  END IF;
  SELECT * INTO lim FROM public.ai_provider_limits l WHERE l.provider_id = p_provider;
  IF lim.remaining_tokens IS NOT NULL AND lim.reset_at > now()
     AND lim.remaining_tokens < coalesce(p_estimate, 0) THEN
    ms := ceil(extract(epoch FROM lim.reset_at - now()) * 1000)::int;
    IF ms <= 10000 THEN
      RETURN QUERY SELECT false, 'sleep'::text, lim.reset_at, 'limits'::text, NULL::integer, ms;
    ELSE
      RETURN QUERY SELECT false, 'hold'::text, lim.reset_at, 'limits'::text, NULL::integer,
                          NULL::integer;
    END IF;
    RETURN;
  END IF;
  n := CASE pkind WHEN 'groq' THEN 1 ELSE 2 END;
  SELECT s INTO took FROM generate_series(1, n) AS s
   WHERE NOT EXISTS (SELECT 1 FROM public.ai_leases l
                      WHERE l.lease_key = lease AND l.slot = s AND l.lease_until > now()
                        AND l.job_id <> p_job)
   ORDER BY s LIMIT 1;
  IF took IS NULL THEN
    RETURN QUERY SELECT false, 'hold'::text, now() + interval '15 seconds', 'concurrency'::text,
                        NULL::integer, NULL::integer;
    RETURN;
  END IF;
  INSERT INTO public.ai_leases (lease_key, slot, job_id, lease_until)
  VALUES (lease, took, p_job, now() + interval '5 minutes')
  ON CONFLICT ON CONSTRAINT ai_leases_pk DO UPDATE
    SET job_id = EXCLUDED.job_id, lease_until = EXCLUDED.lease_until;
  RETURN QUERY SELECT true, 'ok'::text, NULL::timestamptz, NULL::text, took, NULL::integer;
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.ai_key_release(p_provider uuid, p_slot integer, p_job text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT kept.ai_provider_reachable(p_provider) THEN
    RAISE EXCEPTION 'no such provider of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.ai_leases l
   WHERE l.lease_key = 'key:' || p_provider AND l.slot = p_slot AND l.job_id = p_job;
  RETURN FOUND;
END $$;
--> statement-breakpoint
-- The breaker's stored state, locked for the rest of the caller's transaction: the caller runs
-- ai/breaker.ts nextBreaker() on it and stores the result with kept.ai_observe().
CREATE FUNCTION kept.ai_breaker_state(p_provider uuid)
RETURNS TABLE (reason text, until timestamptz, trips integer, recent_errors timestamptz[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT kept.ai_provider_reachable(p_provider) THEN
    RAISE EXCEPTION 'no such provider of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.ai_breakers (provider_id) VALUES (p_provider)
  ON CONFLICT (provider_id) DO NOTHING;
  RETURN QUERY
    SELECT b.reason, b.until, b.trips, b.recent_errors FROM public.ai_breakers b
     WHERE b.provider_id = p_provider FOR UPDATE;
END $$;
--> statement-breakpoint
-- After a call: the breaker's next state {reason, until, trips, recentErrors} and the provider's
-- window {limitTokens, remainingTokens, resetAt} (either may be null: left as it is).
CREATE FUNCTION kept.ai_observe(p_provider uuid, p_breaker jsonb, p_limits jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT kept.ai_provider_reachable(p_provider) THEN
    RAISE EXCEPTION 'no such provider of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_breaker IS NOT NULL THEN
    INSERT INTO public.ai_breakers AS b (provider_id, reason, until, trips, recent_errors,
                                         updated_at)
    VALUES (p_provider, p_breaker->>'reason', (p_breaker->>'until')::timestamptz,
            coalesce((p_breaker->>'trips')::int, 0),
            coalesce(ARRAY(SELECT jsonb_array_elements_text(p_breaker->'recentErrors')::timestamptz),
                     '{}'),
            now())
    ON CONFLICT (provider_id) DO UPDATE
      SET reason = EXCLUDED.reason, until = EXCLUDED.until, trips = EXCLUDED.trips,
          recent_errors = EXCLUDED.recent_errors, updated_at = EXCLUDED.updated_at;
  END IF;
  IF p_limits IS NOT NULL THEN
    INSERT INTO public.ai_provider_limits (provider_id, limit_tokens, remaining_tokens, reset_at,
                                           updated_at)
    VALUES (p_provider, (p_limits->>'limitTokens')::int, (p_limits->>'remainingTokens')::int,
            (p_limits->>'resetAt')::timestamptz, now())
    ON CONFLICT (provider_id) DO UPDATE
      SET limit_tokens = EXCLUDED.limit_tokens, remaining_tokens = EXCLUDED.remaining_tokens,
          reset_at = EXCLUDED.reset_at, updated_at = EXCLUDED.updated_at;
  END IF;
END $$;
--> statement-breakpoint
-- A trip set directly (a caller that saw the provider refuse outside callModel, T9).
CREATE FUNCTION kept.ai_trip(p_provider uuid, p_until timestamptz, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT kept.ai_provider_reachable(p_provider) THEN
    RAISE EXCEPTION 'no such provider of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.ai_breakers AS b (provider_id, reason, until, updated_at)
  VALUES (p_provider, p_reason, p_until, now())
  ON CONFLICT (provider_id) DO UPDATE
    SET reason = EXCLUDED.reason, until = EXCLUDED.until, updated_at = EXCLUDED.updated_at;
END $$;
--> statement-breakpoint
-- A replaced key clears a rejected-key (`auth`) trip; other trips run their course. For the
-- provider's manager (T9, on saving a new key).
CREATE FUNCTION kept.ai_clear_trip(p_provider uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT kept.ai_provider_managed(p_provider) THEN
    RAISE EXCEPTION 'no such provider of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.ai_breakers b SET reason = NULL, until = NULL, updated_at = now()
   WHERE b.provider_id = p_provider AND b.reason = 'auth';
  RETURN FOUND;
END $$;
--> statement-breakpoint

-- 3e. Caps, pauses and status -------------------------------------------------------------------
-- Whether the caller writes a cap row (§7.15 "Who writes").
CREATE FUNCTION kept.ai_budget_writable(r public.ai_budgets) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(kept.current_user_id() IS NOT NULL AND CASE
    WHEN r.scope IN ('instance', 'instance_account') THEN kept.is_instance_admin()
    WHEN r.scope IN ('account', 'location', 'member')
      THEN r.owner_account_id = kept.current_owner_account_id()
    ELSE r.user_id = kept.current_user_id() END, false)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_budget_writable(public.ai_budgets)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
-- The status line (screens §5): who would pay, what pauses it (the first paused cap among the
-- call's buckets, its scope and a label), what the key is waiting for, the month's percent of
-- the tightest cap, and whether the caller may resume or manage. Members and viewers read it;
-- never any key material.
CREATE FUNCTION kept.ai_status(p_location uuid)
RETURNS TABLE (resolved boolean, source text, kind text, model text, paused_until timestamptz,
               paused_reason text, paused_scope text, paused_label text,
               waiting_until timestamptz, waiting_reason text, cap_percent integer,
               can_resume boolean, can_manage boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  acct uuid;
  pr record;
  bk text;
  r public.ai_budgets%ROWTYPE;
  pct numeric;
  best numeric;
BEGIN
  IF uid IS NULL OR NOT coalesce(p_location IN (SELECT kept.visible_location_ids()), false) THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT l.owner_account_id INTO acct FROM public.locations l WHERE l.id = p_location;
  SELECT * INTO pr FROM kept.ai_cascade(p_location, uid, 'extraction');
  resolved := pr.provider_id IS NOT NULL;
  can_manage := coalesce(acct = kept.current_owner_account_id(), false);
  can_resume := false;
  IF resolved THEN
    source := pr.scope; kind := pr.kind; model := pr.model;
    FOREACH bk IN ARRAY kept.ai_buckets(jsonb_build_object(
        'location_id', p_location, 'owner_account_id', acct, 'user_id', uid,
        'paying_scope', pr.paying_scope, 'paying_account_id', pr.paying_account_id,
        'paying_user_id', pr.paying_user_id, 'budget_task', 'extraction')) LOOP
      FOR r IN SELECT * FROM kept.ai_bucket_rows(bk, NULL) LOOP
        IF r.paused_until > now() AND ai_status.paused_until IS NULL THEN
          ai_status.paused_until := r.paused_until;
          paused_reason := r.paused_reason;
          paused_scope := r.scope;
          paused_label := CASE r.scope
            WHEN 'location' THEN (SELECT l.name FROM public.locations l WHERE l.id = r.location_id)
            WHEN 'member' THEN (SELECT p.display_name FROM public.user_profiles p
                                 WHERE p.user_id = r.user_id) END;
          can_resume := kept.ai_budget_writable(r);
        END IF;
        pct := NULL;
        IF r.tokens_per_month IS NOT NULL THEN
          pct := kept.ai_used(bk, 'month') * 100.0 / r.tokens_per_month;
        END IF;
        IF r.monthly_cap_amount > 0 THEN
          pct := greatest(pct, kept.ai_spent(bk, r.cap_currency) * 100.0 / r.monthly_cap_amount);
        END IF;
        best := greatest(best, pct);
      END LOOP;
    END LOOP;
    cap_percent := floor(best)::int;
    SELECT b.until, b.reason INTO waiting_until, waiting_reason
      FROM public.ai_breakers b WHERE b.provider_id = pr.provider_id AND b.until > now();
    IF waiting_until IS NULL THEN
      SELECT l.reset_at, 'limits' INTO waiting_until, waiting_reason
        FROM public.ai_provider_limits l
       WHERE l.provider_id = pr.provider_id AND l.reset_at > now() AND l.remaining_tokens <= 0;
    END IF;
  END IF;
  RETURN NEXT;
END $$;
--> statement-breakpoint
-- The cap row a request names (scope, accountId, locationId, userId, task), checked against the
-- caller: 42501 unless the caller writes it (a member cap names someone who shares a location with
-- the owner; a location cap one of the owner's visible locations). Only the key fields are set.
CREATE FUNCTION kept.ai_cap_target(p jsonb) RETURNS public.ai_budgets
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  r public.ai_budgets%ROWTYPE;
BEGIN
  r.scope := p->>'scope';
  r.task := p->>'task';
  r.location_id := CASE WHEN r.scope = 'location' THEN (p->>'locationId')::uuid END;
  r.user_id := CASE WHEN r.scope IN ('member', 'user') THEN coalesce((p->>'userId')::uuid, uid) END;
  r.owner_account_id := CASE
    WHEN r.scope = 'location' THEN (SELECT l.owner_account_id FROM public.locations l
                                     WHERE l.id = r.location_id)
    WHEN r.scope IN ('account', 'member') THEN coalesce((p->>'accountId')::uuid,
                                                        kept.current_owner_account_id())
    WHEN r.scope = 'instance_account' THEN (p->>'accountId')::uuid END;
  IF uid IS NULL OR r.scope IS NULL OR NOT coalesce(kept.ai_budget_writable(r), false)
     OR (r.scope = 'location'
         AND NOT coalesce(r.location_id IN (SELECT kept.visible_location_ids()), false))
     OR (r.scope = 'member' AND NOT coalesce(r.user_id IN (SELECT kept.fellow_member_ids()), false))
     OR (r.scope = 'user' AND r.user_id <> uid) THEN
    RAISE EXCEPTION 'no such cap of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r.task IS NOT NULL AND r.scope NOT IN ('instance', 'account') THEN
    RAISE EXCEPTION 'only the instance and an account have per-task budgets'
      USING ERRCODE = 'invalid_parameter_value', CONSTRAINT = 'ai_budgets_task_scope';
  END IF;
  RETURN r;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_cap_target(jsonb) FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
-- A cap or budget row, set by its writer (§7.15). p: the scope fields (kept.ai_cap_target's) and
-- tokensPerMinute, tokensPerDay, tokensPerMonth, monthlyCapAmount, capCurrency. A location's cap
-- may not be above its account's in the same unit (P0001 `cap_above_account`). Upserts by scope.
CREATE FUNCTION kept.ai_cap_set(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.ai_budgets%ROWTYPE := kept.ai_cap_target(p);
  a public.ai_budgets%ROWTYPE;
  out_id uuid;
BEGIN
  r.tokens_per_minute := (p->>'tokensPerMinute')::int;
  r.tokens_per_day := (p->>'tokensPerDay')::int;
  r.tokens_per_month := (p->>'tokensPerMonth')::bigint;
  r.monthly_cap_amount := (p->>'monthlyCapAmount')::numeric;
  r.cap_currency := p->>'capCurrency';
  IF r.scope = 'location' THEN
    SELECT * INTO a FROM public.ai_budgets x
     WHERE x.scope = 'account' AND x.owner_account_id = r.owner_account_id AND x.task IS NULL;
    IF (r.tokens_per_month > a.tokens_per_month)
       OR (r.monthly_cap_amount > a.monthly_cap_amount AND r.cap_currency = a.cap_currency) THEN
      RAISE EXCEPTION 'a location''s cap can''t be above its account''s'
        USING ERRCODE = 'raise_exception', CONSTRAINT = 'cap_above_account';
    END IF;
  END IF;
  INSERT INTO public.ai_budgets AS x (scope, owner_account_id, location_id, user_id, task,
                                     tokens_per_minute, tokens_per_day, tokens_per_month,
                                     monthly_cap_amount, cap_currency, set_by)
  VALUES (r.scope, r.owner_account_id, r.location_id, r.user_id, r.task, r.tokens_per_minute,
          r.tokens_per_day, r.tokens_per_month, r.monthly_cap_amount, r.cap_currency,
          kept.current_user_id())
  ON CONFLICT ON CONSTRAINT ai_budgets_scope_uq DO UPDATE
    SET tokens_per_minute = EXCLUDED.tokens_per_minute, tokens_per_day = EXCLUDED.tokens_per_day,
        tokens_per_month = EXCLUDED.tokens_per_month,
        monthly_cap_amount = EXCLUDED.monthly_cap_amount, cap_currency = EXCLUDED.cap_currency,
        set_by = EXCLUDED.set_by
  RETURNING x.id INTO out_id;
  RETURN out_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.ai_cap_clear(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.ai_budgets%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.ai_budgets x WHERE x.id = p_id;
  IF r.id IS NULL OR NOT kept.ai_budget_writable(r) THEN
    RAISE EXCEPTION 'no such cap of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.ai_budgets x WHERE x.id = p_id;
  RETURN true;
END $$;
--> statement-breakpoint
-- A manual pause (§7.15: until `infinity`), on the scope's row (made, with no limits, when it
-- has none). p: kept.ai_cap_target's scope fields.
CREATE FUNCTION kept.ai_pause(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.ai_budgets%ROWTYPE := kept.ai_cap_target(p);
  out_id uuid;
BEGIN
  INSERT INTO public.ai_budgets (scope, owner_account_id, location_id, user_id, task, set_by)
  VALUES (r.scope, r.owner_account_id, r.location_id, r.user_id, r.task, kept.current_user_id())
  ON CONFLICT ON CONSTRAINT ai_budgets_scope_uq DO NOTHING;
  UPDATE public.ai_budgets x SET paused_until = 'infinity', paused_reason = 'manual'
   WHERE x.scope = r.scope AND x.owner_account_id IS NOT DISTINCT FROM r.owner_account_id
     AND x.location_id IS NOT DISTINCT FROM r.location_id
     AND x.user_id IS NOT DISTINCT FROM r.user_id AND x.task IS NOT DISTINCT FROM r.task
  RETURNING x.id INTO out_id;
  RETURN out_id;
END $$;
--> statement-breakpoint
-- "Resume now" (§7.15): for the cap's writers. p_raise: {remove: true} clears the monthly caps;
-- {amount, currency} or {tokens} raises one. The pause is cleared only when usage is now under
-- every cap the row names (else P0001 `ai_cap_still_reached`, nothing changed but the raise).
-- Returns the paused_budget extractions under that scope, oldest first, for the route to re-send.
CREATE FUNCTION kept.ai_resume(p_id uuid, p_raise jsonb)
RETURNS TABLE (extraction_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.ai_budgets%ROWTYPE;
  bk text;
BEGIN
  SELECT * INTO r FROM public.ai_budgets x WHERE x.id = p_id;
  IF r.id IS NULL OR NOT kept.ai_budget_writable(r) THEN
    RAISE EXCEPTION 'no such cap of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce((p_raise->>'remove')::boolean, false) THEN
    UPDATE public.ai_budgets x
       SET tokens_per_month = NULL, monthly_cap_amount = NULL, cap_currency = NULL,
           set_by = kept.current_user_id()
     WHERE x.id = p_id RETURNING * INTO r;
  ELSIF p_raise ? 'tokens' THEN
    UPDATE public.ai_budgets x SET tokens_per_month = (p_raise->>'tokens')::bigint,
                                  set_by = kept.current_user_id()
     WHERE x.id = p_id RETURNING * INTO r;
  ELSIF p_raise ? 'amount' THEN
    UPDATE public.ai_budgets x SET monthly_cap_amount = (p_raise->>'amount')::numeric,
                                  cap_currency = p_raise->>'currency',
                                  set_by = kept.current_user_id()
     WHERE x.id = p_id RETURNING * INTO r;
  END IF;
  bk := kept.ai_row_bucket(r);
  IF r.paused_reason <> 'manual' AND (
       (r.tokens_per_month IS NOT NULL AND kept.ai_used(bk, 'month') >= r.tokens_per_month)
       OR (r.monthly_cap_amount IS NOT NULL
           AND kept.ai_spent(bk, r.cap_currency) >= r.monthly_cap_amount)
       OR (r.paused_reason = 'tokens_day' AND r.tokens_per_day IS NOT NULL
           AND kept.ai_used(bk, 'day') >= r.tokens_per_day)) THEN
    RAISE EXCEPTION 'usage is still at the cap; raise or remove it'
      USING ERRCODE = 'raise_exception', CONSTRAINT = 'ai_cap_still_reached';
  END IF;
  UPDATE public.ai_budgets x SET paused_until = NULL, paused_reason = NULL WHERE x.id = p_id;
  RETURN QUERY
    SELECT e.id FROM public.extractions e
      JOIN public.locations l ON l.id = e.location_id
     WHERE e.status = 'paused_budget'
       AND CASE r.scope
             WHEN 'location' THEN e.location_id = r.location_id
             WHEN 'member' THEN e.requested_by = r.user_id AND l.owner_account_id = r.owner_account_id
             WHEN 'account' THEN l.owner_account_id = r.owner_account_id
             WHEN 'user' THEN e.requested_by = r.user_id
             WHEN 'instance_account' THEN r.owner_account_id IS NULL
                                          OR l.owner_account_id = r.owner_account_id
             ELSE true END
     ORDER BY e.created_at, e.id;
END $$;
--> statement-breakpoint

-- 3f. Usage and the instance's calls --------------------------------------------------------------
-- Totals per group and currency over [p_from, p_to), from the ledger and, for months already
-- rolled up, ai_usage_months (§7.15). Scopes: `me` (the caller's own calls), `location` (its
-- admins), `account` (the caller's own: rows in its locations or paid by it), `instance`
-- (instance admins: calls the instance key paid, never grouped by person or location). Groups:
-- day · task · model · person · location · account. A location's name, or a person's, is given
-- only where the caller can see it (D123).
CREATE FUNCTION kept.ai_usage(p_scope text, p_scope_id uuid, p_from timestamptz,
                              p_to timestamptz, p_group text)
RETURNS TABLE (key text, label text, calls integer, sent_calls integer, input_tokens bigint,
               output_tokens bigint, reasoning_tokens bigint, cached_tokens bigint,
               images integer, cost numeric, cost_currency character(3),
               unknown_cost_calls integer, outcomes jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  acct uuid := kept.current_owner_account_id();
BEGIN
  IF uid IS NULL
     OR (p_scope = 'location'
         AND NOT coalesce(p_scope_id IN (SELECT kept.admin_location_ids()), false))
     OR (p_scope = 'account' AND (acct IS NULL OR p_scope_id IS DISTINCT FROM acct))
     OR (p_scope = 'instance' AND NOT kept.is_instance_admin()) THEN
    RAISE EXCEPTION 'no such usage of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_scope NOT IN ('me', 'location', 'account', 'instance')
     OR p_group NOT IN ('day', 'task', 'model', 'person', 'location', 'account')
     OR (p_scope = 'instance' AND p_group IN ('person', 'location')) THEN
    RAISE EXCEPTION 'unknown usage scope or grouping' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    WITH base AS (
      SELECT CASE p_group
               WHEN 'day' THEN to_char(c.at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
               WHEN 'task' THEN c.task
               WHEN 'model' THEN c.provider_kind || ':' || c.model
               WHEN 'person' THEN coalesce(c.user_id::text, 'background')
               WHEN 'location' THEN coalesce(c.location_id::text, 'none')
               ELSE coalesce(c.owner_account_id::text, 'none') END AS gkey,
             c.cost_currency AS cur, 1 AS n, c.sent::int AS sent_n,
             coalesce(c.input_tokens, 0)::bigint AS i_t, coalesce(c.output_tokens, 0)::bigint AS o_t,
             coalesce(c.reasoning_tokens, 0)::bigint AS r_t,
             coalesce(c.cached_input_tokens, 0)::bigint AS c_t, c.image_count::int AS img,
             c.cost_amount AS amt, (c.sent AND c.cost_source = 'unknown')::int AS unk,
             jsonb_build_object(c.outcome, 1) AS outs
        FROM public.llm_calls c
       WHERE c.at >= p_from AND c.at < p_to
         AND CASE p_scope
               WHEN 'me' THEN c.user_id = uid
               WHEN 'location' THEN c.location_id = p_scope_id
               WHEN 'account' THEN c.owner_account_id = acct OR c.paying_account_id = acct
               ELSE c.paying_scope = 'instance' END
      UNION ALL
      SELECT CASE p_group
               WHEN 'day' THEN to_char(m.month, 'YYYY-MM-DD')
               WHEN 'task' THEN m.task
               WHEN 'model' THEN m.provider_kind || ':' || m.model
               WHEN 'person' THEN coalesce(m.user_id::text, 'background')
               WHEN 'location' THEN coalesce(m.location_id::text, 'none')
               ELSE coalesce(m.owner_account_id::text, 'none') END,
             m.cost_currency, m.calls, m.sent_calls, m.input_tokens, m.output_tokens,
             m.reasoning_tokens, m.cached_tokens, m.images, m.cost_amount, m.unknown_cost_calls,
             m.outcomes
        FROM public.ai_usage_months m
       WHERE m.month >= date_trunc('month', p_from AT TIME ZONE 'UTC')::date
         AND m.month < (p_to AT TIME ZONE 'UTC')::date
         AND CASE p_scope
               WHEN 'me' THEN m.user_id = uid
               WHEN 'location' THEN m.location_id = p_scope_id
               WHEN 'account' THEN m.owner_account_id = acct OR m.paying_account_id = acct
               ELSE m.paying_scope = 'instance' END),
    totals AS (
      SELECT b.gkey, b.cur, sum(b.n)::int AS n, sum(b.sent_n)::int AS sent_n,
             sum(b.i_t)::bigint AS i_t, sum(b.o_t)::bigint AS o_t, sum(b.r_t)::bigint AS r_t,
             sum(b.c_t)::bigint AS c_t, sum(b.img)::int AS img, sum(b.amt) AS amt,
             sum(b.unk)::int AS unk
        FROM base b GROUP BY b.gkey, b.cur),
    outs AS (
      SELECT x.gkey, x.cur, jsonb_object_agg(x.k, x.v) AS outs
        FROM (SELECT b.gkey, b.cur, e.key AS k, sum(e.value::int) AS v
                FROM base b, jsonb_each_text(b.outs) e GROUP BY b.gkey, b.cur, e.key) x
       GROUP BY x.gkey, x.cur)
    SELECT t.gkey,
           CASE p_group
             WHEN 'location' THEN (SELECT l.name FROM public.locations l
                                    WHERE l.id::text = t.gkey
                                      AND l.id IN (SELECT kept.visible_location_ids()))
             WHEN 'person' THEN (SELECT p.display_name FROM public.user_profiles p
                                  WHERE p.user_id::text = t.gkey
                                    AND (p.user_id = uid
                                         OR p.user_id IN (SELECT kept.fellow_member_ids()))) END,
           t.n, t.sent_n, t.i_t, t.o_t, t.r_t, t.c_t, t.img, t.amt, t.cur::character(3), t.unk,
           coalesce(o.outs, '{}'::jsonb)
      FROM totals t LEFT JOIN outs o ON o.gkey = t.gkey AND o.cur IS NOT DISTINCT FROM t.cur
     ORDER BY t.gkey, t.cur;
END $$;
--> statement-breakpoint
-- The instance key's calls, for instance admins (§7.15): no location, thing, extraction, thread
-- or attachments. p_filters: task, model, outcome, accountId, from, to, limit (20; at most 200).
-- p_cursor: the last row's `<at>|<id>`, as next_cursor gives it.
CREATE FUNCTION kept.ai_instance_calls(p_filters jsonb, p_cursor text)
RETURNS TABLE (id uuid, at timestamptz, request_id text, attempt smallint, task text,
               owner_account_id uuid, user_id uuid, provider_kind text, model text, sent boolean,
               input_tokens integer, output_tokens integer, reasoning_tokens integer,
               cached_input_tokens integer, image_count smallint, cost_amount numeric,
               cost_currency character(3), cost_source text, outcome text, error_code text,
               next_cursor text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  lim integer := least(greatest(coalesce((p_filters->>'limit')::int, 20), 1), 200);
  c_at timestamptz := (split_part(p_cursor, '|', 1))::timestamptz;
  c_id uuid := nullif(split_part(p_cursor, '|', 2), '')::uuid;
BEGIN
  IF kept.current_user_id() IS NULL OR NOT kept.is_instance_admin() THEN
    RAISE EXCEPTION 'instance admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT c.id, c.at, c.request_id, c.attempt, c.task, c.owner_account_id, c.user_id,
           c.provider_kind, c.model, c.sent, c.input_tokens, c.output_tokens, c.reasoning_tokens,
           c.cached_input_tokens, c.image_count, c.cost_amount, c.cost_currency, c.cost_source,
           c.outcome, c.error_code,
           to_char(c.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || c.id
      FROM public.llm_calls c
     WHERE c.paying_scope = 'instance'
       AND (p_cursor IS NULL OR (c.at, c.id) < (c_at, c_id))
       AND (p_filters->>'task' IS NULL OR c.task = p_filters->>'task')
       AND (p_filters->>'model' IS NULL OR c.model = p_filters->>'model')
       AND (p_filters->>'outcome' IS NULL OR c.outcome = p_filters->>'outcome')
       AND (p_filters->>'accountId' IS NULL
            OR c.owner_account_id = (p_filters->>'accountId')::uuid)
       AND (p_filters->>'from' IS NULL OR c.at >= (p_filters->>'from')::timestamptz)
       AND (p_filters->>'to' IS NULL OR c.at < (p_filters->>'to')::timestamptz)
     ORDER BY c.at DESC, c.id DESC
     LIMIT lim;
END $$;
--> statement-breakpoint

-- 3g. Prices ---------------------------------------------------------------------------------------
-- A new version of a model's price (instance admins): the current one is superseded and the next
-- inserted in one statement's transaction. p: providerKind, model, inputPerMtok, outputPerMtok,
-- reasoningPerMtok?, cachedInputPerMtok?, perImage?, currency, source ('admin'),
-- listingFetchedAt.
CREATE FUNCTION kept.ai_price_set(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  k text := p->>'providerKind';
  m text := p->>'model';
  v integer;
  out_id uuid;
BEGIN
  IF kept.current_user_id() IS NULL OR NOT kept.is_instance_admin() THEN
    RAISE EXCEPTION 'instance admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kept.ai_price'), hashtext(k || '|' || m));
  UPDATE public.ai_model_prices x SET superseded_at = now()
   WHERE x.provider_kind = k AND x.model = m AND x.superseded_at IS NULL;
  SELECT coalesce(max(x.version), 0) + 1 INTO v FROM public.ai_model_prices x
   WHERE x.provider_kind = k AND x.model = m;
  INSERT INTO public.ai_model_prices (provider_kind, model, version, input_per_mtok,
                                      output_per_mtok, reasoning_per_mtok, cached_input_per_mtok,
                                      per_image, currency, source, listing_fetched_at, created_by)
  VALUES (k, m, v, (p->>'inputPerMtok')::numeric, (p->>'outputPerMtok')::numeric,
          (p->>'reasoningPerMtok')::numeric, (p->>'cachedInputPerMtok')::numeric,
          (p->>'perImage')::numeric, p->>'currency', coalesce(p->>'source', 'admin'),
          (p->>'listingFetchedAt')::timestamptz, kept.current_user_id())
  RETURNING id INTO out_id;
  RETURN out_id;
END $$;
--> statement-breakpoint
-- No price from now on: calls are "cost unknown" until a new version is set.
CREATE FUNCTION kept.ai_price_remove(p_kind text, p_model text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF kept.current_user_id() IS NULL OR NOT kept.is_instance_admin() THEN
    RAISE EXCEPTION 'instance admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.ai_model_prices x SET superseded_at = now()
   WHERE x.provider_kind = p_kind AND x.model = p_model AND x.superseded_at IS NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint
-- Late costing (§7.15): this month's sent `unknown` rows of a model since p_since get the current
-- price (ai/cost.ts's arithmetic: uncached input, cached input, output less reasoning, reasoning,
-- images; each term rounded half up to 6 places), are marked price_table_later, and their cost
-- is added to the cost windows. The only UPDATE the ledger ever takes. Returns the rows costed.
CREATE FUNCTION kept.ai_recost_unknown(p_kind text, p_model text, p_since timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  pr public.ai_model_prices%ROWTYPE;
  c record;
  n integer := 0;
  bk text;
BEGIN
  IF kept.current_user_id() IS NULL OR NOT kept.is_instance_admin() THEN
    RAISE EXCEPTION 'instance admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO pr FROM public.ai_model_prices x
   WHERE x.provider_kind = p_kind AND x.model = p_model AND x.superseded_at IS NULL;
  IF pr.id IS NULL THEN
    RETURN 0;
  END IF;
  FOR c IN
    UPDATE public.llm_calls l
       SET cost_source = 'price_table_later', price_id = pr.id, cost_currency = pr.currency,
           cost_amount =
             round(greatest(l.input_tokens - least(coalesce(l.cached_input_tokens, 0), l.input_tokens), 0)
                   * pr.input_per_mtok / 1000000, 6)
             + round(least(coalesce(l.cached_input_tokens, 0), l.input_tokens)
                     * coalesce(pr.cached_input_per_mtok, pr.input_per_mtok) / 1000000, 6)
             + round(greatest(l.output_tokens - least(coalesce(l.reasoning_tokens, 0), l.output_tokens), 0)
                     * pr.output_per_mtok / 1000000, 6)
             + round(least(coalesce(l.reasoning_tokens, 0), l.output_tokens)
                     * coalesce(pr.reasoning_per_mtok, pr.output_per_mtok) / 1000000, 6)
             + l.image_count * coalesce(pr.per_image, 0)
     WHERE l.provider_kind = p_kind AND l.model = p_model AND l.sent
       AND l.cost_source = 'unknown' AND l.input_tokens IS NOT NULL
       AND l.output_tokens IS NOT NULL
       AND l.at >= greatest(p_since, kept.ai_window_start('month'))
    RETURNING l.*
  LOOP
    n := n + 1;
    FOREACH bk IN ARRAY kept.ai_buckets(jsonb_build_object(
        'location_id', c.location_id, 'owner_account_id', c.owner_account_id,
        'user_id', c.user_id, 'paying_scope', c.paying_scope,
        'paying_account_id', c.paying_account_id, 'paying_user_id', c.paying_user_id,
        'budget_task', c.budget_task)) LOOP
      PERFORM kept.ai_cost_add(bk, kept.ai_window_start('month')::date, c.cost_currency,
                               c.cost_amount);
    END LOOP;
  END LOOP;
  RETURN n;
END $$;
--> statement-breakpoint

-- 3h. Brands the model proposes (§7.8) -------------------------------------------------------------
-- Found by the account's normalised name, or made. Members can't insert brands directly (admin
-- accounts only), so this is the door; the caller must write in the location.
CREATE FUNCTION kept.ai_ensure_brand(p_location uuid, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  acct uuid;
  nm text := btrim(p_name);
  out_id uuid;
BEGIN
  IF kept.current_user_id() IS NULL
     OR NOT coalesce(p_location IN (SELECT kept.writable_location_ids()), false) THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF nm IS NULL OR char_length(nm) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'a brand name is 1 to 120 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT l.owner_account_id INTO acct FROM public.locations l WHERE l.id = p_location;
  INSERT INTO public.brands (owner_account_id, name) VALUES (acct, nm)
  ON CONFLICT (owner_account_id, kept.normalize(name)) DO NOTHING
  RETURNING id INTO out_id;
  IF out_id IS NULL THEN
    SELECT b.id INTO out_id FROM public.brands b
     WHERE b.owner_account_id = acct AND kept.normalize(b.name) = kept.normalize(nm);
  END IF;
  RETURN out_id;
END $$;
--> statement-breakpoint

-- 3i. kept_system's doors ------------------------------------------------------------------------
-- Daily (ai.rollover, 00:05 UTC): day-budget and cap pauses whose time has passed are cleared (a
-- cap's is the 1st of the month); manual pauses stay. Returns the paused extractions whose pause
-- has ended, oldest first, to re-send.
CREATE FUNCTION kept.ai_rollover() RETURNS TABLE (extraction_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.ai_budgets x SET paused_until = NULL, paused_reason = NULL
   WHERE x.paused_reason IN ('tokens_day', 'cap_money', 'cap_tokens') AND x.paused_until <= now();
  RETURN QUERY
    SELECT e.id FROM public.extractions e
     WHERE e.status = 'paused_budget' AND (e.paused_until IS NULL OR e.paused_until <= now())
     ORDER BY e.created_at, e.id;
END $$;
--> statement-breakpoint
-- Monthly (ai.ledger_rollup): each ledger partition older than p_keep_months (3–60; the
-- instance setting ai_ledger_months, 13 by default) is summed into ai_usage_months, then dropped;
-- then the next three months' partitions are made. Returns the partitions dropped.
CREATE FUNCTION kept.ai_rollup_and_drop(p_keep_months integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  cutoff date;
  part text;
  m date;
  dropped integer := 0;
BEGIN
  IF p_keep_months IS NULL OR p_keep_months NOT BETWEEN 3 AND 60 THEN
    RAISE EXCEPTION 'p_keep_months must be between 3 and 60'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  cutoff := (date_trunc('month', now() AT TIME ZONE 'UTC')
             - make_interval(months => p_keep_months))::date;
  FOR part IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'public.llm_calls'::regclass AND c.relname ~ '^llm_calls_[0-9]{4}_[0-9]{2}$'
     ORDER BY c.relname
  LOOP
    m := to_date(substr(part, 11), 'YYYY_MM');
    CONTINUE WHEN m >= cutoff;
    EXECUTE format($q$
      INSERT INTO public.ai_usage_months AS u (
        month, paying_scope, paying_account_id, paying_user_id, location_id, owner_account_id,
        user_id, task, provider_kind, model, cost_currency, calls, sent_calls, tokens,
        input_tokens, output_tokens, reasoning_tokens, cached_tokens, images, cost_amount,
        unknown_cost_calls, outcomes)
      SELECT %L::date, g.paying_scope, g.paying_account_id, g.paying_user_id, g.location_id,
             min(g.owner_account_id::text)::uuid, g.user_id, g.task, g.provider_kind, g.model,
             g.cost_currency, sum(g.n), sum(g.sent_n), sum(g.i_t + g.o_t), sum(g.i_t),
             sum(g.o_t), sum(g.r_t), sum(g.c_t), sum(g.img), sum(g.amt), sum(g.unk),
             jsonb_object_agg(g.outcome, g.n)
        FROM (SELECT c.paying_scope, c.paying_account_id, c.paying_user_id, c.location_id,
                     c.owner_account_id, c.user_id, c.task, c.provider_kind, c.model,
                     c.cost_currency, c.outcome, count(*)::int AS n,
                     count(*) FILTER (WHERE c.sent)::int AS sent_n,
                     sum(coalesce(c.input_tokens, 0))::bigint AS i_t,
                     sum(coalesce(c.output_tokens, 0))::bigint AS o_t,
                     sum(coalesce(c.reasoning_tokens, 0))::bigint AS r_t,
                     sum(coalesce(c.cached_input_tokens, 0))::bigint AS c_t,
                     sum(c.image_count)::int AS img, sum(c.cost_amount) AS amt,
                     count(*) FILTER (WHERE c.sent AND c.cost_source = 'unknown')::int AS unk
                FROM public.%I c
               GROUP BY c.paying_scope, c.paying_account_id, c.paying_user_id, c.location_id,
                        c.owner_account_id, c.user_id, c.task, c.provider_kind, c.model,
                        c.cost_currency, c.outcome) g
       GROUP BY g.paying_scope, g.paying_account_id, g.paying_user_id, g.location_id, g.user_id,
                g.task, g.provider_kind, g.model, g.cost_currency
      ON CONFLICT ON CONSTRAINT ai_usage_months_uq DO UPDATE
        SET calls = u.calls + EXCLUDED.calls, sent_calls = u.sent_calls + EXCLUDED.sent_calls,
            tokens = u.tokens + EXCLUDED.tokens,
            input_tokens = u.input_tokens + EXCLUDED.input_tokens,
            output_tokens = u.output_tokens + EXCLUDED.output_tokens,
            reasoning_tokens = u.reasoning_tokens + EXCLUDED.reasoning_tokens,
            cached_tokens = u.cached_tokens + EXCLUDED.cached_tokens,
            images = u.images + EXCLUDED.images,
            cost_amount = CASE WHEN u.cost_amount IS NULL AND EXCLUDED.cost_amount IS NULL THEN NULL
                               ELSE coalesce(u.cost_amount, 0) + coalesce(EXCLUDED.cost_amount, 0) END,
            unknown_cost_calls = u.unknown_cost_calls + EXCLUDED.unknown_cost_calls,
            outcomes = (SELECT jsonb_object_agg(k, s) FROM (
                          SELECT k, sum(v::int) AS s FROM (
                            SELECT * FROM jsonb_each_text(u.outcomes)
                            UNION ALL SELECT * FROM jsonb_each_text(EXCLUDED.outcomes)) x(k, v)
                           GROUP BY k) y)
    $q$, m, part);
    EXECUTE format('DROP TABLE public.%I', part);
    dropped := dropped + 1;
  END LOOP;
  PERFORM kept.ensure_llm_partitions(3);
  RETURN dropped;
END $$;
--> statement-breakpoint
-- Hourly or daily: minute windows older than 2 hours and day windows older than 2 days before
-- p_before, month windows and cost windows older than 13 months, and leases that have ended.
CREATE FUNCTION kept.prune_ai_windows(p_before timestamptz)
RETURNS TABLE (what text, removed bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM public.ai_usage_windows w
   WHERE (w.window_kind = 'minute' AND w.window_start < p_before - interval '2 hours')
      OR (w.window_kind = 'day' AND w.window_start < p_before - interval '2 days')
      OR (w.window_kind = 'month' AND w.window_start < p_before - interval '13 months');
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'ai_usage_windows'; removed := n; RETURN NEXT;
  DELETE FROM public.ai_leases l WHERE l.lease_until < p_before;
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'ai_leases'; removed := n; RETURN NEXT;
  DELETE FROM public.ai_cost_windows c WHERE c.month_start < (p_before - interval '13 months')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'ai_cost_windows'; removed := n; RETURN NEXT;
END $$;
--> statement-breakpoint

-- 3j. Who may call what ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  kept.ai_provider_resolved(uuid), kept.ai_provider_for(uuid, text),
  kept.ai_provider_secret(uuid, text), kept.ai_clear_trip(uuid), kept.ai_status(uuid),
  kept.ai_cap_set(jsonb), kept.ai_cap_clear(uuid), kept.ai_pause(jsonb),
  kept.ai_resume(uuid, jsonb), kept.ai_usage(text, uuid, timestamptz, timestamptz, text),
  kept.ai_instance_calls(jsonb, text), kept.ai_price_set(jsonb), kept.ai_price_remove(text, text),
  kept.ai_recost_unknown(text, text, timestamptz), kept.ai_ensure_brand(uuid, text)
  FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  kept.ai_provider_resolved(uuid), kept.ai_provider_for(uuid, text),
  kept.ai_provider_secret(uuid, text), kept.ai_clear_trip(uuid), kept.ai_status(uuid),
  kept.ai_cap_set(jsonb), kept.ai_cap_clear(uuid), kept.ai_pause(jsonb),
  kept.ai_resume(uuid, jsonb), kept.ai_usage(text, uuid, timestamptz, timestamptz, text),
  kept.ai_instance_calls(jsonb, text), kept.ai_price_set(jsonb), kept.ai_price_remove(text, text),
  kept.ai_recost_unknown(text, text, timestamptz), kept.ai_ensure_brand(uuid, text)
  TO kept_app;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  kept.ai_reserve(jsonb), kept.ai_settle(jsonb, jsonb, text, jsonb),
  kept.ai_key_admit(uuid, integer, text), kept.ai_key_release(uuid, integer, text),
  kept.ai_breaker_state(uuid), kept.ai_observe(uuid, jsonb, jsonb),
  kept.ai_trip(uuid, timestamptz, text)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  kept.ai_reserve(jsonb), kept.ai_settle(jsonb, jsonb, text, jsonb),
  kept.ai_key_admit(uuid, integer, text), kept.ai_key_release(uuid, integer, text),
  kept.ai_breaker_state(uuid), kept.ai_observe(uuid, jsonb, jsonb),
  kept.ai_trip(uuid, timestamptz, text)
  TO kept_app, kept_system;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_rollover(), kept.ai_rollup_and_drop(integer),
  kept.prune_ai_windows(timestamptz) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ai_rollover(), kept.ai_rollup_and_drop(integer),
  kept.prune_ai_windows(timestamptz) TO kept_system;
