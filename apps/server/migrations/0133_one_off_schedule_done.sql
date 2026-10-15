-- 1.x (D247): a one-off schedule is done once it is completed. Was: completing a one-off (a date,
-- no interval) recorded the service and re-anchored it, but a one-off's due point is its date, so
-- it stayed due (or overdue) on Home, the summary, the agenda and the calendar for good.
--   1. kept.schedule_done_on(s): the day a one-off was done, the latest confirmed service that
--      completes it (a draft counts nowhere, Q12); NULL while it isn't, and always NULL for a
--      repeating schedule. Derived, not stored: undoing or deleting the completing service, or
--      making the schedule repeat, brings it back with nothing else to keep in step. Invoker: the
--      caller's policies on service_records and service_completions, as last_service reads them.
--   2. kept.schedule_due(): 0100's, but a done one-off has state 'done' and no due point (its
--      `due_on` is still on the schedule). kept.schedule_point(), the twin of @kept/shared
--      scheduleNext(), is unchanged: it is the rule's point; done is history, not rule.
--   3. The agenda: 0104's view, every branch unchanged, but a done one-off is on no agenda, so the
--      reminder scan closes its occurrence as done (scan.ts step 3).
-- test/leak.test.ts and src/db/migrate.test.ts list the function; src/schedules/schedules.test.ts,
-- src/home/summary.test.ts and src/tools/household.test.ts test it.

-- 1. When a one-off was done ---------------------------------------------------------------------
CREATE FUNCTION kept.schedule_done_on(s public.schedules) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN s.every_months IS NULL AND s.every_units IS NULL THEN (
    SELECT max(r.serviced_on)
      FROM public.service_completions c
      JOIN public.service_records r ON r.id = c.service_record_id
     WHERE c.schedule_id = s.id AND r.review_state = 'confirmed') END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.schedule_done_on(public.schedules) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.schedule_done_on(public.schedules) TO kept_app, kept_system;
--> statement-breakpoint

-- 2. The due point: done, or 0100's ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION kept.schedule_due(s public.schedules, p_today date, p_now timestamptz)
RETURNS TABLE (due_on date, due_value numeric, state text, basis text, estimated_on date,
               estimated boolean)
LANGUAGE sql STABLE ROWS 1 AS $$
  WITH n AS MATERIALIZED (
    SELECT p.due_on, p.due_value, p.state, p.basis,
           s.snoozed_until IS NOT NULL OR s.snoozed_until_value IS NOT NULL AS snoozed
      FROM kept.schedule_point(s.every_months, s.every_units, s.due_on, s.anchor_on,
                               s.anchor_value, s.snoozed_until, s.snoozed_until_value,
                               s.skip_next, s.lead_days, s.lead_units, p_today,
                               -- kept.meter_latest(s.meter_id), inlined: a function call
                               -- per row cost more than the read (NULL with no meter).
                               CASE WHEN s.meter_id IS NOT NULL THEN (
                                 SELECT r.value + m."offset"
                                   FROM public.meter_readings r
                                   JOIN public.meters m ON m.id = r.meter_id
                                  WHERE r.meter_id = s.meter_id AND r.state = 'accepted'
                                  ORDER BY r.taken_at DESC, r.received_at DESC, r.id DESC
                                  LIMIT 1) END) p),
  e AS MATERIALIZED (
    SELECT n.*,
           CASE WHEN n.snoozed THEN 0 ELSE coalesce(s.lead_days, 14) END AS lead_days,
           x.eta
      FROM n
      LEFT JOIN LATERAL (
        SELECT a.eta
          FROM kept.meter_eta_at(s.meter_id,
                                 n.due_value - CASE WHEN n.snoozed THEN 0
                                                    ELSE coalesce(s.lead_units,
                                                                  trunc(s.every_units / 10, 12))
                                               END,
                                 p_now) a
         WHERE n.due_value IS NOT NULL AND s.meter_id IS NOT NULL) x ON true),
  -- A one-off has no meter, so no estimate: done, it is only the state and no due point.
  d AS MATERIALIZED (SELECT kept.schedule_done_on(s) IS NOT NULL AS done)
  SELECT CASE WHEN d.done THEN NULL ELSE e.due_on END,
         CASE WHEN d.done THEN NULL ELSE e.due_value END,
         CASE WHEN d.done THEN 'done'
              WHEN e.state = 'upcoming' AND p_today >= e.eta THEN 'due' ELSE e.state END,
         CASE WHEN e.state = 'upcoming' AND p_today >= e.eta THEN 'units' ELSE e.basis END,
         e.eta,
         coalesce(e.eta IS NOT NULL AND (e.due_on IS NULL OR e.eta < e.due_on - e.lead_days), false)
    FROM e, d
$$;
--> statement-breakpoint

-- 3. The agenda ----------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.agenda_items WITH (security_invoker = on) AS
WITH loc AS (
  SELECT l.id, l.timezone, (now() AT TIME ZONE l.timezone)::date AS today,
         kept.module_on(l.id, 'schedules') AS on_schedules,
         kept.module_on(l.id, 'warranties') AS on_warranties,
         kept.module_on(l.id, 'paperwork') AS on_paperwork,
         kept.module_on(l.id, 'vehicles') AS on_vehicles,
         kept.module_on(l.id, 'lending') AS on_lending,
         kept.module_on(l.id, 'consumables') AS on_consumables
    FROM public.locations l
   WHERE l.deleted_at IS NULL)
-- Schedules: due from the lead, or from the day the estimate reaches it; overdue after the due
-- point. A one-off that is done (step 2) is on no agenda.
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
 WHERE s.active AND loc.on_schedules AND n.state <> 'done'
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
 WHERE w.effective_ends_on IS NOT NULL AND loc.on_warranties
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
   AND loc.on_warranties
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
       CASE WHEN loc.on_paperwork THEN 'paperwork' ELSE 'vehicles' END,
       d.title, NULL::date, false
  FROM public.expiring_documents d
  JOIN loc ON loc.id = d.location_id
  LEFT JOIN public.things t ON t.id = d.thing_id
  LEFT JOIN public.places p ON p.id = d.place_id
 WHERE d.superseded_by_id IS NULL
   AND (loc.on_paperwork
        OR (t.id IS NOT NULL AND loc.on_vehicles AND kept.is_vehicle_type(t.type_id)))
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
 WHERE o.returned_at IS NULL AND o.due_on IS NOT NULL AND loc.on_lending
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
 WHERE t.expires_on IS NOT NULL AND loc.on_schedules
   AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
UNION ALL
-- Stale readings (step 5; D52, Q19): due from the latest accepted reading's local day plus the
-- meter's nudge_days, then rolled forward in steps of nudge_days to the last step on or before
-- today (0089), so a reading still not taken nudges again each period, under a new key
-- ('date:' || the step) that stays the same within the period; none before the first reading,
-- none with nudge_days NULL. Core: no module.
SELECT 'reading_stale', m.id, m.location_id, m.thing_id, NULL::uuid, 'due',
       p.due_on, NULL::numeric, m.id,
       CASE WHEN loc.today >= p.due_on THEN 'due' ELSE 'upcoming' END,
       'date:' || p.due_on::text, NULL::text, m.label, NULL::date, false
  FROM public.meters m
  JOIN loc ON loc.id = m.location_id
  JOIN public.things t ON t.id = m.thing_id
 CROSS JOIN LATERAL (
   SELECT (d.taken_at AT TIME ZONE loc.timezone)::date AS read_on
     FROM public.meter_readings d
    WHERE d.meter_id = m.id AND d.state = 'accepted'
    ORDER BY d.taken_at DESC LIMIT 1) r
 CROSS JOIN LATERAL (
   SELECT r.read_on
          + m.nudge_days * greatest(1, (loc.today - r.read_on) / m.nudge_days) AS due_on) p
 WHERE m.nudge_days IS NOT NULL AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'
UNION ALL
-- Low stock (step 7; D14, D29, D113): a live thing in use below its "keep at least" while
-- Consumables is on, due from the location's day it ran low (stock_rules.low_since) and keyed on
-- it, so each time it runs low reminds once; restocked, it leaves the agenda and the scan closes
-- the reminder.
SELECT 'stock', r.id, r.location_id, r.thing_id, NULL::uuid, 'due',
       r.low_since, NULL::numeric, NULL::uuid, 'due',
       'date:' || r.low_since::text, 'consumables', NULL::text, NULL::date, false
  FROM public.stock_rules r
  JOIN loc ON loc.id = r.location_id
  JOIN public.things t ON t.id = r.thing_id
 WHERE loc.on_consumables AND r.low_since IS NOT NULL AND t.quantity < r.min_quantity
   AND t.deleted_at IS NULL AND t.lifecycle = 'in_use';

--> statement-breakpoint
REVOKE ALL ON public.agenda_items FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT SELECT ON public.agenda_items TO kept_app, kept_system;
