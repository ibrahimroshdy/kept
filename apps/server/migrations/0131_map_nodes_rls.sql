-- Custom SQL migration file, put your code below! --
-- 1.x, D237: the location map's layout (0130's map_nodes). Row-level security:
--   - kept_app: everyone who sees the location reads its layout (viewers see the map); anyone who
--     may edit things there (members and up, kept.writable_location_ids()) arranges it. An arrange
--     session replaces the location's rows (DELETE, then INSERT), so nobody UPDATEs a row.
--   - kept_system: nothing. No job reads or writes the layout; a purged place, thing or location
--     takes its rows with it through the foreign keys.
-- src/map/map.test.ts tests them; test/leak.test.ts covers the table from the catalogue.
ALTER TABLE public.map_nodes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.map_nodes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.map_nodes FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_select ON public.map_nodes FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.map_nodes FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.map_nodes FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
REVOKE ALL ON public.map_nodes FROM kept_app, kept_system;
--> statement-breakpoint
GRANT SELECT (id, location_id, place_id, thing_id, x_cm, z_cm, w_cm, d_cm, rot, model,
              room_kind, surface, host_id, created_by, created_at)
  ON public.map_nodes TO kept_app;
--> statement-breakpoint
-- Not granted: the id and created_at (the table's defaults).
GRANT INSERT (location_id, place_id, thing_id, x_cm, z_cm, w_cm, d_cm, rot, model, room_kind,
              surface, host_id, created_by)
  ON public.map_nodes TO kept_app;
--> statement-breakpoint
GRANT DELETE ON public.map_nodes TO kept_app;
