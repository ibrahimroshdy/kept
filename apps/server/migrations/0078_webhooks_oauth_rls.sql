-- Custom SQL migration file, put your code below! --
-- Step 6, task 7: location webhooks, Better Auth's OAuth tables, instance settings (engineering
-- spec §1.10, §2.6, §3.1b, §3.3; D63, D110, D172, D180; plan Q16, Q18). Above, in 0077, drizzle's
-- part: webhooks (a sealed, write-only secret; key_version as every sealed column, so rotate-key
-- walks it), webhook_deliveries (one per hook and event), the eight tables Better Auth's jwt(),
-- oauthProvider()/mcp() and cimd() plugins use (schema auth, exactly spike S6.2's delta; kept_auth
-- has DML on them through 0000's default privileges, kept_app and kept_system nothing), and
-- instance_settings_values_chk (the embeddings source, the thread lifetime, the OIDC and SMTP
-- configuration hashes). Below:
--   1. webhooks: its location's owners and admins read, add, change and remove them
--      (webhooks.manage); an undo puts the creator back (kept.undo_keep_creator(), 0065). kept_app
--      can't SELECT secret_ciphertext (the column grant) and may write it (the secret is
--      write-only, as AI keys are); kept_system reads the rest and marks a failing hook, each
--      policy commented with the job it serves. The delivery job opens the secret through
--      kept.webhook_secret() (SYS).
--   2. webhook_deliveries: the location's admins read them (the webhook's history); only
--      kept_system writes them (the fan-out records one per hook and event, the delivery job each
--      attempt). kept.prune_stale_rows() drops those past 30 days (§3.3).
--   3. kept.webhooks_listening(location, event) (APP): whether an active hook there takes the
--      event, so audited() enqueues a fan-out only then, in the write's transaction (Q18); a
--      member can't read the hooks themselves. A yes or no, nothing else.
--   4. D180: a hook stops (disabled_reason 'creator_lost_role') when its creator stops
--      administering the location: kept.disable_webhooks_for() (SYS; APP for the membership
--      routes), and 0073's membership trigger now calls it when a membership ends or drops below
--      admin.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-assistant.ts fills
-- the tables; src/db/webhooks.test.ts tests them.

-- 1. webhooks ---------------------------------------------------------------------------------------------
ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhooks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.webhooks FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.webhooks
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER undo_keep_creator BEFORE INSERT ON public.webhooks
  FOR EACH ROW EXECUTE FUNCTION kept.undo_keep_creator();
--> statement-breakpoint
CREATE POLICY app_select ON public.webhooks FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.webhooks FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND (created_by = (SELECT kept.current_user_id())
                   OR created_by = kept.undo_creator(location_id, id)));
--> statement-breakpoint
CREATE POLICY app_update ON public.webhooks FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.webhooks FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY system_select ON public.webhooks FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.webhooks IS
  'the webhook fan-out and delivery jobs (step-6 T15) find the hooks an event goes to';
--> statement-breakpoint
CREATE POLICY system_update ON public.webhooks FOR UPDATE TO kept_system USING (true)
  WITH CHECK (true);
--> statement-breakpoint
COMMENT ON POLICY system_update ON public.webhooks IS
  'the delivery job (step-6 T15) marks a failing hook, and turns it off when it gives up';
--> statement-breakpoint
REVOKE SELECT, UPDATE ON public.webhooks FROM kept_app, kept_system;
--> statement-breakpoint
REVOKE INSERT, DELETE ON public.webhooks FROM kept_system;
--> statement-breakpoint
-- Every column but the sealed secret.
GRANT SELECT (id, location_id, url, key_version, events, active, failing_since, disabled_reason,
              created_by, created_at, updated_at, row_version, change_seq)
  ON public.webhooks TO kept_app, kept_system;
--> statement-breakpoint
-- Not granted: the id, location_id and created_by.
GRANT UPDATE (url, events, active, failing_since, disabled_reason, secret_ciphertext, key_version,
              updated_at, row_version)
  ON public.webhooks TO kept_app;
--> statement-breakpoint
GRANT UPDATE (active, failing_since, disabled_reason, updated_at, row_version)
  ON public.webhooks TO kept_system;
--> statement-breakpoint

-- 2. webhook_deliveries -------------------------------------------------------------------------------------
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.webhook_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.webhook_deliveries FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_select ON public.webhook_deliveries FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.webhook_deliveries FROM kept_app;
--> statement-breakpoint
CREATE POLICY system_select ON public.webhook_deliveries FOR SELECT TO kept_system USING (true);
--> statement-breakpoint
COMMENT ON POLICY system_select ON public.webhook_deliveries IS
  'the delivery job (step-6 T15) picks the deliveries that are due';
--> statement-breakpoint
CREATE POLICY system_insert ON public.webhook_deliveries FOR INSERT TO kept_system
  WITH CHECK (true);
--> statement-breakpoint
COMMENT ON POLICY system_insert ON public.webhook_deliveries IS
  'the fan-out job (step-6 T15) records one delivery per hook and event';
--> statement-breakpoint
CREATE POLICY system_update ON public.webhook_deliveries FOR UPDATE TO kept_system USING (true)
  WITH CHECK (true);
--> statement-breakpoint
COMMENT ON POLICY system_update ON public.webhook_deliveries IS
  'the delivery job (step-6 T15) records each attempt';
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.webhook_deliveries FROM kept_system;
--> statement-breakpoint
GRANT UPDATE (status, attempts, next_attempt_at, http_status, updated_at)
  ON public.webhook_deliveries TO kept_system;
--> statement-breakpoint

-- 3. The doors ----------------------------------------------------------------------------------------------
-- The delivery job's view of one hook, with its sealed secret (SYS).
CREATE FUNCTION kept.webhook_secret(p_id uuid)
RETURNS TABLE (location_id uuid, url text, secret_ciphertext jsonb, key_version integer,
               active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT w.location_id, w.url, w.secret_ciphertext, w.key_version, w.active
    FROM public.webhooks w WHERE w.id = p_id
$$;
--> statement-breakpoint
-- Whether a write in a location the caller sees should fan out (Q18): false for a location it
-- can't see.
CREATE FUNCTION kept.webhooks_listening(p_location uuid, p_event text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(p_location IN (SELECT kept.visible_location_ids()), false)
     AND EXISTS (SELECT 1 FROM public.webhooks w
                  WHERE w.location_id = p_location AND w.active AND p_event = ANY (w.events))
$$;
--> statement-breakpoint
-- The work (owner-only): turn off the hooks p_user made in p_location. Returns how many.
CREATE FUNCTION kept.disable_webhooks_in(p_user uuid, p_location uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.webhooks w SET active = false, disabled_reason = 'creator_lost_role'
   WHERE w.created_by = p_user AND w.location_id = p_location AND w.active;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
-- The door (SYS for the jobs; APP for the membership routes): the user themself, or an admin of
-- the location. Never a token.
CREATE FUNCTION kept.disable_webhooks_for(p_user uuid, p_location uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'kept_system'
     AND (kept.current_user_id() IS NULL OR kept.current_token_id() IS NOT NULL
          OR (p_user IS DISTINCT FROM kept.current_user_id()
              AND NOT coalesce(p_location IN (SELECT kept.admin_location_ids()), false))) THEN
    RAISE EXCEPTION 'not a location you administer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN kept.disable_webhooks_in(p_user, p_location);
END $$;
--> statement-breakpoint

-- 4. D180: access ends -------------------------------------------------------------------------------------
-- 0073's, with webhooks: a hook stops when its creator stops administering the location.
CREATE OR REPLACE FUNCTION kept.membership_access_ended() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  purged boolean := NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = OLD.location_id);
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM kept.redact_assistant_in(OLD.user_id, OLD.location_id);
    IF NOT purged THEN
      PERFORM kept.revoke_tokens_in(OLD.user_id, OLD.location_id, 'membership_ended');
      PERFORM kept.disable_webhooks_in(OLD.user_id, OLD.location_id);
    END IF;
  ELSIF NOT purged THEN
    IF NEW.role = 'viewer' AND OLD.role <> 'viewer' THEN
      PERFORM kept.revoke_tokens_in(OLD.user_id, OLD.location_id, 'role_lost');
    END IF;
    IF OLD.role IN ('owner', 'admin') AND NEW.role NOT IN ('owner', 'admin') THEN
      PERFORM kept.disable_webhooks_in(OLD.user_id, OLD.location_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.webhook_secret(uuid), kept.webhooks_listening(uuid, text),
  kept.disable_webhooks_in(uuid, uuid), kept.disable_webhooks_for(uuid, uuid)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.webhook_secret(uuid) TO kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.webhooks_listening(uuid, text) TO kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.disable_webhooks_for(uuid, uuid) TO kept_app, kept_system;
--> statement-breakpoint

-- 5. Maintenance -------------------------------------------------------------------------------------------
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

  -- 0070 (step 6, Q19): a rate window is a minute; two hours is plenty for Retry-After.
  DELETE FROM public.token_rate_windows w WHERE w.minute < now() - interval '2 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'token_rate_windows'; removed := n; RETURN NEXT;

  -- 0078 (step 6, §3.3): a webhook's deliveries keep 30 days.
  DELETE FROM public.webhook_deliveries d WHERE d.created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'webhook_deliveries'; removed := n; RETURN NEXT;
END $$;
