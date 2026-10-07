CREATE TABLE "short_ids" (
	"code" char(6) PRIMARY KEY NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid,
	"place_id" uuid,
	"state" text DEFAULT 'assigned' NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"printed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "short_ids_state_chk" CHECK ("state" IN ('blank', 'assigned', 'retired')),
	CONSTRAINT "short_ids_code_chk" CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{6}$'),
	CONSTRAINT "short_ids_target_chk" CHECK (CASE state WHEN 'blank' THEN num_nonnulls(thing_id, place_id) = 0
                     WHEN 'assigned' THEN num_nonnulls(thing_id, place_id) = 1
                     ELSE num_nonnulls(thing_id, place_id) <= 1 END)
);
--> statement-breakpoint
CREATE TABLE "thing_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"from_thing_id" uuid NOT NULL,
	"to_thing_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "thing_links_uq" UNIQUE("from_thing_id","to_thing_id","kind"),
	CONSTRAINT "thing_links_kind_chk" CHECK ("kind" IN ('accessory_of', 'spare_part_for', 'consumable_for', 'bundled_with', 'replaces', 'related')),
	CONSTRAINT "thing_links_not_self_chk" CHECK (from_thing_id <> to_thing_id)
);
--> statement-breakpoint
CREATE TABLE "thing_tags" (
	"location_id" uuid NOT NULL,
	"thing_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "thing_tags_pk" PRIMARY KEY("thing_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "things" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"place_id" uuid,
	"container_id" uuid,
	"type_id" uuid,
	"name" text,
	"brand_id" uuid,
	"model" text,
	"serial" text,
	"barcode" text,
	"colour" text,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"condition" text,
	"notes" text,
	"aliases" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"belongs_to_person_id" uuid,
	"purchase_line_id" uuid,
	"manual_url" text,
	"expires_on" date,
	"expiry_lead_days" integer,
	"lifecycle" text DEFAULT 'in_use' NOT NULL,
	"ended_on" date,
	"ended_price" numeric(16, 4),
	"ended_currency" char(3),
	"ended_to" text,
	"ended_notes" text,
	"acquired_from" text,
	"provenance_notes" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"location_uncertain" boolean DEFAULT false NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"field_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_state" text DEFAULT 'confirmed' NOT NULL,
	"created_via" text DEFAULT 'app' NOT NULL,
	"created_by" uuid,
	"split_from_id" uuid,
	"place_path" text,
	"search_tsv" "tsvector",
	"deleted_at" timestamp with time zone,
	"trash_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "things_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "things_lifecycle_chk" CHECK ("lifecycle" IN ('in_use', 'sold', 'given_away', 'lost', 'disposed', 'stolen', 'destroyed', 'returned_to_owner')),
	CONSTRAINT "things_condition_chk" CHECK ("condition" IN ('new', 'good', 'fair', 'poor', 'broken')),
	CONSTRAINT "things_review_state_chk" CHECK ("review_state" IN ('draft', 'confirmed')),
	CONSTRAINT "things_created_via_chk" CHECK ("created_via" IN ('app', 'mcp', 'assistant', 'import', 'email')),
	CONSTRAINT "things_one_parent_chk" CHECK (num_nonnulls(place_id, container_id) = 1),
	CONSTRAINT "things_not_own_container_chk" CHECK (container_id IS NULL OR container_id <> id),
	CONSTRAINT "things_named_chk" CHECK (name IS NOT NULL OR review_state = 'draft'),
	CONSTRAINT "things_name_chk" CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 200),
	CONSTRAINT "things_model_chk" CHECK (char_length(model) <= 120),
	CONSTRAINT "things_serial_chk" CHECK (char_length(serial) <= 100),
	CONSTRAINT "things_barcode_chk" CHECK (char_length(barcode) <= 64),
	CONSTRAINT "things_colour_chk" CHECK (char_length(colour) <= 60),
	CONSTRAINT "things_notes_chk" CHECK (char_length(notes) <= 5000),
	CONSTRAINT "things_manual_url_chk" CHECK (char_length(manual_url) <= 2000),
	CONSTRAINT "things_ended_to_chk" CHECK (char_length(ended_to) <= 200),
	CONSTRAINT "things_ended_notes_chk" CHECK (char_length(ended_notes) <= 5000),
	CONSTRAINT "things_acquired_from_chk" CHECK (char_length(acquired_from) <= 200),
	CONSTRAINT "things_provenance_notes_chk" CHECK (char_length(provenance_notes) <= 5000),
	CONSTRAINT "things_quantity_chk" CHECK (quantity >= 0),
	CONSTRAINT "things_expiry_lead_chk" CHECK (expiry_lead_days BETWEEN 0 AND 3650),
	CONSTRAINT "things_ended_price_chk" CHECK (ended_price >= 0),
	CONSTRAINT "things_ended_money_chk" CHECK ((ended_price IS NULL) = (ended_currency IS NULL)),
	CONSTRAINT "things_in_use_chk" CHECK (lifecycle <> 'in_use' OR (ended_on IS NULL AND ended_price IS NULL AND ended_to IS NULL)),
	CONSTRAINT "things_aliases_chk" CHECK (jsonb_typeof(aliases) = 'object'),
	CONSTRAINT "things_custom_chk" CHECK (jsonb_typeof(custom) = 'object'),
	CONSTRAINT "things_archived_custom_chk" CHECK (jsonb_typeof(archived_custom) = 'object'),
	CONSTRAINT "things_field_status_chk" CHECK (jsonb_typeof(field_status) = 'object')
);
--> statement-breakpoint
ALTER TABLE "places" DROP CONSTRAINT "places_parent_fk";
--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "sort" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "trash_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "thing_links" ADD CONSTRAINT "thing_links_from_fk" FOREIGN KEY ("location_id","from_thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "thing_links" ADD CONSTRAINT "thing_links_to_fk" FOREIGN KEY ("location_id","to_thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "thing_tags" ADD CONSTRAINT "thing_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thing_tags" ADD CONSTRAINT "thing_tags_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_type_id_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_belongs_to_person_id_people_id_fk" FOREIGN KEY ("belongs_to_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_ended_currency_currencies_code_fk" FOREIGN KEY ("ended_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_split_from_id_things_id_fk" FOREIGN KEY ("split_from_id") REFERENCES "public"."things"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_place_fk" FOREIGN KEY ("location_id","place_id") REFERENCES "public"."places"("location_id","id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_container_fk" FOREIGN KEY ("location_id","container_id") REFERENCES "public"."things"("location_id","id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "short_ids_primary_thing_uq" ON "short_ids" USING btree ("thing_id") WHERE is_primary AND state = 'assigned';--> statement-breakpoint
CREATE UNIQUE INDEX "short_ids_primary_place_uq" ON "short_ids" USING btree ("place_id") WHERE is_primary AND state = 'assigned';--> statement-breakpoint
CREATE INDEX "short_ids_thing_idx" ON "short_ids" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "short_ids_place_idx" ON "short_ids" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "short_ids_location_idx" ON "short_ids" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "thing_links_to_idx" ON "thing_links" USING btree ("to_thing_id");--> statement-breakpoint
CREATE INDEX "thing_tags_tag_idx" ON "thing_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "things_place_idx" ON "things" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "things_container_idx" ON "things" USING btree ("container_id");--> statement-breakpoint
CREATE INDEX "things_type_idx" ON "things" USING btree ("type_id");--> statement-breakpoint
CREATE INDEX "things_brand_idx" ON "things" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "things_person_idx" ON "things" USING btree ("belongs_to_person_id");--> statement-breakpoint
CREATE INDEX "things_barcode_idx" ON "things" USING btree ("location_id","barcode");--> statement-breakpoint
CREATE INDEX "things_last_seen_idx" ON "things" USING btree ("location_id","last_seen_at") WHERE lifecycle = 'in_use' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "things_uncertain_idx" ON "things" USING btree ("location_id") WHERE location_uncertain;--> statement-breakpoint
CREATE INDEX "things_draft_idx" ON "things" USING btree ("location_id") WHERE review_state = 'draft';--> statement-breakpoint
CREATE INDEX "things_expires_idx" ON "things" USING btree ("expires_on") WHERE expires_on IS NOT NULL;--> statement-breakpoint
CREATE INDEX "things_trash_idx" ON "things" USING btree ("location_id","deleted_at") WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "things_created_by_idx" ON "things" USING btree ("created_by") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_parent_fk" FOREIGN KEY ("location_id","parent_id") REFERENCES "public"."places"("location_id","id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_custom_chk" CHECK (jsonb_typeof(custom) = 'object');--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_icon_chk" CHECK (icon IS NULL OR icon ~ '^(lucide|tabler|kept):[a-z0-9-]+$');