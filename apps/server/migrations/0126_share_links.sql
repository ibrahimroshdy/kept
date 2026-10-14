CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"thing_id" uuid,
	"place_id" uuid,
	"filter" jsonb,
	"title" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	CONSTRAINT "share_links_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "share_links_scope_type_chk" CHECK ("scope_type" IN ('thing', 'place', 'view')),
	CONSTRAINT "share_links_token_hash_chk" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "share_links_subject_chk" CHECK (CASE scope_type
            WHEN 'thing' THEN thing_id IS NOT NULL AND place_id IS NULL AND filter IS NULL
            WHEN 'place' THEN place_id IS NOT NULL AND thing_id IS NULL AND filter IS NULL
            ELSE filter IS NOT NULL AND thing_id IS NULL AND place_id IS NULL
                 AND title IS NOT NULL END),
	CONSTRAINT "share_links_filter_chk" CHECK (filter IS NULL OR jsonb_typeof(filter) = 'object'),
	CONSTRAINT "share_links_title_chk" CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
	CONSTRAINT "share_links_expiry_chk" CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 year'),
	CONSTRAINT "share_links_views_chk" CHECK (views >= 0)
);
--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_thing_id_things_id_fk" FOREIGN KEY ("thing_id") REFERENCES "public"."things"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_links_location_idx" ON "share_links" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "share_links_thing_idx" ON "share_links" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "share_links_place_idx" ON "share_links" USING btree ("place_id");