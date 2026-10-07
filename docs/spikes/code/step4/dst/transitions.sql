-- Step-4 spike T0 (V21): the same transitions from Postgres's tz data, and how it reads the
-- nonexistent and repeated wall times. psql -At -F ' | ' -f transitions.sql
WITH s AS (
  SELECT t, (t AT TIME ZONE 'Africa/Cairo') - (t AT TIME ZONE 'UTC') AS off
    FROM generate_series('2026-01-01 00:00+00'::timestamptz, '2027-01-01 00:00+00'::timestamptz, interval '1 minute') t),
d AS (SELECT t, off, lag(off) OVER (ORDER BY t) AS prev FROM s)
SELECT 'transition', t AT TIME ZONE 'UTC' AS utc_instant, prev, off,
       (t - interval '1 second') AT TIME ZONE 'Africa/Cairo' AS local_before,
       t AT TIME ZONE 'Africa/Cairo' AS local_at
  FROM d WHERE off IS DISTINCT FROM prev AND prev IS NOT NULL;
SELECT 'gap', ('2026-04-24 00:30'::timestamp AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'UTC';
SELECT 'overlap', ('2026-10-29 23:30'::timestamp AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'UTC';
SELECT 'today', x AT TIME ZONE 'UTC', (x AT TIME ZONE 'Africa/Cairo')::date
  FROM unnest(ARRAY['2026-04-23 21:59:59+00', '2026-04-23 22:00:00+00', '2026-10-29 20:59:59+00',
                    '2026-10-29 21:00:00+00', '2026-10-29 21:59:59+00', '2026-10-29 22:00:00+00']::timestamptz[]) x;
SELECT 'months', d, n, (d + make_interval(months => n))::date, (d + make_interval(months => n))::date - 1
  FROM (VALUES ('2026-01-31'::date, 1), ('2028-01-31'::date, 1), ('2026-01-31'::date, 2),
               ('2028-02-29'::date, 12), ('2026-10-01'::date, 24)) v(d, n);
