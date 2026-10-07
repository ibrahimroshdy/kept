CREATE TABLE "brand_logos" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"png" "bytea" NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "brand_logos_png_chk" CHECK (octet_length(png) BETWEEN 8 AND 262144),
	CONSTRAINT "brand_logos_size_chk" CHECK (width BETWEEN 1 AND 256 AND height BETWEEN 1 AND 256),
	CONSTRAINT "brand_logos_sha256_chk" CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "brand_logos" ADD CONSTRAINT "brand_logos_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."owner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_logos" ADD CONSTRAINT "brand_logos_brand_fk" FOREIGN KEY ("owner_account_id","brand_id") REFERENCES "public"."brands"("owner_account_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "brand_logos_owner_idx" ON "brand_logos" USING btree ("owner_account_id");--> statement-breakpoint
ALTER TABLE "brands" DROP COLUMN "logo_file_id";