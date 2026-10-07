-- Custom SQL migration file, put your code below! --
-- Step 4, task 7: reminder occurrences and deliveries, notifications, channels, push
-- subscriptions, preferences and calendar feeds (engineering spec §1.9, §3.3, §7.1, §7.3, §7.13;
-- D29, D30, D39, D111, D122, D142, D166, D181; plan Q10–Q13, Q23, Q30, Q35). Above, in 0054,
-- drizzle's part: the eight tables (src/db/schema/{reminders,notify}.ts) and admin_alerts' kind
-- `reminders_not_scanned`. Below:
--   1. Row-level security. The ledger (occurrences, deliveries, digests) is the reminder jobs'
--      (T14): kept_system writes it, each policy commented with its job; kept_app reads its own
--      share (occurrences where it sees the location, its own deliveries and digests). Channels,
--      push subscriptions, preferences, notifications and calendar feeds are their user's own:
--      invisible to every other user, even of the same location. A notification of a location
--      the user no longer sees is hidden. kept_app never SELECTs a webhook's sealed config
--      (notification_channels.config_ciphertext: column grants, as for ai_providers.key_ciphertext).
--   2. The caps: 5 webhooks per user (23514 notification_channels_webhook_cap) and 3 live
--      calendar links per user (23514 calendar_feeds_cap), each under a per-user advisory lock.
--   3. kept.calendar_feed_user(token hash) (SYS): the public `/cal/<token>` fetch's door. The
--      feed's user when it is unrevoked and the user isn't banned (Better Auth's `banned`), else
--      NULL (a 404 alike for all); it counts the fetch and records when, at most once a minute
--      (L35). The feed is then built in that user's scope (T17).
--   4. The VAPID key (Q11) lives in instance_settings under `vapid`: no kept_app policy reaches
--      that key, instance admin or not (kept_system's system_all does).
--   5. kept.prune_stale_rows() (§3.3), every earlier clause kept, plus: notifications after 90
--      days; deliveries after a year; closed occurrences after a year once no delivery is left;
--      digests after a year.
--   6. Step-3 carry-over (T19, routed here):
--      - a short ID moved from one thing to another (a merge, a relabel) bumps the thing it left
--        (things.state_version, 0051), so the snapshot resends it with its own primary code and
--        the phone stops showing the moved code on it. Not a `code` tombstone, as the plan had
--        it: the phone applies a page's removals after its changes (web offline/store.ts), so a
--        tombstone of a code that stays in the location would delete it there;
--      - kept.was_member_of(location) (APP): whether the caller was a member of a location, for
--        sync's `location_revoked` without a prior op there (D210). A boolean only: their own
--        membership row (expired, or its location in its deletion grace), or an audit event of
--        their removal, leaving or expiry there.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-household.ts fills
-- the tables; src/db/reminders.test.ts tests them.

-- 1. Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reminder_occurrences', 'reminder_deliveries', 'notification_digests',
                           'notifications', 'notification_channels', 'push_subscriptions',
                           'notification_preferences', 'calendar_feeds'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM kept_app, kept_system', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.notification_channels
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- Occurrences: read where the location is seen; written by the scan.
CREATE POLICY app_select ON public.reminder_occurrences FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY system_select ON public.reminder_occurrences FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
CREATE POLICY system_insert ON public.reminder_occurrences FOR INSERT TO kept_system
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY system_update ON public.reminder_occurrences FOR UPDATE TO kept_system
  USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT UPDATE (state, closed_at) ON public.reminder_occurrences TO kept_system;
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.reminder_occurrences IS
  'the reminder scan (T14) writes each occurrence once and closes the ones the agenda dropped';
--> statement-breakpoint
COMMENT ON POLICY system_insert ON public.reminder_occurrences IS
  'the reminder scan (T14) writes each occurrence once and closes the ones the agenda dropped';
--> statement-breakpoint
COMMENT ON POLICY system_update ON public.reminder_occurrences IS
  'the reminder scan (T14) writes each occurrence once and closes the ones the agenda dropped';
--> statement-breakpoint

-- Deliveries: a user reads their own; the scan fans out, the deliver and digest jobs send.
CREATE POLICY app_select ON public.reminder_deliveries FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY system_select ON public.reminder_deliveries FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
CREATE POLICY system_insert ON public.reminder_deliveries FOR INSERT TO kept_system
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY system_update ON public.reminder_deliveries FOR UPDATE TO kept_system
  USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT UPDATE (status, not_before, sent_at, error) ON public.reminder_deliveries TO kept_system;
--> statement-breakpoint
DO $$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['system_select', 'system_insert', 'system_update'] LOOP
    EXECUTE format('COMMENT ON POLICY %I ON public.reminder_deliveries IS %L', p,
      'the reminder scan fans out, and the deliver and digest jobs (T14, T15) send');
  END LOOP;
END $$;
--> statement-breakpoint

-- Digests: one per user, day and channel; the digest job's. A user may read their own.
CREATE POLICY app_select ON public.notification_digests FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY system_select ON public.notification_digests FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
CREATE POLICY system_insert ON public.notification_digests FOR INSERT TO kept_system
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY system_update ON public.notification_digests FOR UPDATE TO kept_system
  USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT UPDATE (sent_at) ON public.notification_digests TO kept_system;
--> statement-breakpoint
DO $$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['system_select', 'system_insert', 'system_update'] LOOP
    EXECUTE format('COMMENT ON POLICY %I ON public.notification_digests IS %L', p,
      'the digest job (T14) sends each user''s digest once a day per channel');
  END LOOP;
END $$;
--> statement-breakpoint

-- Notifications: the user's own, while they see its location; they mark them read. Written by
-- the scan and the notice jobs (membership, AI caps, exports: Q30).
CREATE POLICY app_select ON public.notifications FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
         AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids())));
--> statement-breakpoint
CREATE POLICY app_update ON public.notifications FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id())
         AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids())))
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
GRANT UPDATE (read_at) ON public.notifications TO kept_app;
--> statement-breakpoint
CREATE POLICY system_select ON public.notifications FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
CREATE POLICY system_insert ON public.notifications FOR INSERT TO kept_system WITH CHECK (true);
--> statement-breakpoint
DO $$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['system_select', 'system_insert'] LOOP
    EXECUTE format('COMMENT ON POLICY %I ON public.notifications IS %L', p,
      'the reminder scan and the notice jobs (T14, T16) write the centre''s rows');
  END LOOP;
END $$;
--> statement-breakpoint

-- Channels: the user's own. kept_app reads every column but the sealed config.
CREATE POLICY app_select ON public.notification_channels FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.notification_channels FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.notification_channels FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()))
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.notification_channels FOR DELETE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
GRANT DELETE ON public.notification_channels TO kept_app;
--> statement-breakpoint
GRANT UPDATE (label, verified_at, updated_at, row_version) ON public.notification_channels
  TO kept_app;
--> statement-breakpoint
REVOKE SELECT ON public.notification_channels FROM kept_app;
--> statement-breakpoint
GRANT SELECT (id, user_id, kind, label, display_host, key_version, verified_at, failing_since,
              created_at, updated_at, row_version, change_seq)
  ON public.notification_channels TO kept_app;
--> statement-breakpoint
CREATE POLICY system_select ON public.notification_channels FOR SELECT TO kept_system
  USING (true);
--> statement-breakpoint
CREATE POLICY system_update ON public.notification_channels FOR UPDATE TO kept_system
  USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT UPDATE (failing_since, verified_at) ON public.notification_channels TO kept_system;
--> statement-breakpoint
DO $$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['system_select', 'system_update'] LOOP
    EXECUTE format('COMMENT ON POLICY %I ON public.notification_channels IS %L', p,
      'the deliver jobs (T15) open a channel to send and mark it failing or verified');
  END LOOP;
END $$;
--> statement-breakpoint

-- Push subscriptions: the user's own devices; the push sender drops the dead ones (404/410).
CREATE POLICY app_select ON public.push_subscriptions FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.push_subscriptions FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.push_subscriptions FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()))
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.push_subscriptions FOR DELETE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
GRANT DELETE ON public.push_subscriptions TO kept_app, kept_system;
--> statement-breakpoint
GRANT UPDATE (label) ON public.push_subscriptions TO kept_app;
--> statement-breakpoint
CREATE POLICY system_select ON public.push_subscriptions FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
CREATE POLICY system_update ON public.push_subscriptions FOR UPDATE TO kept_system
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY system_delete ON public.push_subscriptions FOR DELETE TO kept_system USING (true);
--> statement-breakpoint
GRANT UPDATE (last_success_at, failures) ON public.push_subscriptions TO kept_system;
--> statement-breakpoint
DO $$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['system_select', 'system_update', 'system_delete'] LOOP
    EXECUTE format('COMMENT ON POLICY %I ON public.push_subscriptions IS %L', p,
      'the push sender (T15) sends, counts failures and drops a subscription gone (404/410)');
  END LOOP;
END $$;
--> statement-breakpoint

-- Preferences: the user's own choices, for a location they see or none (account-level kinds).
CREATE POLICY app_select ON public.notification_preferences FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.notification_preferences FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids())));
--> statement-breakpoint
CREATE POLICY app_update ON public.notification_preferences FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()))
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids())));
--> statement-breakpoint
CREATE POLICY app_delete ON public.notification_preferences FOR DELETE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
GRANT DELETE ON public.notification_preferences TO kept_app;
--> statement-breakpoint
GRANT UPDATE (enabled, updated_at, row_version) ON public.notification_preferences TO kept_app;
--> statement-breakpoint
CREATE POLICY system_select ON public.notification_preferences FOR SELECT TO kept_system
  USING (true);
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.notification_preferences IS
  'the reminder scan (T14) reads who wants which kind on which channel';
--> statement-breakpoint

-- Calendar feeds: the user's own links; revoked, never deleted by a request.
CREATE POLICY app_select ON public.calendar_feeds FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.calendar_feeds FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id()) AND revoked_at IS NULL
              AND last_fetched_at IS NULL AND fetches = 0);
--> statement-breakpoint
CREATE POLICY app_update ON public.calendar_feeds FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()))
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON public.calendar_feeds TO kept_app;
--> statement-breakpoint

-- 2. The caps ----------------------------------------------------------------------------------------
-- Invoker: a user counts their own rows, which they see.
CREATE FUNCTION kept.guard_notify_caps() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kept.notify_caps'), hashtext(NEW.user_id::text));
  IF TG_TABLE_NAME = 'notification_channels' THEN
    IF NEW.kind = 'webhook' AND (SELECT count(*) FROM public.notification_channels c
                                  WHERE c.user_id = NEW.user_id AND c.kind = 'webhook'
                                    AND c.id <> NEW.id) >= 5 THEN
      RAISE EXCEPTION 'a person has at most 5 webhooks'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_channels_webhook_cap';
    END IF;
  ELSIF NEW.revoked_at IS NULL AND (SELECT count(*) FROM public.calendar_feeds f
                                     WHERE f.user_id = NEW.user_id AND f.revoked_at IS NULL
                                       AND f.id <> NEW.id) >= 3 THEN
    RAISE EXCEPTION 'a person has at most 3 calendar links'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'calendar_feeds_cap';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER notification_channels_cap BEFORE INSERT ON public.notification_channels
  FOR EACH ROW EXECUTE FUNCTION kept.guard_notify_caps();
--> statement-breakpoint
CREATE TRIGGER calendar_feeds_cap BEFORE INSERT OR UPDATE OF revoked_at ON public.calendar_feeds
  FOR EACH ROW EXECUTE FUNCTION kept.guard_notify_caps();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_notify_caps() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 3. The calendar feed's door ------------------------------------------------------------------------
CREATE FUNCTION kept.calendar_feed_user(p_token_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  f public.calendar_feeds%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.calendar_feeds x
   WHERE x.token_hash = p_token_hash AND p_token_hash ~ '^[0-9a-f]{64}$' AND x.revoked_at IS NULL;
  IF f.id IS NULL OR EXISTS (SELECT 1 FROM auth."user" u
                              WHERE u.id = f.user_id AND coalesce(u.banned, false)) THEN
    RETURN NULL;
  END IF;
  UPDATE public.calendar_feeds x SET fetches = x.fetches + 1, last_fetched_at = now()
   WHERE x.id = f.id
     AND (x.last_fetched_at IS NULL OR x.last_fetched_at < now() - interval '1 minute');
  RETURN f.user_id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.calendar_feed_user(text) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.calendar_feed_user(text) TO kept_system;
--> statement-breakpoint

-- 4. The VAPID key is no request's to read --------------------------------------------------------------
DROP POLICY app_admin ON public.instance_settings;
--> statement-breakpoint
CREATE POLICY app_admin ON public.instance_settings FOR ALL TO kept_app
  USING ((SELECT kept.is_instance_admin()) AND key <> 'vapid')
  WITH CHECK ((SELECT kept.is_instance_admin()) AND key <> 'vapid');
--> statement-breakpoint

-- 5. Retention -------------------------------------------------------------------------------------------
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

  -- 0055 (step 4, §3.3): the centre keeps 90 days; the reminder ledger a year.
  DELETE FROM public.notifications x WHERE x.created_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'notifications'; removed := n; RETURN NEXT;

  DELETE FROM public.reminder_deliveries d WHERE d.created_at < now() - interval '1 year';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'reminder_deliveries'; removed := n; RETURN NEXT;

  DELETE FROM public.reminder_occurrences o
   WHERE o.state <> 'open' AND o.closed_at < now() - interval '1 year'
     AND NOT EXISTS (SELECT 1 FROM public.reminder_deliveries d WHERE d.occurrence_id = o.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'reminder_occurrences'; removed := n; RETURN NEXT;

  DELETE FROM public.notification_digests g WHERE g.digest_on < current_date - 365;
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'notification_digests'; removed := n; RETURN NEXT;
END $$;

--> statement-breakpoint

-- 6. Step-3 carry-over (T19) ---------------------------------------------------------------------------
-- A code that moved to another target bumps the thing it left, so the phone resends it.
CREATE FUNCTION kept.touch_code_move() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.things t SET state_version = t.state_version + 1 WHERE t.id = OLD.thing_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.touch_code_move() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER short_ids_code_move AFTER UPDATE OF thing_id, place_id ON public.short_ids
  FOR EACH ROW
  WHEN (OLD.thing_id IS NOT NULL AND OLD.location_id = NEW.location_id
        AND (OLD.thing_id IS DISTINCT FROM NEW.thing_id
             OR OLD.place_id IS DISTINCT FROM NEW.place_id))
  EXECUTE FUNCTION kept.touch_code_move();
--> statement-breakpoint
-- Whether the caller was a member of `p_location` (D210): only a boolean, only about themselves.
CREATE FUNCTION kept.was_member_of(p_location uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT kept.current_user_id() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.memberships m
             WHERE m.location_id = p_location AND m.user_id = kept.current_user_id())
    OR EXISTS (SELECT 1 FROM public.audit_events e
                WHERE e.location_id = p_location AND e.entity_type = 'membership'
                  AND e.action IN ('member.remove', 'member.leave', 'member.expire')
                  AND e.diff -> 'user_id' ->> 'before' = kept.current_user_id()::text))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.was_member_of(uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.was_member_of(uuid) TO kept_app;
