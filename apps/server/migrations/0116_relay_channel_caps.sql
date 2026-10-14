-- Custom SQL migration file, put your code below! --
-- 1.3, D227: ntfy and Telegram channels. The previous migration let `notification_channels.kind`
-- and `notification_preferences.channel` take them and lets their sealed config exist. Here, the
-- per-person caps: at most 3 ntfy and 3 Telegram channels, beside 5 webhooks and 3 calendar links
-- (@kept/shared MAX_RELAY_CHANNELS). CREATE OR REPLACE keeps the function's privileges (0055: no
-- role may call it; only the triggers run it).
CREATE OR REPLACE FUNCTION kept.guard_notify_caps() RETURNS trigger
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
    IF NEW.kind IN ('ntfy', 'telegram') AND (SELECT count(*) FROM public.notification_channels c
                                              WHERE c.user_id = NEW.user_id AND c.kind = NEW.kind
                                                AND c.id <> NEW.id) >= 3 THEN
      RAISE EXCEPTION 'a person has at most 3 channels of a kind'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'notification_channels_relay_cap';
    END IF;
  ELSIF NEW.revoked_at IS NULL AND (SELECT count(*) FROM public.calendar_feeds f
                                     WHERE f.user_id = NEW.user_id AND f.revoked_at IS NULL
                                       AND f.id <> NEW.id) >= 3 THEN
    RAISE EXCEPTION 'a person has at most 3 calendar links'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'calendar_feeds_cap';
  END IF;
  RETURN NEW;
END $$;
