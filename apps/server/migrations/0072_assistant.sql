CREATE TABLE "assistant_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"step" smallint DEFAULT 0 NOT NULL,
	"parts" jsonb NOT NULL,
	"cited_location_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_messages_user_id_uq" UNIQUE("user_id","id"),
	CONSTRAINT "assistant_messages_role_chk" CHECK ("role" IN ('user', 'assistant', 'tool')),
	CONSTRAINT "assistant_messages_parts_chk" CHECK (jsonb_typeof(parts) = 'array'),
	CONSTRAINT "assistant_messages_step_chk" CHECK (step BETWEEN 0 AND 20)
);
--> statement-breakpoint
CREATE TABLE "assistant_proposals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"args_hash" text NOT NULL,
	"before" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"result" jsonb,
	"audit_event_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "assistant_proposals_status_chk" CHECK ("status" IN ('open', 'confirmed', 'cancelled', 'expired', 'conflict', 'failed')),
	CONSTRAINT "assistant_proposals_tool_chk" CHECK (tool ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "assistant_proposals_args_chk" CHECK (jsonb_typeof(args) = 'object'),
	CONSTRAINT "assistant_proposals_args_hash_chk" CHECK (args_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assistant_proposals_objects_chk" CHECK (jsonb_typeof(before) = 'object' AND jsonb_typeof(refs) = 'object')
);
--> statement-breakpoint
CREATE TABLE "assistant_threads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locale" text NOT NULL,
	"search_tsv" "tsvector",
	"expires_at" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "assistant_threads_user_id_uq" UNIQUE("user_id","id"),
	CONSTRAINT "assistant_threads_title_chk" CHECK (char_length(title) <= 120),
	CONSTRAINT "assistant_threads_context_chk" CHECK (jsonb_typeof(context) = 'object'),
	CONSTRAINT "assistant_threads_locale_chk" CHECK (char_length(locale) BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "assistant_tool_results" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" uuid,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"output" jsonb,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "assistant_tool_results_call_id_chk" CHECK (char_length(call_id) BETWEEN 1 AND 100),
	CONSTRAINT "assistant_tool_results_tool_chk" CHECK (tool ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "assistant_tool_results_redacted_chk" CHECK ((output IS NULL) = (redacted_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "assistant_turns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"paused_until" timestamp with time zone,
	"steps" integer DEFAULT 0 NOT NULL,
	"location_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "assistant_turns_user_id_uq" UNIQUE("user_id","id"),
	CONSTRAINT "assistant_turns_status_chk" CHECK ("status" IN ('queued', 'running', 'waiting_provider', 'paused_budget', 'done', 'failed', 'cancelled')),
	CONSTRAINT "assistant_turns_status_reason_chk" CHECK (char_length(status_reason) <= 60),
	CONSTRAINT "assistant_turns_steps_chk" CHECK (steps BETWEEN 0 AND 20)
);
--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_thread_fk" FOREIGN KEY ("user_id","thread_id") REFERENCES "public"."assistant_threads"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_turn_fk" FOREIGN KEY ("user_id","turn_id") REFERENCES "public"."assistant_turns"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_proposals" ADD CONSTRAINT "assistant_proposals_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_proposals" ADD CONSTRAINT "assistant_proposals_thread_fk" FOREIGN KEY ("user_id","thread_id") REFERENCES "public"."assistant_threads"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_proposals" ADD CONSTRAINT "assistant_proposals_turn_fk" FOREIGN KEY ("user_id","turn_id") REFERENCES "public"."assistant_turns"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_threads" ADD CONSTRAINT "assistant_threads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_tool_results" ADD CONSTRAINT "assistant_tool_results_message_fk" FOREIGN KEY ("user_id","message_id") REFERENCES "public"."assistant_messages"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_thread_fk" FOREIGN KEY ("user_id","thread_id") REFERENCES "public"."assistant_threads"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_messages_thread_idx" ON "assistant_messages" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "assistant_messages_turn_idx" ON "assistant_messages" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "assistant_proposals_thread_idx" ON "assistant_proposals" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "assistant_proposals_turn_idx" ON "assistant_proposals" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "assistant_proposals_open_idx" ON "assistant_proposals" USING btree ("user_id","location_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "assistant_proposals_location_idx" ON "assistant_proposals" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "assistant_threads_user_idx" ON "assistant_threads" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assistant_threads_tsv_idx" ON "assistant_threads" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "assistant_threads_expiry_idx" ON "assistant_threads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "assistant_tool_results_message_idx" ON "assistant_tool_results" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "assistant_tool_results_redact_idx" ON "assistant_tool_results" USING btree ("user_id","location_id") WHERE redacted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_turns_one_live_uq" ON "assistant_turns" USING btree ("thread_id") WHERE status IN ('queued', 'running', 'waiting_provider');--> statement-breakpoint
CREATE INDEX "assistant_turns_thread_idx" ON "assistant_turns" USING btree ("thread_id","created_at");