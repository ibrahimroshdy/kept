-- Custom SQL migration file, put your code below! --
-- Step 4, task 4: money records, incidents and export runs (engineering spec §1.4, §1.10, §7.1,
-- §7.13, §7.15; D76, D136, D158, D169, D180, D201; plan Q19–Q22). Above, in 0048, drizzle's
-- part: fx_rates, valuations, incidents, incident_things, export_runs and report_runs.kind
-- (src/db/schema/money.ts, reports.ts). Below:
--   1. Row-level security:
--      - fx_rates are the account's: read by anyone who sees one of its locations, written by its
--        admins (the brands expressions of 0014);
--      - valuations are read where the thing is seen and written by its writers;
--      - incidents and the things they touched are read where seen and written by owners and
--        admins (§7.1 "Incidents; claim packs");
--      - an export run is its creator's alone, while they still hold owner or admin on the
--        location; kept_app changes only its link (token, expiry, revoked), the job moves the
--        rest through the doors in 3.
--   2. export_runs' incident key: ON DELETE SET NULL (incident_id), which drizzle can't declare.
--      The run keeps its built pack; its scope is then empty (the CHECK allows at most one, the
--      insert policy requires exactly one).
--   3. The export doors (D180, Q19):
--      - kept.export_run_claim(), _progress(), _finish(): the claim-pack job's, which is a tenant
--        job (jobs/queue.ts TENANT_REQUEST_QUEUES), so kept_app may call them for its own runs,
--        and kept_system for any; the storage key is always the run's own (`x/<id>.zip`, the
--        table's CHECK), never one the caller names;
--      - kept.export_download(token hash) (SYS): the public `/x/<token>` route's, without a
--        session. It refuses a revoked, expired, unknown or unbuilt link, and one whose creator
--        no longer holds owner or admin on the location (D180: downloads re-check the current
--        role), all alike (42501, a 404), and counts the download;
--      - kept.purge_expired_exports() (SYS): the `purge-exports` job's. A run past its seven days
--        becomes `expired` (its link and key cleared; the keys come back for the job to delete
--        after its commit); an expired run older than 90 days goes.
--   4. The AI money caps count other currencies through the account's exchange rates (step-3
--      carry-over; D76, §7.15): kept.fx_rate() is the SQL twin of @kept/shared money.ts
--      `convert` (the pair's newest rate on or before the day, else its inverse's, never
--      chained, never estimated); kept.ai_spent() now sums a bucket's month in the cap's
--      currency through the bucket's account's rates, leaving out a currency with no rate;
--      kept.ai_reserve() counts an estimate the same way, and kept.ai_settle() warns at 80% and
--      100% on the counted sum. kept.ai_status(), kept.ai_resume() and kept.ai_notice_cap() call
--      kept.ai_spent(), so they follow. kept.ai_cap_usage() gains `spent` (counted, in the cap's
--      currency) and `not_counted` (the currencies left out): AI settings list them (D76).
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-household.ts fills
-- the tables; src/db/money.test.ts and src/db/ai.test.ts test them.

-- 1. Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fx_rates', 'valuations', 'incidents', 'incident_things',
                           'export_runs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE ON public.%I FROM kept_app, kept_system', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY app_select ON public.fx_rates FOR SELECT TO kept_app
  USING (owner_account_id IN (SELECT kept.visible_account_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.fx_rates FOR INSERT TO kept_app
  WITH CHECK (owner_account_id IN (SELECT kept.admin_account_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.fx_rates FOR UPDATE TO kept_app
  USING (owner_account_id IN (SELECT kept.admin_account_ids()))
  WITH CHECK (owner_account_id IN (SELECT kept.admin_account_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.fx_rates FOR DELETE TO kept_app
  USING (owner_account_id IN (SELECT kept.admin_account_ids()));
--> statement-breakpoint
GRANT UPDATE (rate, updated_at, row_version) ON public.fx_rates TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.fx_rates
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

CREATE POLICY app_select ON public.valuations FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.valuations FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.valuations FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.valuations FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (value, currency, valued_on, source, notes, updated_at, row_version)
  ON public.valuations TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.valuations
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

CREATE POLICY app_select ON public.incidents FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.incidents FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.incidents FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.incidents FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
GRANT UPDATE (kind, occurred_on, police_reference, insurer_reference, notes, updated_at,
              row_version)
  ON public.incidents TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- Never updated: a thing is added to an incident or taken off it.
CREATE POLICY app_select ON public.incident_things FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.incident_things FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.incident_things FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint

-- The creator's alone, while they administer the location (D180). A new run is queued, unbuilt
-- and names exactly one scope; after that kept_app changes only its link.
CREATE POLICY app_select ON public.export_runs FOR SELECT TO kept_app
  USING (created_by = (SELECT kept.current_user_id())
         AND location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.export_runs FOR INSERT TO kept_app
  WITH CHECK (created_by = (SELECT kept.current_user_id())
              AND location_id IN (SELECT kept.admin_location_ids())
              AND num_nonnulls(incident_id, thing_ids) = 1
              AND status = 'queued' AND storage_key IS NULL AND bytes IS NULL
              AND error IS NULL AND finished_at IS NULL AND revoked_at IS NULL
              AND downloads = 0 AND last_downloaded_at IS NULL
              AND progress_done = 0 AND progress_total = 0
              AND expires_at <= now() + interval '7 days'
              AND (token_expires_at IS NULL OR token_expires_at <= expires_at));
--> statement-breakpoint
CREATE POLICY app_update ON public.export_runs FOR UPDATE TO kept_app
  USING (created_by = (SELECT kept.current_user_id())
         AND location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (created_by = (SELECT kept.current_user_id())
              AND location_id IN (SELECT kept.admin_location_ids())
              AND (token_expires_at IS NULL OR token_expires_at <= expires_at));
--> statement-breakpoint
REVOKE DELETE ON public.export_runs FROM kept_app, kept_system;
--> statement-breakpoint
GRANT UPDATE (token_hash, token_expires_at, revoked_at) ON public.export_runs TO kept_app;
--> statement-breakpoint

-- 2. The incident key ------------------------------------------------------------------------------
ALTER TABLE public.export_runs ADD CONSTRAINT export_runs_incident_fk
  FOREIGN KEY (location_id, incident_id)
  REFERENCES public.incidents (location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (incident_id);
--> statement-breakpoint
CREATE INDEX export_runs_incident_idx ON public.export_runs (incident_id)
  WHERE incident_id IS NOT NULL;
--> statement-breakpoint

-- 3. The export doors -----------------------------------------------------------------------------
-- Who may move a run along: kept_system (any run), or its creator while they administer its
-- location. Owner-only: the doors call it.
CREATE FUNCTION kept.export_run_mine(p_run public.export_runs) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT session_user = 'kept_system' OR coalesce(
    p_run.created_by = kept.current_user_id()
    AND p_run.location_id IN (SELECT kept.admin_location_ids()), false)
$$;
--> statement-breakpoint
-- The job takes a queued run: running, with what it covers. Anything else is 42501.
CREATE FUNCTION kept.export_run_claim(p_id uuid)
RETURNS TABLE (location_id uuid, kind text, incident_id uuid, thing_ids uuid[], created_by uuid,
               include_secrets boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.export_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.export_runs x WHERE x.id = p_id FOR UPDATE;
  IF r.id IS NULL OR r.status <> 'queued' OR NOT kept.export_run_mine(r) THEN
    RAISE EXCEPTION 'no such export run to build' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.export_runs x SET status = 'running' WHERE x.id = p_id;
  RETURN QUERY SELECT r.location_id, r.kind, r.incident_id, r.thing_ids, r.created_by,
                      r.include_secrets;
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.export_run_progress(p_id uuid, p_done integer, p_total integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.export_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.export_runs x WHERE x.id = p_id FOR UPDATE;
  IF r.id IS NULL OR r.status <> 'running' OR NOT kept.export_run_mine(r) THEN
    RAISE EXCEPTION 'no such export run being built' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.export_runs x SET progress_done = p_done, progress_total = p_total
   WHERE x.id = p_id;
END $$;
--> statement-breakpoint
-- Done: the pack is at the run's own key. Failed: a short code (the CHECK), and no key.
CREATE FUNCTION kept.export_run_finish(p_id uuid, p_bytes bigint, p_status text, p_error text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.export_runs%ROWTYPE;
BEGIN
  IF p_status NOT IN ('done', 'failed') OR (p_status = 'done' AND p_bytes IS NULL) THEN
    RAISE EXCEPTION 'a run finishes done, with its size, or failed'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM public.export_runs x WHERE x.id = p_id FOR UPDATE;
  IF r.id IS NULL OR r.status NOT IN ('queued', 'running') OR NOT kept.export_run_mine(r) THEN
    RAISE EXCEPTION 'no such export run being built' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.export_runs x
     SET status = p_status,
         storage_key = CASE WHEN p_status = 'done' THEN 'x/' || x.id::text || '.zip' END,
         bytes = CASE WHEN p_status = 'done' THEN p_bytes END,
         error = CASE WHEN p_status = 'failed' THEN coalesce(p_error, 'failed') END,
         progress_done = CASE WHEN p_status = 'done' THEN x.progress_total ELSE x.progress_done END,
         finished_at = now()
   WHERE x.id = p_id;
END $$;
--> statement-breakpoint
-- The public link, without a session (D180, Q19). Every refusal is the same 42501.
CREATE FUNCTION kept.export_download(p_token_hash text)
RETURNS TABLE (storage_key text, bytes bigint, location_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.export_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.export_runs x
   WHERE x.token_hash = p_token_hash AND p_token_hash ~ '^[0-9a-f]{64}$' FOR UPDATE;
  IF r.id IS NULL OR r.revoked_at IS NOT NULL OR r.status <> 'done' OR r.storage_key IS NULL
     OR r.expires_at <= now() OR coalesce(r.token_expires_at <= now(), true)
     OR NOT EXISTS (
       SELECT 1 FROM public.memberships m JOIN public.locations l ON l.id = m.location_id
        WHERE m.location_id = r.location_id AND m.user_id = r.created_by
          AND m.role IN ('owner', 'admin')
          AND (m.expires_at IS NULL OR m.expires_at > now())
          AND l.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'no such download' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.export_runs x SET downloads = x.downloads + 1, last_downloaded_at = now()
   WHERE x.id = r.id;
  RETURN QUERY SELECT r.storage_key, r.bytes, r.location_id;
END $$;
--> statement-breakpoint
-- Seven days (§3.3 export retention): the run stays as history, its pack and link go. Returns the
-- keys whose blobs the job deletes after its commit.
CREATE FUNCTION kept.purge_expired_exports(p_limit integer) RETURNS SETOF text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  WITH gone AS (
    SELECT x.id, x.storage_key FROM public.export_runs x
     WHERE x.status <> 'expired' AND (x.expires_at <= now() OR x.created_by IS NULL)
     ORDER BY x.expires_at, x.id
     LIMIT greatest(p_limit, 0)
     FOR UPDATE),
  done AS (
    UPDATE public.export_runs x
       SET status = 'expired', storage_key = NULL, token_hash = NULL, token_expires_at = NULL
      FROM gone
     WHERE x.id = gone.id
    RETURNING gone.storage_key)
  SELECT d.storage_key FROM done d WHERE d.storage_key IS NOT NULL;
  DELETE FROM public.export_runs x
   WHERE x.status = 'expired' AND x.expires_at <= now() - interval '90 days';
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.export_run_mine(public.export_runs),
  kept.export_download(text), kept.purge_expired_exports(integer)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.export_run_claim(uuid),
  kept.export_run_progress(uuid, integer, integer),
  kept.export_run_finish(uuid, bigint, text, text)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.export_download(text), kept.purge_expired_exports(integer)
  TO kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.export_run_claim(uuid),
  kept.export_run_progress(uuid, integer, integer),
  kept.export_run_finish(uuid, bigint, text, text)
  TO kept_app, kept_system;
--> statement-breakpoint

-- 4. AI money caps through exchange rates ---------------------------------------------------------
-- The rate from one currency to another an account holds for a day: the pair's newest rate valid
-- on or before it; only when the pair has none, its inverse's (as 1/rate), as @kept/shared
-- money.ts `convert` orders them. Never chained through a third currency, never estimated (D76):
-- NULL when there is none.
-- Owner-only: the definers call it with the account they resolved themselves.
CREATE FUNCTION kept.fx_rate(p_account uuid, p_from text, p_to text, p_on date) RETURNS numeric
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_from = p_to THEN 1::numeric ELSE (
    SELECT x.rate FROM (
      SELECT f.rate, f.valid_from, 0 AS pref FROM public.fx_rates f
       WHERE f.owner_account_id = p_account AND f.from_ccy = p_from AND f.to_ccy = p_to
         AND f.valid_from <= p_on
      UNION ALL
      SELECT 1 / f.rate, f.valid_from, 1 FROM public.fx_rates f
       WHERE f.owner_account_id = p_account AND f.from_ccy = p_to AND f.to_ccy = p_from
         AND f.valid_from <= p_on) x
     ORDER BY x.pref, x.valid_from DESC
     LIMIT 1) END
$$;
--> statement-breakpoint
-- The account whose rates a bucket's spend is counted through: a location's owner account, the
-- account of an account, member or instance-account bucket, a personal key's user's account.
-- The instance's own buckets have none (no account enters their rates).
CREATE FUNCTION kept.ai_bucket_account(p_bucket text) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  kind text := split_part(p_bucket, ':', 1);
  a text := nullif(split_part(p_bucket, ':', 2), '');
BEGIN
  IF a IS NULL OR a = '*' THEN
    RETURN NULL;
  ELSIF kind = 'location' THEN
    RETURN (SELECT l.owner_account_id FROM public.locations l WHERE l.id = a::uuid);
  ELSIF kind IN ('account', 'member', 'instance_account') THEN
    RETURN a::uuid;
  ELSIF kind = 'user' THEN
    RETURN (SELECT oa.id FROM public.owner_accounts oa WHERE oa.user_id = a::uuid);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- An amount in another currency, as a bucket's cap counts it today (UTC, as the windows are):
-- NULL without a rate.
CREATE FUNCTION kept.ai_convert(p_amount numeric, p_from text, p_to text, p_bucket text)
RETURNS numeric
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_amount IS NULL OR p_from IS NULL OR p_to IS NULL THEN NULL
              WHEN p_from = p_to THEN p_amount
              ELSE p_amount * kept.fx_rate(kept.ai_bucket_account(p_bucket), p_from, p_to,
                                           (now() AT TIME ZONE 'UTC')::date) END
$$;
--> statement-breakpoint
-- A bucket's month in `p_currency`: its own currency as spent, the others through the account's
-- rates, and a currency with no rate left out (kept.ai_spent_uncounted() names them).
CREATE OR REPLACE FUNCTION kept.ai_spent(p_bucket text, p_currency text) RETURNS numeric
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(sum(kept.ai_convert(c.amount, c.currency::text, p_currency, p_bucket)), 0)
    FROM public.ai_cost_windows c
   WHERE c.bucket = p_bucket AND c.month_start = kept.ai_window_start('month')::date
$$;
--> statement-breakpoint
CREATE FUNCTION kept.ai_spent_uncounted(p_bucket text, p_currency text) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(c.currency::text ORDER BY c.currency), '{}')
    FROM public.ai_cost_windows c
   WHERE c.bucket = p_bucket AND c.month_start = kept.ai_window_start('month')::date
     AND c.amount <> 0 AND c.currency::text <> p_currency
     AND kept.ai_convert(c.amount, c.currency::text, p_currency, p_bucket) IS NULL
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.fx_rate(uuid, text, text, date), kept.ai_bucket_account(text),
  kept.ai_convert(numeric, text, text, text), kept.ai_spent_uncounted(text, text)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.ai_reserve(p_ctx jsonb)
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
                  + coalesce(kept.ai_convert(est_amount, est_currency, r.cap_currency, bk), 0)
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
CREATE OR REPLACE FUNCTION kept.ai_settle(p_ctx jsonb, p_usage jsonb, p_outcome text, p_cost jsonb)
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
        IF cost_amount IS NOT NULL THEN
          PERFORM kept.ai_cost_add(bk, month_date, cost_currency, cost_amount);
        END IF;

        FOR r IN SELECT * FROM kept.ai_bucket_rows(bk, coalesce(p_ctx->'defaults', '{}')) LOOP
          unit := NULL; pb := 0; pa := 0;
          IF r.tokens_per_month IS NOT NULL THEN
            pb := tok_before * 100.0 / r.tokens_per_month;
            pa := tok_after * 100.0 / r.tokens_per_month;
            unit := 'tokens';
          END IF;
          -- 0049: the month's spend in the cap's currency, other currencies counted through the
          -- account's exchange rates; before this call, less its cost as counted (none when the
          -- cost's currency has no rate: it moved nothing, D76).
          money_after := NULL;
          IF r.monthly_cap_amount > 0 AND cost_amount IS NOT NULL THEN
            money_after := kept.ai_spent(bk, r.cap_currency);
            money_before := money_after
              - coalesce(kept.ai_convert(cost_amount, cost_currency, r.cap_currency, bk), 0);
          END IF;
          IF money_after IS NOT NULL AND money_after * 100.0 / r.monthly_cap_amount > pa THEN
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
-- A cap's month for AI settings (0043), now with what the cap counts: `spent` in its currency
-- (kept.ai_spent, the figure the gate pauses on) and `not_counted`, the currencies spent this
-- month with no rate to it (D76). The return type changes, so it is dropped and made again.
DROP FUNCTION kept.ai_cap_usage(uuid[]);
--> statement-breakpoint
CREATE FUNCTION kept.ai_cap_usage(p_ids uuid[])
RETURNS TABLE (budget_id uuid, tokens bigint, cost jsonb, unknown_cost_calls integer,
               spent numeric, not_counted text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  acct uuid := kept.current_owner_account_id();
  m_start timestamptz := kept.ai_window_start('month');
  r public.ai_budgets%ROWTYPE;
  bk text;
BEGIN
  IF uid IS NULL THEN
    RETURN;
  END IF;
  FOR r IN SELECT * FROM public.ai_budgets x WHERE x.id = ANY (p_ids) ORDER BY x.id LOOP
    CONTINUE WHEN NOT coalesce(
      (r.scope IN ('instance', 'instance_account') AND kept.is_instance_admin())
      OR (r.scope IN ('account', 'location', 'member') AND r.owner_account_id = acct)
      OR (r.scope = 'user' AND r.user_id = uid)
      OR (r.scope = 'location' AND r.location_id IN (SELECT kept.admin_location_ids()))
      OR (r.scope = 'member' AND r.user_id = uid), false);
    bk := kept.ai_row_bucket(r);
    budget_id := r.id;
    tokens := kept.ai_used(bk, 'month');
    SELECT coalesce(jsonb_agg(jsonb_build_object('currency', w.currency, 'amount', w.amount)
                              ORDER BY w.currency), '[]'::jsonb)
      INTO cost
      FROM public.ai_cost_windows w
     WHERE w.bucket = bk AND w.month_start = m_start::date AND w.amount <> 0;
    SELECT count(*)::int INTO unknown_cost_calls
      FROM public.llm_calls c
     WHERE c.at >= m_start AND c.sent AND c.cost_source = 'unknown'
       AND CASE r.scope
             WHEN 'location' THEN c.location_id = r.location_id
             WHEN 'member' THEN c.location_id IS NOT NULL
                                AND c.owner_account_id = r.owner_account_id
                                AND c.user_id = r.user_id
             WHEN 'account' THEN c.paying_account_id = r.owner_account_id
                                 AND (r.task IS NULL OR c.budget_task = r.task)
             WHEN 'user' THEN c.paying_user_id = r.user_id
             WHEN 'instance' THEN c.paying_scope = 'instance'
                                  AND (r.task IS NULL OR c.budget_task = r.task)
             ELSE c.paying_scope = 'instance'
                  AND (r.owner_account_id IS NULL OR c.owner_account_id = r.owner_account_id) END;
    spent := CASE WHEN r.cap_currency IS NOT NULL THEN kept.ai_spent(bk, r.cap_currency) END;
    not_counted := CASE WHEN r.cap_currency IS NOT NULL
                        THEN kept.ai_spent_uncounted(bk, r.cap_currency) ELSE '{}'::text[] END;
    RETURN NEXT;
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_cap_usage(uuid[]) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ai_cap_usage(uuid[]) TO kept_app;
