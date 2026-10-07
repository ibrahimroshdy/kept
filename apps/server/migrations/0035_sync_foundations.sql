CREATE TABLE "box_check_lines" (
	"box_check_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid NOT NULL,
	"expected_qty" numeric(12, 3) NOT NULL,
	"found_qty" numeric(12, 3) NOT NULL,
	CONSTRAINT "box_check_lines_pk" PRIMARY KEY("box_check_id","thing_id"),
	CONSTRAINT "box_check_lines_expected_chk" CHECK (expected_qty >= 0),
	CONSTRAINT "box_check_lines_found_chk" CHECK (found_qty >= 0)
);
--> statement-breakpoint
CREATE TABLE "box_checks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"checked_by" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_checks_location_id_uq" UNIQUE("location_id","id")
);
--> statement-breakpoint
CREATE TABLE "legacy_codes" (
	"location_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_collection" text DEFAULT '' NOT NULL,
	"code" text NOT NULL,
	"thing_id" uuid,
	"place_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	"change_xid" "xid8",
	CONSTRAINT "legacy_codes_pk" PRIMARY KEY("location_id","source","source_collection","code"),
	CONSTRAINT "legacy_codes_source_chk" CHECK ("source" IN ('homebox', 'csv')),
	CONSTRAINT "legacy_codes_collection_chk" CHECK (char_length(source_collection) <= 100),
	CONSTRAINT "legacy_codes_code_chk" CHECK (char_length(code) BETWEEN 1 AND 100 AND code = upper(btrim(code))),
	CONSTRAINT "legacy_codes_target_chk" CHECK (num_nonnulls(thing_id, place_id) = 1)
);
--> statement-breakpoint
CREATE TABLE "sync_ops" (
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"client_id" uuid NOT NULL,
	"location_id" uuid,
	"op" text NOT NULL,
	"payload_version" integer NOT NULL,
	"client_version" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "sync_ops_pk" PRIMARY KEY("user_id","idempotency_key"),
	CONSTRAINT "sync_ops_op_chk" CHECK ("op" IN ('create_thing', 'move', 'log_reading', 'claim_label', 'mark_seen', 'not_here', 'create_area', 'box_check')),
	CONSTRAINT "sync_ops_outcome_chk" CHECK ("outcome" IN ('applied', 'needs_review', 'dropped')),
	CONSTRAINT "sync_ops_key_chk" CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,200}$'),
	CONSTRAINT "sync_ops_payload_version_chk" CHECK (payload_version > 0),
	CONSTRAINT "sync_ops_client_version_chk" CHECK (char_length(client_version) BETWEEN 1 AND 40),
	CONSTRAINT "sync_ops_request_hash_chk" CHECK (request_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sync_ops_reason_chk" CHECK (char_length(reason) <= 60),
	CONSTRAINT "sync_ops_result_chk" CHECK (jsonb_typeof(result) = 'object')
);
--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "change_xid" "xid8";--> statement-breakpoint
ALTER TABLE "sync_tombstones" ADD COLUMN "change_xid" "xid8";--> statement-breakpoint
ALTER TABLE "short_ids" ADD COLUMN "change_xid" "xid8";--> statement-breakpoint
ALTER TABLE "things" ADD COLUMN "capture_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "things" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "things" ADD COLUMN "cover_file_id" uuid;--> statement-breakpoint
ALTER TABLE "things" ADD COLUMN "change_xid" "xid8";--> statement-breakpoint
ALTER TABLE "box_check_lines" ADD CONSTRAINT "box_check_lines_check_fk" FOREIGN KEY ("location_id","box_check_id") REFERENCES "public"."box_checks"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "box_check_lines" ADD CONSTRAINT "box_check_lines_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "box_checks" ADD CONSTRAINT "box_checks_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_checks" ADD CONSTRAINT "box_checks_container_fk" FOREIGN KEY ("location_id","container_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "legacy_codes" ADD CONSTRAINT "legacy_codes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_codes" ADD CONSTRAINT "legacy_codes_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "legacy_codes" ADD CONSTRAINT "legacy_codes_place_fk" FOREIGN KEY ("location_id","place_id") REFERENCES "public"."places"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sync_ops" ADD CONSTRAINT "sync_ops_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_ops" ADD CONSTRAINT "sync_ops_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_check_lines_thing_idx" ON "box_check_lines" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "box_checks_container_idx" ON "box_checks" USING btree ("container_id","checked_at");--> statement-breakpoint
CREATE INDEX "legacy_codes_code_idx" ON "legacy_codes" USING btree ("source","code");--> statement-breakpoint
CREATE INDEX "legacy_codes_thing_idx" ON "legacy_codes" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "legacy_codes_place_idx" ON "legacy_codes" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "legacy_codes_sync_idx" ON "legacy_codes" USING btree ("location_id","change_xid");--> statement-breakpoint
CREATE INDEX "sync_ops_received_idx" ON "sync_ops" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "things" ADD CONSTRAINT "things_merged_into_id_things_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."things"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "places_sync_idx" ON "places" USING btree ("location_id","change_xid");--> statement-breakpoint
CREATE INDEX "sync_tombstones_sync_idx" ON "sync_tombstones" USING btree ("location_id","change_xid");--> statement-breakpoint
CREATE INDEX "short_ids_sync_idx" ON "short_ids" USING btree ("location_id","change_xid");--> statement-breakpoint
CREATE INDEX "things_capture_batch_idx" ON "things" USING btree ("created_by","capture_batch_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "things_merged_into_idx" ON "things" USING btree ("merged_into_id") WHERE merged_into_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "things_sync_idx" ON "things" USING btree ("location_id","change_xid");