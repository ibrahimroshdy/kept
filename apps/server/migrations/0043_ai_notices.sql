-- Custom SQL migration file, put your code below! --
-- Step 3, task 9: what the AI settings and the cap notices read that 0040's doors don't give
-- (engineering spec §7.15 "Notices and alerts"; D166, D206). kept_system holds no grant on the AI
-- tables (0040), and kept_app can't read the counters, so each of these is a door:
--   1. kept.ai_cap_usage(ids) (APP): a cap's month so far as its readers see it on AI settings
--      and usage (GET /api/v1/ai/caps): the tokens and money in its bucket's counters, the same
--      figures kept.ai_reserve pauses on, and this month's calls with no price. Only for cap rows
--      the caller may read under ai_budgets' SELECT policy; any other id answers nothing.
--   2. kept.ai_notice_cap(id) (SYS): the `ai-notice` job's view of a cap that crossed 80% or
--      100%: its scope, limits, the month's use and a label for the mail.
--   3. kept.ai_notice_recipients(id) (SYS): who hears of it (product design §8a "Warnings"):
--      whoever set it; for a location cap its owner and admins; for a person cap that person and
--      the account's owner; an account's cap its owner; a personal key's cap its person. Instance
--      caps also raise an admin alert (the job does that). Banned accounts are left out.
--   4. kept.ai_notice_provider(id) (SYS): whether a provider is the instance key and its key is
--      rejected now (`ai_instance_key_rejected`), so the job raises the alert on the database's
--      word, never on the payload's.
-- test/leak.test.ts and src/db/migrate.test.ts list the four.

CREATE FUNCTION kept.ai_cap_usage(p_ids uuid[])
RETURNS TABLE (budget_id uuid, tokens bigint, cost jsonb, unknown_cost_calls integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  acct uuid := kept.current_owner_account_id();
  m_start timestamptz := kept.ai_window_start('month');
  r public.ai_budgets%ROWTYPE;
  bk text;
BEGIN
  IF uid IS NULL THEN
    RETURN;
  END IF;
  FOR r IN SELECT * FROM public.ai_budgets x WHERE x.id = ANY (p_ids) ORDER BY x.id LOOP
    CONTINUE WHEN NOT coalesce(
      (r.scope IN ('instance', 'instance_account') AND kept.is_instance_admin())
      OR (r.scope IN ('account', 'location', 'member') AND r.owner_account_id = acct)
      OR (r.scope = 'user' AND r.user_id = uid)
      OR (r.scope = 'location' AND r.location_id IN (SELECT kept.admin_location_ids()))
      OR (r.scope = 'member' AND r.user_id = uid), false);
    bk := kept.ai_row_bucket(r);
    budget_id := r.id;
    tokens := kept.ai_used(bk, 'month');
    SELECT coalesce(jsonb_agg(jsonb_build_object('currency', w.currency, 'amount', w.amount)
                              ORDER BY w.currency), '[]'::jsonb)
      INTO cost
      FROM public.ai_cost_windows w
     WHERE w.bucket = bk AND w.month_start = m_start::date AND w.amount <> 0;
    SELECT count(*)::int INTO unknown_cost_calls
      FROM public.llm_calls c
     WHERE c.at >= m_start AND c.sent AND c.cost_source = 'unknown'
       AND CASE r.scope
             WHEN 'location' THEN c.location_id = r.location_id
             WHEN 'member' THEN c.location_id IS NOT NULL
                                AND c.owner_account_id = r.owner_account_id
                                AND c.user_id = r.user_id
             WHEN 'account' THEN c.paying_account_id = r.owner_account_id
                                 AND (r.task IS NULL OR c.budget_task = r.task)
             WHEN 'user' THEN c.paying_user_id = r.user_id
             WHEN 'instance' THEN c.paying_scope = 'instance'
                                  AND (r.task IS NULL OR c.budget_task = r.task)
             ELSE c.paying_scope = 'instance'
                  AND (r.owner_account_id IS NULL OR c.owner_account_id = r.owner_account_id) END;
    RETURN NEXT;
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_cap_usage(uuid[]) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ai_cap_usage(uuid[]) TO kept_app;
--> statement-breakpoint

CREATE FUNCTION kept.ai_notice_cap(p_budget uuid)
RETURNS TABLE (scope text, owner_account_id uuid, location_id uuid, user_id uuid, task text,
               tokens_per_month bigint, monthly_cap_amount numeric, cap_currency text,
               paused_until timestamptz, paused_reason text, used_tokens bigint,
               used_amount numeric, target_label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.scope, r.owner_account_id, r.location_id, r.user_id, r.task, r.tokens_per_month,
         r.monthly_cap_amount, r.cap_currency::text, r.paused_until, r.paused_reason,
         kept.ai_used(kept.ai_row_bucket(r), 'month'),
         CASE WHEN r.cap_currency IS NOT NULL
              THEN kept.ai_spent(kept.ai_row_bucket(r), r.cap_currency) END,
         CASE r.scope
           WHEN 'location' THEN (SELECT l.name FROM public.locations l WHERE l.id = r.location_id)
           WHEN 'member' THEN (SELECT p.display_name FROM public.user_profiles p
                                WHERE p.user_id = r.user_id)
           WHEN 'user' THEN (SELECT p.display_name FROM public.user_profiles p
                              WHERE p.user_id = r.user_id)
           WHEN 'account' THEN (SELECT p.display_name FROM public.owner_accounts oa
                                  JOIN public.user_profiles p ON p.user_id = oa.user_id
                                 WHERE oa.id = r.owner_account_id)
           WHEN 'instance_account' THEN (SELECT p.display_name FROM public.owner_accounts oa
                                           JOIN public.user_profiles p ON p.user_id = oa.user_id
                                          WHERE oa.id = r.owner_account_id)
           ELSE NULL END
    FROM public.ai_budgets r
   WHERE r.id = p_budget
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_notice_cap(uuid) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ai_notice_cap(uuid) TO kept_system;
--> statement-breakpoint

CREATE FUNCTION kept.ai_notice_recipients(p_budget uuid)
RETURNS TABLE (user_id uuid, email text, locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH r AS (SELECT * FROM public.ai_budgets b WHERE b.id = p_budget),
  who AS (
    SELECT r.set_by AS uid FROM r
    UNION
    SELECT m.user_id FROM r JOIN public.memberships m ON m.location_id = r.location_id
     WHERE r.scope = 'location' AND m.role IN ('owner', 'admin')
       AND (m.expires_at IS NULL OR m.expires_at > now())
    UNION
    SELECT r.user_id FROM r WHERE r.scope IN ('member', 'user')
    UNION
    SELECT oa.user_id FROM r JOIN public.owner_accounts oa ON oa.id = r.owner_account_id
     WHERE r.scope IN ('member', 'account'))
  SELECT u.id, u.email, p.locale
    FROM who
    JOIN auth."user" u ON u.id = who.uid
    LEFT JOIN public.user_profiles p ON p.user_id = u.id
   WHERE NOT coalesce(u.banned, false)
   ORDER BY u.id
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_notice_recipients(uuid) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ai_notice_recipients(uuid) TO kept_system;
--> statement-breakpoint

CREATE FUNCTION kept.ai_notice_provider(p_provider uuid)
RETURNS TABLE (scope text, kind text, active boolean, rejected boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.scope, p.kind, p.disabled_at IS NULL,
         coalesce(b.reason = 'auth' AND b.until > now(), false)
    FROM public.ai_providers p
    LEFT JOIN public.ai_breakers b ON b.provider_id = p.id
   WHERE p.id = p_provider
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_notice_provider(uuid) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ai_notice_provider(uuid) TO kept_system;
