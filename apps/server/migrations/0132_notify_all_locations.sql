-- 1.6.1 (D239): a notification preference with no location is the person's choice for all their
-- locations, for every kind; only the AI monthly summary stays account-only (Q35). Was: no location
-- exactly for ai_summary. Rows already stored all still satisfy the new rule.
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_account_chk";--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_account_chk" CHECK (kind <> 'ai_summary' OR location_id IS NULL);