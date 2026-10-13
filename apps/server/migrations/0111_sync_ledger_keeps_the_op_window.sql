-- Custom SQL migration file, put your code below! --
-- Review finding (2026-10-14): the sync ledger was pruned after 30 days, but the server accepts an
-- op up to 90 days old (SYNC_LIMITS.clientIdPastDays, sync/payload.ts). A phone whose answer was
-- lost (it locked mid-request) and that next synced more than 30 days later resent the op, found
-- no ledger row, and applied it again: a stale move undid every move made since. The ledger now
-- keeps an op for the whole window. Nothing else in kept.prune_stale_rows() changes.

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

  -- 0111: as long as an op may be resent (SYNC_LIMITS: 90 days and a day of clock skew), so a
  -- replay finds its answer instead of applying again.
  DELETE FROM public.sync_ops o WHERE o.received_at < now() - interval '91 days';
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
