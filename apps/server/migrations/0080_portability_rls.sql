-- Custom SQL migration file, put your code below! --
-- Step 7, task 4: export runs, archive imports, source ids and abandoned runs (engineering spec
-- §1.10, §3.1b, §3.3, §7.1, §7.2; D68, D146, D157, D180; step-7 plan Q2, Q6, Q7, Q8, Q14, Q17,
-- Q18). Above, in 0079, drizzle's part: step 4's export_runs gains step 7's kinds (`location`,
-- `me`), `cancelled`, its options, start, SHA-256 and sealed key; import_runs gains the archive
-- columns, the sealed key and a null location while a draft; import_source_ids gains `homebox`
-- and the wider entity list (src/db/schema/money.ts, imports.ts). Below:
--   1. export_runs, still its creator's alone while they hold owner or admin (0049, D180):
--      - a new run names exactly one incident or thing list for a claim pack, and none for a
--        Kept export; `me` is the requester's own Personal location (Q14);
--      - "Include secrets" is the owner's (D68): a run with it (and its sealed key) is inserted
--        only by the location's owner. The key is sealed by the route (Q7) and only ever cleared,
--        by the doors below: kept_app holds no grant on it.
--   2. The export doors, step 4's, widened rather than duplicated:
--      - kept.export_run_claim() also records when the job began;
--      - kept.export_run_finish() also takes the archive's SHA-256, accepts `cancelled` (the
--        creator's POST /exports/:id/cancel; the job's next door call then fails and it stops),
--        starts a done run's seven days when it is ready (§3.3), and clears the sealed key
--        whatever the outcome;
--      - kept.purge_expired_exports() also fails a step-7 run its job abandoned (queued or
--        running three hours after it began: the job expires at two) and clears its key.
--   3. import_runs for archives: a run with no target yet is its creator's alone (draft, or
--      failed on inspection, or pruned); kept.set_import_target() sets the target once (kept_app
--      holds no grant on location_id: 23514 import_runs_target_fixed for a second time). The
--      archive columns and the sealed key take column grants; the key is cleared by the job.
--   4. Abandoned runs (step-3 carry-over, Q18): kept.stale_import_runs() and
--      kept.clear_import_run(), the `prune-imports` job's (kept_system), which deletes the
--      archive blob `i/<id>.zip` between the two.
--   5. Access ends (D180): when someone stops administering a location, their unfinished
--      exports of it fail (`not_permitted`) and their unfinished imports into it are cancelled,
--      and the sealed keys of both are cleared at once, through kept.membership_access_ended().
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-portability.ts
-- fills the rows; src/db/portability.test.ts tests them.

-- 1. export_runs ---------------------------------------------------------------------------------
DROP POLICY app_insert ON public.export_runs;
--> statement-breakpoint
CREATE POLICY app_insert ON public.export_runs FOR INSERT TO kept_app
  WITH CHECK (created_by = (SELECT kept.current_user_id())
              AND location_id IN (SELECT kept.admin_location_ids())
              AND CASE kind
                    WHEN 'claim_pack' THEN num_nonnulls(incident_id, thing_ids) = 1
                    WHEN 'me' THEN kept.owns_location(location_id) AND EXISTS (
                      SELECT 1 FROM public.locations l
                       WHERE l.id = location_id AND l.kind = 'personal')
                    ELSE true END
              AND (NOT include_secrets OR kept.owns_location(location_id))
              AND status = 'queued' AND storage_key IS NULL AND bytes IS NULL AND sha256 IS NULL
              AND error IS NULL AND started_at IS NULL AND finished_at IS NULL
              AND revoked_at IS NULL AND downloads = 0 AND last_downloaded_at IS NULL
              AND progress_done = 0 AND progress_total = 0
              AND expires_at <= now() + interval '7 days'
              AND (token_expires_at IS NULL OR token_expires_at <= expires_at));
--> statement-breakpoint

-- 2. The export doors -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kept.export_run_claim(p_id uuid)
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
  UPDATE public.export_runs x SET status = 'running', started_at = now() WHERE x.id = p_id;
  RETURN QUERY SELECT r.location_id, r.kind, r.incident_id, r.thing_ids, r.created_by,
                      r.include_secrets;
END $$;
--> statement-breakpoint
DROP FUNCTION kept.export_run_finish(uuid, bigint, text, text);
--> statement-breakpoint
-- Done: the archive is at the run's own key, with its size and (step 7) SHA-256, kept seven days
-- from now. Failed: a short code (the CHECK), and no key. Cancelled: by its creator, queued or
-- running. The sealed key goes in every case.
CREATE FUNCTION kept.export_run_finish(p_id uuid, p_bytes bigint, p_status text, p_error text,
                                       p_sha256 text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.export_runs%ROWTYPE;
BEGIN
  IF p_status NOT IN ('done', 'failed', 'cancelled') OR (p_status = 'done' AND p_bytes IS NULL) THEN
    RAISE EXCEPTION 'a run finishes done, with its size, failed or cancelled'
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
         sha256 = CASE WHEN p_status = 'done' THEN p_sha256 END,
         error = CASE WHEN p_status = 'failed' THEN coalesce(p_error, 'failed') END,
         progress_done = CASE WHEN p_status = 'done' THEN x.progress_total ELSE x.progress_done END,
         expires_at = CASE WHEN p_status = 'done' THEN now() + interval '7 days'
                           ELSE x.expires_at END,
         secrets_key_ciphertext = NULL, key_version = NULL,
         finished_at = now()
   WHERE x.id = p_id;
END $$;
--> statement-breakpoint
-- Seven days (§3.3 export retention): the run stays as history, its archive and link go. Returns
-- the keys whose blobs the job deletes after its commit. A step-7 run whose job died (queued or
-- running three hours after it began; the job expires at two, jobs/policies.ts) fails, and no
-- sealed key outlives its run.
CREATE OR REPLACE FUNCTION kept.purge_expired_exports(p_limit integer) RETURNS SETOF text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.export_runs x
     SET status = 'failed', error = 'abandoned', finished_at = now(),
         secrets_key_ciphertext = NULL, key_version = NULL
   WHERE x.kind <> 'claim_pack' AND x.status IN ('queued', 'running')
     AND coalesce(x.started_at, x.created_at) <= now() - interval '3 hours';
  RETURN QUERY
  WITH gone AS (
    SELECT x.id, x.storage_key FROM public.export_runs x
     WHERE x.status <> 'expired' AND (x.expires_at <= now() OR x.created_by IS NULL)
     ORDER BY x.expires_at, x.id
     LIMIT greatest(p_limit, 0)
     FOR UPDATE),
  done AS (
    UPDATE public.export_runs x
       SET status = 'expired', storage_key = NULL, token_hash = NULL, token_expires_at = NULL,
           secrets_key_ciphertext = NULL, key_version = NULL
      FROM gone
     WHERE x.id = gone.id
    RETURNING gone.storage_key)
  SELECT d.storage_key FROM done d WHERE d.storage_key IS NOT NULL;
  DELETE FROM public.export_runs x
   WHERE x.status = 'expired' AND x.expires_at <= now() - interval '90 days';
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.export_run_finish(uuid, bigint, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.export_run_finish(uuid, bigint, text, text, text)
  TO kept_app, kept_system;
--> statement-breakpoint

-- 3. import_runs for archives -------------------------------------------------------------------
DROP POLICY app_select ON public.import_runs;
--> statement-breakpoint
DROP POLICY app_insert ON public.import_runs;
--> statement-breakpoint
DROP POLICY app_update ON public.import_runs;
--> statement-breakpoint
-- An archive run with no target is its creator's alone; with one, the location's owners and
-- admins' (0038).
CREATE POLICY app_select ON public.import_runs FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids())
         OR (location_id IS NULL AND created_by = (SELECT kept.current_user_id())));
--> statement-breakpoint
CREATE POLICY app_insert ON public.import_runs FOR INSERT TO kept_app
  WITH CHECK (created_by = (SELECT kept.current_user_id())
              AND (location_id IN (SELECT kept.admin_location_ids())
                   OR (location_id IS NULL AND status = 'draft'
                       AND source IN ('homebox_zip', 'kept_zip'))));
--> statement-breakpoint
CREATE POLICY app_update ON public.import_runs FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids())
         OR (location_id IS NULL AND created_by = (SELECT kept.current_user_id())))
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              OR (location_id IS NULL AND created_by = (SELECT kept.current_user_id())));
--> statement-breakpoint
GRANT UPDATE (source_version, archive_bytes, archive_sha256, archive_ready_at, inspect,
              secrets_key_ciphertext, key_version)
  ON public.import_runs TO kept_app;
--> statement-breakpoint
-- The target, once (screens §6, plan T8): only the run's creator, only while it is a draft with
-- none, and only a location they administer. The route creates a new location first, in the
-- same transaction, when that is the choice (a Kept export always lands in a new one, Q8).
CREATE FUNCTION kept.set_import_target(p_run uuid, p_location uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.import_runs%ROWTYPE;
  uid uuid := kept.current_user_id();
BEGIN
  SELECT * INTO r FROM public.import_runs x WHERE x.id = p_run FOR UPDATE;
  IF r.id IS NULL OR uid IS NULL
     OR NOT (r.created_by = uid
             OR (r.location_id IS NOT NULL AND r.location_id IN (SELECT kept.admin_location_ids())))
  THEN
    RAISE EXCEPTION 'no such import run' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r.location_id IS NOT NULL THEN
    RAISE EXCEPTION 'an import''s location is set once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'import_runs_target_fixed';
  END IF;
  IF r.status <> 'draft' OR p_location IS NULL
     OR p_location NOT IN (SELECT kept.admin_location_ids()) THEN
    RAISE EXCEPTION 'no such location to import into' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.import_runs x SET location_id = p_location WHERE x.id = p_run;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.set_import_target(uuid, uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.set_import_target(uuid, uuid) TO kept_app;
--> statement-breakpoint

-- 4. Abandoned runs ---------------------------------------------------------------------------
-- Runs untouched since `p_before` that still hold something to clear: a draft or checked run,
-- and a failed, cancelled or done one still holding rows, an archive, its inspection or a key.
-- A running run is left alone. `has_archive`: the job deletes `i/<id>.zip` (missing is fine).
CREATE FUNCTION kept.stale_import_runs(p_before timestamptz, p_limit integer)
RETURNS TABLE (id uuid, has_archive boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT x.id, x.archive_bytes IS NOT NULL OR x.archive_sha256 IS NOT NULL
    FROM public.import_runs x
   WHERE x.updated_at < p_before
     AND (x.status IN ('draft', 'checked')
          OR (x.status IN ('failed', 'cancelled', 'done')
              AND (x.rows IS NOT NULL OR x.archive_bytes IS NOT NULL
                   OR x.archive_sha256 IS NOT NULL OR x.inspect IS NOT NULL
                   OR x.secrets_key_ciphertext IS NOT NULL)))
   ORDER BY x.updated_at, x.id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
-- Clears one: its rows, archive columns, inspection and key; a draft or checked run becomes
-- cancelled. The dry run's report stays (the summary of what it would have done).
CREATE FUNCTION kept.clear_import_run(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE public.import_runs x
     SET rows = NULL, archive_bytes = NULL, archive_sha256 = NULL, archive_ready_at = NULL,
         inspect = NULL, secrets_key_ciphertext = NULL, key_version = NULL,
         status = CASE WHEN x.status IN ('draft', 'checked') THEN 'cancelled' ELSE x.status END,
         finished_at = CASE WHEN x.status IN ('draft', 'checked') THEN now()
                            ELSE x.finished_at END
   WHERE x.id = p_id AND x.status <> 'running'
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.stale_import_runs(timestamptz, integer),
  kept.clear_import_run(uuid) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.stale_import_runs(timestamptz, integer),
  kept.clear_import_run(uuid) TO kept_system;
--> statement-breakpoint

-- 5. Access ends --------------------------------------------------------------------------------
-- Owner-only: the membership trigger calls it. Someone who no longer administers a location loses
-- their unfinished exports of it and their unfinished imports into it, and the keys they held.
CREATE FUNCTION kept.end_portability_runs_in(p_user uuid, p_location uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.export_runs x
     SET status = 'failed', error = 'not_permitted', finished_at = now(),
         secrets_key_ciphertext = NULL, key_version = NULL
   WHERE x.created_by = p_user AND x.location_id = p_location
     AND x.status IN ('queued', 'running');
  UPDATE public.import_runs x
     SET status = 'cancelled', finished_at = now(), secrets_key_ciphertext = NULL,
         key_version = NULL
   WHERE x.created_by = p_user AND x.location_id = p_location
     AND x.status IN ('draft', 'checked', 'running');
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.end_portability_runs_in(uuid, uuid)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.membership_access_ended() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  purged boolean := NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = OLD.location_id);
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM kept.redact_assistant_in(OLD.user_id, OLD.location_id);
    IF NOT purged THEN
      PERFORM kept.revoke_tokens_in(OLD.user_id, OLD.location_id, 'membership_ended');
      PERFORM kept.disable_webhooks_in(OLD.user_id, OLD.location_id);
      PERFORM kept.end_portability_runs_in(OLD.user_id, OLD.location_id);
    END IF;
  ELSIF NOT purged THEN
    IF NEW.role = 'viewer' AND OLD.role <> 'viewer' THEN
      PERFORM kept.revoke_tokens_in(OLD.user_id, OLD.location_id, 'role_lost');
    END IF;
    IF OLD.role IN ('owner', 'admin') AND NEW.role NOT IN ('owner', 'admin') THEN
      PERFORM kept.disable_webhooks_in(OLD.user_id, OLD.location_id);
      PERFORM kept.end_portability_runs_in(OLD.user_id, OLD.location_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
