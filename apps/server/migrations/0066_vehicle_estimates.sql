-- Custom SQL migration file, put your code below! --
-- Step 5, task 7: usage estimates, estimated due dates, the stale-reading nudge and vehicle types
-- (engineering spec §1.9, §3.4, §7.6; D26, D52, D113, D154, D188; plan Q2, Q8, Q19; step 4's
-- Q2, Q3, Q5). Nothing drizzle declares. Below:
--   1. kept.meter_estimate(meter, now): the meter's latest accepted reading (offset-corrected by
--      the latest replacement at or before each reading, as meters/check.ts compares them), its
--      rate over the 90 days before that reading (RATE_WINDOW_DAYS; 2 readings at least 7 days
--      apart, MIN_SPAN_DAYS), the reading's age in the location's own days, and the advice:
--      none · fresh · stale (30+, ADVICE_DAYS) · unknown (60+, UNKNOWN_DAYS: no rate, so estimated
--      dates disappear). @kept/shared vehicles.ts holds the same constants and readingAdvice().
--      Invoker: RLS decides which meters it sees; one it can't see gives no row.
--   2. kept.meter_eta(meter, value, now): the location's local date the meter is expected to
--      reach `value` at that rate; NULL with no rate, a rate of 0, a value already reached, or one
--      more than a century away.
--   3. Estimated due dates (step 4's Q2; D52): kept.schedule_due(schedule, today, now), the one
--      place a schedule's next due point is decided, is 0053's kept.schedule_point() plus the
--      estimate: `estimated_on` is when the meter is expected to reach the unit side's due-from
--      reading (due_value - lead_units, the plan's formula); from that day the schedule is due
--      ("whichever first": an estimate never makes it overdue, only a reading or a date does), and
--      `estimated` says the estimate is what brings it due first (earlier than the date side's
--      due-from day). @kept/shared scheduleNext() is its twin, given the ETA as `at.eta`.
--      kept.schedule_next() returns the two new columns (its return type changes, so it is made
--      again); the agenda's schedule rows carry them. due_period stays 'meter:<due_value>' for a
--      due point from the estimate, so the reminder's key doesn't move as the estimate does.
--   4. The `reading_stale` source (D52, D113; step 4's Q3): an agenda branch per meter with
--      nudge_days, on a live in-use thing, with an accepted reading: due from the latest reading's
--      local date + nudge_days, keyed 'date:<that day>'. No module: stale nudges are core.
--   5. kept.is_vehicle_type(type) (Q2): the type reaches the built-in `vehicle` through parent_id
--      or copied_from_id (a customised copy), at most 64 steps. kept.type_chain() follows parent_id
--      only, so this is its own walk.
--   6. Documents on vehicles (step 4's Q5): the agenda's document branch counts a document whose
--      thing is a vehicle while Paperwork or Vehicles is on; its `module` is 'paperwork' when
--      Paperwork is on, else 'vehicles' (what the scan and the feed check a person's hidden modules
--      against).
--   7. kept_system reads for the reminder scan: meter_events (the estimate's offsets) and types
--      (whether a document's thing is a vehicle), SELECT only, each commented.
-- The agenda view is otherwise 0053's, every clause kept. test/leak.test.ts and
-- src/db/migrate.test.ts list the functions; src/db/estimate.test.ts, src/db/vehicle-type.test.ts
-- and src/db/agenda-vehicles.test.ts test them, and src/db/schedules.test.ts twins the estimate.

-- 1. The estimate ------------------------------------------------------------------------------------
CREATE FUNCTION kept.meter_estimate(p_meter uuid, p_now timestamptz DEFAULT now())
RETURNS TABLE (last_value numeric, last_taken_at timestamptz, per_day numeric, basis_days integer,
               age_days integer, advice text)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH m AS (
    SELECT m.id, l.timezone
      FROM public.meters m JOIN public.locations l ON l.id = m.location_id
     WHERE m.id = p_meter),
  r AS (
    SELECT d.taken_at, d.received_at, d.id,
           d.value + coalesce((SELECT e."offset" FROM public.meter_events e
                                WHERE e.meter_id = d.meter_id AND e.kind = 'replaced'
                                  AND e.at <= d.taken_at
                                ORDER BY e.at DESC, e.id DESC LIMIT 1), 0) AS v
      FROM public.meter_readings d
     WHERE d.meter_id = p_meter AND d.state = 'accepted' AND d.taken_at <= p_now),
  latest AS (
    SELECT r.* FROM r ORDER BY r.taken_at DESC, r.received_at DESC, r.id DESC LIMIT 1),
  win AS (
    SELECT r.* FROM r, latest WHERE r.taken_at >= latest.taken_at - interval '90 days'),
  earliest AS (
    SELECT w.* FROM win w ORDER BY w.taken_at, w.received_at, w.id LIMIT 1),
  x AS (
    SELECT latest.v AS last_value, latest.taken_at AS last_taken_at,
           extract(epoch FROM latest.taken_at - earliest.taken_at) / 86400 AS span,
           latest.v - earliest.v AS rise,
           (SELECT count(*) FROM win) AS n,
           ((p_now AT TIME ZONE m.timezone)::date
             - (latest.taken_at AT TIME ZONE m.timezone)::date) AS age
      FROM m, latest, earliest)
  SELECT x.last_value, x.last_taken_at,
         CASE WHEN x.age < 60 AND x.n >= 2 AND x.span >= 7 THEN round(x.rise / x.span, 6) END,
         CASE WHEN x.n >= 2 THEN floor(x.span)::integer END,
         x.age,
         CASE WHEN x.last_taken_at IS NULL THEN 'none'
              WHEN x.age >= 60 THEN 'unknown'
              WHEN x.age >= 30 THEN 'stale'
              ELSE 'fresh' END
    FROM m LEFT JOIN x ON true
$$;
--> statement-breakpoint
CREATE FUNCTION kept.meter_eta(p_meter uuid, p_value numeric, p_now timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN e.per_day IS NULL OR e.per_day <= 0 OR p_value IS NULL
                   OR p_value <= e.last_value OR (p_value - e.last_value) / e.per_day > 36500
              THEN NULL
              ELSE ((e.last_taken_at
                     + make_interval(secs => ((p_value - e.last_value) / e.per_day * 86400)::float8))
                    AT TIME ZONE l.timezone)::date END
    FROM kept.meter_estimate(p_meter, p_now) e
    JOIN public.meters m ON m.id = p_meter
    JOIN public.locations l ON l.id = m.location_id
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.meter_estimate(uuid, timestamptz),
  kept.meter_eta(uuid, numeric, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.meter_estimate(uuid, timestamptz),
  kept.meter_eta(uuid, numeric, timestamptz)
  TO kept_app, kept_system;
--> statement-breakpoint

-- 3. Estimated due dates --------------------------------------------------------------------------------
-- 0053's schedule_point() on the schedule's rule, then the estimate. The unit side's lead is
-- schedule_point()'s: none while snoozed, else lead_units or 10% of the interval.
CREATE FUNCTION kept.schedule_due(s public.schedules, p_today date, p_now timestamptz)
RETURNS TABLE (due_on date, due_value numeric, state text, basis text, estimated_on date,
               estimated boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH n AS (
    SELECT p.due_on, p.due_value, p.state, p.basis,
           s.snoozed_until IS NOT NULL OR s.snoozed_until_value IS NOT NULL AS snoozed
      FROM kept.schedule_point(s.every_months, s.every_units, s.due_on, s.anchor_on,
                               s.anchor_value, s.snoozed_until, s.snoozed_until_value,
                               s.skip_next, s.lead_days, s.lead_units, p_today,
                               kept.meter_latest(s.meter_id)) p),
  e AS (
    SELECT n.*,
           CASE WHEN n.snoozed THEN 0 ELSE coalesce(s.lead_days, 14) END AS lead_days,
           CASE WHEN n.due_value IS NOT NULL AND s.meter_id IS NOT NULL
                THEN kept.meter_eta(s.meter_id,
                                    n.due_value - CASE WHEN n.snoozed THEN 0
                                                       ELSE coalesce(s.lead_units,
                                                                     trunc(s.every_units / 10, 12))
                                                  END,
                                    p_now) END AS eta
      FROM n)
  SELECT e.due_on, e.due_value,
         CASE WHEN e.state = 'upcoming' AND p_today >= e.eta THEN 'due' ELSE e.state END,
         CASE WHEN e.state = 'upcoming' AND p_today >= e.eta THEN 'units' ELSE e.basis END,
         e.eta,
         coalesce(e.eta IS NOT NULL AND (e.due_on IS NULL OR e.eta < e.due_on - e.lead_days), false)
    FROM e
$$;
--> statement-breakpoint
DROP FUNCTION kept.schedule_next(uuid, date);
--> statement-breakpoint
-- A schedule's next due point on `p_today`, estimated where the meter's rate is known.
CREATE FUNCTION kept.schedule_next(p_schedule uuid, p_today date)
RETURNS TABLE (due_on date, due_value numeric, state text, basis text, estimated_on date,
               estimated boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT n.* FROM public.schedules s
   CROSS JOIN LATERAL kept.schedule_due(s, p_today, now()) n
   WHERE s.id = p_schedule
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.schedule_due(public.schedules, date, timestamptz),
  kept.schedule_next(uuid, date)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.schedule_due(public.schedules, date, timestamptz),
  kept.schedule_next(uuid, date)
  TO kept_app, kept_system;
--> statement-breakpoint

-- 5. Vehicle types --------------------------------------------------------------------------------------
-- Invoker: the caller sees built-ins and its visible accounts' types.
CREATE FUNCTION kept.is_vehicle_type(p_type uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH RECURSIVE up(id, depth) AS (
    SELECT p_type, 0 WHERE p_type IS NOT NULL
    UNION
    SELECT x.next, up.depth + 1
      FROM up
      JOIN public.types t ON t.id = up.id
     CROSS JOIN LATERAL (VALUES (t.parent_id), (t.copied_from_id)) AS x(next)
     WHERE x.next IS NOT NULL AND up.depth < 64)
  SELECT EXISTS (SELECT 1 FROM up JOIN public.types t ON t.id = up.id
                  WHERE t.owner_account_id IS NULL AND t.builtin_key = 'vehicle')
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.is_vehicle_type(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.is_vehicle_type(uuid) TO kept_app, kept_system;
--> statement-breakpoint

-- 4, 6. The agenda ------------------------------------------------------------------------------------
-- 0053's, with the schedule branch through kept.schedule_due(), the document branch's vehicle
-- rule, the reading_stale branch, and estimated_on and estimated at the end.
CREATE OR REPLACE VIEW public.agenda_items WITH (security_invoker = on) AS
WITH loc AS (
  SELECT l.id, l.timezone, (now() AT TIME ZONE l.timezone)::date AS today
    FROM public.locations l
   WHERE l.deleted_at IS NULL)
-- Schedules: due from the lead, or from the day the estimate reaches it; overdue after the due
-- point.
SELECT 'schedule'::text AS source_type, s.id AS source_id, s.location_id, s.thing_id,
       s.place_id, CASE WHEN n.state = 'overdue' THEN 'overdue' ELSE 'due' END AS kind,
       n.due_on, n.due_value, s.meter_id, n.state,
       CASE WHEN n.basis = 'units' OR n.due_on IS NULL THEN 'meter:' || n.due_value::text
            ELSE 'date:' || n.due_on::text END AS due_period,
       'schedules'::text AS module, s.name AS title,
       n.estimated_on, n.estimated
  FROM public.schedules s
  JOIN loc ON loc.id = s.location_id
  LEFT JOIN public.things t ON t.id = s.thing_id
  LEFT JOIN public.places p ON p.id = s.place_id
 CROSS JOIN LATERAL kept.schedule_due(s, loc.today, now()) n
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
       'date:' || w.effective_ends_on::text, 'warranties', w.provider, NULL::date, false
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
       'date:' || w.registration_deadline::text, 'warranties', w.provider, NULL::date, false
  FROM public.warranties w
  JOIN loc ON loc.id = w.location_id
  JOIN public.things t ON t.id = w.thing_id
 WHERE NOT w.registered AND w.registration_deadline IS NOT NULL
   AND kept.module_on(w.location_id, 'warranties')
   AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
UNION ALL
-- Documents, current ones only: expiring from the lead, overdue after (an expired lease matters).
-- A vehicle's document also while Vehicles alone is on (step 5, step 4's Q5).
SELECT 'document', d.id, d.location_id, d.thing_id, d.place_id,
       CASE WHEN loc.today > d.expires_on THEN 'overdue' ELSE 'expiring' END,
       d.expires_on, NULL::numeric, NULL::uuid,
       CASE WHEN loc.today > d.expires_on THEN 'overdue'
            WHEN loc.today >= d.expires_on - d.lead_days THEN 'expiring'
            ELSE 'upcoming' END,
       'date:' || d.expires_on::text,
       CASE WHEN kept.module_on(d.location_id, 'paperwork') THEN 'paperwork' ELSE 'vehicles' END,
       d.title, NULL::date, false
  FROM public.expiring_documents d
  JOIN loc ON loc.id = d.location_id
  LEFT JOIN public.things t ON t.id = d.thing_id
  LEFT JOIN public.places p ON p.id = d.place_id
 WHERE d.superseded_by_id IS NULL
   AND (kept.module_on(d.location_id, 'paperwork')
        OR (t.id IS NOT NULL AND kept.module_on(d.location_id, 'vehicles')
            AND kept.is_vehicle_type(t.type_id)))
   AND (d.thing_id IS NULL OR (t.deleted_at IS NULL AND t.lifecycle = 'in_use'))
   AND (d.place_id IS NULL OR p.deleted_at IS NULL)
UNION ALL
-- Loans out and in, open, with a due date: overdue from the day after (D56, D57).
SELECT 'loan', o.id, o.location_id, o.thing_id, NULL::uuid, 'overdue',
       o.due_on, NULL::numeric, NULL::uuid,
       CASE WHEN loc.today > o.due_on THEN 'overdue'
            WHEN loc.today >= o.due_on - o.lead_days THEN 'due'
            ELSE 'upcoming' END,
       'date:' || o.due_on::text, 'lending', NULL::text, NULL::date, false
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
       'date:' || t.expires_on::text, 'schedules', NULL::text, NULL::date, false
  FROM public.things t
  JOIN loc ON loc.id = t.location_id
 WHERE t.expires_on IS NOT NULL AND kept.module_on(t.location_id, 'schedules')
   AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
UNION ALL
-- Stale readings (step 5; D52, Q19): due from the latest accepted reading's local day plus the
-- meter's nudge_days; none before the first reading, none with nudge_days NULL. Core: no module.
SELECT 'reading_stale', m.id, m.location_id, m.thing_id, NULL::uuid, 'due',
       r.due_on, NULL::numeric, m.id,
       CASE WHEN loc.today >= r.due_on THEN 'due' ELSE 'upcoming' END,
       'date:' || r.due_on::text, NULL::text, m.label, NULL::date, false
  FROM public.meters m
  JOIN loc ON loc.id = m.location_id
  JOIN public.things t ON t.id = m.thing_id
 CROSS JOIN LATERAL (
   SELECT (d.taken_at AT TIME ZONE loc.timezone)::date + m.nudge_days AS due_on
     FROM public.meter_readings d
    WHERE d.meter_id = m.id AND d.state = 'accepted'
    ORDER BY d.taken_at DESC LIMIT 1) r
 WHERE m.nudge_days IS NOT NULL AND t.deleted_at IS NULL AND t.lifecycle = 'in_use';
--> statement-breakpoint
REVOKE ALL ON public.agenda_items FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT SELECT ON public.agenda_items TO kept_app, kept_system;
--> statement-breakpoint

-- 7. kept_system reads for the reminder scan ---------------------------------------------------------
CREATE POLICY system_select ON public.meter_events FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.meter_events IS
  'the reminder scan (T14) estimates a unit schedule''s date from the meter''s offset-corrected readings';
--> statement-breakpoint
CREATE POLICY system_select ON public.types FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.types IS
  'the reminder scan (T14) reminds of a vehicle''s documents while Vehicles is on (kept.is_vehicle_type)';
