CREATE TABLE "calendar_feeds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_fetched_at" timestamp with time zone,
	"fetches" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "calendar_feeds_token_hash_uq" UNIQUE("token_hash"),
	CONSTRAINT "calendar_feeds_token_hash_chk" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "calendar_feeds_fetches_chk" CHECK (fetches >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"display_host" text,
	"config_ciphertext" jsonb,
	"key_version" integer,
	"verified_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "notification_channels_kind_chk" CHECK ("kind" IN ('email', 'webpush', 'webhook')),
	CONSTRAINT "notification_channels_label_chk" CHECK (char_length(label) <= 60),
	CONSTRAINT "notification_channels_display_host_chk" CHECK (char_length(display_host) <= 255),
	CONSTRAINT "notification_channels_config_chk" CHECK ((kind = 'webhook') = (config_ciphertext IS NOT NULL)
          AND (config_ciphertext IS NULL) = (key_version IS NULL))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "notification_preferences_uq" UNIQUE NULLS NOT DISTINCT("user_id","location_id","kind","channel"),
	CONSTRAINT "notification_preferences_kind_chk" CHECK ("kind" IN ('schedule', 'warranty', 'registration', 'document', 'loan', 'thing_expiry', 'membership', 'ai_cap', 'ai_summary')),
	CONSTRAINT "notification_preferences_channel_chk" CHECK ("channel" IN ('inapp', 'email', 'webpush', 'webhook')),
	CONSTRAINT "notification_preferences_account_chk" CHECK ((kind = 'ai_summary') = (location_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_uq" UNIQUE("endpoint"),
	CONSTRAINT "push_subscriptions_endpoint_chk" CHECK (endpoint ~ '^https://' AND char_length(endpoint) <= 1000),
	CONSTRAINT "push_subscriptions_keys_chk" CHECK (char_length(p256dh) <= 200 AND char_length(auth) <= 100),
	CONSTRAINT "push_subscriptions_label_chk" CHECK (char_length(label) <= 60),
	CONSTRAINT "push_subscriptions_failures_chk" CHECK (failures >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_digests" (
	"user_id" uuid NOT NULL,
	"digest_on" date NOT NULL,
	"channel_id" uuid NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_digests_pk" PRIMARY KEY("user_id","digest_on","channel_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" uuid,
	"occurrence_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_user_occurrence_uq" UNIQUE("user_id","occurrence_id"),
	CONSTRAINT "notifications_kind_chk" CHECK ("kind" IN ('reminder', 'membership_added', 'membership_ended', 'ai_cap', 'ai_summary', 'export_ready')),
	CONSTRAINT "notifications_payload_chk" CHECK (jsonb_typeof(payload) = 'object'),
	CONSTRAINT "notifications_reminder_chk" CHECK ((kind = 'reminder') = (occurrence_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "reminder_deliveries" (
	"occurrence_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" text NOT NULL,
	"not_before" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_deliveries_pk" PRIMARY KEY("occurrence_id","user_id","channel_id"),
	CONSTRAINT "reminder_deliveries_status_chk" CHECK ("status" IN ('digest', 'queued', 'sending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "reminder_deliveries_error_chk" CHECK (error ~ '^[a-z_0-9]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "reminder_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"thing_id" uuid,
	"place_id" uuid,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"due_period" text NOT NULL,
	"due_on" date,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "reminder_occurrences_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "reminder_occurrences_key_uq" UNIQUE NULLS NOT DISTINCT("thing_id","place_id","location_id","source_type","source_id","kind","due_period"),
	CONSTRAINT "reminder_occurrences_source_type_chk" CHECK ("source_type" IN ('schedule', 'warranty', 'registration', 'document', 'loan', 'thing_expiry', 'stock', 'reading_stale')),
	CONSTRAINT "reminder_occurrences_kind_chk" CHECK ("kind" IN ('due', 'overdue', 'expiring')),
	CONSTRAINT "reminder_occurrences_state_chk" CHECK ("state" IN ('open', 'done', 'superseded', 'cancelled')),
	CONSTRAINT "reminder_occurrences_due_period_chk" CHECK (due_period ~ '^(date:\d{4}-\d{2}-\d{2}|meter:\d+(\.\d{1,3})?)$'),
	CONSTRAINT "reminder_occurrences_subject_chk" CHECK (num_nonnulls(thing_id, place_id) <= 1),
	CONSTRAINT "reminder_occurrences_closed_chk" CHECK ((state = 'open') = (closed_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "admin_alerts" DROP CONSTRAINT "admin_alerts_kind_chk";--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digests" ADD CONSTRAINT "notification_digests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digests" ADD CONSTRAINT "notification_digests_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_occurrence_id_reminder_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."reminder_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_occurrence_id_reminder_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."reminder_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_place_fk" FOREIGN KEY ("location_id","place_id") REFERENCES "public"."places"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "calendar_feeds_user_idx" ON "calendar_feeds" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_email_uq" ON "notification_channels" USING btree ("user_id") WHERE kind = 'email';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_webpush_uq" ON "notification_channels" USING btree ("user_id") WHERE kind = 'webpush';--> statement-breakpoint
CREATE INDEX "notification_channels_user_idx" ON "notification_channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_preferences_location_idx" ON "notification_preferences" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_digests_channel_idx" ON "notification_digests" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE read_at IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_occurrence_idx" ON "notifications" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "reminder_deliveries_digest_idx" ON "reminder_deliveries" USING btree ("user_id") WHERE status = 'digest';--> statement-breakpoint
CREATE INDEX "reminder_deliveries_queued_idx" ON "reminder_deliveries" USING btree ("not_before") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "reminder_deliveries_channel_idx" ON "reminder_deliveries" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "reminder_occurrences_open_idx" ON "reminder_occurrences" USING btree ("location_id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "reminder_occurrences_source_idx" ON "reminder_occurrences" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_kind_chk" CHECK ("kind" IN ('failed_jobs_rising', 'audit_default_partition', 'llm_default_partition', 'ai_instance_cap_warning', 'ai_instance_cap_reached', 'ai_instance_key_rejected', 'backup_failed', 'reminders_not_scanned'));