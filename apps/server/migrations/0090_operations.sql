CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"storage_mode" text NOT NULL,
	"target" text NOT NULL,
	"snapshot_id" text,
	"db_bytes" bigint,
	"bytes_added" bigint,
	"bytes_total" bigint,
	"files_total" integer,
	"files_new" integer,
	"missing" integer DEFAULT 0 NOT NULL,
	"readable_locations" integer,
	"readable_bytes" bigint,
	"same_volume" boolean,
	"bucket_versioning_ok" boolean,
	"from_version" text,
	"to_version" text,
	"verified_at" timestamp with time zone,
	"error" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "backup_runs_kind_chk" CHECK ("kind" IN ('nightly', 'manual', 'pre_upgrade', 'drill', 'verify')),
	CONSTRAINT "backup_runs_status_chk" CHECK ("status" IN ('running', 'ok', 'warning', 'failed')),
	CONSTRAINT "backup_runs_storage_mode_chk" CHECK ("storage_mode" IN ('local', 's3')),
	CONSTRAINT "backup_runs_target_chk" CHECK (char_length(target) BETWEEN 1 AND 300),
	CONSTRAINT "backup_runs_snapshot_id_chk" CHECK (snapshot_id ~ '^[0-9a-f]{8,64}$'),
	CONSTRAINT "backup_runs_error_chk" CHECK (error ~ '^[a-z_]{1,48}$'),
	CONSTRAINT "backup_runs_detail_chk" CHECK (jsonb_typeof(detail) = 'object'),
	CONSTRAINT "backup_runs_finished_chk" CHECK ((status = 'running') = (finished_at IS NULL)),
	CONSTRAINT "backup_runs_missing_chk" CHECK (missing >= 0)
);
--> statement-breakpoint
CREATE TABLE "release_history" (
	"version" text PRIMARY KEY NOT NULL,
	"revision" text,
	"last_migration" text NOT NULL,
	"first_migrated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_booted_at" timestamp with time zone,
	CONSTRAINT "release_history_version_chk" CHECK (version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
	CONSTRAINT "release_history_revision_chk" CHECK (revision ~ '^[0-9a-f]{7,40}$'),
	CONSTRAINT "release_history_last_migration_chk" CHECK (char_length(last_migration) BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "admin_alerts" DROP CONSTRAINT "admin_alerts_kind_chk";--> statement-breakpoint
CREATE INDEX "backup_runs_started_idx" ON "backup_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "backup_runs_kind_idx" ON "backup_runs" USING btree ("kind","started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_kind_chk" CHECK ("kind" IN ('failed_jobs_rising', 'audit_default_partition', 'llm_default_partition', 'ai_instance_cap_warning', 'ai_instance_cap_reached', 'ai_instance_key_rejected', 'backup_failed', 'reminders_not_scanned', 'backup_stale', 'disk_space_low', 'bucket_versioning_off', 'restore_drill_due', 'backup_suspicious_size', 'webhook_failing'));