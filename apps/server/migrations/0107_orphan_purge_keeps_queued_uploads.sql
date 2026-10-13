-- Custom SQL migration file, put your code below! --
-- The orphan purge deleted any unattached file older than a day. A phone uploads a capture's
-- files before it sends the capture's op, and a queue held back (an outdated server, D148; a
-- locked queue after a sign-out, D210) can send that op days later. The file was gone by then,
-- the op was dropped as target_missing, and the phone deleted its own copy: the photos were lost.
--   1. files.attached_at (0106) is set when a file is first attached, by a trigger on
--      attachments, and backfilled for every file attached now.
--   2. kept.purge_orphan_files() takes a second cut-off for files never attached: the worker
--      passes the sync op window (SYNC_LIMITS.clientIdPastDays), after which their op would be
--      refused anyway. A file attached once and let go (its thing purged) keeps the old cut-off.
-- A file let go before this migration has no attached_at and is kept for the longer window,
-- once. test/leak.test.ts and src/db/migrate.test.ts list both functions.

UPDATE public.files f SET attached_at = f.created_at
 WHERE f.attached_at IS NULL
   AND EXISTS (SELECT 1 FROM public.attachments a WHERE a.file_id = f.id);
--> statement-breakpoint
CREATE FUNCTION kept.note_file_attached() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.files f SET attached_at = now()
   WHERE f.id = NEW.file_id AND f.attached_at IS NULL;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.note_file_attached() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER attachments_note_file AFTER INSERT ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION kept.note_file_attached();
--> statement-breakpoint
DROP FUNCTION kept.purge_orphan_files(timestamptz, integer);
--> statement-breakpoint
CREATE FUNCTION kept.purge_orphan_files(p_older_than timestamptz,
                                        p_never_attached_before timestamptz, p_limit integer)
RETURNS TABLE (storage_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  ids uuid[];
  keys text[];
  held uuid[];
BEGIN
  IF p_older_than IS NULL OR p_never_attached_before IS NULL OR p_limit IS NULL
     OR p_limit < 1 THEN
    RAISE EXCEPTION 'purging needs both cut-offs and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 0056: files an undoable event still holds (a deleted document's, loan's, service's …).
  SELECT coalesce(array_agg(DISTINCT (q.v #>> '{}')::uuid), '{}'::uuid[]) INTO held
    FROM public.audit_events e, jsonb_path_query(e.diff, 'lax $.**.file_id') AS q(v)
   WHERE e.at > now() - interval '8 days' AND e.undoable_until > now()
     AND jsonb_typeof(q.v) = 'string'
     AND (q.v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  -- The first bound keeps the walk on files_unattached_idx (created_at, id); the second picks
  -- each file's own cut-off.
  SELECT coalesce(array_agg(v.id), '{}'::uuid[]) INTO ids
    FROM (SELECT f.id FROM public.files f
           WHERE f.created_at < greatest(p_older_than, p_never_attached_before)
             AND f.created_at < CASE WHEN f.attached_at IS NULL THEN p_never_attached_before
                                     ELSE p_older_than END
             AND NOT EXISTS (SELECT 1 FROM public.attachments a WHERE a.file_id = f.id)
             AND NOT f.id = ANY (held)
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
REVOKE EXECUTE ON FUNCTION kept.purge_orphan_files(timestamptz, timestamptz, integer)
  FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.purge_orphan_files(timestamptz, timestamptz, integer)
  TO kept_system;
