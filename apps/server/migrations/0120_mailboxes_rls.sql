-- 1.4, D231: email-in, a location's IMAP mailbox (0119's tables).
--   1. mailboxes: its location's owners and admins read, add, change and remove it
--      (location.settings). kept_app never reads the sealed connection; the `mail-in` job
--      (kept_system) reads every mailbox, records how far it has read, and opens the connection
--      through kept.mailbox_config().
--   2. mailbox_messages: the location's admins read them (the page's recent mail); only the
--      `mail-in` job writes them, and removes those past 90 days.
-- src/mailin/mailin.test.ts tests them.

-- 1. mailboxes ----------------------------------------------------------------------------------------------
ALTER TABLE public.mailboxes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mailboxes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.mailboxes FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.mailboxes
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE POLICY app_select ON public.mailboxes FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.mailboxes FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.mailboxes FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.mailboxes FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY system_select ON public.mailboxes FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.mailboxes IS
  'the mail-in job (1.4, D231) finds the mailboxes due a poll';
--> statement-breakpoint
CREATE POLICY system_update ON public.mailboxes FOR UPDATE TO kept_system USING (true)
  WITH CHECK (true);
--> statement-breakpoint
COMMENT ON POLICY system_update ON public.mailboxes IS
  'the mail-in job (1.4, D231) records how far it read, its last error, and turns a mailbox off';
--> statement-breakpoint
REVOKE SELECT, UPDATE ON public.mailboxes FROM kept_app, kept_system;
--> statement-breakpoint
REVOKE INSERT, DELETE ON public.mailboxes FROM kept_system;
--> statement-breakpoint
-- Every column but the sealed connection.
GRANT SELECT (id, location_id, kind, host, username, folder, allowed_senders, key_version, active,
              disabled_reason, uid_validity, last_uid, last_polled_at, last_error, created_by,
              created_at, updated_at, row_version, change_seq)
  ON public.mailboxes TO kept_app, kept_system;
--> statement-breakpoint
-- Not granted: the id, location_id, kind and created_by.
GRANT UPDATE (host, username, folder, allowed_senders, config_ciphertext, key_version, active,
              disabled_reason, uid_validity, last_uid, last_polled_at, last_error, updated_at,
              row_version)
  ON public.mailboxes TO kept_app;
--> statement-breakpoint
GRANT UPDATE (active, disabled_reason, uid_validity, last_uid, last_polled_at, last_error,
              updated_at, row_version)
  ON public.mailboxes TO kept_system;
--> statement-breakpoint

-- 2. mailbox_messages ---------------------------------------------------------------------------------------
ALTER TABLE public.mailbox_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mailbox_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.mailbox_messages FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_select ON public.mailbox_messages FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.mailbox_messages FROM kept_app;
--> statement-breakpoint
CREATE POLICY system_select ON public.mailbox_messages FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.mailbox_messages IS
  'the mail-in job (1.4, D231) skips a message it already read';
--> statement-breakpoint
CREATE POLICY system_insert ON public.mailbox_messages FOR INSERT TO kept_system
  WITH CHECK (true);
--> statement-breakpoint
COMMENT ON POLICY system_insert ON public.mailbox_messages IS
  'the mail-in job (1.4, D231) records each message it read and what it became';
--> statement-breakpoint
CREATE POLICY system_delete ON public.mailbox_messages FOR DELETE TO kept_system
  USING (created_at < now() - interval '90 days');
--> statement-breakpoint
COMMENT ON POLICY system_delete ON public.mailbox_messages IS
  'the mail-in job (1.4, D231) removes the record of messages past 90 days';
--> statement-breakpoint
REVOKE UPDATE ON public.mailbox_messages FROM kept_system;
--> statement-breakpoint

-- 3. The door -----------------------------------------------------------------------------------------------
-- The mail-in job's view of one mailbox, with its sealed connection (SYS).
CREATE FUNCTION kept.mailbox_config(p_id uuid)
RETURNS TABLE (location_id uuid, config_ciphertext jsonb, key_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.location_id, m.config_ciphertext, m.key_version FROM public.mailboxes m WHERE m.id = p_id
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.mailbox_config(uuid) FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.mailbox_config(uuid) TO kept_system;
