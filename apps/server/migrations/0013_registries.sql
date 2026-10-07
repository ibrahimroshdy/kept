CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"support_phone" text,
	"claim_url" text,
	"default_warranty_months" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "brands_owner_id_uq" UNIQUE("owner_account_id","id"),
	CONSTRAINT "brands_name_chk" CHECK (char_length(name) BETWEEN 1 AND 120),
	CONSTRAINT "brands_website_chk" CHECK (website IS NULL OR char_length(website) <= 2000),
	CONSTRAINT "brands_claim_url_chk" CHECK (claim_url IS NULL OR char_length(claim_url) <= 2000),
	CONSTRAINT "brands_support_phone_chk" CHECK (support_phone IS NULL OR char_length(support_phone) <= 40),
	CONSTRAINT "brands_default_warranty_chk" CHECK (default_warranty_months IS NULL OR default_warranty_months >= 0)
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"member_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "people_owner_id_uq" UNIQUE("owner_account_id","id"),
	CONSTRAINT "people_display_name_chk" CHECK (char_length(display_name) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "person_contacts" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"phone" text,
	"email" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "person_contacts_phone_chk" CHECK (phone IS NULL OR char_length(phone) <= 40),
	CONSTRAINT "person_contacts_email_chk" CHECK (email IS NULL OR char_length(email) <= 320),
	CONSTRAINT "person_contacts_notes_chk" CHECK (notes IS NULL OR char_length(notes) <= 5000)
);
--> statement-breakpoint
CREATE TABLE "place_kinds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_account_id" uuid,
	"key" text NOT NULL,
	"name" text,
	"icon" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "place_kinds_owner_key_uq" UNIQUE NULLS NOT DISTINCT("owner_account_id","key"),
	CONSTRAINT "place_kinds_owner_id_uq" UNIQUE("owner_account_id","id"),
	CONSTRAINT "place_kinds_key_chk" CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "place_kinds_icon_chk" CHECK (icon ~ '^(lucide|tabler|kept):[a-z0-9-]+$'),
	CONSTRAINT "place_kinds_name_chk" CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 80),
	CONSTRAINT "place_kinds_named_chk" CHECK (owner_account_id IS NULL OR name IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"colour" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "tags_owner_id_uq" UNIQUE("owner_account_id","id"),
	CONSTRAINT "tags_name_chk" CHECK (char_length(name) BETWEEN 1 AND 60),
	CONSTRAINT "tags_colour_chk" CHECK (colour IS NULL OR colour ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "type_fields" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_account_id" uuid,
	"type_id" uuid,
	"place_kind_id" uuid,
	"key" text NOT NULL,
	"label" text,
	"kind" text NOT NULL,
	"unit" text,
	"options" jsonb,
	"repeatable" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "type_fields_kind_chk" CHECK ("kind" IN ('text', 'number', 'date', 'select', 'multi_select', 'boolean', 'url', 'money', 'person', 'vendor', 'file')),
	CONSTRAINT "type_fields_one_owner_chk" CHECK (num_nonnulls(type_id, place_kind_id) = 1),
	CONSTRAINT "type_fields_key_chk" CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "type_fields_secret_text_chk" CHECK (NOT secret OR kind = 'text'),
	CONSTRAINT "type_fields_label_chk" CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80),
	CONSTRAINT "type_fields_unit_chk" CHECK (unit IS NULL OR char_length(unit) BETWEEN 1 AND 12),
	CONSTRAINT "type_fields_options_chk" CHECK (options IS NULL OR jsonb_typeof(options) = 'array')
);
--> statement-breakpoint
CREATE TABLE "types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_account_id" uuid,
	"builtin_key" text,
	"copied_from_id" uuid,
	"parent_id" uuid,
	"name" text,
	"search_names" text,
	"icon" text NOT NULL,
	"colour" text,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"default_meter" jsonb,
	"is_field_group" boolean DEFAULT false NOT NULL,
	"field_groups" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"default_warranty_months" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "types_owner_id_uq" UNIQUE("owner_account_id","id"),
	CONSTRAINT "types_builtin_chk" CHECK ((owner_account_id IS NULL) = (builtin_key IS NOT NULL)),
	CONSTRAINT "types_builtin_key_chk" CHECK (builtin_key IS NULL OR builtin_key ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "types_named_chk" CHECK (name IS NOT NULL OR builtin_key IS NOT NULL OR copied_from_id IS NOT NULL),
	CONSTRAINT "types_name_chk" CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 80),
	CONSTRAINT "types_icon_chk" CHECK (icon ~ '^(lucide|tabler|kept):[a-z0-9-]+$'),
	CONSTRAINT "types_colour_chk" CHECK (colour IS NULL OR colour ~ '^#[0-9A-Fa-f]{6}$'),
	CONSTRAINT "types_capabilities_chk" CHECK (capabilities <@ ARRAY['container', 'metered', 'warranty', 'serialized', 'consumable', 'expires']::text[]),
	CONSTRAINT "types_default_meter_chk" CHECK (default_meter IS NULL OR jsonb_typeof(default_meter) IN ('object', 'null')),
	CONSTRAINT "types_field_group_chk" CHECK (NOT is_field_group OR (parent_id IS NULL AND cardinality(field_groups) = 0)),
	CONSTRAINT "types_not_own_parent_chk" CHECK (parent_id IS NULL OR parent_id <> id),
	CONSTRAINT "types_default_warranty_chk" CHECK (default_warranty_months IS NULL OR default_warranty_months >= 0)
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"address" text,
	"phone" text,
	"website" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "vendors_owner_id_uq" UNIQUE("owner_account_id","id"),
	CONSTRAINT "vendors_kind_chk" CHECK ("kind" IN ('store', 'online', 'service_centre', 'station', 'other')),
	CONSTRAINT "vendors_name_chk" CHECK (char_length(name) BETWEEN 1 AND 120),
	CONSTRAINT "vendors_address_chk" CHECK (address IS NULL OR char_length(address) <= 500),
	CONSTRAINT "vendors_phone_chk" CHECK (phone IS NULL OR char_length(phone) <= 40),
	CONSTRAINT "vendors_website_chk" CHECK (website IS NULL OR char_length(website) <= 2000)
);
--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_member_user_id_user_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_contacts" ADD CONSTRAINT "person_contacts_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_contacts" ADD CONSTRAINT "person_contacts_person_fk" FOREIGN KEY ("owner_account_id","person_id") REFERENCES "public"."people"("owner_account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_kinds" ADD CONSTRAINT "place_kinds_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_fields" ADD CONSTRAINT "type_fields_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_fields" ADD CONSTRAINT "type_fields_type_id_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_fields" ADD CONSTRAINT "type_fields_place_kind_id_place_kinds_id_fk" FOREIGN KEY ("place_kind_id") REFERENCES "public"."place_kinds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_fields" ADD CONSTRAINT "type_fields_type_account_fk" FOREIGN KEY ("owner_account_id","type_id") REFERENCES "public"."types"("owner_account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_fields" ADD CONSTRAINT "type_fields_place_kind_account_fk" FOREIGN KEY ("owner_account_id","place_kind_id") REFERENCES "public"."place_kinds"("owner_account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "types" ADD CONSTRAINT "types_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "types" ADD CONSTRAINT "types_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "types" ADD CONSTRAINT "types_copied_from_fk" FOREIGN KEY ("copied_from_id") REFERENCES "public"."types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "type_fields_type_key_uq" ON "type_fields" USING btree ("type_id","key") WHERE type_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "type_fields_place_kind_key_uq" ON "type_fields" USING btree ("place_kind_id","key") WHERE place_kind_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "type_fields_owner_idx" ON "type_fields" USING btree ("owner_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "types_builtin_key_uq" ON "types" USING btree ("builtin_key") WHERE owner_account_id IS NULL;--> statement-breakpoint
CREATE INDEX "types_parent_idx" ON "types" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "types_copied_from_idx" ON "types" USING btree ("copied_from_id");