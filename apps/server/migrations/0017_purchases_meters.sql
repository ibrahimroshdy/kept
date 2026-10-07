CREATE TABLE "meter_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"offset" numeric(14, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "meter_events_kind_chk" CHECK ("kind" IN ('replaced'))
);
--> statement-breakpoint
CREATE TABLE "meter_readings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"value" numeric(14, 3) NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"logged_by" uuid,
	"state" text DEFAULT 'accepted' NOT NULL,
	"review_reason" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "meter_readings_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "meter_readings_source_chk" CHECK ("source" IN ('manual', 'photo', 'fuel', 'service', 'import', 'home_assistant')),
	CONSTRAINT "meter_readings_state_chk" CHECK ("state" IN ('accepted', 'needs_review')),
	CONSTRAINT "meter_readings_value_chk" CHECK (value >= 0),
	CONSTRAINT "meter_readings_note_chk" CHECK (char_length(note) <= 500),
	CONSTRAINT "meter_readings_review_reason_chk" CHECK (char_length(review_reason) <= 200)
);
--> statement-breakpoint
CREATE TABLE "meters" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"unit" text NOT NULL,
	"label" text,
	"offset" numeric(14, 3) DEFAULT '0' NOT NULL,
	"max_per_day" numeric(14, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "meters_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "meters_kind_chk" CHECK ("kind" IN ('distance', 'hours', 'custom')),
	CONSTRAINT "meters_unit_chk" CHECK (char_length(unit) BETWEEN 1 AND 12),
	CONSTRAINT "meters_label_chk" CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80),
	CONSTRAINT "meters_max_per_day_chk" CHECK (max_per_day IS NULL OR max_per_day > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit_price" numeric(16, 4),
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "purchase_lines_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "purchase_lines_description_chk" CHECK (char_length(description) BETWEEN 1 AND 300),
	CONSTRAINT "purchase_lines_quantity_chk" CHECK (quantity > 0),
	CONSTRAINT "purchase_lines_unit_price_chk" CHECK (unit_price >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"vendor_id" uuid,
	"purchased_on" date NOT NULL,
	"currency" char(3),
	"total" numeric(16, 4),
	"tax" numeric(16, 4),
	"notes" text,
	"review_state" text DEFAULT 'confirmed' NOT NULL,
	"created_via" text DEFAULT 'app' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "purchases_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "purchases_review_state_chk" CHECK ("review_state" IN ('draft', 'confirmed')),
	CONSTRAINT "purchases_created_via_chk" CHECK ("created_via" IN ('app', 'mcp', 'assistant', 'import', 'email')),
	CONSTRAINT "purchases_total_chk" CHECK (total >= 0),
	CONSTRAINT "purchases_tax_chk" CHECK (tax >= 0),
	CONSTRAINT "purchases_money_chk" CHECK ((total IS NULL AND tax IS NULL) OR currency IS NOT NULL),
	CONSTRAINT "purchases_notes_chk" CHECK (char_length(notes) <= 5000)
);
--> statement-breakpoint
ALTER TABLE "meter_events" ADD CONSTRAINT "meter_events_meter_fk" FOREIGN KEY ("location_id","meter_id") REFERENCES "public"."meters"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_meter_fk" FOREIGN KEY ("location_id","meter_id") REFERENCES "public"."meters"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "meters" ADD CONSTRAINT "meters_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_purchase_fk" FOREIGN KEY ("location_id","purchase_id") REFERENCES "public"."purchases"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meter_events_meter_idx" ON "meter_events" USING btree ("meter_id","at");--> statement-breakpoint
CREATE INDEX "meter_readings_meter_taken_idx" ON "meter_readings" USING btree ("meter_id","taken_at");--> statement-breakpoint
CREATE INDEX "meters_thing_idx" ON "meters" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "purchase_lines_purchase_idx" ON "purchase_lines" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "purchases_location_date_idx" ON "purchases" USING btree ("location_id","purchased_on");--> statement-breakpoint
CREATE INDEX "purchases_vendor_idx" ON "purchases" USING btree ("vendor_id");--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_purchase_line_fk" FOREIGN KEY ("purchase_line_id") REFERENCES "public"."purchase_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "things_purchase_line_idx" ON "things" USING btree ("purchase_line_id");