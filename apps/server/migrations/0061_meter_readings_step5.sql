-- Custom SQL migration file, put your code below! --
-- Step 5, task 4: meters and readings, step 5's additions (engineering spec §3.4, §7.13; D27, D52,
-- D195; plan Q10, Q18, Q19). Above, in 0060, drizzle's part: meters.nudge_days (7–365, 30 by
-- default, NULL for no nudge). Below:
--   1. nudge_days joins the meter's column grant (0018): owners and admins set it
--      (`meters.manage` is can()'s, as for the daily limit).
--   2. Readings reach the snapshot (Q18): the offline snapshot's SnapMeter carries the latest
--      reading, and the snapshot resends a thing only when its change_xid moves. A reading doesn't
--      touch its thing, so kept.touch_reading_meters() bumps things.meter_version (a quiet column
--      since 0047: change_seq only, row_version stays) when a reading is added, removed, or its
--      value, time or state changes. A move's cascade rewrites location_id only and fires nothing.
--      A reading deleted with its thing (the trash purge's cascade) finds no meter left to join,
--      so it bumps nothing.
--   3. Proof photos move to their reading (Q10, D27, D195), once. Step 3 attached READING proofs
--      to the thing. A READING capture with a typed value made its reading with the capture's id,
--      and its `thing.capture` event's diff names the meter and the attachments
--      (capture/service.ts: capture_id, meter_id, attachment_ids, each as {before, after}; the
--      plan's `after->>…` is the audit input's shape, not the stored one). Those proofs now hang
--      on their reading; the rest stay on the thing, and the strip shows them by date.
-- test/leak.test.ts and src/db/migrate.test.ts list the function; test/leak-vehicles.ts fills
-- the column and a proof on its reading; src/db/meters-step5.test.ts tests them.

-- 1. The nudge's grant -------------------------------------------------------------------------------
GRANT UPDATE (nudge_days) ON public.meters TO kept_app;
--> statement-breakpoint

-- 2. Readings reach the snapshot ------------------------------------------------------------------------
-- A definer: things.meter_version has no column grant.
CREATE FUNCTION kept.touch_reading_meters() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.things t SET meter_version = t.meter_version + 1
    FROM public.meters m
   WHERE m.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.meter_id ELSE NEW.meter_id END
     AND t.id = m.thing_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.touch_reading_meters() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER meter_readings_thing_version AFTER INSERT OR DELETE ON public.meter_readings
  FOR EACH ROW EXECUTE FUNCTION kept.touch_reading_meters();
--> statement-breakpoint
-- Only a real change: a move's cascade rewrites location_id, and nothing READING shows.
CREATE TRIGGER meter_readings_thing_version_update
  AFTER UPDATE OF value, taken_at, state ON public.meter_readings
  FOR EACH ROW
  WHEN (OLD.value IS DISTINCT FROM NEW.value OR OLD.taken_at IS DISTINCT FROM NEW.taken_at
        OR OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION kept.touch_reading_meters();
--> statement-breakpoint

-- 3. Proof photos move to their reading -------------------------------------------------------------
-- The capture's reading has the capture's id; only a proof of that capture still on the reading's
-- thing, in the reading's location, moves. Idempotent: a moved proof has no thing_id to match.
WITH cap AS (
  SELECT e.location_id,
         (e.diff -> 'capture_id' ->> 'after')::uuid AS reading_id,
         x.value::uuid AS attachment_id
    FROM public.audit_events e
   CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(e.diff -> 'attachment_ids' -> 'after') = 'array'
                THEN e.diff -> 'attachment_ids' -> 'after' END) AS x(value)
   WHERE e.action = 'thing.capture' AND e.location_id IS NOT NULL
     AND jsonb_typeof(e.diff -> 'meter_id' -> 'after') = 'string'
     AND (e.diff -> 'capture_id' ->> 'after')
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND x.value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
UPDATE public.attachments a
   SET thing_id = NULL, meter_reading_id = cap.reading_id
  FROM cap
  JOIN public.meter_readings r ON r.id = cap.reading_id
  JOIN public.meters m ON m.id = r.meter_id
 WHERE a.id = cap.attachment_id AND a.role = 'proof' AND a.thing_id = m.thing_id
   AND a.location_id = r.location_id AND r.location_id = cap.location_id;
