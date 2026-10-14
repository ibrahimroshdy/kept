-- Custom SQL migration file, put your code below! --
-- 1.3, D228: scheduled and emailed reports. Above, drizzle's part: report_schedules and
-- report_runs.email_when_done. Below, row-level security on report_schedules:
--   - kept_app: a person's own schedules, for a location they can see; they may change only the
--     cadence (an upsert from Settings or the report sheet) or delete one.
--   - kept_system: the hourly `report-schedules` job reads every schedule and writes only when it
--     last ran and why it couldn't (last_run_on, last_error). It requests the run itself in the
--     owner's scope (kept_app), so the person's rights and the report limit still apply.
-- test/leak.test.ts lists the table.
ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.report_schedules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.report_schedules FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE UPDATE ON public.report_schedules FROM kept_app, kept_system;
--> statement-breakpoint
REVOKE INSERT, DELETE ON public.report_schedules FROM kept_system;
--> statement-breakpoint
CREATE POLICY app_own ON public.report_schedules FOR ALL TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
         AND location_id IN (SELECT kept.visible_location_ids()))
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
GRANT UPDATE (cadence) ON public.report_schedules TO kept_app;
--> statement-breakpoint
CREATE POLICY system_select ON public.report_schedules FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
CREATE POLICY system_update ON public.report_schedules FOR UPDATE TO kept_system
  USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT UPDATE (last_run_on, last_error) ON public.report_schedules TO kept_system;
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.report_schedules IS
  'the report-schedules job (1.3, D228) reads every schedule to find the ones due';
--> statement-breakpoint
COMMENT ON POLICY system_update ON public.report_schedules IS
  'the report-schedules job (1.3, D228) marks when a schedule last ran, and why it could not';
