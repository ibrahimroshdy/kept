CREATE TABLE "map_nodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"place_id" uuid,
	"thing_id" uuid,
	"x_cm" integer NOT NULL,
	"z_cm" integer NOT NULL,
	"w_cm" integer,
	"d_cm" integer,
	"rot" integer DEFAULT 0 NOT NULL,
	"model" text,
	"room_kind" text,
	"surface" text,
	"host_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "map_nodes_room_kind_chk" CHECK ("room_kind" IN ('room', 'balcony', 'terrace', 'garden')),
	CONSTRAINT "map_nodes_surface_chk" CHECK ("surface" IN ('wood', 'tile', 'concrete', 'deck', 'grass')),
	CONSTRAINT "map_nodes_one_subject_chk" CHECK (num_nonnulls(place_id, thing_id) = 1),
	CONSTRAINT "map_nodes_rot_chk" CHECK (rot IN (0, 90, 180, 270)),
	CONSTRAINT "map_nodes_xz_chk" CHECK (x_cm BETWEEN 0 AND 100000 AND z_cm BETWEEN 0 AND 100000),
	CONSTRAINT "map_nodes_size_chk" CHECK ((w_cm IS NULL AND d_cm IS NULL) OR (w_cm BETWEEN 100 AND 10000 AND d_cm BETWEEN 100 AND 10000)),
	CONSTRAINT "map_nodes_model_chk" CHECK (model IS NULL OR model ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "map_nodes_room_chk" CHECK ((room_kind IS NULL AND surface IS NULL) OR w_cm IS NOT NULL),
	CONSTRAINT "map_nodes_not_own_host_chk" CHECK (host_id IS NULL OR host_id <> coalesce(place_id, thing_id))
);
--> statement-breakpoint
ALTER TABLE "map_nodes" ADD CONSTRAINT "map_nodes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_nodes" ADD CONSTRAINT "map_nodes_place_fk" FOREIGN KEY ("location_id","place_id") REFERENCES "public"."places"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "map_nodes" ADD CONSTRAINT "map_nodes_thing_fk" FOREIGN KEY ("location_id","thing_id") REFERENCES "public"."things"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "map_nodes_place_uq" ON "map_nodes" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "map_nodes_thing_uq" ON "map_nodes" USING btree ("thing_id");--> statement-breakpoint
CREATE INDEX "map_nodes_location_idx" ON "map_nodes" USING btree ("location_id");