-- Step 3 follow-up: meters in the offline snapshot (READING offline; plan T12, T13). A SnapThing
-- now carries its meters (sync/snapshot.ts), and the snapshot's delta reads a thing only when its
-- change_xid moves. Adding a meter, or changing its kind, unit or label, doesn't touch the thing,
-- so the phone would never learn of it. Below drizzle's column:
--   1. things.meter_version joins cover_file_id among the columns that bump change_seq only
--      (kept.touch_row's second argument): the snapshot resends the thing, and its row_version,
--      the one an edit's If-Match names, stays.
--   2. kept.touch_thing_meters(), a definer (things.meter_version has no column grant), bumps it
--      for a meter's thing, as kept.refresh_thing_cover() keeps cover_file_id. Meters are never
--      deleted on their own (only with their thing), so a delete needs nothing, and a move's
--      cascade, which changes no value READING shows, doesn't fire it.
--   3. kept.move_things() (0024's) recomputes the moved contents' place_path once every moved
--      row is written. Its one UPDATE computed a content's path from its container as the rows
--      before it in that statement had left it, so the result followed the rows' order on disk;
--      bumping a box (2.) after its contents were made put it after them, and a move then left
--      them under the box's old place (inventory-definers.test.ts). A box edited after its
--      contents were added did the same before this.
-- test/leak.test.ts and src/db/migrate.test.ts list the function.
ALTER TABLE "things" ADD COLUMN "meter_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP TRIGGER touch_row ON public.things;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row('place_path,search_tsv', 'last_seen_at,cover_file_id,meter_version');
--> statement-breakpoint
CREATE FUNCTION kept.touch_thing_meters() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  ids uuid[] := ARRAY[NEW.thing_id];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.thing_id IS DISTINCT FROM NEW.thing_id THEN
    ids := ids || OLD.thing_id;
  END IF;
  UPDATE public.things t SET meter_version = t.meter_version + 1 WHERE t.id = ANY (ids);
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.touch_thing_meters() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER meters_thing_version AFTER INSERT ON public.meters
  FOR EACH ROW EXECUTE FUNCTION kept.touch_thing_meters();
--> statement-breakpoint
-- Only a real change: a move's cascade (meters_thing_fk, ON UPDATE CASCADE) sets thing_id to
-- itself, and bumping the thing from inside that cascade would re-run its triggers mid-move.
CREATE TRIGGER meters_thing_version_update
  AFTER UPDATE OF kind, unit, label, thing_id ON public.meters
  FOR EACH ROW
  WHEN (OLD.kind IS DISTINCT FROM NEW.kind OR OLD.unit IS DISTINCT FROM NEW.unit
        OR OLD.label IS DISTINCT FROM NEW.label OR OLD.thing_id IS DISTINCT FROM NEW.thing_id)
  EXECUTE FUNCTION kept.touch_thing_meters();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.move_things(p_ids uuid[], p_to_location uuid, p_place uuid,
                                            p_container uuid)
RETURNS TABLE (thing_id uuid, from_location uuid, dropped_link_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  uid uuid := kept.current_user_id();
  ids uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(p_ids) AS x WHERE x IS NOT NULL);
  target_acct uuid;
  set_ids uuid[];
  set_locs uuid[];
  leaving uuid[];
  r record;
  map_id uuid[] := '{}';
  map_type uuid[] := '{}';
  map_brand uuid[] := '{}';
  map_person uuid[] := '{}';
  map_line uuid[] := '{}';
  map_custom jsonb[] := '{}';
  map_archived jsonb[] := '{}';
  line_from uuid[] := '{}';
  line_to uuid[] := '{}';
  new_line uuid;
  new_type uuid;
  split record;
  dropped record;
  drop_ids uuid[] := '{}';
  drop_from uuid[] := '{}';
  drop_to uuid[] := '{}';
  child_locs uuid[] := '{}';
  child_kinds text[] := '{}';
  child_ids uuid[] := '{}';
  tf public.type_fields%ROWTYPE;
  ty public.types%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'moving needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cardinality(ids) = 0 OR num_nonnulls(p_place, p_container) <> 1 THEN
    RAISE EXCEPTION 'a move takes things and exactly one of a place or a container'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT coalesce(p_to_location IN (SELECT kept.writable_location_ids()), false) THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT l.owner_account_id INTO target_acct FROM public.locations l WHERE l.id = p_to_location;
  IF (SELECT count(*) FROM public.things t
       WHERE t.id = ANY (ids) AND t.deleted_at IS NULL
         AND t.location_id IN (SELECT kept.writable_location_ids())) <> cardinality(ids) THEN
    RAISE EXCEPTION 'no such things of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_place IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.places p
        WHERE p.id = p_place AND p.location_id = p_to_location AND p.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'no such place' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_container IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.things c
        WHERE c.id = p_container AND c.location_id = p_to_location AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'no such container' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kept.things'), hashtext(p_to_location::text));

  -- The set: the things and everything inside them, with where each is now.
  SELECT array_agg(s.id ORDER BY s.id), array_agg(t.location_id ORDER BY s.id)
    INTO set_ids, set_locs
    FROM (WITH RECURSIVE s(id) AS (
            SELECT unnest(ids)
            UNION
            SELECT t.id FROM public.things t JOIN s ON t.container_id = s.id)
          SELECT id FROM s) s
    JOIN public.things t ON t.id = s.id;
  IF p_container = ANY (set_ids) THEN
    RAISE EXCEPTION 'a thing can''t go inside itself or something inside it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_no_loop';
  END IF;
  leaving := ARRAY(SELECT x.id FROM unnest(set_ids, set_locs) AS x(id, loc)
                    WHERE x.loc <> p_to_location);

  -- C1: secrets leave a location only with its owner, who can reveal them there.
  IF EXISTS (SELECT 1 FROM public.secret_values s
               JOIN unnest(set_ids, set_locs) AS x(id, loc) ON s.thing_id = x.id
              WHERE x.loc <> p_to_location
                AND NOT (kept.owns_location(x.loc)
                         AND kept.can_reveal_secret(x.loc, s.type_field_id))) THEN
    RAISE EXCEPTION 'only the location''s owner moves its secrets elsewhere'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'things_move_secrets';
  END IF;

  -- D156: what leaves with the things, to tombstone where it was.
  SELECT coalesce(array_agg(c.loc), '{}'), coalesce(array_agg(c.kind), '{}'),
         coalesce(array_agg(c.id), '{}')
    INTO child_locs, child_kinds, child_ids
    FROM (SELECT a.location_id AS loc, 'attachment'::text AS kind, a.id FROM public.attachments a
           WHERE a.thing_id = ANY (leaving)
          UNION ALL
          SELECT m.location_id, 'meter', m.id FROM public.meters m WHERE m.thing_id = ANY (leaving)
          UNION ALL
          SELECT d.location_id, 'meter_reading', d.id FROM public.meter_readings d
            JOIN public.meters m ON m.id = d.meter_id WHERE m.thing_id = ANY (leaving)
          UNION ALL
          SELECT e.location_id, 'meter_event', e.id FROM public.meter_events e
            JOIN public.meters m ON m.id = e.meter_id WHERE m.thing_id = ANY (leaving)
          UNION ALL
          SELECT a.location_id, 'attachment', a.id FROM public.attachments a
            JOIN public.meter_readings d ON d.id = a.meter_reading_id
            JOIN public.meters m ON m.id = d.meter_id WHERE m.thing_id = ANY (leaving)
          UNION ALL
          SELECT k.location_id, 'thing_link', k.id FROM public.thing_links k
           WHERE k.from_thing_id = ANY (leaving) AND k.to_thing_id = ANY (leaving)) c;

  -- Links to something staying behind (or already elsewhere) would cross locations.
  FOR dropped IN
    DELETE FROM public.thing_links k
     WHERE (k.from_thing_id = ANY (set_ids) OR k.to_thing_id = ANY (set_ids))
       AND (k.from_thing_id = ANY (set_ids)) <> (k.to_thing_id = ANY (set_ids))
       AND k.location_id <> p_to_location
    RETURNING k.id, k.location_id, k.from_thing_id, k.to_thing_id
  LOOP
    drop_ids := drop_ids || dropped.id;
    drop_from := drop_from || dropped.from_thing_id;
    drop_to := drop_to || dropped.to_thing_id;
    child_locs := child_locs || dropped.location_id;
    child_kinds := child_kinds || 'thing_link'::text;
    child_ids := child_ids || dropped.id;
  END LOOP;

  -- Across accounts: map the registries, the custom references and the purchase line, before
  -- anything moves.
  FOR r IN
    SELECT t.id, t.type_id, t.brand_id, t.belongs_to_person_id, t.purchase_line_id, t.custom,
           t.archived_custom, l.owner_account_id AS src_acct
      FROM public.things t JOIN public.locations l ON l.id = t.location_id
     WHERE t.id = ANY (set_ids) AND l.owner_account_id <> target_acct
  LOOP
    new_type := kept.map_type(r.type_id, target_acct);
    split := kept.split_custom(
               kept.remap_custom_refs(r.custom, r.type_id, r.src_acct, target_acct), new_type);
    map_id := map_id || r.id;
    map_type := map_type || new_type;
    map_brand := map_brand || kept.map_registry('brand', r.brand_id, target_acct);
    map_person := map_person || kept.map_registry('person', r.belongs_to_person_id, target_acct);
    map_custom := array_append(map_custom, split.kept_values);
    map_archived := array_append(map_archived, r.archived_custom || split.archived);
    new_line := NULL;
    IF r.purchase_line_id IS NOT NULL THEN
      IF r.purchase_line_id = ANY (line_from) THEN
        new_line := line_to[array_position(line_from, r.purchase_line_id)];
      ELSE
        new_line := kept.copy_purchase_line(r.purchase_line_id, p_to_location, target_acct);
        line_from := line_from || r.purchase_line_id;
        line_to := line_to || new_line;
      END IF;
    END IF;
    map_line := map_line || new_line;
  END LOOP;

  -- Everything in one statement: the moved things to the target, their contents along (their
  -- own container keys follow the same statement, so the cascade finds nothing left to do).
  SET CONSTRAINTS public.attachments_file_fk DEFERRED;
  UPDATE public.things t
     SET location_id = p_to_location,
         place_id = CASE WHEN t.id = ANY (ids) THEN p_place ELSE t.place_id END,
         container_id = CASE WHEN t.id = ANY (ids) THEN p_container ELSE t.container_id END,
         location_uncertain = CASE WHEN t.id = ANY (ids) THEN false ELSE t.location_uncertain END,
         last_seen_at = CASE WHEN t.id = ANY (ids) THEN now() ELSE t.last_seen_at END,
         type_id = CASE WHEN m.id IS NULL THEN t.type_id ELSE m.type_id END,
         brand_id = CASE WHEN m.id IS NULL THEN t.brand_id ELSE m.brand_id END,
         belongs_to_person_id = CASE WHEN m.id IS NULL THEN t.belongs_to_person_id
                                     ELSE m.person_id END,
         purchase_line_id = CASE WHEN m.id IS NULL THEN t.purchase_line_id ELSE m.line_id END,
         custom = CASE WHEN m.id IS NULL THEN t.custom ELSE m.custom END,
         archived_custom = CASE WHEN m.id IS NULL THEN t.archived_custom ELSE m.archived END
    FROM unnest(set_ids) AS s(id)
    LEFT JOIN unnest(map_id, map_type, map_brand, map_person, map_line, map_custom, map_archived)
           AS m(id, type_id, brand_id, person_id, line_id, custom, archived) ON m.id = s.id
   WHERE t.id = s.id;

  -- 0047: the contents' caches again, now that every moved row is written. The statement above
  -- computed each one's place_path (and the "where it is" of search_tsv) from its container as
  -- that statement's earlier rows had left it, so a box written after its contents (a later
  -- edit, a meter) came out of the move with its contents still under its old place. Setting a
  -- quiet cache column to NULL makes kept.thing_cache() recompute it; row_version stays.
  UPDATE public.things t SET place_path = NULL
   WHERE t.id = ANY (set_ids) AND NOT t.id = ANY (ids);

  -- Attachment files of the moved things (and of their readings) now in another location than
  -- their attachment: re-homed (D161).
  FOR r IN
    SELECT a.id, a.file_id FROM public.attachments a JOIN public.files f ON f.id = a.file_id
     WHERE a.location_id = p_to_location AND f.location_id <> a.location_id
       AND (a.thing_id = ANY (set_ids)
            OR a.meter_reading_id IN (SELECT d.id FROM public.meter_readings d
                                        JOIN public.meters m ON m.id = d.meter_id
                                       WHERE m.thing_id = ANY (set_ids)))
  LOOP
    UPDATE public.attachments SET file_id = kept.copy_file(r.file_id, p_to_location)
     WHERE id = r.id;
  END LOOP;
  SET CONSTRAINTS public.attachments_file_fk IMMEDIATE;

  -- Across accounts: tags by name.
  INSERT INTO public.thing_tags (location_id, thing_id, tag_id)
  SELECT p_to_location, x.thing_id, kept.map_registry('tag', x.tag_id, target_acct)
    FROM public.thing_tags x JOIN public.tags g ON g.id = x.tag_id
   WHERE x.thing_id = ANY (set_ids) AND g.owner_account_id <> target_acct
  ON CONFLICT DO NOTHING;
  DELETE FROM public.thing_tags x USING public.tags g
   WHERE g.id = x.tag_id AND x.thing_id = ANY (set_ids) AND g.owner_account_id <> target_acct;

  -- Across accounts: secret values of the other account's fields, onto the target's.
  FOR r IN
    SELECT s.id, s.field_key, t.type_id, f.label
      FROM public.secret_values s
      JOIN public.things t ON t.id = s.thing_id
      JOIN public.type_fields f ON f.id = s.type_field_id
     WHERE s.thing_id = ANY (set_ids)
       AND f.owner_account_id IS NOT NULL AND f.owner_account_id <> target_acct
     ORDER BY s.created_at, s.id
  LOOP
    tf := NULL;
    SELECT * INTO tf FROM public.type_fields WHERE id = kept.field_for_key(r.type_id, r.field_key);
    IF tf.id IS NULL THEN
      ty := NULL;
      SELECT * INTO ty FROM public.types WHERE id = r.type_id;
      IF ty.id IS NOT NULL AND ty.owner_account_id = target_acct THEN
        INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind, secret,
                                        archived_at)
        VALUES (target_acct, ty.id, r.field_key, r.label, 'text', true, now())
        RETURNING * INTO tf;
      END IF;
    END IF;
    IF tf.id IS NULL OR NOT tf.secret THEN
      RAISE EXCEPTION 'the thing''s type in the target account has no secret field %', r.field_key
        USING ERRCODE = 'check_violation', CONSTRAINT = 'things_move_secret_field';
    END IF;
    -- A value on an archived field is history.
    UPDATE public.secret_values
       SET type_field_id = tf.id,
           superseded_at = coalesce(superseded_at, CASE WHEN tf.archived_at IS NOT NULL
                                                        THEN now() END)
     WHERE id = r.id;
  END LOOP;

  -- Sync (§7.4): gone from each source location; no longer gone from the target.
  INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
  SELECT x.loc, 'thing', x.id FROM unnest(set_ids, set_locs) AS x(id, loc)
   WHERE x.loc <> p_to_location
  UNION ALL
  SELECT c.loc, c.kind, c.id FROM unnest(child_locs, child_kinds, child_ids) AS c(loc, kind, id)
  ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now();
  DELETE FROM public.sync_tombstones z
   WHERE z.location_id = p_to_location
     AND ((z.entity_type = 'thing' AND z.entity_id = ANY (set_ids))
          OR (z.entity_type <> 'thing' AND z.entity_id = ANY (child_ids)
              AND NOT z.entity_id = ANY (drop_ids)));

  RETURN QUERY
  SELECT x.id, x.loc,
         coalesce(ARRAY(SELECT d.id FROM unnest(drop_ids, drop_from, drop_to) AS d(id, f, t)
                         WHERE d.f = x.id OR d.t = x.id), '{}'::uuid[])
    FROM unnest(set_ids, set_locs) AS x(id, loc);
END $$;
