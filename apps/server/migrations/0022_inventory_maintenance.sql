-- Custom SQL migration file, put your code below! --
-- Step 2, task 10: the maintenance doors the reindex and purge jobs call (engineering spec §3.3,
-- §7.4, §7.9; D149, D161, D162; plan Q12). Each is SECURITY DEFINER and kept_system's alone:
-- the worker has no policy on any inventory table (SYSTEM_TABLES doesn't grow), and a job's data
-- is at most a location id, so reindexing or purging reads nothing out to its caller but counts
-- and storage keys. Blobs are deleted by the job after commit, from the keys these return.
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.

-- Recomputes the path and search caches of a location's live things (§7.9), after a place, a
-- container or a registry entry was renamed or moved. Setting the caches to NULL makes
-- kept.thing_cache() recompute them; touch_row sees only quiet columns, so no row_version bump.
-- Returns the things refreshed.
CREATE FUNCTION kept.reindex_location(p_location uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n integer;
BEGIN
  IF p_location IS NULL THEN
    RAISE EXCEPTION 'reindexing needs a location' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.things t SET place_path = NULL, search_tsv = NULL
   WHERE t.location_id = p_location AND t.deleted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint

-- Empties the trash (D162, §3.3): things trashed before `p_before`, innermost first (a box goes
-- once nothing is left inside it; something live inside a trashed box keeps the box), then
-- places trashed before `p_before` with nothing left under them. At most `p_limit` rows in all,
-- oldest first. Each deletion leaves a tombstone (§7.4); short IDs turn into retired codes
-- (kept.retire_orphan_code()); meters, readings, attachments, links, tags and secret values go
-- by cascade, and their files become unattached (kept.purge_orphan_files() takes those).
-- Returns the rows deleted.
CREATE FUNCTION kept.purge_trash(p_before timestamptz, p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n integer := 0;
  batch integer;
BEGIN
  IF p_before IS NULL OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'purging needs a cut-off and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  LOOP
    EXIT WHEN n >= p_limit;
    WITH victims AS (
      SELECT t.id FROM public.things t
       WHERE t.deleted_at < p_before
         AND NOT EXISTS (SELECT 1 FROM public.things c WHERE c.container_id = t.id)
       ORDER BY t.deleted_at, t.id
       LIMIT p_limit - n
       FOR UPDATE SKIP LOCKED
    ), gone AS (
      DELETE FROM public.things t USING victims v WHERE t.id = v.id
      RETURNING t.id, t.location_id
    )
    INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
    SELECT g.location_id, 'thing', g.id FROM gone g
    ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now();
    GET DIAGNOSTICS batch = ROW_COUNT;
    EXIT WHEN batch = 0;
    n := n + batch;
  END LOOP;
  LOOP
    EXIT WHEN n >= p_limit;
    WITH victims AS (
      SELECT p.id FROM public.places p
       WHERE p.deleted_at < p_before AND NOT p.is_unplaced
         AND NOT EXISTS (SELECT 1 FROM public.places c WHERE c.parent_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM public.things t WHERE t.place_id = p.id)
       ORDER BY p.deleted_at, p.id
       LIMIT p_limit - n
       FOR UPDATE SKIP LOCKED
    ), gone AS (
      DELETE FROM public.places p USING victims v WHERE p.id = v.id
      RETURNING p.id, p.location_id
    )
    INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
    SELECT g.location_id, 'place', g.id FROM gone g
    ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now();
    GET DIAGNOSTICS batch = ROW_COUNT;
    EXIT WHEN batch = 0;
    n := n + batch;
  END LOOP;
  RETURN n;
END $$;
--> statement-breakpoint

-- Deletes locations past their deletion grace period (D149): at most `p_limit`, oldest purge
-- date first. Everything in them goes by ON DELETE CASCADE (the tree's self-references are NO
-- ACTION, so one cascading delete succeeds, Q12); the deferred owner check skips a vanished
-- location. Short IDs stay, as retired codes keeping their location_id (§7.13). Returns one row
-- per purged location with the storage keys its files and derivatives held that nothing left
-- references (a cross-account copy may still share a blob, D161), for the job to delete after
-- commit. (The plan had an integer; without the keys those blobs would never be deleted.)
CREATE FUNCTION kept.purge_deleted_locations(p_limit integer)
RETURNS TABLE (location_id uuid, storage_keys text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  loc uuid;
  keys text[];
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'purging needs a positive limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR loc IN
    SELECT l.id FROM public.locations l
     WHERE l.purge_after < now()
     ORDER BY l.purge_after, l.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    SELECT coalesce(array_agg(DISTINCT k.storage_key), '{}'::text[]) INTO keys
      FROM (SELECT f.storage_key FROM public.files f WHERE f.location_id = loc
            UNION
            SELECT d.storage_key FROM public.file_derivatives d WHERE d.location_id = loc) k
     WHERE NOT EXISTS (SELECT 1 FROM public.files f
                        WHERE f.storage_key = k.storage_key AND f.location_id <> loc)
       AND NOT EXISTS (SELECT 1 FROM public.file_derivatives d
                        WHERE d.storage_key = k.storage_key AND d.location_id <> loc);
    DELETE FROM public.locations l WHERE l.id = loc;
    location_id := loc;
    storage_keys := keys;
    RETURN NEXT;
  END LOOP;
END $$;
--> statement-breakpoint

-- Deletes files no attachment holds, created before `p_older_than` (uploads never attached, and
-- files whose subjects were purged; D161, D162), at most `p_limit`, oldest first; derivatives go
-- by cascade. Returns the storage keys that no remaining file or derivative row references (a
-- blob shared by a cross-account copy stays while the copy exists), for the job to delete after
-- commit.
CREATE FUNCTION kept.purge_orphan_files(p_older_than timestamptz, p_limit integer)
RETURNS TABLE (storage_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  ids uuid[];
  keys text[];
BEGIN
  IF p_older_than IS NULL OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'purging needs a cut-off and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT coalesce(array_agg(v.id), '{}'::uuid[]) INTO ids
    FROM (SELECT f.id FROM public.files f
           WHERE f.created_at < p_older_than
             AND NOT EXISTS (SELECT 1 FROM public.attachments a WHERE a.file_id = f.id)
           ORDER BY f.created_at, f.id
           LIMIT p_limit
           FOR UPDATE SKIP LOCKED) v;
  SELECT coalesce(array_agg(DISTINCT k.storage_key), '{}'::text[]) INTO keys
    FROM (SELECT f.storage_key FROM public.files f WHERE f.id = ANY (ids)
          UNION
          SELECT d.storage_key FROM public.file_derivatives d WHERE d.file_id = ANY (ids)) k;
  DELETE FROM public.files f WHERE f.id = ANY (ids);
  RETURN QUERY
  SELECT k.key FROM unnest(keys) AS k(key)
   WHERE NOT EXISTS (SELECT 1 FROM public.files f WHERE f.storage_key = k.key)
     AND NOT EXISTS (SELECT 1 FROM public.file_derivatives d WHERE d.storage_key = k.key)
   ORDER BY 1;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.reindex_location(uuid), kept.purge_trash(timestamptz, integer),
  kept.purge_deleted_locations(integer), kept.purge_orphan_files(timestamptz, integer)
  FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.reindex_location(uuid), kept.purge_trash(timestamptz, integer),
  kept.purge_deleted_locations(integer), kept.purge_orphan_files(timestamptz, integer)
  TO kept_system;
