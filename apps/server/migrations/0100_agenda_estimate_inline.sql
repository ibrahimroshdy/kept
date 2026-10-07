-- Custom SQL migration file, put your code below! --
-- Step 5's carried-over perf fix (docs/perf/2026-10-06-step5.md; the agenda, Home and the
-- Vehicles list with vehicles): every result is 0053/0066's, only how it is computed changes.
-- Measured on the step-5 perf fixture (10,000 things, 700 schedules, 150 of them on a meter), a
-- read of public.agenda_items spent ~160 of its ~170 ms in the schedule branch: one
-- kept.schedule_due() per schedule, and inside it kept.meter_latest() for every schedule (a meter
-- or not) and kept.meter_eta() → kept.meter_estimate() for each unit schedule. All were SQL
-- functions with SET search_path, which Postgres never inlines, so each ran as its own plan with
-- its own GUC save and restore. And every set-returning one was costed at 1,000 rows a call, which
-- pushed the plans of the agenda's readers (Home, the agenda, the Vehicles list, a schedule's
-- view) past jit_above_cost: Postgres JIT-compiled them on every request, 0.3–3 s under load
-- (the server's half of the fix, src/db/pools.ts, turns JIT off for Kept's connections).
--   1. The invoker functions the agenda reads lose SET search_path (they name every table with
--      its schema; a definer keeps its pin, test/leak.test.ts), so the planner inlines the
--      set-returning ones into their callers, and are costed at one row (ROWS 1).
--   2. kept.meter_estimate() reads only what it uses, by the meter_readings (meter_id, taken_at)
--      index: the latest accepted reading at or before p_now, the count and the earliest of the
--      90 days before it; each of the two corrected by the latest replacement at or before it.
--      0066's read every accepted reading of the meter, each with its own replacement lookup.
--   3. kept.meter_eta_at(meter, value, now): 0066's meter_eta() as a one-row table, so a caller
--      can join it (inlined); kept.meter_eta() is now that row's date.
--   4. kept.schedule_due(): kept.meter_latest()'s read inlined, only for a schedule on a meter
--      (NULL otherwise, as it answered for a NULL meter), and the estimate through
--      kept.meter_eta_at(), joined
--      only for a unit due point; its steps are MATERIALIZED, so once inlined the ETA is still
--      computed once per schedule, not once per reference.
--   5. kept.schedule_next(), kept.schedule_point(): ROWS 1 (schedule_point is plpgsql and keeps
--      its pin; schedule_next loses it, so a schedule list's LATERAL call inlines too).
-- src/db/estimate.test.ts, src/db/schedules.test.ts, src/db/agenda.test.ts and
-- src/db/agenda-vehicles.test.ts hold the results; test/perf/vehicles.perf.test.ts and
-- test/perf/step4.perf.test.ts time them.

-- 2. The estimate --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kept.meter_estimate(p_meter uuid, p_now timestamptz DEFAULT now())
RETURNS TABLE (last_value numeric, last_taken_at timestamptz, per_day numeric, basis_days integer,
               age_days integer, advice text)
LANGUAGE sql STABLE ROWS 1 AS $$
  WITH m AS (
    SELECT m.id, l.timezone
      FROM public.meters m JOIN public.locations l ON l.id = m.location_id
     WHERE m.id = p_meter),
  latest AS (
    SELECT d.taken_at, d.received_at, d.id,
           d.value + coalesce((SELECT e."offset" FROM public.meter_events e
                                WHERE e.meter_id = d.meter_id AND e.kind = 'replaced'
                                  AND e.at <= d.taken_at
                                ORDER BY e.at DESC, e.id DESC LIMIT 1), 0) AS v
      FROM public.meter_readings d
     WHERE d.meter_id = p_meter AND d.state = 'accepted' AND d.taken_at <= p_now
     ORDER BY d.taken_at DESC, d.received_at DESC, d.id DESC
     LIMIT 1),
  win AS (
    SELECT count(*) AS n
      FROM latest, public.meter_readings d
     WHERE d.meter_id = p_meter AND d.state = 'accepted' AND d.taken_at <= p_now
       AND d.taken_at >= latest.taken_at - interval '90 days'),
  earliest AS (
    SELECT d.taken_at,
           d.value + coalesce((SELECT e."offset" FROM public.meter_events e
                                WHERE e.meter_id = d.meter_id AND e.kind = 'replaced'
                                  AND e.at <= d.taken_at
                                ORDER BY e.at DESC, e.id DESC LIMIT 1), 0) AS v
      FROM latest, public.meter_readings d
     WHERE d.meter_id = p_meter AND d.state = 'accepted' AND d.taken_at <= p_now
       AND d.taken_at >= latest.taken_at - interval '90 days'
     ORDER BY d.taken_at, d.received_at, d.id
     LIMIT 1),
  x AS (
    SELECT latest.v AS last_value, latest.taken_at AS last_taken_at,
           extract(epoch FROM latest.taken_at - earliest.taken_at) / 86400 AS span,
           latest.v - earliest.v AS rise,
           win.n,
           ((p_now AT TIME ZONE m.timezone)::date
             - (latest.taken_at AT TIME ZONE m.timezone)::date) AS age
      FROM m, latest, earliest, win)
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
ALTER FUNCTION kept.meter_estimate(uuid, timestamptz) RESET search_path;
--> statement-breakpoint

-- 3. The ETA ---------------------------------------------------------------------------------------
CREATE FUNCTION kept.meter_eta_at(p_meter uuid, p_value numeric, p_now timestamptz DEFAULT now())
RETURNS TABLE (eta date)
LANGUAGE sql STABLE ROWS 1 AS $$
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
CREATE OR REPLACE FUNCTION kept.meter_eta(p_meter uuid, p_value numeric,
                                          p_now timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT a.eta FROM kept.meter_eta_at(p_meter, p_value, p_now) a
$$;
--> statement-breakpoint
ALTER FUNCTION kept.meter_eta(uuid, numeric, timestamptz) RESET search_path;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.meter_eta_at(uuid, numeric, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.meter_eta_at(uuid, numeric, timestamptz) TO kept_app, kept_system;
--> statement-breakpoint

-- 1, 4. The latest reading and a schedule's due point -------------------------------------------------
CREATE OR REPLACE FUNCTION kept.meter_latest(p_meter uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT r.value + m.offset
    FROM public.meter_readings r JOIN public.meters m ON m.id = r.meter_id
   WHERE r.meter_id = p_meter AND r.state = 'accepted'
   ORDER BY r.taken_at DESC, r.received_at DESC, r.id DESC
   LIMIT 1
$$;
--> statement-breakpoint
ALTER FUNCTION kept.meter_latest(uuid) RESET search_path;
--> statement-breakpoint
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
         WHERE n.due_value IS NOT NULL AND s.meter_id IS NOT NULL) x ON true)
  SELECT e.due_on, e.due_value,
         CASE WHEN e.state = 'upcoming' AND p_today >= e.eta THEN 'due' ELSE e.state END,
         CASE WHEN e.state = 'upcoming' AND p_today >= e.eta THEN 'units' ELSE e.basis END,
         e.eta,
         coalesce(e.eta IS NOT NULL AND (e.due_on IS NULL OR e.eta < e.due_on - e.lead_days), false)
    FROM e
$$;
--> statement-breakpoint
ALTER FUNCTION kept.schedule_due(public.schedules, date, timestamptz) RESET search_path;
--> statement-breakpoint

-- 5. The callers' costing ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kept.schedule_next(p_schedule uuid, p_today date)
RETURNS TABLE (due_on date, due_value numeric, state text, basis text, estimated_on date,
               estimated boolean)
LANGUAGE sql STABLE ROWS 1 AS $$
  SELECT n.* FROM public.schedules s
   CROSS JOIN LATERAL kept.schedule_due(s, p_today, now()) n
   WHERE s.id = p_schedule
$$;
--> statement-breakpoint
ALTER FUNCTION kept.schedule_next(uuid, date) RESET search_path;
--> statement-breakpoint
ALTER FUNCTION kept.schedule_point(integer, numeric, date, date, numeric, date, numeric, boolean,
                                   integer, numeric, date, numeric) ROWS 1;
