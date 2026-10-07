-- Custom SQL migration file, put your code below! --
-- Step 2, task 9: the definer paths the inventory routes use for what the policies can't express
-- (engineering spec §6.1, §7.2, §7.4, §7.9, §7.13; D45, D92, D115, D123, D160, D161, D177; plan
-- Q13, Q13b, Q14). Each public one is SECURITY DEFINER, kept_app only, checks its caller from
-- app.user_id first, and refuses anything the caller can't see or write with 42501 (a 404),
-- exactly as for an id that doesn't exist. None writes an audit event: the route does, in the
-- same transaction. Phase B calls these; it never re-implements them.
--   1. Helpers (invoker, kept_owner's only; called from the definers below).
--   2. kept.move_things(): across places, locations and accounts.
--   3. kept.convert_place_to_container() / kept.convert_container_to_place(): same UUID.
--   4. kept.merge_places() and kept.merge_registry().
--   5. kept.customise_type() and kept.type_impact().
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.

-- 1. Helpers ---------------------------------------------------------------------------------

-- The field keys a type resolves: its own and its ancestors', and those of their field groups.
CREATE FUNCTION kept.resolved_keys(p_type uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT f.key), '{}'::text[])
    FROM kept.type_chain(p_type) ch
    JOIN public.types t ON t.id = ch.id
    JOIN public.type_fields f ON f.type_id = t.id OR f.type_id = ANY (t.field_groups)
$$;
--> statement-breakpoint
-- The field a type resolves for `p_key` (nearest first), or NULL.
CREATE FUNCTION kept.field_for_key(p_type uuid, p_key text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT f.id
    FROM kept.type_chain(p_type) ch
    JOIN public.types t ON t.id = ch.id
    JOIN public.type_fields f ON f.type_id = t.id OR f.type_id = ANY (t.field_groups)
   WHERE f.key = p_key
   ORDER BY ch.depth, f.type_id = t.id DESC
   LIMIT 1
$$;
--> statement-breakpoint
-- The type in `p_account` that stands for `p_type` (Q13): a built-in or one of the account's own
-- is itself; otherwise a matching type of the account (same parent after mapping, same
-- normalised name, or the same customised built-in), or a copy made now with its fields, its
-- parent chain mapped first and its field groups mapped too.
CREATE FUNCTION kept.map_type(p_type uuid, p_account uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  src public.types%ROWTYPE;
  parent_copy uuid;
  groups_copy uuid[];
  found_id uuid;
  new_id uuid := uuidv7();
BEGIN
  IF p_type IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO src FROM public.types WHERE id = p_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such type' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF src.owner_account_id IS NULL OR src.owner_account_id = p_account THEN
    RETURN src.id;
  END IF;
  parent_copy := kept.map_type(src.parent_id, p_account);
  SELECT coalesce(array_agg(kept.map_type(g.id, p_account) ORDER BY g.n), '{}'::uuid[])
    INTO groups_copy FROM unnest(src.field_groups) WITH ORDINALITY AS g(id, n);
  SELECT t.id INTO found_id FROM public.types t
   WHERE t.owner_account_id = p_account AND t.is_field_group = src.is_field_group
     AND t.parent_id IS NOT DISTINCT FROM parent_copy AND t.archived_at IS NULL
     AND CASE WHEN src.name IS NULL
              THEN t.name IS NULL AND t.copied_from_id IS NOT DISTINCT FROM src.copied_from_id
              ELSE t.name IS NOT NULL AND kept.normalize(t.name) = kept.normalize(src.name) END
   ORDER BY t.created_at, t.id
   LIMIT 1;
  IF found_id IS NOT NULL THEN
    RETURN found_id;
  END IF;
  INSERT INTO public.types (id, owner_account_id, copied_from_id, parent_id, name, icon, colour,
                            capabilities, default_meter, is_field_group, field_groups,
                            default_warranty_months)
  VALUES (new_id, p_account, src.copied_from_id, parent_copy, src.name, src.icon, src.colour,
          src.capabilities, src.default_meter, src.is_field_group, groups_copy,
          src.default_warranty_months);
  INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind, unit, options,
                                  repeatable, required, sort, secret, archived_at)
  SELECT p_account, new_id, f.key, f.label, f.kind, f.unit, f.options, f.repeatable, f.required,
         f.sort, f.secret, f.archived_at
    FROM public.type_fields f WHERE f.type_id = src.id;
  RETURN new_id;
END $$;
--> statement-breakpoint
-- The brand, vendor, person or tag in `p_account` that stands for `p_id` (Q13): the same row if
-- it is already the account's; else one with the same normalised name; else a copy made now.
-- A person is copied by name only: contact details never cross accounts (D177).
CREATE FUNCTION kept.map_registry(p_kind text, p_id uuid, p_account uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  src record;
  found_id uuid;
  new_id uuid := uuidv7();
BEGIN
  IF p_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_kind = 'brand' THEN
    SELECT * INTO src FROM public.brands WHERE id = p_id;
    IF src.owner_account_id = p_account THEN RETURN p_id; END IF;
    SELECT b.id INTO found_id FROM public.brands b
     WHERE b.owner_account_id = p_account AND kept.normalize(b.name) = kept.normalize(src.name);
    IF found_id IS NOT NULL THEN RETURN found_id; END IF;
    INSERT INTO public.brands (id, owner_account_id, name, website, support_phone, claim_url,
                               default_warranty_months)
    VALUES (new_id, p_account, src.name, src.website, src.support_phone, src.claim_url,
            src.default_warranty_months);
  ELSIF p_kind = 'vendor' THEN
    SELECT * INTO src FROM public.vendors WHERE id = p_id;
    IF src.owner_account_id = p_account THEN RETURN p_id; END IF;
    SELECT v.id INTO found_id FROM public.vendors v
     WHERE v.owner_account_id = p_account AND kept.normalize(v.name) = kept.normalize(src.name)
     ORDER BY v.created_at, v.id LIMIT 1;
    IF found_id IS NOT NULL THEN RETURN found_id; END IF;
    INSERT INTO public.vendors (id, owner_account_id, name, kind, address, phone, website)
    VALUES (new_id, p_account, src.name, src.kind, src.address, src.phone, src.website);
  ELSIF p_kind = 'person' THEN
    SELECT * INTO src FROM public.people WHERE id = p_id;
    IF src.owner_account_id = p_account THEN RETURN p_id; END IF;
    SELECT p.id INTO found_id FROM public.people p
     WHERE p.owner_account_id = p_account
       AND kept.normalize(p.display_name) = kept.normalize(src.display_name)
     ORDER BY p.created_at, p.id LIMIT 1;
    IF found_id IS NOT NULL THEN RETURN found_id; END IF;
    INSERT INTO public.people (id, owner_account_id, display_name)
    VALUES (new_id, p_account, src.display_name);
  ELSIF p_kind = 'tag' THEN
    SELECT * INTO src FROM public.tags WHERE id = p_id;
    IF src.owner_account_id = p_account THEN RETURN p_id; END IF;
    SELECT g.id INTO found_id FROM public.tags g
     WHERE g.owner_account_id = p_account AND kept.normalize(g.name) = kept.normalize(src.name);
    IF found_id IS NOT NULL THEN RETURN found_id; END IF;
    INSERT INTO public.tags (id, owner_account_id, name, colour)
    VALUES (new_id, p_account, src.name, src.colour);
  ELSE
    RAISE EXCEPTION 'unknown registry %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN new_id;
END $$;
--> statement-breakpoint
-- A file row for `p_file` in `p_location`: itself, the location's own file with the same bytes
-- (D177 dedupe), or a copy sharing the stored blob and its derivatives' (D161).
CREATE FUNCTION kept.copy_file(p_file uuid, p_location uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  src public.files%ROWTYPE;
  found_id uuid;
  new_id uuid := uuidv7();
BEGIN
  SELECT * INTO src FROM public.files WHERE id = p_file;
  IF src.location_id = p_location THEN
    RETURN p_file;
  END IF;
  SELECT f.id INTO found_id FROM public.files f
   WHERE f.location_id = p_location AND f.sha256 = src.sha256;
  IF found_id IS NOT NULL THEN
    RETURN found_id;
  END IF;
  INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class, has_gps,
                            width, height, derivative_state, created_by)
  VALUES (new_id, p_location, src.storage_key, src.sha256, src.bytes, src.mime, src.class,
          src.has_gps, src.width, src.height, src.derivative_state, src.created_by);
  INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width, height,
                                       bytes)
  SELECT new_id, d.variant, p_location, d.storage_key, d.width, d.height, d.bytes
    FROM public.file_derivatives d WHERE d.file_id = src.id;
  RETURN new_id;
END $$;
--> statement-breakpoint
-- A cross-account move's purchase (Q13, D161): the purchase header and the one line, copied into
-- `p_location` with the vendor mapped, and the purchase's receipts and invoices with it (file
-- rows copied, blobs shared). Returns the new line's id.
CREATE FUNCTION kept.copy_purchase_line(p_line uuid, p_location uuid, p_account uuid) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  l public.purchase_lines%ROWTYPE;
  p public.purchases%ROWTYPE;
  new_purchase uuid := uuidv7();
  new_line uuid := uuidv7();
BEGIN
  SELECT * INTO l FROM public.purchase_lines WHERE id = p_line;
  SELECT * INTO p FROM public.purchases WHERE id = l.purchase_id;
  INSERT INTO public.purchases (id, location_id, vendor_id, purchased_on, currency, total, tax,
                                notes, review_state, created_via, created_by)
  VALUES (new_purchase, p_location, kept.map_registry('vendor', p.vendor_id, p_account),
          p.purchased_on, p.currency, p.total, p.tax, p.notes, p.review_state, p.created_via,
          p.created_by);
  INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, quantity,
                                     unit_price, sort)
  VALUES (new_line, p_location, new_purchase, l.description, l.quantity, l.unit_price, l.sort);
  INSERT INTO public.attachments (location_id, file_id, purchase_id, role, sort, created_by)
  SELECT p_location, kept.copy_file(a.file_id, p_location), new_purchase, a.role, a.sort,
         a.created_by
    FROM public.attachments a
   WHERE a.purchase_id = p.id AND a.location_id = p.location_id
     AND a.role IN ('receipt', 'invoice') AND a.file_id IS NOT NULL;
  RETURN new_line;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.resolved_keys(uuid), kept.field_for_key(uuid, text),
  kept.map_type(uuid, uuid), kept.map_registry(text, uuid, uuid), kept.copy_file(uuid, uuid),
  kept.copy_purchase_line(uuid, uuid, uuid)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 0016 checked a thing's tags on UPDATE too, which a move's ON UPDATE CASCADE fires before the
-- move can map the tags into the target account. Tag rows are never updated otherwise, so the
-- check is on INSERT only (as the plan has it); a move maps the tags itself.
DROP TRIGGER thing_tags_guard ON public.thing_tags;
--> statement-breakpoint
CREATE TRIGGER thing_tags_guard BEFORE INSERT ON public.thing_tags
  FOR EACH ROW EXECUTE FUNCTION kept.guard_thing_tags();
--> statement-breakpoint

-- 2. Moves (D45, D161, §6.1, Q13) -------------------------------------------------------------
-- Moves `p_ids` (and everything inside them) into place `p_place` or container `p_container` of
-- location `p_to_location`. The caller must write in every source location and in the target;
-- the targets must be live and in the target location; nothing may go inside itself (23514
-- things_no_loop). Across accounts, the registries are mapped first (map_type, map_registry;
-- people by name only), the purchase line is copied with its receipts, and tags follow by name;
-- within an account the line stays where it is (D115). Links that would cross locations are
-- dropped. Contents keep their last_seen_at (D45); the moved things are seen now and are no
-- longer uncertain. Short IDs, meters, readings, attachments and secret values follow through
-- ON UPDATE CASCADE; attachment files are re-homed (copies sharing the blob, D161) under the
-- deferred file key. Tombstones are written in each source location (§7.4). Returns one row per
-- moved thing (contents included) with where it came from and the links dropped with it.
CREATE FUNCTION kept.move_things(p_ids uuid[], p_to_location uuid, p_place uuid, p_container uuid)
RETURNS TABLE (thing_id uuid, from_location uuid, dropped_link_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  uid uuid := kept.current_user_id();
  ids uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(p_ids) AS x WHERE x IS NOT NULL);
  target_acct uuid;
  set_ids uuid[];
  set_locs uuid[];
  r record;
  map_id uuid[] := '{}';
  map_type uuid[] := '{}';
  map_brand uuid[] := '{}';
  map_person uuid[] := '{}';
  map_line uuid[] := '{}';
  line_from uuid[] := '{}';
  line_to uuid[] := '{}';
  new_line uuid;
  dropped record;
  drop_ids uuid[] := '{}';
  drop_from uuid[] := '{}';
  drop_to uuid[] := '{}';
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

  -- Links to something staying behind (or already elsewhere) would cross locations.
  FOR dropped IN
    DELETE FROM public.thing_links k
     WHERE (k.from_thing_id = ANY (set_ids)) <> (k.to_thing_id = ANY (set_ids))
       AND k.location_id <> p_to_location
    RETURNING k.id, k.from_thing_id, k.to_thing_id
  LOOP
    drop_ids := drop_ids || dropped.id;
    drop_from := drop_from || dropped.from_thing_id;
    drop_to := drop_to || dropped.to_thing_id;
  END LOOP;

  -- Across accounts: map the registries and copy the purchase line, before anything moves.
  FOR r IN
    SELECT t.id, t.type_id, t.brand_id, t.belongs_to_person_id, t.purchase_line_id
      FROM public.things t JOIN public.locations l ON l.id = t.location_id
     WHERE t.id = ANY (set_ids) AND l.owner_account_id <> target_acct
  LOOP
    map_id := map_id || r.id;
    map_type := map_type || kept.map_type(r.type_id, target_acct);
    map_brand := map_brand || kept.map_registry('brand', r.brand_id, target_acct);
    map_person := map_person || kept.map_registry('person', r.belongs_to_person_id, target_acct);
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
         purchase_line_id = CASE WHEN m.id IS NULL THEN t.purchase_line_id ELSE m.line_id END
    FROM unnest(set_ids) AS s(id)
    LEFT JOIN unnest(map_id, map_type, map_brand, map_person, map_line)
           AS m(id, type_id, brand_id, person_id, line_id) ON m.id = s.id
   WHERE t.id = s.id;

  -- Attachment files now in another location than their attachment: re-homed (D161).
  FOR r IN
    SELECT a.id, a.file_id FROM public.attachments a JOIN public.files f ON f.id = a.file_id
     WHERE a.location_id = p_to_location AND f.location_id <> a.location_id
  LOOP
    UPDATE public.attachments SET file_id = kept.copy_file(r.file_id, p_to_location)
     WHERE id = r.id;
  END LOOP;
  SET CONSTRAINTS public.attachments_file_fk IMMEDIATE;

  -- Across accounts: tags by name, and secret values onto the mapped type's fields.
  INSERT INTO public.thing_tags (location_id, thing_id, tag_id)
  SELECT p_to_location, x.thing_id, kept.map_registry('tag', x.tag_id, target_acct)
    FROM public.thing_tags x JOIN public.tags g ON g.id = x.tag_id
   WHERE x.thing_id = ANY (set_ids) AND g.owner_account_id <> target_acct
  ON CONFLICT DO NOTHING;
  DELETE FROM public.thing_tags x USING public.tags g
   WHERE g.id = x.tag_id AND x.thing_id = ANY (set_ids) AND g.owner_account_id <> target_acct;
  UPDATE public.secret_values s
     SET type_field_id = kept.field_for_key(t.type_id, s.field_key)
    FROM public.things t, public.type_fields f
   WHERE t.id = s.thing_id AND f.id = s.type_field_id AND s.thing_id = ANY (set_ids)
     AND f.owner_account_id IS NOT NULL AND f.owner_account_id <> target_acct
     AND kept.field_for_key(t.type_id, s.field_key) IS NOT NULL;

  -- Sync (§7.4): gone from each source location; no longer gone from the target.
  INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
  SELECT x.loc, 'thing', x.id FROM unnest(set_ids, set_locs) AS x(id, loc)
   WHERE x.loc <> p_to_location
  ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now();
  DELETE FROM public.sync_tombstones z
   WHERE z.location_id = p_to_location AND z.entity_type = 'thing' AND z.entity_id = ANY (set_ids);

  RETURN QUERY
  SELECT x.id, x.loc,
         coalesce(ARRAY(SELECT d.id FROM unnest(drop_ids, drop_from, drop_to) AS d(id, f, t)
                         WHERE d.f = x.id OR d.t = x.id), '{}'::uuid[])
    FROM unnest(set_ids, set_locs) AS x(id, loc);
END $$;
--> statement-breakpoint

-- 3. Conversions (D160, §7.13, Q14): the same UUID, so routes, short IDs, audit subjects and
--    client caches stay valid; a tombstone for the old entity type.

-- A place becomes a container thing of type `p_type` (NULL: the built-in box_bin), in the place's
-- parent (or the Unplaced area, for a top-level place). Its things go inside it; its short IDs,
-- attachments and secret values point at the thing. Place-field values the type resolves go to
-- `custom`, the rest to `archived_custom`. Not the Unplaced area (23514 places_unplaced_fixed);
-- not a place with places under it (23514 places_has_children).
CREATE FUNCTION kept.convert_place_to_container(p_place uuid, p_type uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  p public.places%ROWTYPE;
  v_type uuid;
  keys text[];
  parent uuid;
BEGIN
  SELECT * INTO p FROM public.places pl
   WHERE pl.id = p_place AND pl.deleted_at IS NULL
     AND pl.location_id IN (SELECT kept.writable_location_ids());
  IF uid IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'no such place of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p.is_unplaced THEN
    RAISE EXCEPTION 'the Unplaced area can''t be converted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'places_unplaced_fixed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.places c WHERE c.parent_id = p_place AND c.location_id = p.location_id) THEN
    RAISE EXCEPTION 'move the places inside it first'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'places_has_children';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kept.places'), hashtext(p.location_id::text));
  -- A type the caller can see: built in, or of the location's account (guard_thing_refs checks
  -- the account on insert).
  IF p_type IS NULL THEN
    SELECT t.id INTO v_type FROM public.types t
     WHERE t.owner_account_id IS NULL AND t.builtin_key = 'box_bin';
  ELSIF EXISTS (SELECT 1 FROM public.types t
                 WHERE t.id = p_type
                   AND (t.owner_account_id IS NULL
                        OR t.owner_account_id IN (SELECT kept.visible_account_ids()))) THEN
    v_type := p_type;
  ELSE
    RAISE EXCEPTION 'no such type' USING ERRCODE = 'insufficient_privilege';
  END IF;
  keys := kept.resolved_keys(v_type);
  parent := coalesce(p.parent_id, (SELECT u.id FROM public.places u
                                    WHERE u.location_id = p.location_id AND u.is_unplaced));
  INSERT INTO public.things (id, location_id, place_id, type_id, name, custom, archived_custom,
                             created_by)
  VALUES (p.id, p.location_id, parent, v_type, p.name,
          (SELECT coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb)
             FROM jsonb_each(p.custom) AS e(k, v) WHERE e.k = ANY (keys)),
          (SELECT coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb)
             FROM jsonb_each(p.custom) AS e(k, v) WHERE NOT e.k = ANY (keys)),
          uid);
  UPDATE public.things SET place_id = NULL, container_id = p.id
   WHERE place_id = p.id AND location_id = p.location_id;
  UPDATE public.short_ids SET thing_id = p.id, place_id = NULL WHERE place_id = p.id;
  UPDATE public.attachments SET thing_id = p.id, place_id = NULL WHERE place_id = p.id;
  UPDATE public.secret_values SET thing_id = p.id, place_id = NULL WHERE place_id = p.id;
  DELETE FROM public.places WHERE id = p.id;
  INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
  VALUES (p.location_id, 'place', p.id)
  ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now();
  DELETE FROM public.sync_tombstones z
   WHERE z.location_id = p.location_id AND z.entity_type = 'thing' AND z.entity_id = p.id;
  RETURN p.id;
END $$;
--> statement-breakpoint
-- The reverse: a container thing becomes a place under `p_parent`, or under the place it sits
-- in directly (22023 when it sits in another container and no parent is given; a thing in the
-- Unplaced area becomes a top-level place). What it holds goes into the place; its short IDs,
-- attachments and secret values point at the place; `custom` becomes the place's fields. A thing
-- with a meter can't become a place (23514 things_has_meters), nor a nameless draft (22023).
-- Tags, links and the purchase line go with the thing.
CREATE FUNCTION kept.convert_container_to_place(p_thing uuid, p_parent uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  t public.things%ROWTYPE;
  parent uuid;
BEGIN
  SELECT * INTO t FROM public.things th
   WHERE th.id = p_thing AND th.deleted_at IS NULL
     AND th.location_id IN (SELECT kept.writable_location_ids());
  IF uid IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'no such thing of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_parent IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.places pl
                    WHERE pl.id = p_parent AND pl.location_id = t.location_id
                      AND pl.deleted_at IS NULL AND NOT pl.is_unplaced) THEN
      RAISE EXCEPTION 'no such place' USING ERRCODE = 'insufficient_privilege';
    END IF;
    parent := p_parent;
  ELSIF t.container_id IS NOT NULL THEN
    RAISE EXCEPTION 'a thing inside another needs a parent place to become a place'
      USING ERRCODE = 'invalid_parameter_value';
  ELSE
    SELECT CASE WHEN pl.is_unplaced THEN NULL ELSE pl.id END INTO parent
      FROM public.places pl WHERE pl.id = t.place_id;
  END IF;
  IF t.name IS NULL THEN
    RAISE EXCEPTION 'name the draft first' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = t.id) THEN
    RAISE EXCEPTION 'a thing with a meter can''t become a place'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_has_meters';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kept.places'), hashtext(t.location_id::text));
  INSERT INTO public.places (id, location_id, parent_id, name, custom, created_by)
  VALUES (t.id, t.location_id, parent, t.name, t.custom, uid);
  UPDATE public.things SET container_id = NULL, place_id = t.id
   WHERE container_id = t.id AND location_id = t.location_id;
  UPDATE public.short_ids SET place_id = t.id, thing_id = NULL WHERE thing_id = t.id;
  UPDATE public.attachments SET place_id = t.id, thing_id = NULL WHERE thing_id = t.id;
  UPDATE public.secret_values SET place_id = t.id, thing_id = NULL WHERE thing_id = t.id;
  DELETE FROM public.things WHERE id = t.id;
  INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
  VALUES (t.location_id, 'thing', t.id)
  ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now();
  DELETE FROM public.sync_tombstones z
   WHERE z.location_id = t.location_id AND z.entity_type = 'place' AND z.entity_id = t.id;
  RETURN t.id;
END $$;
--> statement-breakpoint

-- 4. Merges (D92, D160) -----------------------------------------------------------------------

-- `p_from` into `p_into`, two live places of one location the caller writes, neither the
-- Unplaced area (23514 places_unplaced_fixed), `p_into` not under `p_from` (23514
-- places_no_loop). Places and things under `p_from` move to `p_into`, and its attachments; its
-- short IDs now resolve to `p_into`, as secondary codes; its secret values move unless `p_into`
-- has a current value for the key (then they are kept as superseded history); place-field values
-- `p_into` lacks are taken. Then `p_from` is deleted, with a tombstone. Returns the things moved.
CREATE FUNCTION kept.merge_places(p_from uuid, p_into uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  f public.places%ROWTYPE;
  i public.places%ROWTYPE;
  n integer;
BEGIN
  SELECT * INTO f FROM public.places pl
   WHERE pl.id = p_from AND pl.deleted_at IS NULL
     AND pl.location_id IN (SELECT kept.writable_location_ids());
  SELECT * INTO i FROM public.places pl
   WHERE pl.id = p_into AND pl.deleted_at IS NULL AND pl.location_id = f.location_id;
  IF uid IS NULL OR f.id IS NULL OR i.id IS NULL OR p_from = p_into THEN
    RAISE EXCEPTION 'no such places of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF f.is_unplaced OR i.is_unplaced THEN
    RAISE EXCEPTION 'the Unplaced area can''t be merged'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'places_unplaced_fixed';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kept.places'), hashtext(f.location_id::text));
  IF EXISTS (WITH RECURSIVE up(id) AS (
               SELECT i.parent_id
               UNION
               SELECT pl.parent_id FROM public.places pl JOIN up ON pl.id = up.id
                WHERE pl.parent_id IS NOT NULL)
             SELECT 1 FROM up WHERE up.id = p_from) THEN
    RAISE EXCEPTION 'a place can''t be merged into one inside it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'places_no_loop';
  END IF;
  UPDATE public.places SET parent_id = p_into WHERE parent_id = p_from;
  UPDATE public.things SET place_id = p_into WHERE place_id = p_from;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.attachments SET place_id = p_into WHERE place_id = p_from;
  UPDATE public.short_ids SET place_id = p_into, is_primary = false WHERE place_id = p_from;
  UPDATE public.secret_values s
     SET place_id = p_into,
         superseded_at = coalesce(s.superseded_at,
                                  CASE WHEN EXISTS (SELECT 1 FROM public.secret_values c
                                                     WHERE c.place_id = p_into
                                                       AND c.field_key = s.field_key
                                                       AND c.superseded_at IS NULL)
                                       THEN now() END)
   WHERE s.place_id = p_from;
  UPDATE public.places SET custom = f.custom || custom WHERE id = p_into;
  DELETE FROM public.places WHERE id = p_from;
  INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
  VALUES (f.location_id, 'place', p_from)
  ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now();
  RETURN n;
END $$;
--> statement-breakpoint

-- `p_from` into `p_into`, two rows of one registry (type, brand, vendor, person, tag) in one
-- account the caller administers (D123). Every reference moves, in every location of the
-- account, including those the caller can't see; then `p_from` is deleted. Types: both ordinary
-- (not field groups), `p_into` not under `p_from` (23514 types_no_loop); `p_from`'s children
-- move under `p_into`; custom values `p_into` doesn't resolve move to archived_custom; secret
-- values follow the field with the same key, and a secret with no such field refuses the merge
-- (23514 types_merge_secret_fields). People: `p_into` keeps its contact details, or takes
-- `p_from`'s if it has none. Returns the references moved (things, or purchases for a vendor).
CREATE FUNCTION kept.merge_registry(p_kind text, p_from uuid, p_into uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  tbl text;
  acct uuid;
  acct_into uuid;
  n integer := 0;
  keys text[];
BEGIN
  tbl := CASE p_kind WHEN 'type' THEN 'types' WHEN 'brand' THEN 'brands'
                     WHEN 'vendor' THEN 'vendors' WHEN 'person' THEN 'people'
                     WHEN 'tag' THEN 'tags' END;
  IF tbl IS NULL THEN
    RAISE EXCEPTION 'unknown registry %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  EXECUTE format('SELECT owner_account_id FROM public.%I WHERE id = $1', tbl) INTO acct USING p_from;
  EXECUTE format('SELECT owner_account_id FROM public.%I WHERE id = $1', tbl) INTO acct_into
    USING p_into;
  IF uid IS NULL OR acct IS NULL OR acct IS DISTINCT FROM acct_into OR p_from = p_into
     OR NOT coalesce(acct IN (SELECT kept.admin_account_ids()), false) THEN
    RAISE EXCEPTION 'no such % of yours', p_kind USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kept.types'), hashtext(acct::text));
  IF p_kind = 'brand' THEN
    UPDATE public.things SET brand_id = p_into WHERE brand_id = p_from;
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM public.brands WHERE id = p_from;
  ELSIF p_kind = 'vendor' THEN
    UPDATE public.purchases SET vendor_id = p_into WHERE vendor_id = p_from;
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM public.vendors WHERE id = p_from;
  ELSIF p_kind = 'person' THEN
    UPDATE public.things SET belongs_to_person_id = p_into WHERE belongs_to_person_id = p_from;
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE public.people SET member_user_id = coalesce(member_user_id,
                                (SELECT member_user_id FROM public.people WHERE id = p_from))
     WHERE id = p_into;
    IF NOT EXISTS (SELECT 1 FROM public.person_contacts WHERE person_id = p_into) THEN
      UPDATE public.person_contacts SET person_id = p_into WHERE person_id = p_from;
    END IF;
    DELETE FROM public.people WHERE id = p_from;
  ELSIF p_kind = 'tag' THEN
    INSERT INTO public.thing_tags (location_id, thing_id, tag_id)
    SELECT x.location_id, x.thing_id, p_into FROM public.thing_tags x WHERE x.tag_id = p_from
    ON CONFLICT DO NOTHING;
    SELECT count(*) INTO n FROM public.thing_tags WHERE tag_id = p_from;
    DELETE FROM public.tags WHERE id = p_from;
  ELSE -- type
    IF EXISTS (SELECT 1 FROM public.types t WHERE t.id IN (p_from, p_into) AND t.is_field_group) THEN
      RAISE EXCEPTION 'field groups are not merged' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF EXISTS (SELECT 1 FROM kept.type_chain(p_into) ch WHERE ch.id = p_from) THEN
      RAISE EXCEPTION 'a type can''t be merged into one under it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'types_no_loop';
    END IF;
    keys := kept.resolved_keys(p_into);
    UPDATE public.things t
       SET type_id = p_into,
           custom = (SELECT coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb)
                       FROM jsonb_each(t.custom) AS e(k, v) WHERE e.k = ANY (keys)),
           archived_custom = t.archived_custom
                             || (SELECT coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb)
                                   FROM jsonb_each(t.custom) AS e(k, v) WHERE NOT e.k = ANY (keys))
     WHERE t.type_id = p_from;
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE public.secret_values s SET type_field_id = kept.field_for_key(p_into, f.key)
      FROM public.type_fields f
     WHERE f.id = s.type_field_id AND f.type_id = p_from
       AND kept.field_for_key(p_into, f.key) IS NOT NULL;
    IF EXISTS (SELECT 1 FROM public.secret_values s JOIN public.type_fields f ON f.id = s.type_field_id
                WHERE f.type_id = p_from) THEN
      RAISE EXCEPTION 'a secret value has no field of the same key in the type merged into'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'types_merge_secret_fields';
    END IF;
    UPDATE public.types SET parent_id = p_into WHERE parent_id = p_from;
    DELETE FROM public.types WHERE id = p_from;
  END IF;
  RETURN n;
END $$;
--> statement-breakpoint

-- 5. Customising and impact (D92, D123, §7.9, Q13b) -------------------------------------------

-- A built-in type, customised for `p_account` (which the caller administers): the built-in and
-- its built-in subtree are copied into the account (copied_from_id set, name NULL so it still
-- translates, parent chain kept, own fields copied, field groups kept as references); the
-- account's own types under any of them move under the copies; the account's things (in all its
-- locations) and their secret values point at the copies, and its locations' secret policies are
-- copied onto the copied fields. Idempotent: a second call returns the existing copy.
CREATE FUNCTION kept.customise_type(p_builtin uuid, p_account uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  existing uuid;
  r record;
  map_from uuid[] := '{}';
  map_to uuid[] := '{}';
  copy_id uuid;
  parent_copy uuid;
BEGIN
  IF uid IS NULL OR NOT coalesce(p_account IN (SELECT kept.admin_account_ids()), false)
     OR NOT EXISTS (SELECT 1 FROM public.types t
                     WHERE t.id = p_builtin AND t.owner_account_id IS NULL
                       AND NOT t.is_field_group) THEN
    RAISE EXCEPTION 'no such built-in type or account of yours'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kept.types'), hashtext(p_account::text));
  SELECT t.id INTO existing FROM public.types t
   WHERE t.owner_account_id = p_account AND t.copied_from_id = p_builtin
   ORDER BY t.created_at, t.id LIMIT 1;
  IF existing IS NOT NULL THEN
    RETURN existing;
  END IF;
  FOR r IN
    WITH RECURSIVE sub(id, parent_id, depth) AS (
      SELECT t.id, t.parent_id, 0 FROM public.types t WHERE t.id = p_builtin
      UNION ALL
      SELECT t.id, t.parent_id, s.depth + 1 FROM public.types t JOIN sub s ON t.parent_id = s.id
       WHERE t.owner_account_id IS NULL AND s.depth < 64)
    SELECT sub.id, sub.parent_id FROM sub ORDER BY sub.depth, sub.id
  LOOP
    parent_copy := CASE WHEN r.id = p_builtin THEN r.parent_id
                        ELSE map_to[array_position(map_from, r.parent_id)] END;
    copy_id := NULL;
    SELECT t.id INTO copy_id FROM public.types t
     WHERE t.owner_account_id = p_account AND t.copied_from_id = r.id
     ORDER BY t.created_at, t.id LIMIT 1;
    IF copy_id IS NULL THEN
      copy_id := uuidv7();
      INSERT INTO public.types (id, owner_account_id, copied_from_id, parent_id, icon, colour,
                                capabilities, default_meter, field_groups,
                                default_warranty_months)
      SELECT copy_id, p_account, t.id, parent_copy, t.icon, t.colour, t.capabilities,
             t.default_meter, t.field_groups, t.default_warranty_months
        FROM public.types t WHERE t.id = r.id;
      INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind, unit, options,
                                      repeatable, required, sort, secret, archived_at)
      SELECT p_account, copy_id, f.key, f.label, f.kind, f.unit, f.options, f.repeatable,
             f.required, f.sort, f.secret, f.archived_at
        FROM public.type_fields f WHERE f.type_id = r.id;
    ELSE
      UPDATE public.types SET parent_id = parent_copy
       WHERE id = copy_id AND parent_id IS DISTINCT FROM parent_copy;
    END IF;
    map_from := map_from || r.id;
    map_to := map_to || copy_id;
  END LOOP;
  UPDATE public.types t SET parent_id = map_to[array_position(map_from, t.parent_id)]
   WHERE t.owner_account_id = p_account AND t.parent_id = ANY (map_from)
     AND NOT t.id = ANY (map_to);
  INSERT INTO public.secret_field_policies (location_id, type_field_id, reveal_roles,
                                            reveal_user_ids, ai_allowed)
  SELECT sp.location_id, cf.id, sp.reveal_roles, sp.reveal_user_ids, sp.ai_allowed
    FROM public.secret_field_policies sp
    JOIN public.type_fields bf ON bf.id = sp.type_field_id
    JOIN public.type_fields cf
      ON cf.type_id = map_to[array_position(map_from, bf.type_id)] AND cf.key = bf.key
    JOIN public.locations l ON l.id = sp.location_id
   WHERE bf.type_id = ANY (map_from) AND l.owner_account_id = p_account
  ON CONFLICT DO NOTHING;
  UPDATE public.things t SET type_id = map_to[array_position(map_from, t.type_id)]
    FROM public.locations l
   WHERE l.id = t.location_id AND l.owner_account_id = p_account AND t.type_id = ANY (map_from);
  UPDATE public.secret_values s SET type_field_id = cf.id
    FROM public.type_fields bf, public.type_fields cf, public.locations l
   WHERE bf.id = s.type_field_id AND bf.type_id = ANY (map_from)
     AND cf.type_id = map_to[array_position(map_from, bf.type_id)] AND cf.key = bf.key
     AND l.id = s.location_id AND l.owner_account_id = p_account;
  RETURN map_to[1];
END $$;
--> statement-breakpoint
-- What changing type `p_type` touches (D123, §7.9): per location, the live things of the type or
-- a type under it. A custom type's account's locations the caller can't see are counted with no
-- id or name (D123); a built-in's count covers only the caller's own visible locations (there is
-- no account boundary to count within). 42501 for a type the caller can't see.
CREATE FUNCTION kept.type_impact(p_type uuid)
RETURNS TABLE (location_id uuid, location_name text, things integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  acct uuid;
BEGIN
  SELECT t.owner_account_id INTO acct FROM public.types t
   WHERE t.id = p_type
     AND (t.owner_account_id IS NULL
          OR t.owner_account_id IN (SELECT kept.visible_account_ids()));
  IF NOT FOUND OR kept.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'no such type' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  WITH RECURSIVE down(id) AS (
    SELECT p_type
    UNION
    SELECT t.id FROM public.types t JOIN down d ON t.parent_id = d.id
  ), seen AS (
    SELECT v.id FROM kept.visible_location_ids() AS v(id)
  )
  SELECT CASE WHEN l.id IN (SELECT id FROM seen) THEN l.id END,
         CASE WHEN l.id IN (SELECT id FROM seen) THEN l.name END,
         count(*)::integer
    FROM public.things th JOIN public.locations l ON l.id = th.location_id
   WHERE th.type_id IN (SELECT id FROM down) AND th.deleted_at IS NULL AND l.deleted_at IS NULL
     AND CASE WHEN acct IS NULL THEN l.id IN (SELECT id FROM seen)
              ELSE l.owner_account_id = acct END
   GROUP BY l.id, l.name
   ORDER BY 3 DESC, 2;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION
  kept.move_things(uuid[], uuid, uuid, uuid), kept.convert_place_to_container(uuid, uuid),
  kept.convert_container_to_place(uuid, uuid), kept.merge_places(uuid, uuid),
  kept.merge_registry(text, uuid, uuid), kept.customise_type(uuid, uuid), kept.type_impact(uuid)
  FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  kept.move_things(uuid[], uuid, uuid, uuid), kept.convert_place_to_container(uuid, uuid),
  kept.convert_container_to_place(uuid, uuid), kept.merge_places(uuid, uuid),
  kept.merge_registry(text, uuid, uuid), kept.customise_type(uuid, uuid), kept.type_impact(uuid)
  TO kept_app;
