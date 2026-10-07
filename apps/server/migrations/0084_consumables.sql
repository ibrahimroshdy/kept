CREATE TABLE "stock_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"thing_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"min_quantity" numeric(12, 3) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "stock_rules_thing_uq" UNIQUE("thing_id"),
	CONSTRAINT "stock_rules_min_quantity_chk" CHECK (min_quantity > 0 AND min_quantity <= 1000000)
);
--> statement-breakpoint
ALTER TABLE "stock_rules" ADD CONSTRAINT "stock_rules_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_rules" ADD CONSTRAINT "stock_rules_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "stock_rules_location_idx" ON "stock_rules" USING btree ("location_id");