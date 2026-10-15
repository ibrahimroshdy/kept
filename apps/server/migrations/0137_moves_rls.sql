-- Custom SQL migration file, put your code below! --
-- 1.x, D251: moving mode (D39 (5)). Above, drizzle's part: moves, move_boxes, 'move' in
-- report_runs_kind_chk (a move's contents sheets) and 'move_box' in sync_ops_op_chk (the offline
-- op). Below, row-level security:
--   Everyone who sees the move's location reads the move and its boxes, viewers included; members
--   and above (kept.writable_location_ids(), `things.edit`) start, pack, mark and unpack. A move
--   can only be pointed at a location its creator also writes. Boxes are added to an open move
--   only. Deleting a move takes its box rows with it (the foreign key); the boxes themselves are
--   things and stay.
-- No kept_system policy: no job reads these tables. A purged container takes its box row with it,
-- and a purged room clears the boxes going to it (referential actions pass row-level security).

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['moves', 'move_boxes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE ON public.%I FROM kept_app, kept_system', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Moves ----------------------------------------------------------------------------------------------
CREATE POLICY app_select ON public.moves FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.moves FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id())
              AND status = 'active'
              AND (to_location_id IS NULL
                   OR to_location_id IN (SELECT kept.writable_location_ids())));
--> statement-breakpoint
CREATE POLICY app_update ON public.moves FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.moves FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (name, to_location_id, status, finished_at, updated_at, row_version)
  ON public.moves TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.moves
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- Boxes: added to an open move; their number never changes.
CREATE POLICY app_select ON public.move_boxes FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.move_boxes FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id())
              AND EXISTS (SELECT 1 FROM public.moves m
                           WHERE m.id = move_id AND m.status = 'active'));
--> statement-breakpoint
CREATE POLICY app_update ON public.move_boxes FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.move_boxes FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (state, destination_place_id, state_at, state_by, updated_at, row_version)
  ON public.move_boxes TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.move_boxes
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
