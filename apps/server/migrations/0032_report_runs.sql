-- Step 2, task 32: the inventory report (D201; engineering spec §7.1, §7.2, §7.13). Above,
-- drizzle's part: report_runs (src/db/schema/reports.ts). Below:
--   1. Row-level security: a run is its requester's alone, and only while they can still see what
--      it covers: the location of a location report, the account of an account report. It is
--      created only for locations the requester can see (`location_ids`), queued, and for at most
--      24 hours. The `report` job runs in the requester's scope (a tenant job) and moves it along
--      through the column grants: status, progress, size, error and the times, nothing else.
--   2. kept.purge_expired_reports(): kept_system's door for the hourly purge. It deletes runs past
--      their 24 hours (and runs whose requester's user was deleted) and returns their ids, whose
--      blobs (`r/<id>.pdf`) the job then deletes after its commit. SYSTEM_TABLES does not grow.
-- test/leak.test.ts and src/db/migrate.test.ts list the function; test/leak-inventory.ts fills
-- the table.
CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"location_id" uuid,
	"owner_account_id" uuid,
	"location_ids" uuid[] NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"progress_total" integer DEFAULT 0 NOT NULL,
	"bytes" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	CONSTRAINT "report_runs_status_chk" CHECK ("status" IN ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "report_runs_scope_chk" CHECK (num_nonnulls(location_id, owner_account_id) = 1),
	CONSTRAINT "report_runs_locations_chk" CHECK (cardinality(location_ids) BETWEEN 1 AND 1000
          AND (location_id IS NULL OR location_ids = ARRAY[location_id])),
	CONSTRAINT "report_runs_options_chk" CHECK (jsonb_typeof(options) = 'object'),
	CONSTRAINT "report_runs_progress_chk" CHECK (progress_done >= 0 AND progress_total >= 0 AND progress_done <= progress_total),
	CONSTRAINT "report_runs_error_chk" CHECK (error ~ '^[a-z_]{1,32}$'),
	CONSTRAINT "report_runs_expires_chk" CHECK (expires_at > created_at)
);
--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_runs_user_idx" ON "report_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "report_runs_expires_idx" ON "report_runs" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE public.report_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.report_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.report_runs FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE UPDATE ON public.report_runs FROM kept_app, kept_system;
--> statement-breakpoint
CREATE POLICY app_select ON public.report_runs FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
         AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids()))
         AND (owner_account_id IS NULL
              OR owner_account_id IN (SELECT kept.visible_account_ids())));
--> statement-breakpoint
CREATE POLICY app_insert ON public.report_runs FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND status = 'queued'
              AND expires_at <= now() + interval '24 hours'
              AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids()))
              AND (owner_account_id IS NULL
                   OR owner_account_id IN (SELECT kept.visible_account_ids()))
              AND location_ids <@ ARRAY(SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_update ON public.report_runs FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
         AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids()))
         AND (owner_account_id IS NULL
              OR owner_account_id IN (SELECT kept.visible_account_ids())))
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
GRANT UPDATE (status, progress_done, progress_total, bytes, error, started_at, finished_at)
  ON public.report_runs TO kept_app;
--> statement-breakpoint
CREATE FUNCTION kept.purge_expired_reports(p_limit integer) RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM public.report_runs r
   WHERE r.id IN (SELECT x.id FROM public.report_runs x
                   WHERE x.expires_at <= now() OR x.user_id IS NULL
                   ORDER BY x.expires_at, x.id
                   LIMIT greatest(p_limit, 0))
  RETURNING r.id
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.purge_expired_reports(integer) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.purge_expired_reports(integer) TO kept_system;
