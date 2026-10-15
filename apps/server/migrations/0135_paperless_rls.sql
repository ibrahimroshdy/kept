-- Custom SQL migration file, put your code below! --
-- 1.x, D248: Paperless-ngx, 0134's tables.
--   1. paperless_connections: every member of the location reads that it is connected and where
--      (the thing page's "Open in Paperless"); its owners and admins connect, change and
--      disconnect it (location.settings), never through a token. kept_app never reads the sealed
--      URL and token: the server opens them through kept.paperless_config() (SYS) once the
--      request has passed kept_app's checks. kept_system has no business with the table.
--   2. paperless_links: members read the links of the location's things and places; members and
--      up (writable locations) link, refresh, copy and unlink, never through a token, and only to
--      a live thing or place of the link's own location. A link names a document in its own
--      location's Paperless, so a thing moved to another location leaves its links behind
--      (kept.drop_moved_paperless_links, a trigger on things).
-- src/paperless/paperless.test.ts tests them; test/leak.test.ts and src/db/migrate.test.ts list the
-- functions.

-- 1. paperless_connections ----------------------------------------------------------------------------------
ALTER TABLE public.paperless_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.paperless_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.paperless_connections FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.paperless_connections
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE POLICY app_select ON public.paperless_connections FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.paperless_connections FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND created_by = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_update ON public.paperless_connections FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_delete ON public.paperless_connections FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids())
         AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
REVOKE SELECT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.paperless_connections FROM kept_app;
--> statement-breakpoint
REVOKE ALL ON public.paperless_connections FROM kept_system;
--> statement-breakpoint
-- Every column but the sealed URL and token.
GRANT SELECT (id, location_id, base_url, key_version, server_version, created_by, created_at,
              updated_at, row_version, change_seq)
  ON public.paperless_connections TO kept_app;
--> statement-breakpoint
-- Not granted: the id, location_id and created_by.
GRANT UPDATE (base_url, config_ciphertext, key_version, server_version, updated_at, row_version)
  ON public.paperless_connections TO kept_app;
--> statement-breakpoint

-- 2. paperless_links ----------------------------------------------------------------------------------------
ALTER TABLE public.paperless_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.paperless_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.paperless_links FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.paperless_links
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE POLICY app_select ON public.paperless_links FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.paperless_links FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL
              AND copied_attachment_id IS NULL
              AND (thing_id IS NULL
                   OR EXISTS (SELECT 1 FROM public.things t
                               WHERE t.id = paperless_links.thing_id
                                 AND t.location_id = paperless_links.location_id
                                 AND t.deleted_at IS NULL))
              AND (place_id IS NULL
                   OR EXISTS (SELECT 1 FROM public.places p
                               WHERE p.id = paperless_links.place_id
                                 AND p.location_id = paperless_links.location_id
                                 AND p.deleted_at IS NULL)));
--> statement-breakpoint
CREATE POLICY app_update ON public.paperless_links FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND (SELECT kept.current_token_id()) IS NULL
              AND (copied_attachment_id IS NULL
                   OR EXISTS (SELECT 1 FROM public.attachments a
                               WHERE a.id = paperless_links.copied_attachment_id
                                 AND a.location_id = paperless_links.location_id)));
--> statement-breakpoint
CREATE POLICY app_delete ON public.paperless_links FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids())
         AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.paperless_links FROM kept_app;
--> statement-breakpoint
REVOKE ALL ON public.paperless_links FROM kept_system;
--> statement-breakpoint
-- The cache and the copy; never the document, subject, connection or location.
GRANT UPDATE (title, kind, type_name, correspondent, created_on, copied_attachment_id,
              refreshed_at, updated_at, row_version)
  ON public.paperless_links TO kept_app;
--> statement-breakpoint

-- 3. The door -----------------------------------------------------------------------------------------------
-- A location's connection with its sealed URL and token, for the server once a request has passed
-- kept_app's checks (SYS).
CREATE FUNCTION kept.paperless_config(p_location uuid)
RETURNS TABLE (id uuid, base_url text, config_ciphertext jsonb, key_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id, c.base_url, c.config_ciphertext, c.key_version
    FROM public.paperless_connections c WHERE c.location_id = p_location
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.paperless_config(uuid) FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.paperless_config(uuid) TO kept_system;
--> statement-breakpoint

-- 4. A thing that leaves its location leaves its links ------------------------------------------------------
-- Its links name documents in the old location's Paperless, which the new location's members may
-- not see. Definer: kept.move_things() moves the thing, and the links may be unreadable to the
-- mover there. Nobody calls it.
CREATE FUNCTION kept.drop_moved_paperless_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.paperless_links l
   WHERE l.thing_id = NEW.id AND l.location_id <> NEW.location_id;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.drop_moved_paperless_links() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER drop_moved_paperless_links AFTER UPDATE OF location_id ON public.things
  FOR EACH ROW WHEN (OLD.location_id IS DISTINCT FROM NEW.location_id)
  EXECUTE FUNCTION kept.drop_moved_paperless_links();
