CREATE TABLE "embedding_state" (
	"location_id" uuid PRIMARY KEY NOT NULL,
	"model_key" text,
	"source" text,
	"pending" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"paused_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_state_model_key_chk" CHECK (char_length(model_key) BETWEEN 1 AND 200),
	CONSTRAINT "embedding_state_source_chk" CHECK (source IN ('provider', 'local')),
	CONSTRAINT "embedding_state_pending_chk" CHECK (pending >= 0),
	CONSTRAINT "embedding_state_paused_reason_chk" CHECK (char_length(paused_reason) <= 60)
);
--> statement-breakpoint
CREATE TABLE "thing_embeddings" (
	"thing_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"model_key" text NOT NULL,
	"dims" smallint NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thing_embeddings_pk" PRIMARY KEY("thing_id","model_key"),
	CONSTRAINT "thing_embeddings_model_key_chk" CHECK (char_length(model_key) BETWEEN 1 AND 200),
	CONSTRAINT "thing_embeddings_dims_chk" CHECK (dims BETWEEN 1 AND 2000),
	CONSTRAINT "thing_embeddings_hash_chk" CHECK (content_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "thing_embeddings_vector_chk" CHECK (vector_dims(embedding) = dims)
);
--> statement-breakpoint
ALTER TABLE "embedding_state" ADD CONSTRAINT "embedding_state_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thing_embeddings" ADD CONSTRAINT "thing_embeddings_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "thing_embeddings_loc_model_idx" ON "thing_embeddings" USING btree ("location_id","model_key");