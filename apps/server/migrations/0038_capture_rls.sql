-- Custom SQL migration file, put your code below! --
-- Step 3, task 5: capture records (engineering spec §1.5, §1.8, §1.10, §7.2, §7.8, §7.13; D18,
-- D36, D73, D76, D77, D177; plan Q10, Q14, Q15, Q17, Q18). Above, in 0037, drizzle's part:
-- extractions, inbox_items, templates, template_locations, file_text, import_runs and
-- import_source_ids (src/db/schema/capture.ts, imports.ts), attachments' UNIQUE (location_id, id)
-- and draft purchases without a date. Below:
--   1. Row-level security on every new table (owner_all, kept_app policies on USING and WITH
--      CHECK, UPDATE only through column grants), and touch_row on the mutable ones:
--      - extractions: read if visible, queued and updated by writers (requested_by = me).
--      - inbox_items: members and above only (writable locations, screens §5); created_by = me.
--        No DELETE: an item goes with its subject, or is resolved and pruned.
--      - templates: an account's admins manage them; members use one shared with their location.
--        Editing or deleting needs admin of every location it is shared with (D177, Q17).
--      - template_locations: admins of the location share and unshare; guarded to the
--        template's own account.
--      - file_text: follows its file (§7.2); written by writers, never updated.
--      - import_runs, import_source_ids: owners and admins only (§7.1).
--   2. The guards: a template's location and type belong to its account (or the type is built in).
--   3. kept.prune_stale_rows() also removes inbox items resolved more than 90 days ago (Q15).
--   4. kept.search_file_ids(): document search on file_text's GIN index. `@@` is not leakproof,
--      so under the policy the index is never used (engineering spec §7.2, the RLS benchmark);
--      the door runs the match as kept_owner and applies the caller's file visibility itself.
--      It returns file ids only; the route reads the rows through the policies and never shows a
--      receipt's text to someone without the money gate (T21).
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-capture.ts fills the
-- tables.

-- 1. Row-level security ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['extractions', 'inbox_items', 'templates', 'template_locations',
                           'file_text', 'import_runs', 'import_source_ids'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE ON public.%I FROM kept_app, kept_system', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['extractions', 'inbox_items', 'templates', 'import_runs'] LOOP
    EXECUTE format('CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION kept.touch_row()', t);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE DELETE ON public.extractions, public.inbox_items, public.template_locations,
  public.import_runs, public.import_source_ids FROM kept_system;
--> statement-breakpoint
REVOKE DELETE ON public.extractions, public.inbox_items, public.import_runs,
  public.import_source_ids FROM kept_app;
--> statement-breakpoint
REVOKE DELETE ON public.templates, public.file_text FROM kept_system;
--> statement-breakpoint

-- extractions
CREATE POLICY app_select ON public.extractions FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.extractions FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND requested_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.extractions FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (thing_id, purchase_id, meter_id, status, status_reason, paused_until, llm_call_id,
              result, applied, updated_at, row_version) ON public.extractions TO kept_app;
--> statement-breakpoint

-- inbox_items
CREATE POLICY app_select ON public.inbox_items FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.inbox_items FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.inbox_items FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (payload, resolved_at, resolved_by, resolution, updated_at, row_version)
  ON public.inbox_items TO kept_app;
--> statement-breakpoint

-- templates and where they are shared. template_locations' own policy reads no other table, so
-- the templates policy's EXISTS on it never recurses.
CREATE POLICY app_select ON public.template_locations FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids())
         OR owner_account_id IN (SELECT kept.admin_account_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.template_locations FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND owner_account_id IN (SELECT kept.admin_account_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.template_locations FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_select ON public.templates FOR SELECT TO kept_app
  USING (owner_account_id IN (SELECT kept.admin_account_ids())
         OR EXISTS (SELECT 1 FROM public.template_locations tl
                     WHERE tl.template_id = templates.id
                       AND tl.location_id IN (SELECT kept.writable_location_ids())));
--> statement-breakpoint
CREATE POLICY app_insert ON public.templates FOR INSERT TO kept_app
  WITH CHECK (owner_account_id IN (SELECT kept.admin_account_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
-- D177: only someone who administers every location a template is shared with changes it.
CREATE POLICY app_update ON public.templates FOR UPDATE TO kept_app
  USING (owner_account_id IN (SELECT kept.admin_account_ids())
         AND NOT EXISTS (SELECT 1 FROM public.template_locations tl
                          WHERE tl.template_id = templates.id
                            AND tl.location_id NOT IN (SELECT kept.admin_location_ids())))
  WITH CHECK (owner_account_id IN (SELECT kept.admin_account_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.templates FOR DELETE TO kept_app
  USING (owner_account_id IN (SELECT kept.admin_account_ids())
         AND NOT EXISTS (SELECT 1 FROM public.template_locations tl
                          WHERE tl.template_id = templates.id
                            AND tl.location_id NOT IN (SELECT kept.admin_location_ids())));
--> statement-breakpoint
GRANT UPDATE (name, type_id, payload, archived_at, updated_at, row_version)
  ON public.templates TO kept_app;
--> statement-breakpoint

-- file_text: follows its file.
CREATE POLICY app_select ON public.file_text FOR SELECT TO kept_app
  USING (EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_text.file_id));
--> statement-breakpoint
CREATE POLICY app_insert ON public.file_text FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_text.file_id));
--> statement-breakpoint
CREATE POLICY app_delete ON public.file_text FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint

-- imports: owners and admins.
CREATE POLICY app_select ON public.import_runs FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.import_runs FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.import_runs FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
GRANT UPDATE (status, mapping, choices, rows, dry_run_report, progress, total, started_at,
              finished_at, error, updated_at, row_version) ON public.import_runs TO kept_app;
--> statement-breakpoint
CREATE POLICY app_select ON public.import_source_ids FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.import_source_ids FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint

-- 2. Guards (invoker: the writer is an admin of the account, so sees what it names) ----------------
CREATE FUNCTION kept.guard_template_location() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.locations l
                  WHERE l.id = NEW.location_id AND l.owner_account_id = NEW.owner_account_id) THEN
    RAISE EXCEPTION 'a template is shared only into its own account''s locations'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'template_locations_account';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.guard_template_type() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.type_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.types ty
        WHERE ty.id = NEW.type_id
          AND (ty.owner_account_id IS NULL OR ty.owner_account_id = NEW.owner_account_id)) THEN
    RAISE EXCEPTION 'no such type' USING ERRCODE = 'insufficient_privilege',
      CONSTRAINT = 'templates_type_account';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_template_location(), kept.guard_template_type()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER template_locations_account BEFORE INSERT ON public.template_locations
  FOR EACH ROW EXECUTE FUNCTION kept.guard_template_location();
--> statement-breakpoint
CREATE TRIGGER templates_type BEFORE INSERT OR UPDATE OF type_id ON public.templates
  FOR EACH ROW EXECUTE FUNCTION kept.guard_template_type();
--> statement-breakpoint

-- 3. The nightly prune: every clause of 0036's, and resolved inbox items past 90 days -------------
CREATE OR REPLACE FUNCTION kept.prune_stale_rows()
RETURNS TABLE (what text, removed bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM auth.sign_in_failures f
   WHERE greatest(f.window_start, f.last_failure_at) < now() - interval '25 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'auth.sign_in_failures'; removed := n; RETURN NEXT;

  DELETE FROM auth.session_mfa m USING auth.session s
   WHERE s.id = m.session_id AND s.expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'auth.session_mfa'; removed := n; RETURN NEXT;

  DELETE FROM public.idempotency_keys k WHERE k.created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'idempotency_keys'; removed := n; RETURN NEXT;

  DELETE FROM public.sync_ops o WHERE o.received_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'sync_ops'; removed := n; RETURN NEXT;

  DELETE FROM public.inbox_items i WHERE i.resolved_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'inbox_items'; removed := n; RETURN NEXT;
END $$;
--> statement-breakpoint

-- 4. Document search on its index --------------------------------------------------------------------
CREATE FUNCTION kept.search_file_ids(p_tsq tsquery, p_location uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT x.file_id FROM public.file_text x
    JOIN public.files f ON f.id = x.file_id
   WHERE p_tsq IS NOT NULL AND x.tsv @@ p_tsq
     AND kept.current_user_id() IS NOT NULL
     AND f.location_id IN (SELECT kept.visible_location_ids())
     AND (p_location IS NULL OR f.location_id = p_location)
     AND (f.created_by = kept.current_user_id()
          OR EXISTS (SELECT 1 FROM public.attachments a
                      WHERE a.file_id = f.id
                        AND a.location_id IN (SELECT kept.visible_location_ids())))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.search_file_ids(tsquery, uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.search_file_ids(tsquery, uuid) TO kept_app;
