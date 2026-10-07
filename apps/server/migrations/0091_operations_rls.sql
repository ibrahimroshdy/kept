-- Custom SQL migration file, put your code below! --
-- Step 8, task 4: backup runs, release history, operations alert kinds and sealed backup settings
-- (engineering spec §1.10, §7.11; D64–D66, D166, D186; step-8 plan Q9). Above, in 0090,
-- drizzle's part: backup_runs and release_history (src/db/schema/operations.ts), and the alert
-- kinds backup_stale, disk_space_low, bucket_versioning_off, restore_drill_due,
-- backup_suspicious_size (step 8) and webhook_failing (step 6, T15). Below:
--   1. backup_runs: instance scope, written only by kept_owner (the worker's backup login, the
--      CLI, `kept migrate`); instance admins read them (kept_app, like admin_alerts); nothing for
--      kept_system.
--   2. release_history: written by kept_owner in `kept migrate`. kept_system reads it and stamps
--      last_booted_at (the worker's boot guard, T8), through commented policies; instance admins
--      read it (the status page) — the plan gave kept_app nothing, but every table carries a
--      kept_app policy (test/leak.test.ts), and a read-only one for instance admins is harmless.
--   3. The alpha's backup status (instance_settings `backup_status`: the last run and the last
--      good one, T31c) becomes one or two `nightly` rows, and the key goes. Its summaries never
--      recorded the file storage mode: the rows say `local` (the alpha's default) and carry
--      `{"from": "backup_status"}` in detail; an error that isn't a short code becomes
--      `backup_failed`.
-- The sealed backup settings (the restic password, an S3 secret key, an SFTP private key, in the
-- `backup` instance setting) are registered in src/secrets/rotate.ts. test/leak.test.ts lists the
-- tables; test/leak-operations.ts fills them; src/db/operations.test.ts tests them.

-- 1. backup_runs ------------------------------------------------------------------------------------
ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.backup_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.backup_runs FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_admin_select ON public.backup_runs FOR SELECT TO kept_app
  USING ((SELECT kept.is_instance_admin()));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.backup_runs FROM kept_app;
--> statement-breakpoint
REVOKE ALL ON public.backup_runs FROM kept_system;
--> statement-breakpoint

-- 2. release_history ----------------------------------------------------------------------------
ALTER TABLE public.release_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.release_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.release_history FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_admin_select ON public.release_history FOR SELECT TO kept_app
  USING ((SELECT kept.is_instance_admin()));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.release_history FROM kept_app;
--> statement-breakpoint
CREATE POLICY system_select ON public.release_history FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.release_history IS
  'The worker''s boot guard (step 8 T8): the newest release that migrated this database.';
--> statement-breakpoint
CREATE POLICY system_update ON public.release_history FOR UPDATE TO kept_system USING (true)
  WITH CHECK (true);
--> statement-breakpoint
COMMENT ON POLICY system_update ON public.release_history IS
  'The worker''s boot guard (step 8 T8) stamps last_booted_at, its only column grant.';
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.release_history FROM kept_system;
--> statement-breakpoint
GRANT UPDATE (last_booted_at) ON public.release_history TO kept_system;
--> statement-breakpoint

-- 3. The alpha's backup status --------------------------------------------------------------------
INSERT INTO public.backup_runs (id, kind, status, started_at, finished_at, storage_mode, target,
                                db_bytes, bytes_total, files_total, files_new, missing,
                                same_volume, error, detail)
SELECT DISTINCT ON (s->>'id')
       CASE WHEN s->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (s->>'id')::uuid ELSE uuidv7() END,
       'nightly',
       CASE WHEN s->>'status' = 'ok' THEN 'ok' ELSE 'failed' END,
       coalesce((s->>'startedAt')::timestamptz, (s->>'finishedAt')::timestamptz, now()),
       coalesce((s->>'finishedAt')::timestamptz, (s->>'startedAt')::timestamptz, now()),
       'local',
       left(coalesce(nullif(btrim(s->>'target'), ''), 'backup target'), 300),
       (s->>'dbBytes')::bigint, (s->>'bytes')::bigint, (s->>'files')::int,
       (s->>'newFiles')::int, greatest(coalesce((s->>'missing')::int, 0), 0),
       (s->>'sameVolume')::boolean,
       CASE WHEN s->>'status' = 'ok' THEN NULL
            WHEN s->>'error' ~ '^[a-z_]{1,48}$' THEN s->>'error'
            ELSE 'backup_failed' END,
       '{"from": "backup_status"}'::jsonb
  FROM public.instance_settings i
 CROSS JOIN LATERAL (VALUES (i.value->'last'), (i.value->'lastOk')) AS v(s)
 WHERE i.key = 'backup_status' AND jsonb_typeof(v.s) = 'object'
 ORDER BY s->>'id';
--> statement-breakpoint
DELETE FROM public.instance_settings WHERE key = 'backup_status';
