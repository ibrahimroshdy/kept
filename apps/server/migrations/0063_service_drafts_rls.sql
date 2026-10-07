-- Custom SQL migration file, put your code below! --
-- Step 5, task 5: service drafts for invoices read by AI (screens §5; D26, D29; plan Q11, Q12).
-- Above, in 0062, drizzle's part: service_records.review_state ('draft' | 'confirmed', confirmed
-- by default) with each person's drafts indexed, service_records_reading_uq (one owner per
-- reading, Q11), and extractions.service_record_id (the draft whose invoice the RECEIPT
-- extraction reads; set at insert only, so no grant; extractions_one_draft_chk counts it). Below:
--   1. review_state joins the service record's column grant (0051). It moves one way, draft to
--      confirmed (23514 service_records_review_state), except for kept_owner and an undo
--      (`app.undo` set, 0056).
--   2. A draft counts nowhere: kept.recompute_schedule_anchor() (0053) reads confirmed records
--      only, so a draft that "completes" a schedule doesn't re-anchor it; a draft's completion
--      doesn't end the schedule's snooze or skip (Q28); confirming the draft does both, as a new
--      completion would. public.agenda_items reads no service record, so it needs no change; the
--      scan's "a completion since it opened" (reminders/scan.ts) is Phase B's to filter.
-- src/db/service-drafts.test.ts tests them; test/leak-vehicles.ts fills a draft, its invoice and
-- the extraction reading it.

-- 1. The grant and the one-way state -----------------------------------------------------------------
GRANT UPDATE (review_state) ON public.service_records TO kept_app;
--> statement-breakpoint
CREATE FUNCTION kept.guard_service_review_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user = 'kept_owner'
     OR coalesce(current_setting('app.undo', true), '') NOT IN ('', 'off')
     OR (OLD.review_state = 'draft' AND NEW.review_state = 'confirmed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a confirmed service record stays confirmed'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'service_records_review_state';
END $$;
--> statement-breakpoint
CREATE TRIGGER service_records_guard_review_state BEFORE UPDATE OF review_state
  ON public.service_records
  FOR EACH ROW WHEN (OLD.review_state IS DISTINCT FROM NEW.review_state)
  EXECUTE FUNCTION kept.guard_service_review_state();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_service_review_state() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 2. Drafts count nowhere --------------------------------------------------------------------------
-- 0053's, reading confirmed records only.
CREATE OR REPLACE FUNCTION kept.recompute_schedule_anchor(p_schedule uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  s public.schedules%ROWTYPE;
  last_on date;
  last_value numeric;
BEGIN
  SELECT * INTO s FROM public.schedules x WHERE x.id = p_schedule;
  IF s.id IS NULL THEN
    RETURN;
  END IF;
  SELECT r.serviced_on INTO last_on
    FROM public.service_completions c JOIN public.service_records r ON r.id = c.service_record_id
   WHERE c.schedule_id = p_schedule AND r.review_state = 'confirmed'
   ORDER BY r.serviced_on DESC, r.created_at DESC, r.id DESC LIMIT 1;
  IF s.meter_id IS NOT NULL THEN
    SELECT d.value + m.offset INTO last_value
      FROM public.service_completions c
      JOIN public.service_records r ON r.id = c.service_record_id
      JOIN public.meter_readings d ON d.id = r.meter_reading_id
      JOIN public.meters m ON m.id = d.meter_id
     WHERE c.schedule_id = p_schedule AND d.meter_id = s.meter_id
       AND r.review_state = 'confirmed'
     ORDER BY r.serviced_on DESC, r.created_at DESC, r.id DESC LIMIT 1;
  END IF;
  UPDATE public.schedules x
     SET anchor_on = coalesce(last_on, x.base_on),
         anchor_value = coalesce(last_value, x.base_value)
   WHERE x.id = p_schedule
     AND (x.anchor_on IS DISTINCT FROM coalesce(last_on, x.base_on)
          OR x.anchor_value IS DISTINCT FROM coalesce(last_value, x.base_value));
END $$;
--> statement-breakpoint
-- 0053's: a new completion ends the snooze and the skip (Q28), now only a confirmed record's.
CREATE OR REPLACE FUNCTION kept.schedule_completion_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.schedules x
       SET snoozed_until = NULL, snoozed_until_value = NULL, skip_next = false
     WHERE x.id = NEW.schedule_id
       AND (x.snoozed_until IS NOT NULL OR x.snoozed_until_value IS NOT NULL OR x.skip_next)
       AND EXISTS (SELECT 1 FROM public.service_records r
                    WHERE r.id = NEW.service_record_id AND r.review_state = 'confirmed');
    PERFORM kept.recompute_schedule_anchor(NEW.schedule_id);
  ELSE
    PERFORM kept.recompute_schedule_anchor(OLD.schedule_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- 0053's: a completing service's date or reading changed, or (step 5) it was confirmed. A draft
-- confirmed is its completions arriving: they end each schedule's snooze and skip too.
CREATE OR REPLACE FUNCTION kept.service_record_anchor_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  sid uuid;
BEGIN
  FOR sid IN SELECT c.schedule_id FROM public.service_completions c
              WHERE c.service_record_id = NEW.id LOOP
    IF OLD.review_state = 'draft' AND NEW.review_state = 'confirmed' THEN
      UPDATE public.schedules x
         SET snoozed_until = NULL, snoozed_until_value = NULL, skip_next = false
       WHERE x.id = sid
         AND (x.snoozed_until IS NOT NULL OR x.snoozed_until_value IS NOT NULL OR x.skip_next);
    END IF;
    PERFORM kept.recompute_schedule_anchor(sid);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER service_records_anchor ON public.service_records;
--> statement-breakpoint
CREATE TRIGGER service_records_anchor
  AFTER UPDATE OF serviced_on, meter_reading_id, review_state ON public.service_records
  FOR EACH ROW
  WHEN (OLD.serviced_on IS DISTINCT FROM NEW.serviced_on
        OR OLD.meter_reading_id IS DISTINCT FROM NEW.meter_reading_id
        OR OLD.review_state IS DISTINCT FROM NEW.review_state)
  EXECUTE FUNCTION kept.service_record_anchor_changed();
