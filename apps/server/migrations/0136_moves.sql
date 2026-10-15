CREATE TABLE "move_boxes" (
	"location_id" uuid NOT NULL,
	"move_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"state" text DEFAULT 'packed' NOT NULL,
	"destination_place_id" uuid,
	"state_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "move_boxes_pk" PRIMARY KEY("move_id","container_id"),
	CONSTRAINT "move_boxes_number_uq" UNIQUE("move_id","number"),
	CONSTRAINT "move_boxes_state_chk" CHECK ("state" IN ('packed', 'in_transit', 'unpacked')),
	CONSTRAINT "move_boxes_number_chk" CHECK (number BETWEEN 1 AND 999)
);
--> statement-breakpoint
CREATE TABLE "moves" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"location_id" uuid NOT NULL,
	"to_location_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint,
	CONSTRAINT "moves_location_id_uq" UNIQUE("location_id","id"),
	CONSTRAINT "moves_status_chk" CHECK ("status" IN ('active', 'done')),
	CONSTRAINT "moves_name_chk" CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
	CONSTRAINT "moves_finished_chk" CHECK ((status = 'done') = (finished_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "report_runs" DROP CONSTRAINT "report_runs_kind_chk";--> statement-breakpoint
ALTER TABLE "sync_ops" DROP CONSTRAINT "sync_ops_op_chk";--> statement-breakpoint
ALTER TABLE "move_boxes" ADD CONSTRAINT "move_boxes_container_id_things_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."things"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_boxes" ADD CONSTRAINT "move_boxes_destination_place_id_places_id_fk" FOREIGN KEY ("destination_place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_boxes" ADD CONSTRAINT "move_boxes_move_fk" FOREIGN KEY ("location_id","move_id") REFERENCES "public"."moves"("location_id","id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "move_boxes_container_idx" ON "move_boxes" USING btree ("container_id");--> statement-breakpoint
CREATE INDEX "move_boxes_destination_idx" ON "move_boxes" USING btree ("destination_place_id");--> statement-breakpoint
CREATE INDEX "moves_location_idx" ON "moves" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "moves_to_location_idx" ON "moves" USING btree ("to_location_id");--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_kind_chk" CHECK ("kind" IN ('inventory', 'insurance', 'vehicle_history', 'condition', 'move'));--> statement-breakpoint
ALTER TABLE "sync_ops" ADD CONSTRAINT "sync_ops_op_chk" CHECK ("op" IN ('create_thing', 'move', 'log_reading', 'claim_label', 'mark_seen', 'not_here', 'create_area', 'box_check', 'move_box'));