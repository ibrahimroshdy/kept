CREATE TABLE "mailbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"uid_validity" bigint NOT NULL,
	"uid" bigint NOT NULL,
	"from_address" text,
	"subject" text,
	"received_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"purchase_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_messages_uid_uq" UNIQUE("mailbox_id","uid_validity","uid"),
	CONSTRAINT "mailbox_messages_outcome_chk" CHECK ("outcome" IN ('receipt', 'no_receipt', 'sender_not_allowed', 'too_large', 'failed')),
	CONSTRAINT "mailbox_messages_from_chk" CHECK (from_address IS NULL OR char_length(from_address) <= 254),
	CONSTRAINT "mailbox_messages_subject_chk" CHECK (subject IS NULL OR char_length(subject) <= 200)
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text DEFAULT 'imap' NOT NULL,
	"host" text NOT NULL,
	"username" text NOT NULL,
	"folder" text NOT NULL,
	"allowed_senders" text[] DEFAULT '{}'::text[] NOT NULL,
	"config_ciphertext" jsonb NOT NULL,
	"key_version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"uid_validity" bigint,
	"last_uid" bigint,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "mailboxes_location_uq" UNIQUE("location_id"),
	CONSTRAINT "mailboxes_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "mailboxes_kind_chk" CHECK ("kind" IN ('imap')),
	CONSTRAINT "mailboxes_disabled_reason_chk" CHECK ("disabled_reason" IN ('creator_left', 'auth_failed')),
	CONSTRAINT "mailboxes_host_chk" CHECK (char_length(host) BETWEEN 1 AND 253),
	CONSTRAINT "mailboxes_username_chk" CHECK (char_length(username) BETWEEN 1 AND 254),
	CONSTRAINT "mailboxes_folder_chk" CHECK (char_length(folder) BETWEEN 1 AND 200),
	CONSTRAINT "mailboxes_senders_chk" CHECK (cardinality(allowed_senders) <= 20),
	CONSTRAINT "mailboxes_key_version_chk" CHECK (key_version >= 1),
	CONSTRAINT "mailboxes_disabled_chk" CHECK (active OR disabled_reason IS NOT NULL),
	CONSTRAINT "mailboxes_last_error_chk" CHECK (last_error IS NULL OR char_length(last_error) <= 32)
);
--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_mailbox_fk" FOREIGN KEY ("location_id","mailbox_id") REFERENCES "public"."mailboxes"("location_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailbox_messages_recent_idx" ON "mailbox_messages" USING btree ("mailbox_id","created_at");