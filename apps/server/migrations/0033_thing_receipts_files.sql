-- Receipts after a move get full views (D115; step-2 backlog). kept.thing_receipts() listed only
-- (attachment, file, role), so a receipt the caller reaches through the thing but can't read
-- directly (the purchase stayed in a location they can't see) was shown with a bare file: no
-- hash, no dimensions, no previews. It now also returns the file's metadata and its derivative
-- storage keys, which the server signs for the caller (D157): the same view a readable receipt
-- gets. Originals stay behind kept.thing_receipt_file(), members and above (D117); the original's
-- storage key is not returned here.
--
-- The return type changes, so the function is dropped and made again (kept.thing_receipt_file(),
-- a SQL function, names it only in its body, so nothing depends on it). Same signature, same
-- grants as 0020: kept_app only.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions.

DROP FUNCTION kept.thing_receipts(uuid);
--> statement-breakpoint
CREATE FUNCTION kept.thing_receipts(p_thing uuid)
RETURNS TABLE (attachment_id uuid, file_id uuid, role text, sort int, sha256 text, bytes bigint,
               mime text, class text, has_gps boolean, width int, height int,
               derivative_state text, thumb_key text, display_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.file_id, a.role, a.sort, f.sha256::text, f.bytes, f.mime, f.class, f.has_gps,
         f.width, f.height, f.derivative_state,
         (SELECT d.storage_key FROM public.file_derivatives d
           WHERE d.file_id = f.id AND d.variant = 'thumb'),
         (SELECT d.storage_key FROM public.file_derivatives d
           WHERE d.file_id = f.id AND d.variant = 'display')
    FROM public.things t
    JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
    JOIN public.attachments a ON a.purchase_id = pl.purchase_id AND a.location_id = pl.location_id
    JOIN public.files f ON f.id = a.file_id
   WHERE t.id = p_thing AND t.location_id IN (SELECT kept.visible_location_ids())
     AND a.role IN ('receipt', 'invoice')
   ORDER BY a.sort, a.id
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.thing_receipts(uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.thing_receipts(uuid) TO kept_app;
