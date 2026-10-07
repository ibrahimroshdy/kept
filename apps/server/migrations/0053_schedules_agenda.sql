-- Custom SQL migration file, put your code below! --
-- Step 4, task 6: schedules, expiring documents, module state in SQL and the agenda view
-- (engineering spec §1.6, §1.9, §7.6, §7.13; D29, D39, D52, D111, D113, D141, D146, D155, D162;
-- plan Q2–Q9, Q24, Q27, Q28, Q31). Above, in 0052, drizzle's part: schedules, service_completions,
-- expiring_documents and attachments.expiring_document_id (src/db/schema/schedules.ts). Below:
--   1. Row-level security: read wherever the subject is seen, written by its writers (§7.1
--      "Manage schedules": members and above). A schedule's anchor has no column grant: only
--      kept.recompute_schedule_anchor() writes it.
--   2. expiring_documents' renewal key: ON DELETE SET NULL (superseded_by_id).
--   3. The anchor (D162): a schedule is made with a base (its last-done date and reading, or its
--      creation day), which is its anchor until a service completes it; then the latest
--      completing service's date, and its reading of the schedule's meter (with the meter's
--      offset, D52), are. kept.recompute_schedule_anchor() keeps it after a completion is added or
--      removed, a completing service's date or reading changes (or it goes, through the cascade),
--      and the base changes; a new completion also clears the snooze and the skip (Q28). The
--      anchor bumps change_seq only (kept.touch_row's second argument): a completion must not
--      make an open edit of the schedule a 412.
--   4. Module state in SQL: kept.module_on(location, module), the twin of @kept/shared
--      modules.ts (preset, then location_modules rows, then dependencies). Invoker: it reads the
--      location under the caller's policies, so a location they can't see is off. The AI modules
--      are never asked here (their provider rule is the server's).
--   5. kept.schedule_point() and kept.schedule_next(): the twins of @kept/shared scheduleNext()
--      (months from the anchor, clamped; units from the anchor against the meter's newest
--      accepted reading plus its offset; "whichever first"; snooze and skip; no distance
--      estimate in step 4, Q2).
--   6. public.agenda_items (security_invoker, Q24): one row per live reminder source with a due
--      point, whatever its state. `kind` is the occurrence kind its state gives (plan Q7: a
--      schedule is due, then overdue; a warranty expiring; a registration deadline due; a
--      document or a thing's expiry expiring, then overdue; a loan overdue), and an upcoming row
--      carries the first kind it will reach. `state` is upcoming, due, overdue, expiring or
--      expired (an ended warranty: not actionable, Q7). "Today" is the location's own date; ends
--      are inclusive (L2). Pausing is in its WHERE (§7.6, D162): the source's module off, a
--      trashed subject, a terminal lifecycle, an inactive schedule, a superseded document, a
--      returned loan. It holds no money, secret or contact detail.
--   7. kept_system reads for the reminder scan (T14): SELECT-only policies on the tables the
--      agenda reads, and people (a loan's member, Q16).
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-household.ts fills
-- the tables; src/db/schedules.test.ts and src/db/agenda.test.ts test them.

-- 1. Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['schedules', 'service_completions', 'expiring_documents'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE ON public.%I FROM kept_app, kept_system', t);
    EXECUTE format($p$
      CREATE POLICY app_select ON public.%I FOR SELECT TO kept_app
        USING (location_id IN (SELECT kept.visible_location_ids()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_delete ON public.%I FOR DELETE TO kept_app
        USING (location_id IN (SELECT kept.writable_location_ids()))$p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['schedules', 'expiring_documents'] LOOP
    EXECUTE format($p$
      CREATE POLICY app_insert ON public.%I FOR INSERT TO kept_app
        WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
                    AND created_by = (SELECT kept.current_user_id()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_update ON public.%I FOR UPDATE TO kept_app
        USING (location_id IN (SELECT kept.writable_location_ids()))
        WITH CHECK (location_id IN (SELECT kept.writable_location_ids()))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Never updated: a service completes a schedule, or no longer does.
CREATE POLICY app_insert ON public.service_completions FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (name, every_months, every_units, meter_id, due_on, lead_days, lead_units, base_on,
              base_value, snoozed_until, snoozed_until_value, skip_next, active, updated_at,
              row_version)
  ON public.schedules TO kept_app;
--> statement-breakpoint
GRANT UPDATE (kind, title, expires_on, lead_days, superseded_by_id, updated_at, row_version)
  ON public.expiring_documents TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.schedules
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row('', 'anchor_on,anchor_value');
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.expiring_documents
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- 2. The renewal key ---------------------------------------------------------------------------------
ALTER TABLE public.expiring_documents ADD CONSTRAINT expiring_documents_superseded_fk
  FOREIGN KEY (location_id, superseded_by_id)
  REFERENCES public.expiring_documents (location_id, id) ON UPDATE CASCADE
  ON DELETE SET NULL (superseded_by_id);
--> statement-breakpoint

-- 3. The anchor ---------------------------------------------------------------------------------------
-- A new schedule's base and anchor are one: whichever the request gave fills the other.
CREATE FUNCTION kept.schedule_base() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.base_on := coalesce(NEW.base_on, NEW.anchor_on);
  NEW.base_value := coalesce(NEW.base_value, NEW.anchor_value);
  NEW.anchor_on := NEW.base_on;
  NEW.anchor_value := NEW.base_value;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER schedules_base BEFORE INSERT ON public.schedules
  FOR EACH ROW EXECUTE FUNCTION kept.schedule_base();
--> statement-breakpoint
-- The latest completing service's date (then its creation, then its id), else the base; its
-- reading of the schedule's meter, else the latest completing reading of it, else the base's.
CREATE FUNCTION kept.recompute_schedule_anchor(p_schedule uuid) RETURNS void
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
   WHERE c.schedule_id = p_schedule
   ORDER BY r.serviced_on DESC, r.created_at DESC, r.id DESC LIMIT 1;
  IF s.meter_id IS NOT NULL THEN
    SELECT d.value + m.offset INTO last_value
      FROM public.service_completions c
      JOIN public.service_records r ON r.id = c.service_record_id
      JOIN public.meter_readings d ON d.id = r.meter_reading_id
      JOIN public.meters m ON m.id = d.meter_id
     WHERE c.schedule_id = p_schedule AND d.meter_id = s.meter_id
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
-- Completions come and go; a new one also ends the snooze and the skip (Q28).
CREATE FUNCTION kept.schedule_completion_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.schedules x
       SET snoozed_until = NULL, snoozed_until_value = NULL, skip_next = false
     WHERE x.id = NEW.schedule_id
       AND (x.snoozed_until IS NOT NULL OR x.snoozed_until_value IS NOT NULL OR x.skip_next);
    PERFORM kept.recompute_schedule_anchor(NEW.schedule_id);
  ELSE
    PERFORM kept.recompute_schedule_anchor(OLD.schedule_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER service_completions_anchor AFTER INSERT OR DELETE ON public.service_completions
  FOR EACH ROW EXECUTE FUNCTION kept.schedule_completion_changed();
--> statement-breakpoint
-- A completing service's date or reading changed: every schedule it completes follows.
CREATE FUNCTION kept.service_record_anchor_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  sid uuid;
BEGIN
  FOR sid IN SELECT c.schedule_id FROM public.service_completions c
              WHERE c.service_record_id = NEW.id LOOP
    PERFORM kept.recompute_schedule_anchor(sid);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER service_records_anchor
  AFTER UPDATE OF serviced_on, meter_reading_id ON public.service_records
  FOR EACH ROW
  WHEN (OLD.serviced_on IS DISTINCT FROM NEW.serviced_on
        OR OLD.meter_reading_id IS DISTINCT FROM NEW.meter_reading_id)
  EXECUTE FUNCTION kept.service_record_anchor_changed();
--> statement-breakpoint
-- The base told again ("last done on …"): the anchor follows when nothing completes it since.
CREATE FUNCTION kept.schedule_base_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM kept.recompute_schedule_anchor(NEW.id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER schedules_base_changed AFTER UPDATE OF base_on, base_value, meter_id
  ON public.schedules
  FOR EACH ROW
  WHEN (OLD.base_on IS DISTINCT FROM NEW.base_on OR OLD.base_value IS DISTINCT FROM NEW.base_value
        OR OLD.meter_id IS DISTINCT FROM NEW.meter_id)
  EXECUTE FUNCTION kept.schedule_base_changed();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.schedule_base(), kept.recompute_schedule_anchor(uuid),
  kept.schedule_completion_changed(), kept.service_record_anchor_changed(),
  kept.schedule_base_changed()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 4. Module state in SQL --------------------------------------------------------------------------------
-- @kept/shared modules.ts MODULES[*].presets, per preset. src/db/agenda.test.ts compares every
-- preset and module, with and without a location_modules row, to effectiveModules().
CREATE FUNCTION kept.module_enabled(p_location uuid, p_module text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(
    (SELECT lm.enabled FROM public.location_modules lm
      WHERE lm.location_id = p_location AND lm.module = p_module),
    (SELECT p_module = ANY (CASE l.preset
       WHEN 'essentials' THEN ARRAY['labels', 'ai_capture', 'ai_assistant']
       WHEN 'household' THEN ARRAY['labels', 'money', 'warranties', 'schedules', 'lending',
                                   'paperwork', 'vehicles', 'ai_capture', 'ai_assistant']
       WHEN 'complete' THEN ARRAY['labels', 'money', 'warranties', 'schedules', 'lending',
                                  'paperwork', 'vehicles', 'fuel', 'consumables', 'moving',
                                  'secrets', 'ai_capture', 'ai_assistant', 'mcp']
       ELSE '{}'::text[] END)
       FROM public.locations l WHERE l.id = p_location),
    false)
$$;
--> statement-breakpoint
-- Whether a module is on in a location: enabled, and its dependencies too (fuel needs vehicles,
-- moving needs labels: modules.ts `deps`).
CREATE FUNCTION kept.module_on(p_location uuid, p_module text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT kept.module_enabled(p_location, p_module)
     AND CASE p_module
           WHEN 'fuel' THEN kept.module_enabled(p_location, 'vehicles')
           WHEN 'moving' THEN kept.module_enabled(p_location, 'labels')
           ELSE true END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.module_enabled(uuid, text), kept.module_on(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.module_enabled(uuid, text), kept.module_on(uuid, text)
  TO kept_app, kept_system;
--> statement-breakpoint

-- 5. A schedule's next due point ------------------------------------------------------------------------
-- @kept/shared scheduleNext(), on its rule's values: the due day (the date side) and reading (the
-- unit side), and the state on `p_today` with `p_latest`, the meter's newest accepted reading
-- (plus its offset). The more urgent side wins; the date side on a tie. The default unit lead is
-- 10% of the interval, cut at 12 decimals as the TS's exact arithmetic does.
CREATE FUNCTION kept.schedule_point(p_every_months integer, p_every_units numeric,
                                    p_due_on date, p_anchor_on date, p_anchor_value numeric,
                                    p_snoozed_until date, p_snoozed_until_value numeric,
                                    p_skip_next boolean, p_lead_days integer,
                                    p_lead_units numeric, p_today date, p_latest numeric)
RETURNS TABLE (due_on date, due_value numeric, state text, basis text)
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  steps integer := CASE WHEN p_skip_next THEN 2 ELSE 1 END;
  d date;
  v numeric;
  ld integer := coalesce(p_lead_days, 14);
  lu numeric;
  ds text;
  us text;
  by_units boolean;
BEGIN
  IF p_snoozed_until IS NOT NULL OR p_snoozed_until_value IS NOT NULL THEN
    d := p_snoozed_until;
    v := p_snoozed_until_value;
    ld := 0;
    lu := 0;
  ELSE
    IF p_every_months IS NOT NULL THEN
      d := (p_anchor_on + make_interval(months => p_every_months * steps))::date;
    ELSIF p_due_on IS NOT NULL THEN
      d := p_due_on;
    END IF;
    IF p_every_units IS NOT NULL THEN
      v := coalesce(p_anchor_value, 0) + p_every_units * steps;
      lu := coalesce(p_lead_units, trunc(p_every_units / 10, 12));
    END IF;
  END IF;
  IF d IS NULL AND v IS NULL THEN
    RAISE EXCEPTION 'a schedule needs an interval in months or units, or a date'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  ds := CASE WHEN d IS NULL THEN NULL
             WHEN p_today > d THEN 'overdue'
             WHEN p_today >= d - ld THEN 'due'
             ELSE 'upcoming' END;
  us := CASE WHEN v IS NULL THEN NULL
             WHEN p_latest IS NULL THEN 'upcoming'
             WHEN p_latest > v THEN 'overdue'
             WHEN p_latest >= v - coalesce(lu, 0) THEN 'due'
             ELSE 'upcoming' END;
  by_units := us IS NOT NULL
    AND (ds IS NULL OR array_position(ARRAY['upcoming', 'due', 'overdue'], us)
                       > array_position(ARRAY['upcoming', 'due', 'overdue'], ds));
  RETURN QUERY SELECT d, CASE WHEN v IS NULL THEN NULL ELSE trim_scale(v) END,
                      CASE WHEN by_units THEN us ELSE ds END,
                      CASE WHEN by_units THEN 'units' ELSE 'date' END;
END $$;
--> statement-breakpoint
-- The meter's newest accepted reading, with its offset (D52). Invoker: the caller's policies.
CREATE FUNCTION kept.meter_latest(p_meter uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT r.value + m.offset
    FROM public.meter_readings r JOIN public.meters m ON m.id = r.meter_id
   WHERE r.meter_id = p_meter AND r.state = 'accepted'
   ORDER BY r.taken_at DESC, r.received_at DESC, r.id DESC
   LIMIT 1
$$;
--> statement-breakpoint
-- A schedule's next due point on `p_today` (the plan's name for the twin). Invoker.
CREATE FUNCTION kept.schedule_next(p_schedule uuid, p_today date)
RETURNS TABLE (due_on date, due_value numeric, state text, basis text)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT n.* FROM public.schedules s
   CROSS JOIN LATERAL kept.schedule_point(s.every_months, s.every_units, s.due_on, s.anchor_on,
                                          s.anchor_value, s.snoozed_until, s.snoozed_until_value,
                                          s.skip_next, s.lead_days, s.lead_units, p_today,
                                          kept.meter_latest(s.meter_id)) n
   WHERE s.id = p_schedule
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  kept.schedule_point(integer, numeric, date, date, numeric, date, numeric, boolean, integer,
                      numeric, date, numeric),
  kept.meter_latest(uuid), kept.schedule_next(uuid, date)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  kept.schedule_point(integer, numeric, date, date, numeric, date, numeric, boolean, integer,
                      numeric, date, numeric),
  kept.meter_latest(uuid), kept.schedule_next(uuid, date)
  TO kept_app, kept_system;
--> statement-breakpoint

-- 6. The agenda --------------------------------------------------------------------------------------------
CREATE VIEW public.agenda_items WITH (security_invoker = on) AS
WITH loc AS (
  SELECT l.id, (now() AT TIME ZONE l.timezone)::date AS today
    FROM public.locations l
   WHERE l.deleted_at IS NULL)
-- Schedules: due from the lead, overdue after the due point.
SELECT 'schedule'::text AS source_type, s.id AS source_id, s.location_id, s.thing_id,
       s.place_id, CASE WHEN n.state = 'overdue' THEN 'overdue' ELSE 'due' END AS kind,
       n.due_on, n.due_value, s.meter_id, n.state,
       CASE WHEN n.basis = 'units' OR n.due_on IS NULL THEN 'meter:' || n.due_value::text
            ELSE 'date:' || n.due_on::text END AS due_period,
       'schedules'::text AS module, s.name AS title
  FROM public.schedules s
  JOIN loc ON loc.id = s.location_id
  LEFT JOIN public.things t ON t.id = s.thing_id
  LEFT JOIN public.places p ON p.id = s.place_id
 CROSS JOIN LATERAL kept.schedule_point(s.every_months, s.every_units, s.due_on, s.anchor_on,
                                        s.anchor_value, s.snoozed_until, s.snoozed_until_value,
                                        s.skip_next, s.lead_days, s.lead_units, loc.today,
                                        kept.meter_latest(s.meter_id)) n
 WHERE s.active AND kept.module_on(s.location_id, 'schedules')
   AND (s.thing_id IS NULL OR (t.deleted_at IS NULL AND t.lifecycle = 'in_use'))
   AND (s.place_id IS NULL OR p.deleted_at IS NULL)
UNION ALL
-- Warranties: expiring from the lead to the last day covered (lifetime: none); expired after.
SELECT 'warranty', w.id, w.location_id, w.thing_id, NULL::uuid, 'expiring',
       w.effective_ends_on, NULL::numeric, NULL::uuid,
       CASE WHEN loc.today > w.effective_ends_on THEN 'expired'
            WHEN loc.today >= w.effective_ends_on - w.lead_days THEN 'expiring'
            ELSE 'upcoming' END,
       'date:' || w.effective_ends_on::text, 'warranties', w.provider
  FROM public.warranties w
  JOIN loc ON loc.id = w.location_id
  JOIN public.things t ON t.id = w.thing_id
 WHERE w.effective_ends_on IS NOT NULL AND kept.module_on(w.location_id, 'warranties')
   AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
UNION ALL
-- Registration (Q4: D55's warranty-registration deadline): due from 14 days before.
SELECT 'registration', w.id, w.location_id, w.thing_id, NULL::uuid, 'due',
       w.registration_deadline, NULL::numeric, NULL::uuid,
       CASE WHEN loc.today > w.registration_deadline THEN 'overdue'
            WHEN loc.today >= w.registration_deadline - 14 THEN 'due'
            ELSE 'upcoming' END,
       'date:' || w.registration_deadline::text, 'warranties', w.provider
  FROM public.warranties w
  JOIN loc ON loc.id = w.location_id
  JOIN public.things t ON t.id = w.thing_id
 WHERE NOT w.registered AND w.registration_deadline IS NOT NULL
   AND kept.module_on(w.location_id, 'warranties')
   AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
UNION ALL
-- Documents, current ones only: expiring from the lead, overdue after (an expired lease matters).
SELECT 'document', d.id, d.location_id, d.thing_id, d.place_id,
       CASE WHEN loc.today > d.expires_on THEN 'overdue' ELSE 'expiring' END,
       d.expires_on, NULL::numeric, NULL::uuid,
       CASE WHEN loc.today > d.expires_on THEN 'overdue'
            WHEN loc.today >= d.expires_on - d.lead_days THEN 'expiring'
            ELSE 'upcoming' END,
       'date:' || d.expires_on::text, 'paperwork', d.title
  FROM public.expiring_documents d
  JOIN loc ON loc.id = d.location_id
  LEFT JOIN public.things t ON t.id = d.thing_id
  LEFT JOIN public.places p ON p.id = d.place_id
 WHERE d.superseded_by_id IS NULL AND kept.module_on(d.location_id, 'paperwork')
   AND (d.thing_id IS NULL OR (t.deleted_at IS NULL AND t.lifecycle = 'in_use'))
   AND (d.place_id IS NULL OR p.deleted_at IS NULL)
UNION ALL
-- Loans out and in, open, with a due date: overdue from the day after (D56, D57).
SELECT 'loan', o.id, o.location_id, o.thing_id, NULL::uuid, 'overdue',
       o.due_on, NULL::numeric, NULL::uuid,
       CASE WHEN loc.today > o.due_on THEN 'overdue'
            WHEN loc.today >= o.due_on - o.lead_days THEN 'due'
            ELSE 'upcoming' END,
       'date:' || o.due_on::text, 'lending', NULL::text
  FROM public.loans o
  JOIN loc ON loc.id = o.location_id
  JOIN public.things t ON t.id = o.thing_id
 WHERE o.returned_at IS NULL AND o.due_on IS NOT NULL AND kept.module_on(o.location_id, 'lending')
   AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
UNION ALL
-- Thing expiries (D141): expiring from the thing's lead (30 days by default), overdue after.
SELECT 'thing_expiry', t.id, t.location_id, t.id, NULL::uuid,
       CASE WHEN loc.today > t.expires_on THEN 'overdue' ELSE 'expiring' END,
       t.expires_on, NULL::numeric, NULL::uuid,
       CASE WHEN loc.today > t.expires_on THEN 'overdue'
            WHEN loc.today >= t.expires_on - coalesce(t.expiry_lead_days, 30) THEN 'expiring'
            ELSE 'upcoming' END,
       'date:' || t.expires_on::text, 'schedules', NULL::text
  FROM public.things t
  JOIN loc ON loc.id = t.location_id
 WHERE t.expires_on IS NOT NULL AND kept.module_on(t.location_id, 'schedules')
   AND t.deleted_at IS NULL AND t.lifecycle = 'in_use';
--> statement-breakpoint
REVOKE ALL ON public.agenda_items FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT SELECT ON public.agenda_items TO kept_app, kept_system;
--> statement-breakpoint

-- 7. kept_system reads for the reminder scan (T14) ---------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations', 'location_modules', 'places', 'things', 'meters',
                           'meter_readings', 'schedules', 'warranties', 'loans',
                           'expiring_documents', 'people'] LOOP
    EXECUTE format(
      'CREATE POLICY system_select ON public.%I FOR SELECT TO kept_system USING (true)', t);
    EXECUTE format(
      'COMMENT ON POLICY system_select ON public.%I IS %L', t,
      'the reminder scan (T14) reads every location''s agenda');
  END LOOP;
END $$;
