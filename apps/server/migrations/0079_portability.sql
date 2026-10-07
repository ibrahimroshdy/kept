ALTER TABLE "import_source_ids" DROP CONSTRAINT "import_source_ids_source_chk";--> statement-breakpoint
ALTER TABLE "import_source_ids" DROP CONSTRAINT "import_source_ids_entity_type_chk";--> statement-breakpoint
ALTER TABLE "export_runs" DROP CONSTRAINT "export_runs_kind_chk";--> statement-breakpoint
ALTER TABLE "export_runs" DROP CONSTRAINT "export_runs_status_chk";--> statement-breakpoint
ALTER TABLE "import_runs" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "archive_bytes" bigint;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "archive_sha256" text;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "archive_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "inspect" jsonb;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "secrets_key_ciphertext" jsonb;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "key_version" integer;--> statement-breakpoint
ALTER TABLE "export_runs" ADD COLUMN "options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "export_runs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "export_runs" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "export_runs" ADD COLUMN "secrets_key_ciphertext" jsonb;--> statement-breakpoint
ALTER TABLE "export_runs" ADD COLUMN "key_version" integer;--> statement-breakpoint
CREATE INDEX "import_runs_draft_idx" ON "import_runs" USING btree ("created_by","created_at") WHERE location_id IS NULL;--> statement-breakpoint
CREATE INDEX "export_runs_creator_idx" ON "export_runs" USING btree ("created_by","created_at");--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_target_chk" CHECK (location_id IS NOT NULL OR status IN ('draft', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_archive_chk" CHECK ((archive_bytes IS NULL AND archive_sha256 IS NULL AND archive_ready_at IS NULL)
          OR source IN ('homebox_zip', 'kept_zip'));--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_archive_bytes_chk" CHECK (archive_bytes >= 0);--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_archive_sha256_chk" CHECK (archive_sha256 ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_inspect_chk" CHECK (inspect IS NULL OR jsonb_typeof(inspect) = 'object');--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_secrets_key_chk" CHECK ((secrets_key_ciphertext IS NULL) = (key_version IS NULL)
          AND (secrets_key_ciphertext IS NULL OR source = 'kept_zip'));--> statement-breakpoint
ALTER TABLE "import_source_ids" ADD CONSTRAINT "import_source_ids_source_chk" CHECK ("source" IN ('csv', 'homebox_zip', 'homebox_api', 'kept_zip', 'lubelogger_csv', 'homebox'));--> statement-breakpoint
ALTER TABLE "import_source_ids" ADD CONSTRAINT "import_source_ids_entity_type_chk" CHECK ("entity_type" IN ('thing', 'place', 'purchase', 'attachment', 'file', 'tag', 'type', 'type_field', 'brand', 'vendor', 'person', 'template', 'meter', 'reading', 'box_check', 'stock_rule', 'warranty', 'service_record', 'schedule'));--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_kind_scope_chk" CHECK (kind = 'claim_pack' OR num_nonnulls(incident_id, thing_ids) = 0);--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_options_chk" CHECK (jsonb_typeof(options) = 'object');--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_sha256_chk" CHECK (sha256 ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_secrets_key_chk" CHECK ((secrets_key_ciphertext IS NULL) = (key_version IS NULL)
          AND (secrets_key_ciphertext IS NULL OR include_secrets));--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_kind_chk" CHECK ("kind" IN ('claim_pack', 'location', 'me'));--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_status_chk" CHECK ("status" IN ('queued', 'running', 'done', 'failed', 'cancelled', 'expired'));