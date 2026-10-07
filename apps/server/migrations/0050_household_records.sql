CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"person_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"due_on" date,
	"returned_at" timestamp with time zone,
	"return_place_id" uuid,
	"previous_place_id" uuid,
	"previous_container_id" uuid,
	"split_from_thing_id" uuid,
	"lead_days" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "loans_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "loans_direction_chk" CHECK ("direction" IN ('out', 'in')),
	CONSTRAINT "loans_lead_days_chk" CHECK (lead_days BETWEEN 0 AND 60),
	CONSTRAINT "loans_notes_chk" CHECK (char_length(notes) <= 2000),
	CONSTRAINT "loans_due_chk" CHECK (due_on IS NULL OR due_on >= (started_at AT TIME ZONE 'UTC')::date - 1),
	CONSTRAINT "loans_returned_chk" CHECK (returned_at IS NULL OR returned_at >= started_at)
);
--> statement-breakpoint
CREATE TABLE "service_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"service_record_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 3),
	"unit_cost" numeric(16, 4),
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "service_lines_kind_chk" CHECK ("kind" IN ('part', 'labour', 'fluid', 'other')),
	CONSTRAINT "service_lines_description_chk" CHECK (char_length(description) BETWEEN 1 AND 300),
	CONSTRAINT "service_lines_quantity_chk" CHECK (quantity > 0),
	CONSTRAINT "service_lines_unit_cost_chk" CHECK (unit_cost >= 0)
);
--> statement-breakpoint
CREATE TABLE "service_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid,
	"place_id" uuid,
	"serviced_on" date NOT NULL,
	"meter_reading_id" uuid,
	"vendor_id" uuid,
	"total" numeric(16, 4),
	"currency" char(3),
	"notes" text,
	"logged_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "service_records_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "service_records_subject_chk" CHECK (num_nonnulls(thing_id, place_id) = 1),
	CONSTRAINT "service_records_money_chk" CHECK ((total IS NULL) = (currency IS NULL)),
	CONSTRAINT "service_records_total_chk" CHECK (total >= 0),
	CONSTRAINT "service_records_notes_chk" CHECK (char_length(notes) <= 5000)
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid NOT NULL,
	"warranty_id" uuid,
	"incident_id" uuid,
	"opened_on" date NOT NULL,
	"reference" text,
	"vendor_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"cost" numeric(16, 4),
	"currency" char(3),
	"covered_amount" numeric(16, 4),
	"notes" text,
	"closed_on" date,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "claims_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "claims_status_chk" CHECK ("status" IN ('open', 'in_repair', 'resolved', 'rejected')),
	CONSTRAINT "claims_reference_chk" CHECK (char_length(reference) <= 100),
	CONSTRAINT "claims_cost_chk" CHECK (cost >= 0),
	CONSTRAINT "claims_covered_amount_chk" CHECK (covered_amount >= 0),
	CONSTRAINT "claims_notes_chk" CHECK (char_length(notes) <= 5000),
	CONSTRAINT "claims_money_chk" CHECK ((cost IS NULL AND covered_amount IS NULL) OR currency IS NOT NULL),
	CONSTRAINT "claims_closed_chk" CHECK ((status IN ('resolved', 'rejected')) = (closed_on IS NOT NULL)),
	CONSTRAINT "claims_closed_on_chk" CHECK (closed_on IS NULL OR closed_on >= opened_on)
);
--> statement-breakpoint
CREATE TABLE "warranties" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"term_months" integer,
	"lifetime" boolean DEFAULT false NOT NULL,
	"effective_ends_on" date GENERATED ALWAYS AS (CASE WHEN lifetime THEN NULL
               WHEN ends_on IS NOT NULL THEN ends_on
               ELSE (starts_on + make_interval(months => term_months))::date - 1 END) STORED,
	"lead_days" integer DEFAULT 30 NOT NULL,
	"claim_contact" text,
	"registered" boolean DEFAULT false NOT NULL,
	"registration_deadline" date,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "warranties_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "warranties_kind_chk" CHECK ("kind" IN ('manufacturer', 'extended', 'store', 'credit_card', 'insurance')),
	CONSTRAINT "warranties_provider_chk" CHECK (char_length(provider) <= 120),
	CONSTRAINT "warranties_term_months_chk" CHECK (term_months BETWEEN 1 AND 600),
	CONSTRAINT "warranties_lead_days_chk" CHECK (lead_days BETWEEN 0 AND 365),
	CONSTRAINT "warranties_claim_contact_chk" CHECK (char_length(claim_contact) <= 300),
	CONSTRAINT "warranties_term_chk" CHECK (num_nonnulls(ends_on, term_months) + lifetime::int = 1),
	CONSTRAINT "warranties_ends_chk" CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_one_subject_chk";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "warranty_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "loan_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "incident_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "valuation_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "service_record_id" uuid;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "logo_file_id" uuid;--> statement-breakpoint
ALTER TABLE "things" ADD COLUMN "state_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "service_lines" ADD CONSTRAINT "service_lines_record_fk" FOREIGN KEY ("location_id","service_record_id") REFERENCES "public"."service_records"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "service_records" ADD CONSTRAINT "service_records_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_records" ADD CONSTRAINT "service_records_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_records" ADD CONSTRAINT "service_records_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "service_records" ADD CONSTRAINT "service_records_place_fk" FOREIGN KEY ("location_id","place_id") REFERENCES "public"."places"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "loans_one_open_uq" ON "loans" USING btree ("thing_id") WHERE returned_at IS NULL;--> statement-breakpoint
CREATE INDEX "loans_due_idx" ON "loans" USING btree ("due_on") WHERE returned_at IS NULL;--> statement-breakpoint
CREATE INDEX "loans_person_idx" ON "loans" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "loans_thing_idx" ON "loans" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "service_lines_record_idx" ON "service_lines" USING btree ("service_record_id","sort");--> statement-breakpoint
CREATE INDEX "service_records_thing_idx" ON "service_records" USING btree ("thing_id","serviced_on");--> statement-breakpoint
CREATE INDEX "service_records_place_idx" ON "service_records" USING btree ("place_id","serviced_on");--> statement-breakpoint
CREATE INDEX "service_records_reading_idx" ON "service_records" USING btree ("meter_reading_id");--> statement-breakpoint
CREATE INDEX "service_records_vendor_idx" ON "service_records" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_one_repair_uq" ON "claims" USING btree ("thing_id") WHERE status = 'in_repair';--> statement-breakpoint
CREATE INDEX "claims_thing_idx" ON "claims" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "claims_warranty_idx" ON "claims" USING btree ("warranty_id");--> statement-breakpoint
CREATE INDEX "claims_incident_idx" ON "claims" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "claims_vendor_idx" ON "claims" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "warranties_thing_idx" ON "warranties" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "warranties_ends_idx" ON "warranties" USING btree ("effective_ends_on");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_warranty_fk" FOREIGN KEY ("location_id","warranty_id") REFERENCES "public"."warranties"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_claim_fk" FOREIGN KEY ("location_id","claim_id") REFERENCES "public"."claims"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_loan_fk" FOREIGN KEY ("location_id","loan_id") REFERENCES "public"."loans"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_incident_fk" FOREIGN KEY ("location_id","incident_id") REFERENCES "public"."incidents"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_valuation_fk" FOREIGN KEY ("location_id","valuation_id") REFERENCES "public"."valuations"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_service_record_fk" FOREIGN KEY ("location_id","service_record_id") REFERENCES "public"."service_records"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "attachments_warranty_idx" ON "attachments" USING btree ("warranty_id");--> statement-breakpoint
CREATE INDEX "attachments_claim_idx" ON "attachments" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "attachments_loan_idx" ON "attachments" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "attachments_incident_idx" ON "attachments" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "attachments_valuation_idx" ON "attachments" USING btree ("valuation_id");--> statement-breakpoint
CREATE INDEX "attachments_service_record_idx" ON "attachments" USING btree ("service_record_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_subject_chk" CHECK (num_nonnulls(thing_id, place_id, purchase_id, meter_reading_id, warranty_id, claim_id,
                       loan_id, incident_id, valuation_id, service_record_id) <= 1);