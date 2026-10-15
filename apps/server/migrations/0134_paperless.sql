CREATE TABLE "paperless_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"base_url" text NOT NULL,
	"config_ciphertext" jsonb NOT NULL,
	"key_version" integer NOT NULL,
	"server_version" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "paperless_connections_location_uq" UNIQUE("location_id"),
	CONSTRAINT "paperless_connections_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "paperless_connections_base_url_chk" CHECK (char_length(base_url) BETWEEN 1 AND 500),
	CONSTRAINT "paperless_connections_key_version_chk" CHECK (key_version >= 1),
	CONSTRAINT "paperless_connections_version_chk" CHECK (server_version IS NULL OR char_length(server_version) <= 40)
);
--> statement-breakpoint
CREATE TABLE "paperless_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"thing_id" uuid,
	"place_id" uuid,
	"document_id" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"type_name" text,
	"correspondent" text,
	"created_on" date,
	"copied_attachment_id" uuid,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "paperless_links_thing_uq" UNIQUE("thing_id","document_id"),
	CONSTRAINT "paperless_links_place_uq" UNIQUE("place_id","document_id"),
	CONSTRAINT "paperless_links_kind_chk" CHECK ("kind" IN ('receipt', 'invoice', 'manual', 'warranty_doc', 'document')),
	CONSTRAINT "paperless_links_subject_chk" CHECK (num_nonnulls(thing_id, place_id) = 1),
	CONSTRAINT "paperless_links_document_chk" CHECK (document_id > 0),
	CONSTRAINT "paperless_links_title_chk" CHECK (char_length(title) BETWEEN 1 AND 300),
	CONSTRAINT "paperless_links_type_chk" CHECK (type_name IS NULL OR char_length(type_name) <= 128),
	CONSTRAINT "paperless_links_correspondent_chk" CHECK (correspondent IS NULL OR char_length(correspondent) <= 128)
);
--> statement-breakpoint
ALTER TABLE "paperless_connections" ADD CONSTRAINT "paperless_connections_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_links" ADD CONSTRAINT "paperless_links_thing_id_things_id_fk" FOREIGN KEY ("thing_id") REFERENCES "public"."things"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_links" ADD CONSTRAINT "paperless_links_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_links" ADD CONSTRAINT "paperless_links_copied_attachment_id_attachments_id_fk" FOREIGN KEY ("copied_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_links" ADD CONSTRAINT "paperless_links_connection_fk" FOREIGN KEY ("location_id","connection_id") REFERENCES "public"."paperless_connections"("location_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paperless_links_location_idx" ON "paperless_links" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "paperless_links_copied_idx" ON "paperless_links" USING btree ("copied_attachment_id");