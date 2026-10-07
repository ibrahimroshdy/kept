CREATE TABLE "saved_view_prefs" (
	"user_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"default_view_id" uuid,
	"pinned" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "saved_view_prefs_pk" PRIMARY KEY("user_id","surface"),
	CONSTRAINT "saved_view_prefs_surface_chk" CHECK (surface ~ '^[a-z][a-z-]{0,31}$'),
	CONSTRAINT "saved_view_prefs_pinned_chk" CHECK (cardinality(pinned) <= 20)
);
--> statement-breakpoint
ALTER TABLE "saved_views" ADD COLUMN "surface" text DEFAULT 'search' NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_view_prefs" ADD CONSTRAINT "saved_view_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view_prefs" ADD CONSTRAINT "saved_view_prefs_default_view_id_saved_views_id_fk" FOREIGN KEY ("default_view_id") REFERENCES "public"."saved_views"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_views_user_surface_idx" ON "saved_views" USING btree ("user_id","surface");--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_surface_chk" CHECK (surface ~ '^[a-z][a-z-]{0,31}$');--> statement-breakpoint
-- The filter strip's saved views (D205; screens spec "The filter strip"). Above, drizzle's part:
-- saved_views.surface (which list a view belongs to; every view so far is a search view) and
-- saved_view_prefs (src/db/schema/user.ts). Below:
--   1. Every saved view's query becomes list state (@kept/shared SavedListQuery): the old search
--      shape {q?, locationId?, placeId?, typeId?, tagId?, state?, priceMin?, priceMax?, currency?}
--      becomes {q?, filters?: {location: [..], place: [..], type: [..], tag: [..], state: [..],
--      priceMin: [..], priceMax: [..], currency: [..]}}, each filter one value, only the keys the
--      view held. `kind` and `limit` are dropped: a view opens the list, not one group of it.
--   2. Row-level security on saved_view_prefs, as user_hints (0020 section 5): a person's own
--      rows only. kept_app may change the default and the pins, nothing else; the surface and
--      the user are the key. Not audited by the database: the route audits the change.
-- test/leak-inventory.ts fills the table.

-- 1. Old search queries to list state ---------------------------------------------------------
UPDATE public.saved_views v
   SET query = jsonb_strip_nulls(jsonb_build_object(
         'q', v.query->'q',
         'filters', (SELECT jsonb_object_agg(m.new_key, jsonb_build_array(v.query->m.old_key))
                       FROM (VALUES ('locationId', 'location'), ('placeId', 'place'),
                                    ('typeId', 'type'), ('tagId', 'tag'), ('state', 'state'),
                                    ('priceMin', 'priceMin'), ('priceMax', 'priceMax'),
                                    ('currency', 'currency')) AS m(old_key, new_key)
                      WHERE jsonb_typeof(v.query->m.old_key) = 'string')))
 WHERE v.surface = 'search' AND NOT v.query ? 'filters';
--> statement-breakpoint

-- 2. saved_view_prefs: the person's own ---------------------------------------------------------
ALTER TABLE public.saved_view_prefs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.saved_view_prefs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.saved_view_prefs FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE UPDATE ON public.saved_view_prefs FROM kept_app, kept_system;
--> statement-breakpoint
CREATE POLICY app_own ON public.saved_view_prefs FOR ALL TO kept_app
  USING (user_id = (SELECT kept.current_user_id()))
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
GRANT UPDATE (default_view_id, pinned) ON public.saved_view_prefs TO kept_app;
