CREATE TABLE "condition_report_rooms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"place_id" uuid,
	"name" text NOT NULL,
	"condition" text,
	"note" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "condition_report_rooms_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "condition_report_rooms_condition_chk" CHECK ("condition" IN ('good', 'fair', 'poor', 'damaged')),
	CONSTRAINT "condition_report_rooms_name_chk" CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
	CONSTRAINT "condition_report_rooms_note_chk" CHECK (char_length(note) <= 4000)
);
--> statement-breakpoint
CREATE TABLE "condition_reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"held_on" date NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"finished_at" timestamp with time zone,
	"finished_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "condition_reports_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "condition_reports_kind_chk" CHECK ("kind" IN ('move_in', 'move_out')),
	CONSTRAINT "condition_reports_notes_chk" CHECK (char_length(notes) <= 4000),
	CONSTRAINT "condition_reports_finished_chk" CHECK ((finished_at IS NULL) = (finished_by IS NULL))
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_one_subject_chk";--> statement-breakpoint
ALTER TABLE "report_runs" DROP CONSTRAINT "report_runs_kind_chk";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "condition_room_id" uuid;--> statement-breakpoint
ALTER TABLE "condition_report_rooms" ADD CONSTRAINT "condition_report_rooms_report_fk" FOREIGN KEY ("location_id","report_id") REFERENCES "public"."condition_reports"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "condition_reports" ADD CONSTRAINT "condition_reports_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "condition_report_rooms_place_uq" ON "condition_report_rooms" USING btree ("report_id","place_id") WHERE place_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "condition_report_rooms_report_idx" ON "condition_report_rooms" USING btree ("report_id","sort");--> statement-breakpoint
CREATE INDEX "condition_report_rooms_place_idx" ON "condition_report_rooms" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "condition_reports_location_idx" ON "condition_reports" USING btree ("location_id","held_on");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_condition_room_fk" FOREIGN KEY ("location_id","condition_room_id") REFERENCES "public"."condition_report_rooms"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "attachments_condition_room_idx" ON "attachments" USING btree ("condition_room_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_subject_chk" CHECK (num_nonnulls(thing_id, place_id, purchase_id, meter_reading_id, warranty_id, claim_id,
                       loan_id, incident_id, valuation_id, service_record_id,
                       expiring_document_id, fuel_entry_id, condition_room_id) <= 1);--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_kind_chk" CHECK ("kind" IN ('inventory', 'insurance', 'vehicle_history', 'condition'));