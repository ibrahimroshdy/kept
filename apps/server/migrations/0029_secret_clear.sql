-- Custom SQL migration file, put your code below! --
-- Step 2, task 19: clearing a secret value (D110, D116; engineering spec §7.13).
--
-- DELETE /api/v1/{things|places}/:id/secrets/:fieldKey ends the current value of a field. The
-- value is superseded, never deleted: its history stays in the encrypted store, readable by who
-- may reveal it, and goes with its subject. kept_app has no UPDATE or DELETE on secret_values, and
-- a writer who can't reveal the value (a member, under the default policy) can't even see its
-- row, so the route asks this definer. The route has already found the subject and checked the
-- caller's role; this checks again from the caller's own identity, and refuses (42501, a 404)
-- a subject that isn't live or isn't in a location the caller may write, like one that doesn't
-- exist. It never reads or returns a value: only whether there was one to clear.
-- test/leak.test.ts and src/db/migrate.test.ts list it.

CREATE FUNCTION kept.clear_secret(p_thing uuid, p_place uuid, p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  loc uuid;
  n int;
BEGIN
  IF num_nonnulls(p_thing, p_place) <> 1 OR p_key IS NULL THEN
    RAISE EXCEPTION 'a thing or a place, and a field key' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_thing IS NOT NULL THEN
    SELECT t.location_id INTO loc FROM public.things t
     WHERE t.id = p_thing AND t.deleted_at IS NULL;
  ELSE
    SELECT p.location_id INTO loc FROM public.places p
     WHERE p.id = p_place AND p.deleted_at IS NULL;
  END IF;
  IF loc IS NULL OR kept.current_user_id() IS NULL
     OR loc NOT IN (SELECT kept.writable_location_ids()) THEN
    RAISE EXCEPTION 'not a secret this user may clear'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'secret_values_writer';
  END IF;
  UPDATE public.secret_values SET superseded_at = now()
   WHERE superseded_at IS NULL AND field_key = p_key AND location_id = loc
     AND thing_id IS NOT DISTINCT FROM p_thing AND place_id IS NOT DISTINCT FROM p_place;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.clear_secret(uuid, uuid, text) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.clear_secret(uuid, uuid, text) TO kept_app;
