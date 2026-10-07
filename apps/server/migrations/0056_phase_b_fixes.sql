-- Custom SQL migration file, put your code below! --
-- Step 4, Phase B's schema gaps (the migration owner's, reported by T8, T10–T12, T14, T16, T18):
--   1. Exchange-rate history (T8): an account's admins write and read its account-level
--      `fx_rate` events, as they already do for the registries and templates (0044), so an admin
--      may set a rate, not only the owner.
--   2. Undo keeps who made a row (T10–T12, T18; D150, Q25). The undo route sets `app.undo` to the
--      id of the event it undoes, for its own transaction (audit/undo.ts). While that event is
--      undoable, not yet undone and in a location the caller writes:
--      - kept.undo_creator(location, row) names who made the row the event deleted (its
--        `created_by`/`logged_by` in the image, else the actor of the row's first event), or who
--        made a row its image held (an attachment: its own `created_by`, else the same person);
--        kept.undo_keep_creator() puts that person back on the re-inserted row, and each insert
--        policy accepts them as well as the caller;
--      - kept.undo_holds_file(attachment, file) says the event held that attachment of that
--        file, so kept.guard_attachment_file() lets the undo link it again even when the person
--        undoing can't see the file (not theirs, and nothing else holds it);
--      - the claims transition guard (0051) accepts that value as it accepted 'on'.
--   3. The orphan-file purge keeps a file an undoable event still holds (T10–T12): undo's window
--      is 7 days, the purge's 1, so undoing a deleted document, loan, service record or warranty
--      lost its files. Any `file_id` inside the diff of an event whose undo window is open keeps
--      its file.
--   4. The reminder jobs (T14, T16): kept_system reads user_hidden_modules (who hid a module),
--      service_records and service_completions (a schedule reminder is done when a service
--      completes it), and inserts a user's email channel row (kind 'email' only, Q13) instead of
--      acting as that user.
--   5. Merged parts (T10; D172, Q14): a part lent and returned merges back into the row it came
--      from with things.merged_into_id (a column grant now; kept.merge_things() already sets it),
--      held to a live thing of the same location by kept.guard_thing_merge(); a merged part leaves
--      the trash only by un-merging (undo clears merged_into_id in the same update; otherwise
--      23514 things_merged_restore, a 409); and deleting it (the 30-day trash purge) first moves
--      its closed loans to the row it joined (kept.keep_merged_loans()), so the loan history stays;
--      kept.touch_thing_state() (0051) no longer bumps the trashed part those loans leave.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; src/db/phase-b-fixes.test.ts
-- tests them.

-- 1. Exchange-rate history for admins ---------------------------------------------------------------
DROP POLICY app_select ON public.audit_events;
--> statement-breakpoint
CREATE POLICY app_select ON public.audit_events FOR SELECT TO kept_app
  USING (
    location_id IN (SELECT kept.visible_location_ids())
    OR (location_id IS NULL
        AND owner_account_id = (SELECT kept.current_owner_account_id()))
    OR (location_id IS NULL
        AND entity_type = ANY (ARRAY['type', 'type_field', 'place_kind', 'brand', 'vendor',
                                     'person', 'tag', 'template', 'fx_rate'])
        AND owner_account_id IN (SELECT kept.admin_account_ids()))
  );
--> statement-breakpoint
DROP POLICY app_insert ON public.audit_events;
--> statement-breakpoint
CREATE POLICY app_insert ON public.audit_events FOR INSERT TO kept_app
  WITH CHECK (
    actor_type = 'user'
    AND actor_id = (SELECT kept.current_user_id())
    AND (
      (location_id IN (SELECT kept.visible_location_ids())
       AND (owner_account_id IS NULL
            OR owner_account_id = (SELECT l.owner_account_id FROM public.locations l
                                    WHERE l.id = audit_events.location_id)))
      OR (location_id IS NULL
          AND owner_account_id = (SELECT kept.current_owner_account_id()))
      OR (location_id IS NULL AND owner_account_id IS NULL
          AND (SELECT kept.is_instance_admin()))
      OR (location_id IS NULL
          AND entity_type = ANY (ARRAY['type', 'type_field', 'place_kind', 'brand', 'vendor',
                                       'person', 'tag'])
          AND owner_account_id IN (SELECT kept.writable_account_ids()))
      OR (location_id IS NULL
          AND entity_type = ANY (ARRAY['template', 'fx_rate'])
          AND owner_account_id IN (SELECT kept.admin_account_ids()))
    )
  );
--> statement-breakpoint

-- 2. Undo keeps who made a row ------------------------------------------------------------------------
-- The event `app.undo` names, when the caller may be undoing it now; nothing otherwise.
CREATE FUNCTION kept.undo_event() RETURNS public.audit_events
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  v text := coalesce(current_setting('app.undo', true), '');
  e public.audit_events%ROWTYPE;
BEGIN
  IF v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO e FROM public.audit_events x
   WHERE x.id = v::uuid AND x.at > now() - interval '8 days'
     AND x.undoable_until > now() AND x.location_id IS NOT NULL
     AND x.location_id IN (SELECT kept.writable_location_ids())
     AND NOT EXISTS (SELECT 1 FROM public.audit_events u
                      WHERE u.undo_of = x.id AND u.location_id = x.location_id);
  IF e.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN e;
END $$;
--> statement-breakpoint
-- Who made `p_row`, as the undone event knows it: the deleted row itself, or a row its image held.
CREATE FUNCTION kept.undo_creator(p_location uuid, p_row uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  e public.audit_events%ROWTYPE := kept.undo_event();
  maker text;
  held jsonb;
BEGIN
  IF e.id IS NULL OR e.location_id <> p_location OR p_row IS NULL THEN
    RETURN NULL;
  END IF;
  maker := coalesce(e.diff -> 'created_by' ->> 'before', e.diff -> 'logged_by' ->> 'before');
  IF maker IS NULL THEN
    SELECT f.actor_id::text INTO maker FROM public.audit_events f
     WHERE f.location_id = p_location AND f.entity_id = e.entity_id AND f.actor_type = 'user'
     ORDER BY f.at, f.id LIMIT 1;
  END IF;
  IF p_row = e.entity_id THEN
    RETURN maker::uuid;
  END IF;
  SELECT q.v INTO held FROM jsonb_path_query(e.diff, 'lax $.**') AS q(v)
   WHERE jsonb_typeof(q.v) = 'object' AND q.v ->> 'id' = p_row::text LIMIT 1;
  IF held IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN coalesce(held ->> 'created_by', maker)::uuid;
END $$;
--> statement-breakpoint
-- Whether the undone event held attachment `p_attachment` of file `p_file`, a file that still
-- exists in the event's location.
CREATE FUNCTION kept.undo_holds_file(p_attachment uuid, p_file uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  e public.audit_events%ROWTYPE := kept.undo_event();
BEGIN
  IF e.id IS NULL OR p_attachment IS NULL OR p_file IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.files f
                  WHERE f.id = p_file AND f.location_id = e.location_id)
     AND EXISTS (SELECT 1 FROM jsonb_path_query(e.diff, 'lax $.**') AS q(v)
                  WHERE jsonb_typeof(q.v) = 'object' AND q.v ->> 'id' = p_attachment::text
                    AND q.v ->> 'file_id' = p_file::text);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.undo_event() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.undo_creator(uuid, uuid), kept.undo_holds_file(uuid, uuid)
  FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.undo_creator(uuid, uuid), kept.undo_holds_file(uuid, uuid)
  TO kept_app;
--> statement-breakpoint
-- The re-inserted row's maker, when the undo knows them; otherwise the row is left as written.
CREATE FUNCTION kept.undo_keep_creator() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  maker uuid;
  col text := CASE TG_TABLE_NAME WHEN 'service_records' THEN 'logged_by' ELSE 'created_by' END;
BEGIN
  IF coalesce(current_setting('app.undo', true), '') !~ '^[0-9a-f-]{36}$' THEN
    RETURN NEW;
  END IF;
  maker := kept.undo_creator(NEW.location_id, NEW.id);
  IF maker IS NOT NULL THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(col, maker));
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.undo_keep_creator() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['expiring_documents', 'warranties', 'claims', 'valuations',
                           'service_records', 'loans', 'schedules', 'incidents',
                           'attachments'] LOOP
    EXECUTE format('CREATE TRIGGER undo_keep_creator BEFORE INSERT ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION kept.undo_keep_creator()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['expiring_documents', 'warranties', 'claims', 'valuations', 'loans',
                           'schedules', 'attachments'] LOOP
    EXECUTE format($p$
      ALTER POLICY app_insert ON public.%I
        WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
                    AND (created_by = (SELECT kept.current_user_id())
                         OR created_by = kept.undo_creator(location_id, id)))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER POLICY app_insert ON public.incidents
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND (created_by = (SELECT kept.current_user_id())
                   OR created_by = kept.undo_creator(location_id, id)));
--> statement-breakpoint
ALTER POLICY app_insert ON public.service_records
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND (logged_by = (SELECT kept.current_user_id())
                   OR logged_by = kept.undo_creator(location_id, id)));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.guard_attachment_file() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.file_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.files f WHERE f.id = NEW.file_id) THEN
    IF NOT kept.undo_holds_file(NEW.id, NEW.file_id) THEN
      RAISE EXCEPTION 'no such file'
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'attachments_file';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.guard_claim_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user = 'kept_owner'
     OR coalesce(current_setting('app.undo', true), '') NOT IN ('', 'off')
     OR (OLD.status = 'open' AND NEW.status IN ('in_repair', 'resolved', 'rejected'))
     OR (OLD.status = 'in_repair' AND NEW.status IN ('resolved', 'rejected', 'open')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a claim can''t go from % to %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation', CONSTRAINT = 'claims_transition';
END $$;
--> statement-breakpoint

-- 3. The orphan-file purge waits out the undo window -------------------------------------------------
CREATE OR REPLACE FUNCTION kept.purge_orphan_files(p_older_than timestamptz, p_limit integer)
RETURNS TABLE (storage_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  ids uuid[];
  keys text[];
  held uuid[];
BEGIN
  IF p_older_than IS NULL OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'purging needs a cut-off and a positive limit'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 0056: files an undoable event still holds (a deleted document's, loan's, service's …).
  SELECT coalesce(array_agg(DISTINCT (q.v #>> '{}')::uuid), '{}'::uuid[]) INTO held
    FROM public.audit_events e, jsonb_path_query(e.diff, 'lax $.**.file_id') AS q(v)
   WHERE e.at > now() - interval '8 days' AND e.undoable_until > now()
     AND jsonb_typeof(q.v) = 'string'
     AND (q.v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  SELECT coalesce(array_agg(v.id), '{}'::uuid[]) INTO ids
    FROM (SELECT f.id FROM public.files f
           WHERE f.created_at < p_older_than
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

-- 4. The reminder jobs' reads and the lazy email channel -----------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_hidden_modules', 'service_records', 'service_completions'] LOOP
    EXECUTE format(
      'CREATE POLICY system_select ON public.%I FOR SELECT TO kept_system USING (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.user_hidden_modules IS
  'the reminder scan (T14) leaves out whoever hid the source''s module there';
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.service_records IS
  'the reminder scan (T14) closes a schedule''s reminder when a service completes it';
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.service_completions IS
  'the reminder scan (T14) closes a schedule''s reminder when a service completes it';
--> statement-breakpoint
CREATE POLICY system_insert ON public.notification_channels FOR INSERT TO kept_system
  WITH CHECK (kind = 'email' AND config_ciphertext IS NULL AND key_version IS NULL
              AND label IS NULL AND display_host IS NULL);
--> statement-breakpoint
COMMENT ON POLICY system_insert ON public.notification_channels IS
  'the reminder scan (T14) makes a user''s email channel row when it first mails them (Q13)';
--> statement-breakpoint

-- 5. Merged parts ------------------------------------------------------------------------------------
GRANT UPDATE (merged_into_id) ON public.things TO kept_app;
--> statement-breakpoint
-- Invoker: the row joined is one the caller sees (the same location).
CREATE FUNCTION kept.guard_thing_merge() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.merged_into_id IS NOT NULL
     AND NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    IF NEW.deleted_at IS NULL OR NEW.merged_into_id = NEW.id
       OR NOT EXISTS (SELECT 1 FROM public.things t
                       WHERE t.id = NEW.merged_into_id AND t.location_id = NEW.location_id
                         AND t.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'a merged thing is in the trash, joined to a live thing of its location'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'things_merged_into';
    END IF;
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'a merged thing comes back only by undoing its merge'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_merged_restore';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER things_guard_merge BEFORE UPDATE OF merged_into_id, deleted_at ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.guard_thing_merge();
--> statement-breakpoint
-- A merged part's closed loans move to the row it joined before it goes, so its purge keeps the
-- loan history (D56). A definer: the purge is kept_system's door, and a loan's thing_id has no
-- grant.
CREATE FUNCTION kept.keep_merged_loans() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.loans o
     SET thing_id = OLD.merged_into_id,
         split_from_thing_id = CASE WHEN o.split_from_thing_id = OLD.merged_into_id THEN NULL
                                    ELSE o.split_from_thing_id END
   WHERE o.thing_id = OLD.id AND o.returned_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.things t
                  WHERE t.id = OLD.merged_into_id AND t.location_id = OLD.location_id);
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER things_keep_merged_loans BEFORE DELETE ON public.things
  FOR EACH ROW WHEN (OLD.merged_into_id IS NOT NULL)
  EXECUTE FUNCTION kept.keep_merged_loans();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_thing_merge(), kept.keep_merged_loans()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
-- 0051's bump, less the thing a loan left when that thing is in the trash: moving a merged part's
-- loans happens as the part is deleted, and bumping the row being deleted would fail the delete.
CREATE OR REPLACE FUNCTION kept.touch_thing_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.things t SET state_version = t.state_version + 1 WHERE t.id = OLD.thing_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.thing_id IS DISTINCT FROM NEW.thing_id THEN
    UPDATE public.things t SET state_version = t.state_version + 1
     WHERE t.id = NEW.thing_id OR (t.id = OLD.thing_id AND t.deleted_at IS NULL);
  ELSE
    UPDATE public.things t SET state_version = t.state_version + 1 WHERE t.id = NEW.thing_id;
  END IF;
  RETURN NULL;
END $$;
