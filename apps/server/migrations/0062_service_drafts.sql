ALTER TABLE "extractions" DROP CONSTRAINT "extractions_one_draft_chk";--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN "service_record_id" uuid;--> statement-breakpoint
ALTER TABLE "service_records" ADD COLUMN "review_state" text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_service_record_fk" FOREIGN KEY ("location_id","service_record_id") REFERENCES "public"."service_records"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "extractions_service_record_idx" ON "extractions" USING btree ("service_record_id") WHERE service_record_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "service_records_reading_uq" ON "service_records" USING btree ("meter_reading_id") WHERE meter_reading_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "service_records_drafts_idx" ON "service_records" USING btree ("logged_by","created_at") WHERE review_state = 'draft';--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_one_draft_chk" CHECK (num_nonnulls(thing_id, purchase_id, meter_id, service_record_id) <= 1);--> statement-breakpoint
ALTER TABLE "service_records" ADD CONSTRAINT "service_records_review_state_chk" CHECK ("review_state" IN ('draft', 'confirmed'));