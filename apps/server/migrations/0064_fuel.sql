CREATE TABLE "fuel_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"amount" numeric(10, 3) NOT NULL,
	"unit" text NOT NULL,
	"currency" char(3),
	"cost" numeric(16, 4),
	"is_full" boolean DEFAULT true NOT NULL,
	"missed_before" boolean DEFAULT false NOT NULL,
	"vendor_id" uuid,
	"meter_reading_id" uuid,
	"note" text,
	"logged_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "fuel_entries_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "fuel_entries_amount_chk" CHECK (amount > 0),
	CONSTRAINT "fuel_entries_unit_chk" CHECK (unit IN ('L', 'kWh', 'gal')),
	CONSTRAINT "fuel_entries_cost_chk" CHECK (cost >= 0),
	CONSTRAINT "fuel_entries_money_chk" CHECK ((cost IS NULL) = (currency IS NULL)),
	CONSTRAINT "fuel_entries_note_chk" CHECK (char_length(note) <= 500)
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_one_subject_chk";--> statement-breakpoint
ALTER TABLE "report_runs" DROP CONSTRAINT "report_runs_kind_chk";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "fuel_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "report_runs" ADD COLUMN "thing_id" uuid;--> statement-breakpoint
ALTER TABLE "expiring_documents" ADD COLUMN "issued_on" date;--> statement-breakpoint
ALTER TABLE "expiring_documents" ADD COLUMN "currency" char(3);--> statement-breakpoint
ALTER TABLE "expiring_documents" ADD COLUMN "cost" numeric(16, 4);--> statement-breakpoint
ALTER TABLE "fuel_entries" ADD CONSTRAINT "fuel_entries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_entries" ADD CONSTRAINT "fuel_entries_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_entries" ADD CONSTRAINT "fuel_entries_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_entries" ADD CONSTRAINT "fuel_entries_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "fuel_entries_thing_idx" ON "fuel_entries" USING btree ("thing_id","taken_at");--> statement-breakpoint
CREATE INDEX "fuel_entries_vendor_idx" ON "fuel_entries" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_entries_reading_uq" ON "fuel_entries" USING btree ("meter_reading_id") WHERE meter_reading_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_fuel_entry_fk" FOREIGN KEY ("location_id","fuel_entry_id") REFERENCES "public"."fuel_entries"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "expiring_documents" ADD CONSTRAINT "expiring_documents_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_fuel_entry_idx" ON "attachments" USING btree ("fuel_entry_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_subject_chk" CHECK (num_nonnulls(thing_id, place_id, purchase_id, meter_reading_id, warranty_id, claim_id,
                       loan_id, incident_id, valuation_id, service_record_id,
                       expiring_document_id, fuel_entry_id) <= 1);--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_thing_chk" CHECK ((kind = 'vehicle_history') = (thing_id IS NOT NULL)
          AND (thing_id IS NULL OR location_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_kind_chk" CHECK ("kind" IN ('inventory', 'insurance', 'vehicle_history'));--> statement-breakpoint
ALTER TABLE "expiring_documents" ADD CONSTRAINT "expiring_documents_cost_chk" CHECK ((cost IS NULL) = (currency IS NULL) AND (cost IS NULL OR cost >= 0));--> statement-breakpoint
ALTER TABLE "expiring_documents" ADD CONSTRAINT "expiring_documents_issued_chk" CHECK (issued_on IS NULL OR issued_on <= expires_on);