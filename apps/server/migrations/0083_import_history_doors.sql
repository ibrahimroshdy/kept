-- Custom SQL migration file, put your code below! --
-- Step 7, task 5: carried history, adopted short IDs and `kept` legacy codes (engineering spec
-- §3.3, §7.5, §7.13; D45, D120; step-7 plan Q9, Q10). Above, in 0082, drizzle's part:
-- legacy_codes.source gains `kept` (src/db/schema/sync.ts). Below, the two doors a Kept import's
-- job (plan T14) takes, each for the run's own creator while it is running and they still
-- administer its location (else 42501):
--   1. kept.import_history(): the exported history, written as `actor_type = 'import'` events
--      (actor = the run) in the run's location, with the original actor's name kept in the diff
--      as `_importedActor` ("Alfred (before the import)"). kept_app can't write an import event
--      itself (0044's insert policy takes only `user`). Only within the two-year audit retention
--      (§3.3): older events are dropped, and the caller counts them (sent less written). Each
--      month present gets its partition first, so no past-dated row lands in
--      audit_events_default (0005); a month whose rows already sit there is refused by name, as
--      kept.ensure_audit_partitions() does. Creating a partition locks audit_events, so the job
--      calls this in a short transaction of its own, never inside a long chunk.
--   2. kept.adopt_short_code(): a printed label's code on its thing or place, or as a blank or
--      retired label, when the code is free on this server (labels are permanent, D45; codes are
--      unique on the instance, D120). It says only whether it was free, never where it is used
--      (accepted, Q9). The blank-label cap (0042) still applies.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-portability.ts
-- fills the rows; src/db/import-history.test.ts and adopt-codes.test.ts test them.

-- The caller's running Kept import, or 42501. Owner-only: the doors call it.
CREATE FUNCTION kept.import_run_mine(p_run uuid) RETURNS public.import_runs
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  r public.import_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.import_runs x WHERE x.id = p_run;
  IF r.id IS NULL OR r.created_by IS DISTINCT FROM kept.current_user_id()
     OR r.status <> 'running' OR r.source <> 'kept_zip' OR r.location_id IS NULL
     OR NOT coalesce(r.location_id IN (SELECT kept.admin_location_ids()), false) THEN
    RAISE EXCEPTION 'no such import running' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN r;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.import_run_mine(uuid) FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 1. Carried history ---------------------------------------------------------------------------
-- One change of an audit diff as stored (src/audit/audited.ts StoredChange): a plain or money
-- change with exactly its before and after, or a secret's `{changed: true}` and nothing else.
-- Owner-only.
CREATE FUNCTION kept.audit_change_ok(p_change jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_typeof(p_change) = 'object' AND CASE p_change->>'class'
    WHEN 'secret' THEN p_change = '{"changed": true, "class": "secret"}'::jsonb
    WHEN 'plain' THEN p_change ? 'before' AND p_change ? 'after'
                      AND (SELECT count(*) FROM jsonb_object_keys(p_change)) = 3
    WHEN 'money' THEN p_change ? 'before' AND p_change ? 'after'
                      AND (SELECT count(*) FROM jsonb_object_keys(p_change)) = 3
    ELSE false END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.audit_change_ok(jsonb) FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
-- p_events: [{at, action, entityType, entityId?, rootThingId?, subjects?: [uuid], diff?,
-- actorName?}], ids already remapped by the job; at most 5,000. Returns how many were written.
CREATE FUNCTION kept.import_history(p_run uuid, p_events jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.import_runs%ROWTYPE := kept.import_run_mine(p_run);
  acct uuid;
  cutoff timestamptz := now() - interval '2 years';
  ev jsonb;
  ev_at timestamptz;
  ev_id uuid;
  diff jsonb;
  month date;
  written integer := 0;
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) > 5000 THEN
    RAISE EXCEPTION 'history comes as an array of at most 5,000 events'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT l.owner_account_id INTO acct FROM public.locations l WHERE l.id = r.location_id;

  -- Check every event before writing any.
  FOR ev IN SELECT e FROM jsonb_array_elements(p_events) e LOOP
    IF jsonb_typeof(ev) IS DISTINCT FROM 'object'
       OR jsonb_typeof(ev->'at') IS DISTINCT FROM 'string'
       OR NOT coalesce(ev->>'action' ~ '^[a-z][a-z0-9_.]{0,63}$', false)
       OR NOT coalesce(ev->>'entityType' ~ '^[a-z][a-z0-9_]{0,39}$', false)
       OR coalesce(jsonb_typeof(ev->'actorName') NOT IN ('string', 'null'), false)
       OR char_length(ev->>'actorName') > 200
       OR coalesce(jsonb_typeof(ev->'subjects') NOT IN ('array', 'null'), false)
       OR jsonb_array_length(coalesce(ev->'subjects', '[]')) > 1000
       OR coalesce(jsonb_typeof(ev->'diff') NOT IN ('object', 'null'), false)
       OR EXISTS (SELECT 1 FROM jsonb_each(coalesce(ev->'diff', '{}')) d
                   WHERE d.key = '_importedActor' OR NOT kept.audit_change_ok(d.value)) THEN
      RAISE EXCEPTION 'an imported event is not one Kept writes'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Casts raise 22007 / 22P02 for a bad date or id.
    ev_at := (ev->>'at')::timestamptz;
    PERFORM (ev->>'entityId')::uuid, (ev->>'rootThingId')::uuid;
    PERFORM s::uuid FROM jsonb_array_elements_text(coalesce(ev->'subjects', '[]')) s;
    IF ev_at > now() THEN
      RAISE EXCEPTION 'an imported event can''t be in the future'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;

  -- Each month gets its partition first (0005), never the default.
  FOR month IN
    SELECT DISTINCT date_trunc('month', (e->>'at')::timestamptz AT TIME ZONE 'UTC')::date
      FROM jsonb_array_elements(p_events) e
     WHERE (e->>'at')::timestamptz >= cutoff
  LOOP
    CONTINUE WHEN to_regclass('public.audit_events_' || to_char(month, 'YYYY_MM')) IS NOT NULL;
    IF EXISTS (
      SELECT 1 FROM public.audit_events_default d
       WHERE d.at >= (month::text || ' 00:00:00+00')::timestamptz
         AND d.at < ((month + interval '1 month')::date::text || ' 00:00:00+00')::timestamptz
    ) THEN
      RAISE EXCEPTION 'audit_events_default holds rows for %; move them out before its partition can be created',
        to_char(month, 'YYYY-MM')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_events_default_has_rows';
    END IF;
    PERFORM kept.create_audit_partition(month);
  END LOOP;

  FOR ev IN SELECT e FROM jsonb_array_elements(p_events) e LOOP
    ev_at := date_trunc('milliseconds', (ev->>'at')::timestamptz);
    CONTINUE WHEN ev_at < cutoff;
    diff := coalesce(ev->'diff', '{}'::jsonb);
    IF ev->>'actorName' IS NOT NULL THEN
      diff := diff || jsonb_build_object('_importedActor', ev->>'actorName');
    END IF;
    INSERT INTO public.audit_events (at, location_id, owner_account_id, actor_type, actor_id,
                                     action, entity_type, entity_id, root_thing_id, diff)
    VALUES (ev_at, r.location_id, acct, 'import', r.id, ev->>'action', ev->>'entityType',
            (ev->>'entityId')::uuid, (ev->>'rootThingId')::uuid,
            CASE WHEN diff = '{}'::jsonb THEN NULL ELSE diff END)
    RETURNING id INTO ev_id;
    INSERT INTO public.audit_event_subjects (event_id, event_at, location_id, thing_id)
    SELECT DISTINCT ev_id, ev_at, r.location_id, s::uuid
      FROM jsonb_array_elements_text(coalesce(ev->'subjects', '[]')) s;
    written := written + 1;
  END LOOP;
  RETURN written;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.import_history(uuid, jsonb) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.import_history(uuid, jsonb) TO kept_app;
--> statement-breakpoint

-- 2. Adopted short IDs ---------------------------------------------------------------------------
-- `assigned`: on exactly one of a thing or place of the run's location, primary unless that one
-- already has a primary code; `blank`: on neither; `retired`: on at most one. True when adopted,
-- false when the code is taken anywhere on this server (the other row is left alone).
CREATE FUNCTION kept.adopt_short_code(p_run uuid, p_code character(6), p_state text,
                                      p_thing uuid, p_place uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.import_runs%ROWTYPE := kept.import_run_mine(p_run);
  n integer;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('assigned', 'blank', 'retired')
     OR (p_state = 'assigned' AND num_nonnulls(p_thing, p_place) <> 1)
     OR (p_state = 'blank' AND num_nonnulls(p_thing, p_place) <> 0)
     OR (p_state = 'retired' AND num_nonnulls(p_thing, p_place) > 1) THEN
    RAISE EXCEPTION 'a code is assigned to one thing or place, blank, or retired'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_thing IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.things t WHERE t.id = p_thing AND t.location_id = r.location_id))
     OR (p_place IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.places p WHERE p.id = p_place AND p.location_id = r.location_id)) THEN
    RAISE EXCEPTION 'no such thing or place in the import''s location'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.short_ids (code, location_id, thing_id, place_id, state, is_primary)
  VALUES (p_code, r.location_id, p_thing, p_place, p_state,
          p_state = 'assigned' AND NOT EXISTS (
            SELECT 1 FROM public.short_ids s
             WHERE s.state = 'assigned' AND s.is_primary
               AND ((p_thing IS NOT NULL AND s.thing_id = p_thing)
                    OR (p_place IS NOT NULL AND s.place_id = p_place))))
  ON CONFLICT (code) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.adopt_short_code(uuid, character, text, uuid, uuid)
  FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.adopt_short_code(uuid, character, text, uuid, uuid) TO kept_app;
