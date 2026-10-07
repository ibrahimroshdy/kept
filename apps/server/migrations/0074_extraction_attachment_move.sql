-- Custom SQL migration file, put your code below! --
-- Step 5, T8 and T10 (for the migration owner): an extraction can follow its photo. A READING
-- photo read by AI moves onto the reading it produced, and a vehicle card's photo moves (not a
-- copy) onto the new document, by pointing the extraction at the photo's new attachment row
-- before the old one goes; without it, the old attachment's delete would cascade the extraction
-- (and its ledger link) away. Below:
--   1. kept_app may UPDATE extractions.attachment_id (0038's grant, plus this column). 0038's
--      update policy already limits the row to a location the caller writes.
--   2. kept.guard_extraction_attachment(), scoped like the insert: only the person who asked for
--      the reading, or an admin of the location, moves it (42501 extractions_attachment_move, a
--      404), and only onto an attachment they see in the same location (42501, before the key
--      would answer 23503). The key (location_id, attachment_id) still holds it to the location.
-- src/db/migrate.test.ts lists the function; src/db/extraction-move.test.ts tests it.

GRANT UPDATE (attachment_id) ON public.extractions TO kept_app;
--> statement-breakpoint
-- Invoker: the caller's own policies decide which attachments it sees.
CREATE FUNCTION kept.guard_extraction_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.requested_by IS DISTINCT FROM kept.current_user_id()
     AND NOT coalesce(OLD.location_id IN (SELECT kept.admin_location_ids()), false) THEN
    RAISE EXCEPTION 'only its requester or an admin moves an extraction'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'extractions_attachment_move';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.attachments a
                  WHERE a.id = NEW.attachment_id AND a.location_id = NEW.location_id) THEN
    RAISE EXCEPTION 'no such attachment here'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'extractions_attachment_move';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Only a real change: a move of the location cascades (location_id, attachment_id) with the same
-- attachment id.
CREATE TRIGGER extractions_guard_attachment BEFORE UPDATE OF attachment_id ON public.extractions
  FOR EACH ROW WHEN (OLD.attachment_id IS DISTINCT FROM NEW.attachment_id)
  EXECUTE FUNCTION kept.guard_extraction_attachment();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_extraction_attachment() FROM PUBLIC, kept_app, kept_system;
