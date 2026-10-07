CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"mailed_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "admin_alerts_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "admin_alerts_kind_chk" CHECK ("kind" IN ('failed_jobs_rising', 'audit_default_partition')),
	CONSTRAINT "admin_alerts_count_chk" CHECK (count >= 1),
	CONSTRAINT "admin_alerts_seen_chk" CHECK (last_at >= first_at)
);
--> statement-breakpoint
-- Jobs, admin alerts and mail (tasks 24–25; D46, D166, D180, D185, §3.3, §7.1, §7.13).
-- The table above (drizzle-kit) is admin_alerts. Below, by hand: its policies, and the doors the
-- step-1 system jobs and the mail transport need. Each door is SECURITY DEFINER, does one thing
-- and is kept_system's alone, so kept_system gains no table privilege in schema auth and no
-- policy on locations, instance_admins or idempotency_keys. test/leak.test.ts and
-- src/db/migrate.test.ts list every function here.

-- 1. admin_alerts: instance scope. Instance admins read them (kept_app, like instance_settings);
--    only kept_system raises and resolves them.
ALTER TABLE public.admin_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.admin_alerts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.admin_alerts FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_admin_select ON public.admin_alerts FOR SELECT TO kept_app
  USING ((SELECT kept.is_instance_admin()));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON public.admin_alerts FROM kept_app;
--> statement-breakpoint
CREATE POLICY system_all ON public.admin_alerts FOR ALL TO kept_system USING (true) WITH CHECK (true);
--> statement-breakpoint

-- 2. The nightly prune (task 24): rows nothing reads any more.
--    - auth.sign_in_failures whose window and last failure are both older than the longest
--      window any limiter uses (24 h, the sign-up-existing notice) plus an hour;
--    - auth.session_mfa of expired sessions (they go by cascade only when Better Auth deletes the
--      session, which it does only for a session it sees again);
--    - idempotency_keys older than 30 days (§3.3).
--    Returns what it removed, by table, for the job's log line.
CREATE FUNCTION kept.prune_stale_rows()
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
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.prune_stale_rows() FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.prune_stale_rows() TO kept_system;
--> statement-breakpoint

-- 3. The default-partition alert (task 25): whether audit_events_default holds rows, and their
--    span. The partition is locked to kept_owner (0005), so kept_system asks here. Moving the
--    rows out stays a hand job for the operator, as kept_owner.
CREATE FUNCTION kept.audit_default_partition_rows()
RETURNS TABLE (n bigint, oldest timestamptz, newest timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*), min(d.at), max(d.at) FROM public.audit_events_default d
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.audit_default_partition_rows() FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.audit_default_partition_rows() TO kept_system;
--> statement-breakpoint

-- 4. Who an admin alert is mailed to (D166): every instance admin whose account isn't disabled,
--    with the language of their profile. kept_system still has no policy on instance_admins.
CREATE FUNCTION kept.instance_admin_recipients()
RETURNS TABLE (user_id uuid, email text, locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT ia.user_id, u.email, p.locale
    FROM public.instance_admins ia
    JOIN auth."user" u ON u.id = ia.user_id
    LEFT JOIN public.user_profiles p ON p.user_id = ia.user_id
   WHERE NOT coalesce(u.banned, false)
   ORDER BY ia.granted_at, ia.user_id
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.instance_admin_recipients() FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.instance_admin_recipients() TO kept_system;
--> statement-breakpoint

-- 5. The language a mail goes out in (D81): the profile locale of the account with this address,
--    or null (no account, or no profile yet). The mail transport asks as kept_system.
CREATE FUNCTION kept.mail_locale(p_email text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.locale
    FROM auth."user" u
    JOIN public.user_profiles p ON p.user_id = u.id
   WHERE lower(u.email) = lower(p_email)
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.mail_locale(text) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.mail_locale(text) TO kept_system;
--> statement-breakpoint

-- 6. The owner's new-member notice (D180, `notify-owner-new-member`): for a live, non-owner
--    membership of `p_user_id` in `p_location_id`, what the mail says and where it goes. Nothing
--    for a membership that is gone or ended, or a location in its deletion grace.
CREATE FUNCTION kept.new_member_notice(p_location_id uuid, p_user_id uuid)
RETURNS TABLE (owner_email text, owner_locale text, location_name text, member_name text,
               role text, managed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT ou.email, op.locale, l.name,
         coalesce(mp.display_name, mu.name, ''), m.role, coalesce(mp.managed, false)
    FROM public.memberships m
    JOIN public.locations l ON l.id = m.location_id AND l.deleted_at IS NULL
    JOIN public.memberships o ON o.location_id = m.location_id AND o.role = 'owner'
    JOIN auth."user" ou ON ou.id = o.user_id
    LEFT JOIN public.user_profiles op ON op.user_id = o.user_id
    JOIN auth."user" mu ON mu.id = m.user_id
    LEFT JOIN public.user_profiles mp ON mp.user_id = m.user_id
   WHERE m.location_id = p_location_id AND m.user_id = p_user_id AND m.role <> 'owner'
     AND (m.expires_at IS NULL OR m.expires_at > now())
     AND NOT coalesce(ou.banned, false)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.new_member_notice(uuid, uuid) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.new_member_notice(uuid, uuid) TO kept_system;
