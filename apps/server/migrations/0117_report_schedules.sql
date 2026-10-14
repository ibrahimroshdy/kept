CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"cadence" text NOT NULL,
	"last_run_on" date,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_schedules_kind_chk" CHECK ("kind" IN ('inventory', 'insurance')),
	CONSTRAINT "report_schedules_cadence_chk" CHECK ("cadence" IN ('weekly', 'monthly')),
	CONSTRAINT "report_schedules_error_chk" CHECK (last_error ~ '^[a-z_]{1,32}$')
);
--> statement-breakpoint
ALTER TABLE "report_runs" ADD COLUMN "email_when_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedules_uq" ON "report_schedules" USING btree ("user_id","location_id","kind");--> statement-breakpoint
CREATE INDEX "report_schedules_location_idx" ON "report_schedules" USING btree ("location_id");