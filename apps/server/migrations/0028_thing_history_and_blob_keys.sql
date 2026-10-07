-- Step 2 cleanup (T17 and T21 backlog; engineering spec §7.13; D161, D162):
--   1. A thing's history reads the events rooted at it (`root_thing_id`: its attachments,
--      meters, readings) newest first. Partial, as most events have no root thing. Created on
--      the partitioned parent, so Postgres builds it on every partition, the default one
--      included, and every partition kept.create_audit_partition() makes later inherits it
--      (src/db/schema.test.ts checks both). Not CONCURRENTLY: a partitioned index can't be.
--   2. kept.unreferenced_storage_keys(): which of the given storage keys no file or derivative
--      row references any more. "Delete original" (DELETE /api/v1/files/:id) removes the file
--      row and, by cascade, its derivatives, and then asks this after its transaction commits:
--      a blob is deleted only when nothing names it, because a cross-account copy shares its
--      source's blobs (D161) and must keep them. kept_system's alone: it reads every tenant's
--      file rows, and from kept_app it would be an oracle on other tenants' keys.
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.
CREATE INDEX "audit_events_root_thing_idx" ON "audit_events" USING btree ("root_thing_id","at" DESC NULLS LAST) WHERE root_thing_id IS NOT NULL;--> statement-breakpoint
CREATE FUNCTION kept.unreferenced_storage_keys(p_keys text[]) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT k.key FROM unnest(p_keys) AS k(key)
   WHERE k.key IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.files f WHERE f.storage_key = k.key)
     AND NOT EXISTS (SELECT 1 FROM public.file_derivatives d WHERE d.storage_key = k.key)
   ORDER BY 1
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.unreferenced_storage_keys(text[]) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.unreferenced_storage_keys(text[]) TO kept_system;
