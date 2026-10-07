DROP INDEX "files_unattached_idx";--> statement-breakpoint
CREATE INDEX "places_trash_purge_idx" ON "places" USING btree ("deleted_at","id") WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "things_trash_purge_idx" ON "things" USING btree ("deleted_at","id") WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "files_unattached_idx" ON "files" USING btree ("created_at","id");