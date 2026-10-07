CREATE TABLE "export_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"include_secrets" boolean DEFAULT false NOT NULL,
	"incident_id" uuid,
	"thing_ids" uuid[],
	"status" text DEFAULT 'queued' NOT NULL,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"progress_total" integer DEFAULT 0 NOT NULL,
	"storage_key" text,
	"bytes" bigint,
	"error" text,
	"created_by" uuid,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"downloads" integer DEFAULT 0 NOT NULL,
	"last_downloaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	CONSTRAINT "export_runs_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "export_runs_kind_chk" CHECK ("kind" IN ('claim_pack')),
	CONSTRAINT "export_runs_status_chk" CHECK ("status" IN ('queued', 'running', 'done', 'failed', 'expired')),
	CONSTRAINT "export_runs_secrets_chk" CHECK (NOT include_secrets OR kind <> 'claim_pack'),
	CONSTRAINT "export_runs_scope_chk" CHECK (num_nonnulls(incident_id, thing_ids) <= 1),
	CONSTRAINT "export_runs_progress_chk" CHECK (progress_done >= 0 AND progress_total >= 0 AND progress_done <= progress_total),
	CONSTRAINT "export_runs_error_chk" CHECK (error ~ '^[a-z_]{1,32}$'),
	CONSTRAINT "export_runs_token_hash_chk" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "export_runs_storage_key_chk" CHECK (storage_key IS NULL OR storage_key = 'x/' || id::text || '.zip'),
	CONSTRAINT "export_runs_thing_ids_chk" CHECK (cardinality(thing_ids) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"owner_account_id" uuid NOT NULL,
	"from_ccy" char(3) NOT NULL,
	"to_ccy" char(3) NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"valid_from" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "fx_rates_pk" PRIMARY KEY("owner_account_id","from_ccy","to_ccy","valid_from"),
	CONSTRAINT "fx_rates_rate_chk" CHECK (rate > 0),
	CONSTRAINT "fx_rates_pair_chk" CHECK (from_ccy <> to_ccy)
);
--> statement-breakpoint
CREATE TABLE "incident_things" (
	"location_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"thing_id" uuid NOT NULL,
	CONSTRAINT "incident_things_pk" PRIMARY KEY("incident_id","thing_id")
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_on" date NOT NULL,
	"police_reference" text,
	"insurer_reference" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "incidents_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "incidents_kind_chk" CHECK ("kind" IN ('burglary', 'fire', 'flood', 'loss', 'other')),
	CONSTRAINT "incidents_police_reference_chk" CHECK (char_length(police_reference) <= 100),
	CONSTRAINT "incidents_insurer_reference_chk" CHECK (char_length(insurer_reference) <= 100),
	CONSTRAINT "incidents_notes_chk" CHECK (char_length(notes) <= 5000)
);
--> statement-breakpoint
CREATE TABLE "valuations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid NOT NULL,
	"value" numeric(16, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"valued_on" date NOT NULL,
	"source" text NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "valuations_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "valuations_source_chk" CHECK ("source" IN ('purchase', 'appraisal', 'estimate', 'insurer')),
	CONSTRAINT "valuations_value_chk" CHECK (value >= 0),
	CONSTRAINT "valuations_notes_chk" CHECK (char_length(notes) <= 2000)
);
--> statement-breakpoint
ALTER TABLE "report_runs" ADD COLUMN "kind" text DEFAULT 'inventory' NOT NULL;--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_from_ccy_currencies_code_fk" FOREIGN KEY ("from_ccy") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_to_ccy_currencies_code_fk" FOREIGN KEY ("to_ccy") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_things" ADD CONSTRAINT "incident_things_incident_fk" FOREIGN KEY ("location_id","incident_id") REFERENCES "public"."incidents"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "incident_things" ADD CONSTRAINT "incident_things_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "export_runs_location_idx" ON "export_runs" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "export_runs_expires_idx" ON "export_runs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "incident_things_thing_idx" ON "incident_things" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "incidents_location_idx" ON "incidents" USING btree ("location_id","occurred_on");--> statement-breakpoint
CREATE INDEX "valuations_thing_idx" ON "valuations" USING btree ("thing_id","valued_on" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_kind_chk" CHECK ("kind" IN ('inventory', 'insurance'));