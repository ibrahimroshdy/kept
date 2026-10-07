CREATE TABLE "auth"."session_mfa" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"satisfied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."sign_in_failures" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."verification" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "auth"."verification" ALTER COLUMN "id" SET DEFAULT uuidv7()::text;--> statement-breakpoint
ALTER TABLE "auth"."session_mfa" ADD CONSTRAINT "session_mfa_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "auth"."session"("id") ON DELETE cascade ON UPDATE no action;