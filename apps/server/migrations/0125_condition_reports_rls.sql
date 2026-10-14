-- Custom SQL migration file, put your code below! --
-- 1.x, D235: renters' condition reports (D171). Above, drizzle's part: condition_reports,
-- condition_report_rooms, attachments.condition_room_id (a room's photo) and 'condition' in
-- report_runs_kind_chk. Below:
--   1. Row-level security. Everyone who sees the location reads its reports; members and above
--      (kept.writable_location_ids(), `things.edit`) write them. A finished report is locked: no
--      policy lets kept_app change it, nor add, change or remove its rooms; only owners and
--      admins may delete one. Deleting a report takes its rooms and their photos with it (the
--      foreign keys; referential actions pass row-level security).
--   2. A finished report's photos: attachments are policed by location alone (0020), so a trigger
--      refuses adding, moving or removing a photo of a finished report's room. A cascade (the
--      report, its location, or an owner's "delete original" of the file, D162) still goes.
-- No kept_system policy: no job reads these tables. test/leak.test.ts lists the trigger
-- function, and so does src/db/migrate.test.ts.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['condition_reports', 'condition_report_rooms'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE ON public.%I FROM kept_app, kept_system', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 1. Reports ----------------------------------------------------------------------------------------
CREATE POLICY app_select ON public.condition_reports FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.condition_reports FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id())
              AND finished_at IS NULL);
--> statement-breakpoint
-- Only an open report changes; finishing it is its last change, stamped with who finished it.
CREATE POLICY app_update ON public.condition_reports FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()) AND finished_at IS NULL)
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND (finished_by IS NULL OR finished_by = (SELECT kept.current_user_id())));
--> statement-breakpoint
CREATE POLICY app_delete ON public.condition_reports FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids())
         AND (finished_at IS NULL OR location_id IN (SELECT kept.admin_location_ids())));
--> statement-breakpoint
GRANT UPDATE (kind, held_on, notes, finished_at, finished_by, updated_at, row_version)
  ON public.condition_reports TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.condition_reports
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- Rooms: written only while their report is open.
CREATE POLICY app_select ON public.condition_report_rooms FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.condition_report_rooms FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id())
              AND EXISTS (SELECT 1 FROM public.condition_reports r
                           WHERE r.id = report_id AND r.finished_at IS NULL));
--> statement-breakpoint
CREATE POLICY app_update ON public.condition_report_rooms FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids())
         AND EXISTS (SELECT 1 FROM public.condition_reports r
                      WHERE r.id = report_id AND r.finished_at IS NULL))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.condition_report_rooms FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids())
         AND EXISTS (SELECT 1 FROM public.condition_reports r
                      WHERE r.id = report_id AND r.finished_at IS NULL));
--> statement-breakpoint
GRANT UPDATE (name, condition, note, sort, updated_at, row_version)
  ON public.condition_report_rooms TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.condition_report_rooms
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- 2. A finished report's photos ---------------------------------------------------------------------
-- 23514 with the constraint's name, which the API answers as 409 (http/errors.ts CONFLICT_HINTS).
-- Inside the trigger, pg_trigger_depth() is 1 for a statement on attachments itself and more for
-- a cascade from another table (a referential action is a trigger).
CREATE FUNCTION kept.guard_condition_photo() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  rooms uuid[];
BEGIN
  rooms := CASE TG_OP
             WHEN 'INSERT' THEN ARRAY[NEW.condition_room_id]
             WHEN 'DELETE' THEN ARRAY[OLD.condition_room_id]
             ELSE ARRAY[NEW.condition_room_id, OLD.condition_room_id] END;
  rooms := array_remove(rooms, NULL);
  IF pg_trigger_depth() = 1 AND cardinality(rooms) > 0 THEN
    IF EXISTS (SELECT 1 FROM public.condition_report_rooms rm
                 JOIN public.condition_reports r ON r.id = rm.report_id
                WHERE rm.id = ANY (rooms) AND r.finished_at IS NOT NULL) THEN
      RAISE EXCEPTION 'condition report finished'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'condition_report_finished';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_condition_photo() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER attachments_guard_condition_photo
  BEFORE INSERT OR UPDATE OR DELETE ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION kept.guard_condition_photo();
