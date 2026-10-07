CREATE TABLE "label_batch_codes" (
	"batch_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"code" char(6) NOT NULL,
	"sort" integer NOT NULL,
	CONSTRAINT "label_batch_codes_pk" PRIMARY KEY("batch_id","code")
);
--> statement-breakpoint
CREATE TABLE "label_batches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"stock" text NOT NULL,
	"start_cell" integer DEFAULT 1 NOT NULL,
	"code_count" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"printed_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "label_batches_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "label_batches_kind_chk" CHECK ("kind" IN ('things', 'places', 'blank')),
	CONSTRAINT "label_batches_stock_chk" CHECK (stock ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "label_batches_start_cell_chk" CHECK (start_cell BETWEEN 1 AND 200),
	CONSTRAINT "label_batches_code_count_chk" CHECK (code_count BETWEEN 1 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "label_batch_codes" ADD CONSTRAINT "label_batch_codes_code_short_ids_code_fk" FOREIGN KEY ("code") REFERENCES "public"."short_ids"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_batch_codes" ADD CONSTRAINT "label_batch_codes_batch_fk" FOREIGN KEY ("location_id","batch_id") REFERENCES "public"."label_batches"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "label_batches" ADD CONSTRAINT "label_batches_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "label_batch_codes_code_idx" ON "label_batch_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "label_batches_location_idx" ON "label_batches" USING btree ("location_id","created_at");