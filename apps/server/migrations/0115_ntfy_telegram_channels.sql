ALTER TABLE "notification_channels" DROP CONSTRAINT "notification_channels_kind_chk";--> statement-breakpoint
ALTER TABLE "notification_channels" DROP CONSTRAINT "notification_channels_config_chk";--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_channel_chk";--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_kind_chk" CHECK ("kind" IN ('email', 'webpush', 'webhook', 'ntfy', 'telegram'));--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_config_chk" CHECK ((kind IN ('webhook', 'ntfy', 'telegram')) = (config_ciphertext IS NOT NULL)
          AND (config_ciphertext IS NULL) = (key_version IS NULL));--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_channel_chk" CHECK ("channel" IN ('inapp', 'email', 'webpush', 'webhook', 'ntfy', 'telegram'));