-- Custom SQL migration file, put your code below! --
-- 1.5, D233: read-only share links (D39 item 7, D72, D116, D180; engineering spec §1, §3.2,
-- §3.3), 0126's table.
--   1. share_links: its location's owners and admins read, make and revoke them
--      (share-links.create); never through a token, never in a Personal location (D114), never
--      for a box or place of another location, at most 100 live ones a location
--      (share_links_cap). kept_app can't read token_hash back, and changes only revoked_at, once.
--      Rows are revoked, never deleted by a request, so the list says what happened to each.
--      kept_system has no business with the table: the public page reads through the door.
--   2. What a link shows (owner-only, called by the doors): kept.share_link_contents(link, page),
--      the D116 whitelist as JSON (name, photo, type, place path, quantity, condition,
--      description) for the box and what is in it, a place and what is in it, or a filtered list,
--      in the link's own location only. Never an id, money, a serial, a secret, a person, a loan
--      or a document; a photo is its cover's derivative storage keys, which the server signs as
--      five-minute URLs and never sends as they are.
--   3. The doors: kept.share_link_open(token hash, page) (SYS), the public page's, which counts a
--      view of its first page; kept.share_link_preview(link, page) (APP), "Preview as recipient"
--      for the location's admins. A link opens only while it is unrevoked, unexpired and backed
--      by its creator: still an owner or admin of a live, non-personal location, and not banned
--      (D180, checked on every view).
-- src/sharelinks/sharelinks.test.ts tests them; test/leak.test.ts and src/db/migrate.test.ts list
-- the functions.

-- 1. share_links --------------------------------------------------------------------------------------------
ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.share_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.share_links FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_select ON public.share_links FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.share_links FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids())
              AND created_by = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL
              AND revoked_at IS NULL AND views = 0 AND last_viewed_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.locations lo
                               WHERE lo.id = share_links.location_id AND lo.kind = 'personal')
              AND (thing_id IS NULL
                   OR EXISTS (SELECT 1 FROM public.things t
                               WHERE t.id = share_links.thing_id
                                 AND t.location_id = share_links.location_id
                                 AND t.deleted_at IS NULL))
              AND (place_id IS NULL
                   OR EXISTS (SELECT 1 FROM public.places p
                               WHERE p.id = share_links.place_id
                                 AND p.location_id = share_links.location_id
                                 AND p.deleted_at IS NULL)));
--> statement-breakpoint
-- Revoking is the only change, and it is for good.
CREATE POLICY app_update ON public.share_links FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()) AND revoked_at IS NULL)
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()) AND revoked_at IS NOT NULL);
--> statement-breakpoint
REVOKE SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.share_links FROM kept_app;
--> statement-breakpoint
REVOKE ALL ON public.share_links FROM kept_system;
--> statement-breakpoint
-- Every column but the token's hash.
GRANT SELECT (id, location_id, scope_type, thing_id, place_id, filter, title, expires_at,
              revoked_at, created_by, created_at, views, last_viewed_at)
  ON public.share_links TO kept_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON public.share_links TO kept_app;
--> statement-breakpoint

-- The cap. Invoker: the inserting admin sees every link of the location.
CREATE FUNCTION kept.guard_share_link_cap() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kept.share_links_cap'), hashtext(NEW.location_id::text));
  IF (SELECT count(*) FROM public.share_links s
       WHERE s.location_id = NEW.location_id AND s.revoked_at IS NULL AND s.expires_at > now()
         AND s.id <> NEW.id) >= 100 THEN
    RAISE EXCEPTION 'a location has at most 100 live share links'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'share_links_cap';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER share_links_cap BEFORE INSERT ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION kept.guard_share_link_cap();
--> statement-breakpoint

-- 2. What a link shows ---------------------------------------------------------------------------------------
-- A breadcrumb without ids: each step's name, kind, and whether it is the Unplaced area.
CREATE FUNCTION kept.share_path(p_place uuid, p_container uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name', e->>'name',
           'kind', e->>'kind',
           'isUnplaced', coalesce((SELECT pl.is_unplaced FROM public.places pl
                                    WHERE e->>'kind' = 'place' AND pl.id = (e->>'id')::uuid),
                                  false))
         ORDER BY n), '[]'::jsonb)
    FROM jsonb_array_elements(kept.path_of(p_place, p_container)) WITH ORDINALITY AS x(e, n)
$$;
--> statement-breakpoint
-- One thing as D116 allows: name, photo, type, place path, quantity, condition, description
-- (its notes). The photo is the cover (the first `photo` attachment, 0036) with its derivatives'
-- storage keys, for the server to sign; a cover without a ready preview shows none.
CREATE FUNCTION kept.share_thing_json(t public.things) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'name', t.name,
    'type', (SELECT jsonb_build_object('icon', ty.icon, 'name', ty.name,
                                       'builtinKey', ty.builtin_key)
               FROM public.types ty WHERE ty.id = t.type_id),
    'path', kept.share_path(t.place_id, t.container_id),
    'quantity', t.quantity,
    'condition', t.condition,
    'description', t.notes,
    'photo', (SELECT jsonb_build_object(
                       'fileId', f.id,
                       'mime', f.mime,
                       'thumb', (SELECT d.storage_key FROM public.file_derivatives d
                                  WHERE d.file_id = f.id AND d.variant = 'thumb'),
                       'large', coalesce(
                         (SELECT d.storage_key FROM public.file_derivatives d
                           WHERE d.file_id = f.id AND d.variant = 'share'),
                         (SELECT d.storage_key FROM public.file_derivatives d
                           WHERE d.file_id = f.id AND d.variant = 'display')))
                FROM public.files f
               WHERE f.id = t.cover_file_id AND f.derivative_state = 'ready'
                 AND f.location_id = t.location_id))
$$;
--> statement-breakpoint
-- The page: the subject (the box, the place, or none for a list), the matching things' count,
-- and one page of them, A to Z, 60 a page and 1,200 in all (D72's size cap). Things in the trash,
-- drafts and things that ended (sold, lost, stolen…) are left out; so is anything outside the
-- link's location, whatever moved. NULL when the box or place is gone or has left the location.
CREATE FUNCTION kept.share_link_contents(p_link uuid, p_page integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  l public.share_links%ROWTYPE;
  f jsonb;
  subject jsonb;
  ids uuid[];
  in_places uuid[];
  roots uuid[];
  types uuid[];
  tags uuid[];
  total integer;
  items jsonb;
  page integer := greatest(coalesce(p_page, 0), 0);
  size constant integer := 60;
  cap constant integer := 1200;
BEGIN
  SELECT * INTO l FROM public.share_links s WHERE s.id = p_link;
  IF l.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF l.scope_type = 'thing' THEN
    SELECT kept.share_thing_json(t) INTO subject FROM public.things t
     WHERE t.id = l.thing_id AND t.location_id = l.location_id AND t.deleted_at IS NULL;
    IF subject IS NULL THEN
      RETURN NULL;
    END IF;
    WITH RECURSIVE inside(id) AS (
      SELECT x.id FROM public.things x WHERE x.container_id = l.thing_id
      UNION
      SELECT x.id FROM public.things x JOIN inside i ON x.container_id = i.id
    )
    SELECT array_agg(i.id) INTO ids FROM inside i;
  ELSIF l.scope_type = 'place' THEN
    SELECT jsonb_build_object('name', p.name, 'isUnplaced', p.is_unplaced,
                              'path', kept.share_path(p.parent_id, NULL))
      INTO subject FROM public.places p
     WHERE p.id = l.place_id AND p.location_id = l.location_id AND p.deleted_at IS NULL;
    IF subject IS NULL THEN
      RETURN NULL;
    END IF;
    WITH RECURSIVE sub(id) AS (
      SELECT l.place_id
      UNION
      SELECT c.id FROM public.places c JOIN sub ON c.parent_id = sub.id WHERE c.deleted_at IS NULL
    ),
    inside(id) AS (
      SELECT x.id FROM public.things x WHERE x.place_id IN (SELECT s.id FROM sub s)
      UNION
      SELECT x.id FROM public.things x JOIN inside i ON x.container_id = i.id
    )
    SELECT array_agg(i.id) INTO ids FROM inside i;
  ELSE
    -- A filtered list (@kept/shared ShareView): the words as the search matches them (`tsq`,
    -- made by the server from @kept/shared tsQuery()), and places, types and tags, each "any of"
    -- or "none of" (`not`). A thing with no type or tag is "none of" any.
    f := l.filter;
    roots := ARRAY(SELECT jsonb_array_elements_text(coalesce(f->'filters'->'place', '[]'))::uuid);
    types := ARRAY(SELECT jsonb_array_elements_text(coalesce(f->'filters'->'type', '[]'))::uuid);
    tags := ARRAY(SELECT jsonb_array_elements_text(coalesce(f->'filters'->'tag', '[]'))::uuid);
    IF cardinality(roots) > 0 THEN
      WITH RECURSIVE sub(id) AS (
        SELECT pl.id FROM public.places pl
         WHERE pl.id = ANY (roots) AND pl.location_id = l.location_id
        UNION
        SELECT c.id FROM public.places c JOIN sub ON c.parent_id = sub.id
      ),
      inside(id) AS (
        SELECT x.id FROM public.things x
         WHERE x.location_id = l.location_id
           AND (x.place_id IN (SELECT s.id FROM sub s) OR x.container_id = ANY (roots))
        UNION
        SELECT x.id FROM public.things x JOIN inside i ON x.container_id = i.id
      )
      SELECT coalesce(array_agg(i.id), ARRAY[]::uuid[]) INTO in_places FROM inside i;
    END IF;
    SELECT array_agg(t.id) INTO ids FROM public.things t
     WHERE t.location_id = l.location_id AND t.deleted_at IS NULL
       AND (f->>'tsq' IS NULL OR t.search_tsv @@ to_tsquery('simple', f->>'tsq'))
       AND (cardinality(roots) = 0
            OR (t.id = ANY (in_places)) <> coalesce(f->'not' ? 'place', false))
       AND (cardinality(types) = 0
            OR coalesce(t.type_id = ANY (types), false) <> coalesce(f->'not' ? 'type', false))
       AND (cardinality(tags) = 0
            OR EXISTS (SELECT 1 FROM public.thing_tags g
                        WHERE g.thing_id = t.id AND g.tag_id = ANY (tags))
               <> coalesce(f->'not' ? 'tag', false));
  END IF;

  ids := coalesce(ids, ARRAY[]::uuid[]);
  SELECT count(*)::integer INTO total FROM public.things t
   WHERE t.id = ANY (ids) AND t.location_id = l.location_id AND t.deleted_at IS NULL
     AND t.review_state = 'confirmed' AND t.lifecycle = 'in_use';
  IF page * size >= cap THEN
    items := '[]'::jsonb;
  ELSE
    SELECT coalesce(jsonb_agg(kept.share_thing_json(x.t) ORDER BY x.n), '[]'::jsonb) INTO items
      FROM (SELECT t, row_number() OVER (ORDER BY lower(coalesce(t.name, '')) COLLATE "und-x-icu",
                                                  t.id) AS n
              FROM public.things t
             WHERE t.id = ANY (ids) AND t.location_id = l.location_id AND t.deleted_at IS NULL
               AND t.review_state = 'confirmed' AND t.lifecycle = 'in_use'
             ORDER BY lower(coalesce(t.name, '')) COLLATE "und-x-icu", t.id
             OFFSET page * size LIMIT least(size, cap - page * size)) x;
  END IF;
  RETURN jsonb_build_object(
    'scope', l.scope_type,
    'title', l.title,
    'subject', subject,
    'total', total,
    'page', page,
    'pageSize', size,
    'cap', cap,
    'items', items,
    'expiresAt', l.expires_at);
END $$;
--> statement-breakpoint
-- Whether the link's creator still stands behind it (D180): an owner or admin, unexpired, of a
-- live location that isn't a Personal one, and not banned.
CREATE FUNCTION kept.share_link_backed(p_link uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.share_links s
      JOIN public.memberships m ON m.location_id = s.location_id AND m.user_id = s.created_by
      JOIN public.locations lo ON lo.id = s.location_id
     WHERE s.id = p_link AND m.role IN ('owner', 'admin')
       AND (m.expires_at IS NULL OR m.expires_at > now())
       AND lo.deleted_at IS NULL AND lo.kind <> 'personal'
       AND NOT EXISTS (SELECT 1 FROM auth."user" u
                        WHERE u.id = s.created_by AND coalesce(u.banned, false)))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_share_link_cap(), kept.share_path(uuid, uuid),
  kept.share_thing_json(public.things), kept.share_link_contents(uuid, integer),
  kept.share_link_backed(uuid)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 3. The doors ---------------------------------------------------------------------------------------------
-- The public page (SYS): a live, backed link by its token's hash, or NULL for anything else (never
-- saying which). Opening the first page counts a view.
CREATE FUNCTION kept.share_link_open(p_token_hash text, p_page integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  l public.share_links%ROWTYPE;
  out jsonb;
BEGIN
  SELECT * INTO l FROM public.share_links s
   WHERE s.token_hash = p_token_hash AND p_token_hash ~ '^[0-9a-f]{64}$';
  IF l.id IS NULL OR l.revoked_at IS NOT NULL OR l.expires_at <= now()
     OR NOT kept.share_link_backed(l.id) THEN
    RETURN NULL;
  END IF;
  out := kept.share_link_contents(l.id, p_page);
  IF out IS NOT NULL AND coalesce(p_page, 0) = 0 THEN
    UPDATE public.share_links s SET views = s.views + 1, last_viewed_at = now() WHERE s.id = l.id;
  END IF;
  RETURN out;
END $$;
--> statement-breakpoint
-- "Preview as recipient" (APP): the same page for an admin of the link's location, whatever the
-- link's state, without counting a view. Never through a token.
CREATE FUNCTION kept.share_link_preview(p_link uuid, p_page integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF kept.current_user_id() IS NULL OR kept.current_token_id() IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.share_links s
                     WHERE s.id = p_link
                       AND s.location_id IN (SELECT kept.admin_location_ids())) THEN
    RETURN NULL;
  END IF;
  RETURN kept.share_link_contents(p_link, p_page);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.share_link_open(text, integer),
  kept.share_link_preview(uuid, integer)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.share_link_open(text, integer) TO kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.share_link_preview(uuid, integer) TO kept_app;
