-- Custom SQL migration file, put your code below! --
-- The AI monthly summary (product design §8a "A monthly summary for account owners"; engineering
-- spec §7.15 `ai.monthly_summary`, the 1st; plan Q35), never built in step 3: the `ai-summary` job
-- (src/ai/summary.ts) tells each account owner, and each person paying with a key of their own,
-- what AI did for them last month. kept_system holds no grant on the call ledger (0040), so this
-- is its door: per person, the month's sent calls they paid for (their account's key, or their
-- own), with tokens and cost per currency, and the address and language to write to. Totals
-- only: no call, location, thing or model. Banned users are left out; instance-paid calls belong
-- to no account owner. p_month is any day of the month wanted (UTC months, as the ledger's).
CREATE FUNCTION kept.ai_month_summaries(p_month date)
RETURNS TABLE (user_id uuid, email text, locale text, calls integer, tokens bigint,
               unknown_cost_calls integer, cost jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH m AS (
    SELECT date_trunc('month', p_month::timestamp) AT TIME ZONE 'UTC' AS from_at,
           (date_trunc('month', p_month::timestamp) + interval '1 month') AT TIME ZONE 'UTC' AS to_at),
  c AS (
    SELECT CASE x.paying_scope WHEN 'account' THEN oa.user_id ELSE x.paying_user_id END AS uid,
           coalesce(x.input_tokens, 0) + coalesce(x.output_tokens, 0) AS tokens,
           x.cost_amount, x.cost_currency, x.cost_source
      FROM public.llm_calls x
      CROSS JOIN m
      LEFT JOIN public.owner_accounts oa
             ON x.paying_scope = 'account' AND oa.id = x.paying_account_id
     WHERE x.at >= m.from_at AND x.at < m.to_at AND x.sent
       AND x.paying_scope IN ('account', 'user')),
  per AS (
    SELECT c.uid, count(*)::integer AS calls, sum(c.tokens)::bigint AS tokens,
           (count(*) FILTER (WHERE c.cost_source = 'unknown'))::integer AS unknown_cost_calls
      FROM c WHERE c.uid IS NOT NULL GROUP BY c.uid),
  money AS (
    SELECT c.uid, jsonb_agg(jsonb_build_object('currency', c.cost_currency, 'amount', c.amount)
                            ORDER BY c.cost_currency) AS cost
      FROM (SELECT c.uid, c.cost_currency::text AS cost_currency, sum(c.cost_amount) AS amount
              FROM c WHERE c.uid IS NOT NULL AND c.cost_amount IS NOT NULL
               AND c.cost_currency IS NOT NULL
             GROUP BY c.uid, c.cost_currency) c
     GROUP BY c.uid)
  SELECT per.uid, u.email, p.locale, per.calls, per.tokens, per.unknown_cost_calls,
         coalesce(money.cost, '[]'::jsonb)
    FROM per
    JOIN auth."user" u ON u.id = per.uid
    LEFT JOIN public.user_profiles p ON p.user_id = per.uid
    LEFT JOIN money ON money.uid = per.uid
   WHERE NOT coalesce(u.banned, false)
   ORDER BY per.uid
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.ai_month_summaries(date) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ai_month_summaries(date) TO kept_system;
