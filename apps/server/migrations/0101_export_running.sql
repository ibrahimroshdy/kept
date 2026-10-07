-- Custom SQL migration file, put your code below! --
-- Step 7 (T12, Q7): "one export running per location" sees everyone's runs. export_runs are their
-- creator's alone under the policies (D180), so the route's check saw only the caller's own: two
-- admins could export the same location at once. kept.export_running(location) answers whether
-- any Kept export of it (`location` or `me`) is queued or running and not abandoned (the purge
-- fails a run three hours after it began), for an owner or admin of the location only; it says
-- nothing else about the run. The route still takes its advisory lock first
-- (src/exports/service.ts). test/leak.test.ts and src/db/migrate.test.ts list it;
-- src/exports/exports.test.ts tests it.
CREATE FUNCTION kept.export_running(p_location uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT coalesce(p_location IN (SELECT kept.admin_location_ids()), false) THEN
    RAISE EXCEPTION 'not a location you administer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.export_runs x
     WHERE x.location_id = p_location AND x.kind IN ('location', 'me')
       AND x.status IN ('queued', 'running')
       AND coalesce(x.started_at, x.created_at) > now() - interval '3 hours');
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.export_running(uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.export_running(uuid) TO kept_app;
