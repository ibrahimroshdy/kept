ALTER TABLE "service_lines" ADD COLUMN "consumable_thing_id" uuid;--> statement-breakpoint
ALTER TABLE "service_lines" ADD COLUMN "consumed_quantity" numeric(12, 3);--> statement-breakpoint
CREATE INDEX "service_lines_consumable_idx" ON "service_lines" USING btree ("consumable_thing_id") WHERE consumable_thing_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "service_lines" ADD CONSTRAINT "service_lines_consumed_chk" CHECK (consumed_quantity > 0);