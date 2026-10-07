CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"lookup" text,
	"hash" text,
	"oauth_client_id" text,
	"scope" text NOT NULL,
	"created_with_mfa" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "api_tokens_kind_chk" CHECK ("kind" IN ('personal', 'oauth')),
	CONSTRAINT "api_tokens_scope_chk" CHECK ("scope" IN ('read', 'write')),
	CONSTRAINT "api_tokens_revoked_reason_chk" CHECK ("revoked_reason" IN ('user', 'membership_ended', 'role_lost', 'expired', 'admin', 'client_revoked')),
	CONSTRAINT "api_tokens_name_chk" CHECK (char_length(name) BETWEEN 1 AND 80),
	CONSTRAINT "api_tokens_lookup_chk" CHECK (lookup ~ '^[A-Za-z0-9]{8}$'),
	CONSTRAINT "api_tokens_hash_chk" CHECK (hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_tokens_oauth_client_chk" CHECK (char_length(oauth_client_id) <= 400),
	CONSTRAINT "api_tokens_kind_fields_chk" CHECK (CASE kind WHEN 'personal'
            THEN lookup IS NOT NULL AND hash IS NOT NULL AND oauth_client_id IS NULL
            ELSE lookup IS NULL AND hash IS NULL AND oauth_client_id IS NOT NULL END),
	CONSTRAINT "api_tokens_revoked_chk" CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
--> statement-breakpoint
CREATE TABLE "token_locations" (
	"token_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "token_locations_pk" PRIMARY KEY("token_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "token_rate_windows" (
	"token_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "token_rate_windows_pk" PRIMARY KEY("token_id","minute","kind"),
	CONSTRAINT "token_rate_windows_kind_chk" CHECK ("kind" IN ('read', 'write')),
	CONSTRAINT "token_rate_windows_count_chk" CHECK (count >= 0)
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_locations" ADD CONSTRAINT "token_locations_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_locations" ADD CONSTRAINT "token_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_rate_windows" ADD CONSTRAINT "token_rate_windows_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_lookup_uq" ON "api_tokens" USING btree ("lookup");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_oauth_uq" ON "api_tokens" USING btree ("user_id","oauth_client_id") WHERE kind = 'oauth' AND revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "token_locations_location_idx" ON "token_locations" USING btree ("location_id");