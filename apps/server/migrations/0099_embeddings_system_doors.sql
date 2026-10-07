-- Custom SQL migration file, put your code below! --
-- Step 6 T14's queued schema for the embeddings backfill, and the step-6 security review's S4
-- (docs/audits/security-step6-2026-10-06.md). Above, in 0098, drizzle's part:
-- embedding_state.paused_until. Below:
--   1. kept.embedding_mark() also records when a pause ends (paused_until: a cap's reset or a
--      provider's wait; NULL for a pause with no end, such as a manual one, which ai_resume can
--      lift at any time, so the next hourly run tries again). It is kept_system's alone now (S4):
--      only the backfill calls it, and a member or write token with raw SQL could otherwise skew
--      the instance's totals for its own location.
--   2. kept.embedding_backfill_locations() (SYS): the live locations, less those whose pause
--      hasn't ended. The backfill read memberships before (kept_system can't read locations), so
--      it visited a deleted location until its purge, and a paused one every hour.
--   3. kept.embedding_backlog_thing(thing, model): the `embed-thing` job's backlog row for its one
--      thing (APP: visible to the caller, as kept.embedding_backlog() checks), so the editor's job
--      no longer reads up to 500 rows of the location to find it.
--   4. kept.embedding_status(uuid) goes (S4): nothing calls it; the status page reads
--      kept.embedding_status_instance(), which now also answers each group's earliest pause end
--      and its reason, for the status's `paused`.
--   5. kept_system reads ai_model_prices (SELECT only, commented), so a background embedding's
--      cost is priced, not "unknown".
-- A cap raised before its reset is picked up at the reset, not at once: the hourly run skips a
-- location until its paused_until (inferred acceptable: the gate would refuse it until then
-- anyway unless the cap moved, and keyword search is unaffected).
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; src/db/embeddings.test.ts
-- tests them.

-- 1. The mark -------------------------------------------------------------------------------------
DROP FUNCTION kept.embedding_mark(uuid, text, text, integer, text);
--> statement-breakpoint
CREATE FUNCTION kept.embedding_mark(p_location uuid, p_model_key text, p_source text,
                                    p_pending integer, p_paused_reason text,
                                    p_paused_until timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'kept_system' THEN
    RAISE EXCEPTION 'the backfill marks a location' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.embedding_state AS s (location_id, model_key, source, pending, last_run_at,
                                           paused_reason, paused_until, updated_at)
  VALUES (p_location, p_model_key, p_source, greatest(coalesce(p_pending, 0), 0), now(),
          p_paused_reason,
          CASE WHEN p_paused_reason IS NOT NULL AND isfinite(p_paused_until) THEN p_paused_until END,
          now())
  ON CONFLICT (location_id) DO UPDATE
    SET model_key = EXCLUDED.model_key, source = EXCLUDED.source, pending = EXCLUDED.pending,
        last_run_at = EXCLUDED.last_run_at, paused_reason = EXCLUDED.paused_reason,
        paused_until = EXCLUDED.paused_until, updated_at = EXCLUDED.updated_at;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.embedding_mark(uuid, text, text, integer, text, timestamptz)
  FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.embedding_mark(uuid, text, text, integer, text, timestamptz)
  TO kept_system;
--> statement-breakpoint

-- 2. The backfill's locations ----------------------------------------------------------------------
CREATE FUNCTION kept.embedding_backfill_locations()
RETURNS TABLE (location_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT l.id FROM public.locations l
    LEFT JOIN public.embedding_state s ON s.location_id = l.id
   WHERE l.deleted_at IS NULL AND (s.paused_until IS NULL OR s.paused_until <= now())
   ORDER BY l.id
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.embedding_backfill_locations() FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.embedding_backfill_locations() TO kept_system;
--> statement-breakpoint

-- 3. One thing's backlog row ------------------------------------------------------------------------
-- No row when the thing is gone, unnamed, not visible, or its vector for the model is current.
CREATE FUNCTION kept.embedding_backlog_thing(p_thing uuid, p_model_key text)
RETURNS TABLE (thing_id uuid, text text, content_hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT b.id, b.txt, b.hash
    FROM (SELECT t.id, x.txt, encode(sha256(convert_to(x.txt, 'UTF8')), 'hex') AS hash,
                 e.content_hash AS had
            FROM public.things t
           CROSS JOIN LATERAL (SELECT kept.embedding_text(t) AS txt) x
            LEFT JOIN public.thing_embeddings e
              ON e.thing_id = t.id AND e.model_key = p_model_key
           WHERE t.id = p_thing AND t.deleted_at IS NULL AND t.name IS NOT NULL
             AND t.location_id IN (SELECT kept.visible_location_ids())) b
   WHERE b.had IS DISTINCT FROM b.hash;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.embedding_backlog_thing(uuid, text) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.embedding_backlog_thing(uuid, text) TO kept_app;
--> statement-breakpoint

-- 4. Status ----------------------------------------------------------------------------------------
DROP FUNCTION kept.embedding_status(uuid);
--> statement-breakpoint
DROP FUNCTION kept.embedding_status_instance();
--> statement-breakpoint
-- For instance admins (the admin status page, D207): counts per source and model, no location;
-- and the earliest end of a pause still running in the group, with its reason.
CREATE FUNCTION kept.embedding_status_instance()
RETURNS TABLE (source text, model_key text, locations integer, embedded bigint, pending bigint,
               paused integer, paused_until timestamptz, paused_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
BEGIN
  IF NOT kept.is_instance_admin() THEN
    RAISE EXCEPTION 'instance admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT s.source, s.model_key, count(*)::int,
         coalesce(sum((SELECT count(*) FROM public.thing_embeddings e
                         WHERE e.location_id = s.location_id AND e.model_key = s.model_key)),
                  0)::bigint,
         coalesce(sum(s.pending), 0)::bigint,
         count(*) FILTER (WHERE s.paused_reason IS NOT NULL)::int,
         min(s.paused_until) FILTER (WHERE s.paused_until > now()),
         (array_agg(s.paused_reason ORDER BY s.paused_until)
            FILTER (WHERE s.paused_until > now()))[1]
    FROM public.embedding_state s
   GROUP BY s.source, s.model_key
   ORDER BY s.source, s.model_key;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.embedding_status_instance() FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.embedding_status_instance() TO kept_app;
--> statement-breakpoint

-- 5. Prices for the background ---------------------------------------------------------------------
GRANT SELECT ON public.ai_model_prices TO kept_system;
--> statement-breakpoint
CREATE POLICY system_select ON public.ai_model_prices FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.ai_model_prices IS
  'the embeddings backfill (T14) prices a background embedding call it records in the ledger';
