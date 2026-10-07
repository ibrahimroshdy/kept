CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"file_id" uuid,
	"url" text,
	"thing_id" uuid,
	"place_id" uuid,
	"purchase_id" uuid,
	"meter_reading_id" uuid,
	"role" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "attachments_role_chk" CHECK ("role" IN ('photo', 'receipt', 'invoice', 'manual', 'warranty_doc', 'proof', 'condition_out', 'condition_in', 'registration', 'document')),
	CONSTRAINT "attachments_file_or_url_chk" CHECK (num_nonnulls(file_id, url) = 1),
	CONSTRAINT "attachments_one_subject_chk" CHECK (num_nonnulls(thing_id, place_id, purchase_id, meter_reading_id) <= 1),
	CONSTRAINT "attachments_url_chk" CHECK (url IS NULL OR (url ~ '^https?://' AND char_length(url) <= 2000))
);
--> statement-breakpoint
CREATE TABLE "file_derivatives" (
	"file_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"location_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" bigint NOT NULL,
	CONSTRAINT "file_derivatives_pk" PRIMARY KEY("file_id","variant"),
	CONSTRAINT "file_derivatives_variant_chk" CHECK ("variant" IN ('display', 'thumb', 'share', 'poster')),
	CONSTRAINT "file_derivatives_size_chk" CHECK (width > 0 AND height > 0 AND bytes > 0)
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" char(64) NOT NULL,
	"bytes" bigint NOT NULL,
	"mime" text NOT NULL,
	"class" text NOT NULL,
	"has_gps" boolean DEFAULT false NOT NULL,
	"width" integer,
	"height" integer,
	"derivative_state" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_location_sha_uq" UNIQUE("location_id","sha256"),
	CONSTRAINT "files_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "files_class_chk" CHECK ("class" IN ('evidence', 'photo', 'document', 'video')),
	CONSTRAINT "files_derivative_state_chk" CHECK ("derivative_state" IN ('ready', 'unavailable', 'not_applicable')),
	CONSTRAINT "files_sha256_chk" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "files_bytes_chk" CHECK (bytes > 0),
	CONSTRAINT "files_storage_key_chk" CHECK (char_length(storage_key) BETWEEN 1 AND 300),
	CONSTRAINT "files_mime_chk" CHECK (char_length(mime) BETWEEN 1 AND 100),
	CONSTRAINT "files_size_chk" CHECK ((width IS NULL OR width > 0) AND (height IS NULL OR height > 0))
);
--> statement-breakpoint
CREATE TABLE "secret_field_policies" (
	"location_id" uuid NOT NULL,
	"type_field_id" uuid NOT NULL,
	"reveal_roles" text[] DEFAULT ARRAY['owner', 'admin']::text[] NOT NULL,
	"reveal_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"ai_allowed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "secret_field_policies_pk" PRIMARY KEY("location_id","type_field_id"),
	CONSTRAINT "secret_field_policies_roles_chk" CHECK (reveal_roles <@ ARRAY['owner', 'admin', 'member', 'viewer']::text[])
);
--> statement-breakpoint
CREATE TABLE "secret_values" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid,
	"place_id" uuid,
	"type_field_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"ciphertext" jsonb NOT NULL,
	"key_version" integer NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "secret_values_one_subject_chk" CHECK (num_nonnulls(thing_id, place_id) = 1),
	CONSTRAINT "secret_values_key_version_chk" CHECK (key_version > 0),
	CONSTRAINT "secret_values_ciphertext_chk" CHECK (jsonb_typeof(ciphertext) = 'object')
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "saved_views_name_chk" CHECK (char_length(name) BETWEEN 1 AND 80),
	CONSTRAINT "saved_views_query_chk" CHECK (jsonb_typeof(query) = 'object'),
	CONSTRAINT "saved_views_shared_chk" CHECK (NOT shared OR location_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "user_hints" (
	"user_id" uuid NOT NULL,
	"hint_key" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "user_hints_pk" PRIMARY KEY("user_id","hint_key"),
	CONSTRAINT "user_hints_key_chk" CHECK (hint_key ~ '^[a-z0-9_.:-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_place_fk" FOREIGN KEY ("location_id","place_id") REFERENCES "public"."places"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_purchase_fk" FOREIGN KEY ("location_id","purchase_id") REFERENCES "public"."purchases"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_meter_reading_fk" FOREIGN KEY ("location_id","meter_reading_id") REFERENCES "public"."meter_readings"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "file_derivatives" ADD CONSTRAINT "file_derivatives_file_fk" FOREIGN KEY ("location_id","file_id") REFERENCES "public"."files"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_field_policies" ADD CONSTRAINT "secret_field_policies_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_field_policies" ADD CONSTRAINT "secret_field_policies_type_field_id_type_fields_id_fk" FOREIGN KEY ("type_field_id") REFERENCES "public"."type_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_type_field_id_type_fields_id_fk" FOREIGN KEY ("type_field_id") REFERENCES "public"."type_fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_place_fk" FOREIGN KEY ("location_id","place_id") REFERENCES "public"."places"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hints" ADD CONSTRAINT "user_hints_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_file_idx" ON "attachments" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "attachments_thing_idx" ON "attachments" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "attachments_place_idx" ON "attachments" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "attachments_purchase_idx" ON "attachments" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "attachments_meter_reading_idx" ON "attachments" USING btree ("meter_reading_id");--> statement-breakpoint
CREATE INDEX "attachments_location_idx" ON "attachments" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "file_derivatives_storage_key_idx" ON "file_derivatives" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "files_storage_key_idx" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "files_unattached_idx" ON "files" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_values_thing_current_uq" ON "secret_values" USING btree ("thing_id","field_key") WHERE superseded_at IS NULL AND thing_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "secret_values_place_current_uq" ON "secret_values" USING btree ("place_id","field_key") WHERE superseded_at IS NULL AND place_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "secret_values_type_field_idx" ON "secret_values" USING btree ("type_field_id");--> statement-breakpoint
CREATE INDEX "secret_values_key_version_idx" ON "secret_values" USING btree ("key_version");--> statement-breakpoint
CREATE INDEX "saved_views_user_idx" ON "saved_views" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "saved_views_location_idx" ON "saved_views" USING btree ("location_id") WHERE shared;