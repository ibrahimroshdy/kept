-- Custom SQL migration file, put your code below! --
-- Step 2, task 8: files and attachments, the secret store, saved views and hints (engineering
-- spec §1.5, §7.2, §7.3, §7.13; D42, D115, D116, D117, D138, D155, D157, D161, D177). The tables
-- are 0019's.
--   1. Files: readable only through an attachment the caller can see, or by their uploader
--      before they are attached (§7.2); never edited. Derivatives follow their file.
--   2. Attachments: location-scoped; a file id must be one the caller can see. The file foreign
--      key is DEFERRABLE for moves (task 9).
--   3. A thing's receipts after a move (D115): kept.thing_receipts(), kept.thing_receipt_file().
--   4. Secrets: versioned values readable only by who may reveal them; superseding works for a
--      writer who can't reveal; policies are the location owner's (D177).
--   5. Saved views and hints: the user's own; a shared view is readable in its location.
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['files', 'file_derivatives', 'attachments', 'secret_values',
                           'secret_field_policies', 'saved_views', 'user_hints'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE UPDATE ON public.files, public.file_derivatives, public.attachments, public.secret_values,
  public.secret_field_policies, public.saved_views, public.user_hints
  FROM kept_app, kept_system;
--> statement-breakpoint

-- 1. Files and derivatives ------------------------------------------------------------------
-- The EXISTS runs under attachments' own policies, so a file is readable only through an
-- attachment the caller can see (§7.2, D177), or as its own upload before it is attached.
CREATE POLICY app_select ON public.files FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids())
         AND (created_by = (SELECT kept.current_user_id())
              OR EXISTS (SELECT 1 FROM public.attachments a WHERE a.file_id = files.id)));
--> statement-breakpoint
CREATE POLICY app_insert ON public.files FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.files FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_select ON public.file_derivatives FOR SELECT TO kept_app
  USING (EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_derivatives.file_id));
--> statement-breakpoint
CREATE POLICY app_insert ON public.file_derivatives FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.file_derivatives FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint

-- 2. Attachments ----------------------------------------------------------------------------
-- DEFERRABLE, so a cross-location move can re-home a file row and its attachments in one
-- transaction (task 9, SET CONSTRAINTS attachments_file_fk DEFERRED).
ALTER TABLE public.attachments ADD CONSTRAINT attachments_file_fk FOREIGN KEY (location_id, file_id)
  REFERENCES public.files (location_id, id) ON UPDATE CASCADE ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
CREATE POLICY app_select ON public.attachments FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.attachments FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.attachments FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.attachments FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (role, sort, updated_at, row_version) ON public.attachments TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
-- A file id the caller can't see (someone else's unattached upload, or another tenant's, which
-- the composite foreign key would also refuse) is the same 42501 as one that doesn't exist.
CREATE FUNCTION kept.guard_attachment_file() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.files f WHERE f.id = NEW.file_id) THEN
    RAISE EXCEPTION 'no such file'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'attachments_file';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attachments_guard_file BEFORE INSERT ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION kept.guard_attachment_file();
--> statement-breakpoint

-- 3. Receipts after a move (§7.2, D115) ---------------------------------------------------------
-- The receipt and invoice attachments of a thing's purchase, for a thing the caller can see,
-- wherever the purchase is (a move within the account leaves it in the old location).
CREATE FUNCTION kept.thing_receipts(p_thing uuid)
RETURNS TABLE (attachment_id uuid, file_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.file_id, a.role
    FROM public.things t
    JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
    JOIN public.attachments a ON a.purchase_id = pl.purchase_id AND a.location_id = pl.location_id
   WHERE t.id = p_thing AND t.location_id IN (SELECT kept.visible_location_ids())
     AND a.role IN ('receipt', 'invoice') AND a.file_id IS NOT NULL
   ORDER BY a.sort, a.id
$$;
--> statement-breakpoint
-- One of those files, to serve (task 18's originals route): only a file attached as a receipt or
-- invoice to the purchase of a thing the caller can see. Nothing otherwise (a 404).
CREATE FUNCTION kept.thing_receipt_file(p_thing uuid, p_file uuid)
RETURNS TABLE (storage_key text, mime text, bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT f.storage_key, f.mime, f.bytes
    FROM public.files f
   WHERE f.id = p_file
     AND EXISTS (SELECT 1 FROM kept.thing_receipts(p_thing) r WHERE r.file_id = p_file)
$$;
--> statement-breakpoint

-- 4. Secrets (D116, D177, §7.13) ----------------------------------------------------------------
-- Whether the caller may reveal field `p_field` in `p_location`: by role (owners and admins
-- unless the location's policy says otherwise) or by name.
CREATE FUNCTION kept.can_reveal_secret(p_location uuid, p_field uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    LEFT JOIN public.secret_field_policies sp
           ON sp.location_id = m.location_id AND sp.type_field_id = p_field
     WHERE m.location_id = p_location AND m.user_id = kept.current_user_id()
       AND m.location_id IN (SELECT kept.visible_location_ids())
       AND (m.role = ANY (coalesce(sp.reveal_roles, ARRAY['owner', 'admin']))
            OR m.user_id = ANY (coalesce(sp.reveal_user_ids, '{}'::uuid[]))))
$$;
--> statement-breakpoint
-- Which secret fields are set on a thing or place the caller can see, without their values.
CREATE FUNCTION kept.secret_fields_set(p_thing uuid, p_place uuid)
RETURNS TABLE (type_field_id uuid, field_key text, updated_at timestamptz, can_reveal boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.type_field_id, s.field_key, s.created_at,
         kept.can_reveal_secret(s.location_id, s.type_field_id)
    FROM public.secret_values s
   WHERE s.superseded_at IS NULL
     AND s.location_id IN (SELECT kept.visible_location_ids())
     AND ((p_thing IS NOT NULL AND s.thing_id = p_thing)
          OR (p_place IS NOT NULL AND s.place_id = p_place))
   ORDER BY s.field_key
$$;
--> statement-breakpoint
-- The field is a secret one, of the location's account or built in, and the key is its own.
-- Invoker: a field the caller can't see is refused like one that doesn't exist (42501).
CREATE FUNCTION kept.guard_secret_field() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  tf record;
  acct uuid;
BEGIN
  SELECT f.owner_account_id, f.secret, f.key INTO tf
    FROM public.type_fields f WHERE f.id = NEW.type_field_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such secret field'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'secret_field';
  END IF;
  SELECT l.owner_account_id INTO acct FROM public.locations l WHERE l.id = NEW.location_id;
  IF NOT tf.secret OR (tf.owner_account_id IS NOT NULL AND tf.owner_account_id IS DISTINCT FROM acct)
  THEN
    RAISE EXCEPTION 'no such secret field'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'secret_field';
  END IF;
  IF TG_TABLE_NAME = 'secret_values' THEN
    IF NEW.field_key IS DISTINCT FROM tf.key THEN
      RAISE EXCEPTION 'a secret value''s key is its field''s'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'secret_values_field_key';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A new value supersedes the current one (history stays). A definer: a member may write a secret
-- they can't read back (the default policy reveals to owners and admins), so they can't see the
-- row to supersede. It runs before the insert's policy check, so it first refuses a scoped caller
-- the policy would refuse (the same 42501), and supersedes nothing for them. kept_owner's own
-- paths (no scope) supersede as they write.
CREATE FUNCTION kept.supersede_secret() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF kept.current_user_id() IS NOT NULL
     AND (NEW.updated_by IS DISTINCT FROM kept.current_user_id()
          OR NEW.location_id NOT IN (SELECT kept.writable_location_ids())) THEN
    RAISE EXCEPTION 'not a secret this user may write'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'secret_values_writer';
  END IF;
  UPDATE public.secret_values SET superseded_at = now()
   WHERE superseded_at IS NULL AND field_key = NEW.field_key
     AND thing_id IS NOT DISTINCT FROM NEW.thing_id AND place_id IS NOT DISTINCT FROM NEW.place_id
     AND location_id = NEW.location_id;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Trigger names order the BEFORE triggers: the guard, then the supersede.
CREATE TRIGGER secret_values_a_guard BEFORE INSERT ON public.secret_values
  FOR EACH ROW EXECUTE FUNCTION kept.guard_secret_field();
--> statement-breakpoint
CREATE TRIGGER secret_values_b_supersede BEFORE INSERT ON public.secret_values
  FOR EACH ROW EXECUTE FUNCTION kept.supersede_secret();
--> statement-breakpoint
CREATE TRIGGER secret_field_policies_guard BEFORE INSERT OR UPDATE ON public.secret_field_policies
  FOR EACH ROW EXECUTE FUNCTION kept.guard_secret_field();
--> statement-breakpoint
CREATE POLICY app_select ON public.secret_values FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids())
         AND kept.can_reveal_secret(location_id, type_field_id));
--> statement-breakpoint
CREATE POLICY app_insert ON public.secret_values FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND updated_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
-- Never updated or deleted through kept_app: history stays, and values go with their subject.
REVOKE DELETE ON public.secret_values FROM kept_app, kept_system;
--> statement-breakpoint
CREATE POLICY app_select ON public.secret_field_policies FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.secret_field_policies FOR INSERT TO kept_app
  WITH CHECK (kept.owns_location(location_id)
              AND location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_update ON public.secret_field_policies FOR UPDATE TO kept_app
  USING (kept.owns_location(location_id) AND location_id IN (SELECT kept.visible_location_ids()))
  WITH CHECK (kept.owns_location(location_id)
              AND location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.secret_field_policies FOR DELETE TO kept_app
  USING (kept.owns_location(location_id) AND location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
GRANT UPDATE (reveal_roles, reveal_user_ids, ai_allowed, updated_at, row_version)
  ON public.secret_field_policies TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.secret_field_policies
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- 5. Saved views and hints (D42, D138) --------------------------------------------------------
CREATE POLICY app_select ON public.saved_views FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
         OR (shared AND location_id IN (SELECT kept.visible_location_ids())));
--> statement-breakpoint
CREATE POLICY app_write ON public.saved_views FOR ALL TO kept_app
  USING (user_id = (SELECT kept.current_user_id()))
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids()))
              AND (NOT shared OR location_id IN (SELECT kept.writable_location_ids())));
--> statement-breakpoint
GRANT UPDATE (name, query, shared, updated_at, row_version) ON public.saved_views TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.saved_views
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE POLICY app_own ON public.user_hints FOR ALL TO kept_app
  USING (user_id = (SELECT kept.current_user_id()))
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
GRANT UPDATE (seen_at, dismissed) ON public.user_hints TO kept_app;
--> statement-breakpoint

-- Who may call what. Triggers: nobody (supersede_secret is a definer nobody may call directly).
REVOKE EXECUTE ON FUNCTION kept.guard_attachment_file(), kept.guard_secret_field(),
  kept.supersede_secret()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.thing_receipts(uuid), kept.thing_receipt_file(uuid, uuid),
  kept.can_reveal_secret(uuid, uuid), kept.secret_fields_set(uuid, uuid)
  FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.thing_receipts(uuid), kept.thing_receipt_file(uuid, uuid),
  kept.can_reveal_secret(uuid, uuid), kept.secret_fields_set(uuid, uuid)
  TO kept_app;
