CREATE TABLE "expiring_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid,
	"place_id" uuid,
	"kind" text NOT NULL,
	"title" text,
	"expires_on" date NOT NULL,
	"lead_days" integer DEFAULT 30 NOT NULL,
	"superseded_by_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "expiring_documents_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "expiring_documents_kind_chk" CHECK ("kind" IN ('registration', 'insurance', 'licence', 'inspection', 'lease', 'contract', 'other')),
	CONSTRAINT "expiring_documents_title_chk" CHECK (char_length(title) BETWEEN 1 AND 120),
	CONSTRAINT "expiring_documents_lead_days_chk" CHECK (lead_days BETWEEN 0 AND 365),
	CONSTRAINT "expiring_documents_subject_chk" CHECK (num_nonnulls(thing_id, place_id) <= 1),
	CONSTRAINT "expiring_documents_other_chk" CHECK (kind <> 'other' OR title IS NOT NULL),
	CONSTRAINT "expiring_documents_superseded_chk" CHECK (superseded_by_id IS DISTINCT FROM id)
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid,
	"place_id" uuid,
	"name" text NOT NULL,
	"every_months" integer,
	"every_units" numeric(14, 3),
	"meter_id" uuid,
	"due_on" date,
	"lead_days" integer DEFAULT 14 NOT NULL,
	"lead_units" numeric(14, 3),
	"base_on" date NOT NULL,
	"base_value" numeric(14, 3),
	"anchor_on" date NOT NULL,
	"anchor_value" numeric(14, 3),
	"snoozed_until" date,
	"snoozed_until_value" numeric(14, 3),
	"skip_next" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "schedules_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "schedules_name_chk" CHECK (char_length(name) BETWEEN 1 AND 120),
	CONSTRAINT "schedules_every_months_chk" CHECK (every_months BETWEEN 1 AND 600),
	CONSTRAINT "schedules_every_units_chk" CHECK (every_units > 0),
	CONSTRAINT "schedules_lead_days_chk" CHECK (lead_days BETWEEN 0 AND 365),
	CONSTRAINT "schedules_lead_units_chk" CHECK (lead_units >= 0),
	CONSTRAINT "schedules_subject_chk" CHECK (num_nonnulls(thing_id, place_id) = 1),
	CONSTRAINT "schedules_rule_chk" CHECK (num_nonnulls(every_months, every_units, due_on) >= 1),
	CONSTRAINT "schedules_meter_chk" CHECK ((every_units IS NULL) = (meter_id IS NULL)),
	CONSTRAINT "schedules_meter_thing_chk" CHECK (meter_id IS NULL OR thing_id IS NOT NULL),
	CONSTRAINT "schedules_one_off_chk" CHECK (due_on IS NULL OR (every_months IS NULL AND every_units IS NULL))
);
--> statement-breakpoint
CREATE TABLE "service_completions" (
	"location_id" uuid NOT NULL,
	"service_record_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	CONSTRAINT "service_completions_pk" PRIMARY KEY("service_record_id","schedule_id")
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_one_subject_chk";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "expiring_document_id" uuid;--> statement-breakpoint
ALTER TABLE "expiring_documents" ADD CONSTRAINT "expiring_documents_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expiring_documents" ADD CONSTRAINT "expiring_documents_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "expiring_documents" ADD CONSTRAINT "expiring_documents_place_fk" FOREIGN KEY ("location_id","place_id") REFERENCES "public"."places"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_place_fk" FOREIGN KEY ("location_id","place_id") REFERENCES "public"."places"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_meter_fk" FOREIGN KEY ("location_id","meter_id") REFERENCES "public"."meters"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "service_completions" ADD CONSTRAINT "service_completions_record_fk" FOREIGN KEY ("location_id","service_record_id") REFERENCES "public"."service_records"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "service_completions" ADD CONSTRAINT "service_completions_schedule_fk" FOREIGN KEY ("location_id","schedule_id") REFERENCES "public"."schedules"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "expiring_documents_expires_idx" ON "expiring_documents" USING btree ("expires_on") WHERE superseded_by_id IS NULL;--> statement-breakpoint
CREATE INDEX "expiring_documents_location_idx" ON "expiring_documents" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "expiring_documents_thing_idx" ON "expiring_documents" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "expiring_documents_place_idx" ON "expiring_documents" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "schedules_thing_idx" ON "schedules" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "schedules_place_idx" ON "schedules" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "schedules_location_idx" ON "schedules" USING btree ("location_id") WHERE active;--> statement-breakpoint
CREATE INDEX "service_completions_schedule_idx" ON "service_completions" USING btree ("schedule_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_expiring_document_fk" FOREIGN KEY ("location_id","expiring_document_id") REFERENCES "public"."expiring_documents"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "attachments_expiring_document_idx" ON "attachments" USING btree ("expiring_document_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_subject_chk" CHECK (num_nonnulls(thing_id, place_id, purchase_id, meter_reading_id, warranty_id, claim_id,
                       loan_id, incident_id, valuation_id, service_record_id,
                       expiring_document_id) <= 1);