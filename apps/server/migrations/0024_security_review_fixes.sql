-- Custom SQL migration file, put your code below! --
-- Step 2, security review of Phase A (migrations 0012-0022): the fixes (D110, D115, D116, D117,
-- D123, D156, D161, D162, D177). 0023 adds the purge indexes; this one changes functions,
-- triggers and policies. Nothing earlier is edited: every function here is CREATE OR REPLACE
-- with its old signature, or new.
--   1. Helpers (kept_owner's only): secret keys of a type, splitting `custom` for a new type,
--      custom references (people, vendors) remapped or replaced, where a person is used.
--   2. C1, I1, I4, minor: kept.move_things() refuses secrets leaving a location unless their
--      owner (able to reveal them) moves them; maps custom references across accounts; never
--      leaves a secret on another account's field; tombstones what leaves (D156).
--   3. I1, I4: kept.merge_registry(): secrets only onto secret fields with the same policy (or by
--      the owner); custom references follow a person or vendor merge.
--   4. I2: kept.type_impact() counts hidden locations for the account's admins only.
--   5. I3, minor: a thing's purchase shows its line, not the purchase's total and tax; originals
--      are for members and above.
--   6. I4: conversions keep secret-resolving keys out of `custom`; a trigger refuses them.
--   7. I6 and minor: storage keys built by the database; derivatives by the uploader; deletes.
--   8. Minor: attribution stamped from the request; person contacts and member links; a type's
--      copied_from_id and its keys on insert; a field's secret flag fixed.
--   9. Performance: tag refreshes per statement; reindex rewrites only what changed.
--  10. Saved views: admins of a shared view's location may delete it.
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.

-- 1. Helpers -----------------------------------------------------------------------------------

-- The keys a type resolves to a secret field (its own, its ancestors', their field groups').
CREATE FUNCTION kept.secret_keys(p_type uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT f.key), '{}'::text[])
    FROM kept.type_chain(p_type) ch
    JOIN public.types t ON t.id = ch.id
    JOIN public.type_fields f ON f.type_id = t.id OR f.type_id = ANY (t.field_groups)
   WHERE f.secret
$$;
--> statement-breakpoint
-- `p_custom` for a thing of type `p_type`: values of keys it resolves to a plain field stay;
-- the rest (keys it doesn't resolve, and keys it resolves to a secret field: D116, secrets never
-- reach `custom` or the search document) go to archived_custom.
CREATE FUNCTION kept.split_custom(p_custom jsonb, p_type uuid, OUT kept_values jsonb,
                                  OUT archived jsonb)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH k AS (SELECT kept.resolved_keys(p_type) AS keys, kept.secret_keys(p_type) AS secrets)
  SELECT coalesce(jsonb_object_agg(e.k, e.v)
                    FILTER (WHERE e.k = ANY (k.keys) AND NOT e.k = ANY (k.secrets)), '{}'::jsonb),
         coalesce(jsonb_object_agg(e.k, e.v)
                    FILTER (WHERE e.k IS NOT NULL
                              AND NOT (e.k = ANY (k.keys) AND NOT e.k = ANY (k.secrets))),
                  '{}'::jsonb)
    FROM k LEFT JOIN jsonb_each(coalesce(p_custom, '{}'::jsonb)) AS e(k, v) ON true
$$;
--> statement-breakpoint
-- `p_custom` of a thing of type `p_type` in account `p_from_account`, moving to `p_account`: each
-- person or vendor value (one id, or a list) mapped by kept.map_registry(). An id that isn't a
-- row of the source account (a stale or foreign value) is dropped, never looked up elsewhere.
CREATE FUNCTION kept.remap_custom_refs(p_custom jsonb, p_type uuid, p_from_account uuid,
                                       p_account uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  result jsonb := '{}'::jsonb;
  e record;
  v_kind text;
  x text;
  mapped uuid;
  list jsonb;
BEGIN
  FOR e IN SELECT j.key, j.value FROM jsonb_each(coalesce(p_custom, '{}'::jsonb)) AS j LOOP
    v_kind := (SELECT f.kind FROM public.type_fields f
                WHERE f.id = kept.field_for_key(p_type, e.key));
    IF v_kind IS NULL OR v_kind NOT IN ('person', 'vendor') THEN
      result := result || jsonb_build_object(e.key, e.value);
      CONTINUE;
    END IF;
    list := '[]'::jsonb;
    FOR x IN SELECT CASE jsonb_typeof(e.value) WHEN 'array' THEN a.v ELSE e.value #>> '{}' END
               FROM jsonb_array_elements_text(CASE jsonb_typeof(e.value) WHEN 'array' THEN e.value
                                                   ELSE '[null]'::jsonb END) AS a(v) LOOP
      mapped := NULL;
      IF x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        IF (v_kind = 'person' AND EXISTS (SELECT 1 FROM public.people p
                                           WHERE p.id = x::uuid
                                             AND p.owner_account_id = p_from_account))
           OR (v_kind = 'vendor' AND EXISTS (SELECT 1 FROM public.vendors v
                                              WHERE v.id = x::uuid
                                                AND v.owner_account_id = p_from_account)) THEN
          mapped := kept.map_registry(v_kind, x::uuid, p_account);
        END IF;
      END IF;
      IF mapped IS NOT NULL THEN
        list := list || jsonb_build_array(mapped);
      END IF;
    END LOOP;
    IF jsonb_typeof(e.value) = 'array' THEN
      result := result || jsonb_build_object(e.key, list);
    ELSIF jsonb_array_length(list) = 1 THEN
      result := result || jsonb_build_object(e.key, list -> 0);
    END IF;
  END LOOP;
  RETURN result;
END $$;
--> statement-breakpoint
-- `p_custom` with every value equal to `p_from` (alone or in a list) replaced by `p_into`.
CREATE FUNCTION kept.replace_custom_ref(p_custom jsonb, p_from uuid, p_into uuid) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_object_agg(e.k,
           CASE WHEN e.v = to_jsonb(p_from::text) THEN to_jsonb(p_into::text)
                WHEN jsonb_typeof(e.v) = 'array' THEN
                  coalesce((SELECT jsonb_agg(CASE WHEN a.x = to_jsonb(p_from::text)
                                                  THEN to_jsonb(p_into::text) ELSE a.x END
                                             ORDER BY a.n)
                              FROM jsonb_array_elements(e.v) WITH ORDINALITY AS a(x, n)),
                           '[]'::jsonb)
                ELSE e.v END), '{}'::jsonb)
    FROM jsonb_each(coalesce(p_custom, '{}'::jsonb)) AS e(k, v)
$$;
--> statement-breakpoint
-- The locations of the person's account where a live thing uses them: belongs to them, or names
-- them in a custom value (a person field, D177).
CREATE FUNCTION kept.person_use_locations(p_person uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT t.location_id
    FROM public.people p
    JOIN public.locations l ON l.owner_account_id = p.owner_account_id
    JOIN public.things t ON t.location_id = l.id
   WHERE p.id = p_person AND t.deleted_at IS NULL
     AND (t.belongs_to_person_id = p_person
          OR jsonb_path_exists(t.custom, '$.*[*] ? (@ == $id)',
                               jsonb_build_object('id', p_person::text)))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.secret_keys(uuid), kept.split_custom(jsonb, uuid),
  kept.remap_custom_refs(jsonb, uuid, uuid, uuid), kept.replace_custom_ref(jsonb, uuid, uuid),
  kept.person_use_locations(uuid)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 2. Moves (C1, I4, minor; D45, D156, D161, D177) ---------------------------------------------

-- A registry row that isn't found is no row to map (a custom value may be stale): NULL.
CREATE OR REPLACE FUNCTION kept.map_registry(p_kind text, p_id uuid, p_account uuid) RETURNS uuid
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
    IF NOT FOUND THEN RETURN NULL; END IF;
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
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF src.owner_account_id = p_account THEN RETURN p_id; END IF;
    SELECT v.id INTO found_id FROM public.vendors v
     WHERE v.owner_account_id = p_account AND kept.normalize(v.name) = kept.normalize(src.name)
     ORDER BY v.created_at, v.id LIMIT 1;
    IF found_id IS NOT NULL THEN RETURN found_id; END IF;
    INSERT INTO public.vendors (id, owner_account_id, name, kind, address, phone, website)
    VALUES (new_id, p_account, src.name, src.kind, src.address, src.phone, src.website);
  ELSIF p_kind = 'person' THEN
    SELECT * INTO src FROM public.people WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
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
    IF NOT FOUND THEN RETURN NULL; END IF;
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
-- A matching type of the target account must also resolve every key the source keeps secret as
-- a secret field; otherwise a copy is made, so a secret value always has a secret field to go to.
CREATE OR REPLACE FUNCTION kept.map_type(p_type uuid, p_account uuid) RETURNS uuid
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
     AND kept.secret_keys(src.id) <@ kept.secret_keys(t.id)
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
-- I3 (D115): the copy carries the thing's line; the header's total, tax and notes are the
-- purchase's, and come along only when the mover can see the purchase's location. The receipts
-- and invoices come along regardless: D115 shows a thing's receipt to anyone who can see the
-- thing, and D161 has a thing moved across accounts take its receipt.
CREATE OR REPLACE FUNCTION kept.copy_purchase_line(p_line uuid, p_location uuid, p_account uuid)
RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  l public.purchase_lines%ROWTYPE;
  p public.purchases%ROWTYPE;
  whole boolean;
  new_purchase uuid := uuidv7();
  new_line uuid := uuidv7();
BEGIN
  SELECT * INTO l FROM public.purchase_lines WHERE id = p_line;
  SELECT * INTO p FROM public.purchases WHERE id = l.purchase_id;
  whole := coalesce(p.location_id IN (SELECT kept.visible_location_ids()), false);
  INSERT INTO public.purchases (id, location_id, vendor_id, purchased_on, currency, total, tax,
                                notes, review_state, created_via, created_by)
  VALUES (new_purchase, p_location, kept.map_registry('vendor', p.vendor_id, p_account),
          p.purchased_on, p.currency, CASE WHEN whole THEN p.total END,
          CASE WHEN whole THEN p.tax END, CASE WHEN whole THEN p.notes END, p.review_state,
          p.created_via, p.created_by);
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
-- As 0021's, and:
-- - C1 (D116, D177): a thing leaving its location takes its secret values (current and history)
--   under the target's policy. Only the source location's owner, able to reveal each of them,
--   may do that; anyone else gets 42501 things_move_secrets, before anything moves.
-- - I4: across accounts, person and vendor values in `custom` are mapped like the columns, and
--   `custom` is split for the mapped type (keys it doesn't resolve, or resolves as secret, go to
--   archived_custom).
-- - Minor: a secret value of another account's field goes to the field of the same key of the
--   mapped type when that is secret; with no such field on a type of the target account, to an
--   archived secret field made for it there, as history. Otherwise 23514
--   things_move_secret_field. A value never keeps a foreign field.
-- - D156 (§7.4): tombstones in the source for its attachments, meters, readings, meter events
--   and links (dropped or carried). Short IDs and tag rows have no uuid of their own: the
--   thing's tombstone covers them.
-- - Performance: the link and attachment scans are limited to the moved set.
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
--> statement-breakpoint

-- 3. Merges (I1, I4) -----------------------------------------------------------------------------
-- As 0021's, and:
-- - Types (I1, D116, D177): a secret value of a field of `p_from` goes only to a secret field of
--   the same key (else 23514 types_merge_secret_fields), and only when that field's policy in
--   the value's location is the same as the old one's, unless the caller owns that location
--   (else 23514 types_merge_secret_policy). `custom` is split for `p_into` (a key it resolves as
--   secret is archived).
-- - People and vendors (I4): custom values naming `p_from` name `p_into`, in every location of
--   the account; they count among the references moved.
CREATE OR REPLACE FUNCTION kept.merge_registry(p_kind text, p_from uuid, p_into uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  tbl text;
  acct uuid;
  acct_into uuid;
  n integer := 0;
  more integer := 0;
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
    UPDATE public.things t SET custom = kept.replace_custom_ref(t.custom, p_from, p_into)
      FROM public.locations l
     WHERE l.id = t.location_id AND l.owner_account_id = acct
       AND jsonb_path_exists(t.custom, '$.*[*] ? (@ == $id)',
                             jsonb_build_object('id', p_from::text));
    GET DIAGNOSTICS more = ROW_COUNT;
    n := n + more;
    DELETE FROM public.vendors WHERE id = p_from;
  ELSIF p_kind = 'person' THEN
    UPDATE public.things SET belongs_to_person_id = p_into WHERE belongs_to_person_id = p_from;
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE public.things t SET custom = kept.replace_custom_ref(t.custom, p_from, p_into)
      FROM public.locations l
     WHERE l.id = t.location_id AND l.owner_account_id = acct
       AND jsonb_path_exists(t.custom, '$.*[*] ? (@ == $id)',
                             jsonb_build_object('id', p_from::text));
    GET DIAGNOSTICS more = ROW_COUNT;
    n := n + more;
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
    IF EXISTS (SELECT 1 FROM public.secret_values s
                 JOIN public.type_fields f ON f.id = s.type_field_id
                 LEFT JOIN public.type_fields g ON g.id = kept.field_for_key(p_into, f.key)
                WHERE f.type_id = p_from AND (g.id IS NULL OR NOT g.secret)) THEN
      RAISE EXCEPTION 'a secret value has no secret field of the same key in the type merged into'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'types_merge_secret_fields';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.secret_values s
        JOIN public.type_fields f ON f.id = s.type_field_id
        JOIN public.type_fields g ON g.id = kept.field_for_key(p_into, f.key)
        LEFT JOIN public.secret_field_policies a
               ON a.location_id = s.location_id AND a.type_field_id = f.id
        LEFT JOIN public.secret_field_policies b
               ON b.location_id = s.location_id AND b.type_field_id = g.id
        CROSS JOIN LATERAL (
          SELECT coalesce(a.reveal_roles, ARRAY['owner', 'admin']) AS ar,
                 coalesce(b.reveal_roles, ARRAY['owner', 'admin']) AS br,
                 coalesce(a.reveal_user_ids, '{}'::uuid[]) AS au,
                 coalesce(b.reveal_user_ids, '{}'::uuid[]) AS bu,
                 coalesce(a.ai_allowed, false) AS aa, coalesce(b.ai_allowed, false) AS ba) p
       WHERE f.type_id = p_from
         AND NOT (p.ar @> p.br AND p.ar <@ p.br AND p.au @> p.bu AND p.au <@ p.bu AND p.aa = p.ba)
         AND NOT kept.owns_location(s.location_id)) THEN
      RAISE EXCEPTION 'a secret would change who may reveal it; only the location''s owner may'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'types_merge_secret_policy';
    END IF;
    UPDATE public.things t
       SET type_id = p_into,
           custom = (kept.split_custom(t.custom, p_into)).kept_values,
           archived_custom = t.archived_custom || (kept.split_custom(t.custom, p_into)).archived
     WHERE t.type_id = p_from;
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE public.secret_values s SET type_field_id = kept.field_for_key(p_into, f.key)
      FROM public.type_fields f
     WHERE f.id = s.type_field_id AND f.type_id = p_from;
    UPDATE public.types SET parent_id = p_into WHERE parent_id = p_from;
    DELETE FROM public.types WHERE id = p_from;
  END IF;
  RETURN n;
END $$;
--> statement-breakpoint

-- 4. Impact (I2; D123, D177) --------------------------------------------------------------------
-- An account type's impact counts the locations of the account the caller can't see (no id, no
-- name) only for an admin of the account; anyone else sees their own locations only, as for a
-- built-in.
CREATE OR REPLACE FUNCTION kept.type_impact(p_type uuid)
RETURNS TABLE (location_id uuid, location_name text, things integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  acct uuid;
  whole boolean;
BEGIN
  SELECT t.owner_account_id INTO acct FROM public.types t
   WHERE t.id = p_type
     AND (t.owner_account_id IS NULL
          OR t.owner_account_id IN (SELECT kept.visible_account_ids()));
  IF NOT FOUND OR kept.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'no such type' USING ERRCODE = 'insufficient_privilege';
  END IF;
  whole := acct IS NOT NULL AND coalesce(acct IN (SELECT kept.admin_account_ids()), false);
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
     AND (acct IS NULL OR l.owner_account_id = acct)
     AND (whole OR l.id IN (SELECT id FROM seen))
   GROUP BY l.id, l.name
   ORDER BY 3 DESC, 2;
END $$;
--> statement-breakpoint

-- 5. A thing's purchase and receipts (I3, minor; D115, D117) ------------------------------------
-- The purchase's total and tax only with `visible_purchase`: the thing shows its own line.
CREATE OR REPLACE FUNCTION kept.thing_purchase(p_thing uuid)
RETURNS TABLE (purchase_id uuid, location_id uuid, purchased_on date, vendor_name text,
               currency text, total numeric, tax numeric, line_id uuid, line_description text,
               line_quantity numeric, unit_price numeric, visible_purchase boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.id, p.location_id, p.purchased_on, v.name, p.currency::text,
         CASE WHEN w.ok THEN p.total END, CASE WHEN w.ok THEN p.tax END,
         pl.id, pl.description, pl.quantity, pl.unit_price, w.ok
    FROM public.things t
    JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
    JOIN public.purchases p ON p.id = pl.purchase_id
    LEFT JOIN public.vendors v ON v.id = p.vendor_id
    CROSS JOIN LATERAL (SELECT p.location_id IN (SELECT kept.visible_location_ids()) AS ok) w
   WHERE t.id = p_thing AND t.location_id IN (SELECT kept.visible_location_ids())
$$;
--> statement-breakpoint
-- Originals are for members and above (D117): the file is served only to someone who writes in
-- the thing's location. Viewers still list the receipts (kept.thing_receipts()).
CREATE OR REPLACE FUNCTION kept.thing_receipt_file(p_thing uuid, p_file uuid)
RETURNS TABLE (storage_key text, mime text, bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT f.storage_key, f.mime, f.bytes
    FROM public.files f
   WHERE f.id = p_file
     AND EXISTS (SELECT 1 FROM public.things t
                  WHERE t.id = p_thing AND t.location_id IN (SELECT kept.writable_location_ids()))
     AND EXISTS (SELECT 1 FROM kept.thing_receipts(p_thing) r WHERE r.file_id = p_file)
$$;
--> statement-breakpoint

-- 6. Conversions and custom (I4, D116, D156) ----------------------------------------------------
-- As 0021's, with `custom` split by kept.split_custom() (a key the type resolves as secret is
-- archived, never indexed).
CREATE OR REPLACE FUNCTION kept.convert_place_to_container(p_place uuid, p_type uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  p public.places%ROWTYPE;
  v_type uuid;
  split record;
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
  split := kept.split_custom(p.custom, v_type);
  parent := coalesce(p.parent_id, (SELECT u.id FROM public.places u
                                    WHERE u.location_id = p.location_id AND u.is_unplaced));
  INSERT INTO public.things (id, location_id, place_id, type_id, name, custom, archived_custom,
                             created_by)
  VALUES (p.id, p.location_id, parent, v_type, p.name, split.kept_values, split.archived, uid);
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
-- As 0021's, and the links that go with the deleted thing are tombstoned (D156).
CREATE OR REPLACE FUNCTION kept.convert_container_to_place(p_thing uuid, p_parent uuid)
RETURNS uuid
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
  INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
  SELECT k.location_id, 'thing_link', k.id FROM public.thing_links k
   WHERE k.from_thing_id = t.id OR k.to_thing_id = t.id
  ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now();
  DELETE FROM public.things WHERE id = t.id;
  INSERT INTO public.sync_tombstones (location_id, entity_type, entity_id)
  VALUES (t.location_id, 'thing', t.id)
  ON CONFLICT (location_id, entity_type, entity_id) DO UPDATE SET updated_at = now();
  DELETE FROM public.sync_tombstones z
   WHERE z.location_id = t.location_id AND z.entity_type = 'place' AND z.entity_id = t.id;
  RETURN t.id;
END $$;
--> statement-breakpoint
-- Defence in depth (I4, D116): no key of `custom` may resolve to a secret field of the thing's
-- type, on any write (the routes' customSchema refuses it first). 23514 things_custom_secret.
-- Invoker: the type is the location's account's or built in, which the writer sees.
CREATE FUNCTION kept.guard_thing_custom() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  k text;
BEGIN
  IF NEW.type_id IS NULL OR NEW.custom = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  SELECT f.key INTO k
    FROM kept.type_chain(NEW.type_id) ch
    JOIN public.types t ON t.id = ch.id
    JOIN public.type_fields f ON f.type_id = t.id OR f.type_id = ANY (t.field_groups)
   WHERE f.secret AND NEW.custom ? f.key
   LIMIT 1;
  IF k IS NOT NULL THEN
    RAISE EXCEPTION 'field % is secret: it is written through the secret store, never in custom', k
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_custom_secret';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER things_guard_custom BEFORE INSERT OR UPDATE OF custom, type_id ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.guard_thing_custom();
--> statement-breakpoint
-- Contact details (D177): a person named in a custom value is used there, as one they own.
CREATE OR REPLACE FUNCTION kept.person_contact_visible(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.people p
                  WHERE p.id = p_person AND p.owner_account_id IN (SELECT kept.admin_account_ids()))
     AND NOT EXISTS (SELECT 1 FROM kept.person_use_locations(p_person) AS u(id)
                      WHERE u.id NOT IN (SELECT kept.admin_location_ids()))
$$;
--> statement-breakpoint

-- 7. Files (I6, minor; D117, D161, D162, D177) ---------------------------------------------------
-- Storage keys are the database's: `f/<location>/<file>` and `d/<file>/<variant>.jpg`, the blob
-- store's own scheme (storage/blob-store.ts), whatever a request sends. Only kept_owner's paths
-- (the definers: a cross-account copy shares its source's blob, D161; seeds and tests) keep the
-- key they give.
CREATE FUNCTION kept.stamp_storage_key() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user <> 'kept_owner' THEN
    IF TG_TABLE_NAME = 'files' THEN
      NEW.storage_key := 'f/' || NEW.location_id::text || '/' || NEW.id::text;
    ELSE
      NEW.storage_key := 'd/' || NEW.file_id::text || '/' || NEW.variant || '.jpg';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER files_storage_key BEFORE INSERT ON public.files
  FOR EACH ROW EXECUTE FUNCTION kept.stamp_storage_key();
--> statement-breakpoint
CREATE TRIGGER file_derivatives_storage_key BEFORE INSERT ON public.file_derivatives
  FOR EACH ROW EXECUTE FUNCTION kept.stamp_storage_key();
--> statement-breakpoint
-- Derivatives: made for your own upload (or by a definer).
DROP POLICY app_insert ON public.file_derivatives;
--> statement-breakpoint
CREATE POLICY app_insert ON public.file_derivatives FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND EXISTS (SELECT 1 FROM public.files f
                           WHERE f.id = file_derivatives.file_id
                             AND f.location_id = file_derivatives.location_id
                             AND f.created_by = (SELECT kept.current_user_id())));
--> statement-breakpoint
-- Deleting: an admin of the location (D162's "delete original"), or the uploader while nothing
-- is attached (a discarded upload). Derivatives go the same way.
DROP POLICY app_delete ON public.files;
--> statement-breakpoint
CREATE POLICY app_delete ON public.files FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids())
         AND (location_id IN (SELECT kept.admin_location_ids())
              OR (created_by = (SELECT kept.current_user_id())
                  AND NOT EXISTS (SELECT 1 FROM public.attachments a
                                   WHERE a.file_id = files.id))));
--> statement-breakpoint
DROP POLICY app_delete ON public.file_derivatives;
--> statement-breakpoint
CREATE POLICY app_delete ON public.file_derivatives FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids())
         AND (location_id IN (SELECT kept.admin_location_ids())
              OR EXISTS (SELECT 1 FROM public.files f
                          WHERE f.id = file_derivatives.file_id
                            AND f.created_by = (SELECT kept.current_user_id())
                            AND NOT EXISTS (SELECT 1 FROM public.attachments a
                                             WHERE a.file_id = f.id))));
--> statement-breakpoint

-- 8. Attribution, people, types, fields (minor) --------------------------------------------------
-- Who made a row is the request's user, and when a reading arrived is now: a request can't
-- write someone else's name. kept_owner's paths (definers copying rows, seeds) keep theirs.
-- created_via stays the client's, within its CHECK's list.
CREATE FUNCTION kept.stamp_request_user() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
BEGIN
  IF current_user = 'kept_owner' OR uid IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'meter_readings' THEN
    NEW.logged_by := uid;
    NEW.received_at := now();
  ELSIF TG_TABLE_NAME = 'short_ids' THEN
    IF NEW.claimed_by IS NOT NULL OR NEW.claimed_at IS NOT NULL THEN
      NEW.claimed_by := uid;
      NEW.claimed_at := now();
    END IF;
  ELSE
    NEW.created_by := uid;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['things', 'places', 'thing_links', 'purchases', 'meter_readings',
                           'short_ids'] LOOP
    EXECUTE format('CREATE TRIGGER stamp_request_user BEFORE INSERT ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION kept.stamp_request_user()', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- A person linked to a user (member_user_id): someone with a membership in a location of the
-- person's account. Anyone else, and a user who exists nowhere, is the same 42501. A definer: it
-- must see memberships of locations the caller can't.
CREATE FUNCTION kept.guard_person_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.member_user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.member_user_id IS DISTINCT FROM OLD.member_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.memberships m
                       JOIN public.locations l ON l.id = m.location_id
                      WHERE m.user_id = NEW.member_user_id
                        AND l.owner_account_id = NEW.owner_account_id) THEN
    RAISE EXCEPTION 'no such member'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'people_member_user';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER people_guard_member BEFORE INSERT OR UPDATE OF member_user_id ON public.people
  FOR EACH ROW EXECUTE FUNCTION kept.guard_person_member();
--> statement-breakpoint
-- Adding contact details (D177): a writer of the account may, for a person used nowhere they
-- can't write (so nobody else's admins are shown what they add), and who has none yet. A
-- person with contacts is refused like one the caller can't reach (42501, never 23505: whether
-- a contact exists is not the caller's to learn). A definer: uses and contacts in other
-- locations are invisible to the caller.
CREATE FUNCTION kept.person_contact_writable(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.people p
                  WHERE p.id = p_person
                    AND p.owner_account_id IN (SELECT kept.writable_account_ids()))
     AND NOT EXISTS (SELECT 1 FROM public.person_contacts c WHERE c.person_id = p_person)
     AND NOT EXISTS (SELECT 1 FROM kept.person_use_locations(p_person) AS u(id)
                      WHERE u.id NOT IN (SELECT kept.writable_location_ids()))
$$;
--> statement-breakpoint
DROP POLICY app_insert ON public.person_contacts;
--> statement-breakpoint
CREATE POLICY app_insert ON public.person_contacts FOR INSERT TO kept_app
  WITH CHECK (owner_account_id IN (SELECT kept.writable_account_ids())
              AND kept.person_contact_writable(person_id));
--> statement-breakpoint
-- Types (D92): copied_from_id names a built-in, nothing else (another account's type, or one
-- that doesn't exist, is the same 42501 types_copied_from).
CREATE OR REPLACE FUNCTION kept.guard_type() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  p record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kept.types'),
                                hashtext(coalesce(NEW.owner_account_id::text, '')));
  IF NEW.copied_from_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.copied_from_id IS DISTINCT FROM OLD.copied_from_id)
     AND NOT EXISTS (SELECT 1 FROM public.types t
                      WHERE t.id = NEW.copied_from_id AND t.owner_account_id IS NULL) THEN
    RAISE EXCEPTION 'a type is copied from a built-in'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'types_copied_from';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT t.owner_account_id, t.is_field_group INTO p FROM public.types t WHERE t.id = NEW.parent_id;
    IF NOT FOUND OR p.is_field_group
       OR (p.owner_account_id IS NOT NULL
           AND p.owner_account_id IS DISTINCT FROM NEW.owner_account_id) THEN
      RAISE EXCEPTION 'a type''s parent is a type of the same account, or a built-in'
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'types_parent_account';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
      WITH RECURSIVE up(id) AS (
        SELECT NEW.parent_id
        UNION
        SELECT t.parent_id FROM public.types t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL
      )
      SELECT 1 FROM up WHERE up.id = NEW.id
    ) THEN
      RAISE EXCEPTION 'a type can''t sit under itself or one of its descendants'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'types_no_loop';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.field_groups) AS g(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.types t
        WHERE t.id = g.id AND t.is_field_group
          AND (t.owner_account_id IS NULL OR t.owner_account_id = NEW.owner_account_id))
  ) THEN
    RAISE EXCEPTION 'a field group is a field group of the same account, or a built-in'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'types_field_group_account';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.is_field_group AND NOT OLD.is_field_group AND EXISTS (
    SELECT 1 FROM public.types t WHERE t.parent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a field group is nobody''s parent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'types_field_group_chk';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER types_guard ON public.types;
--> statement-breakpoint
CREATE TRIGGER types_guard BEFORE INSERT OR UPDATE OF parent_id, field_groups, owner_account_id,
  is_field_group, copied_from_id ON public.types
  FOR EACH ROW EXECUTE FUNCTION kept.guard_type();
--> statement-breakpoint
-- The key check (0018's) runs on a new type too: a parent and a field group that both define a
-- key can't meet in a type made with both.
CREATE OR REPLACE FUNCTION kept.guard_type_keys() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  starts uuid[];
  clash record;
BEGIN
  -- One query per table and event: a transition table only has its own table's columns, and an
  -- INSERT has no old rows.
  IF TG_TABLE_NAME = 'types' AND TG_OP = 'INSERT' THEN
    SELECT array_agg(n.id) INTO starts
      FROM new_rows n WHERE n.parent_id IS NOT NULL OR cardinality(n.field_groups) > 0;
  ELSIF TG_TABLE_NAME = 'types' THEN
    SELECT array_agg(n.id) INTO starts
      FROM new_rows n JOIN old_rows o ON o.id = n.id
     WHERE (n.parent_id, n.field_groups) IS DISTINCT FROM (o.parent_id, o.field_groups);
  ELSE
    SELECT array_agg(DISTINCT n.type_id) INTO starts FROM new_rows n WHERE n.type_id IS NOT NULL;
  END IF;
  IF starts IS NULL THEN
    RETURN NULL; -- nothing that can clash (place-kind fields have no inheritance)
  END IF;
  WITH RECURSIVE affected(id) AS (
    SELECT unnest(starts)
    UNION
    SELECT t.id FROM public.types t JOIN affected a
        ON t.parent_id = a.id OR a.id = ANY (t.field_groups)
  ),
  chain(root, id, depth) AS (
    SELECT a.id, a.id, 0 FROM affected a
    UNION ALL
    SELECT c.root, t.parent_id, c.depth + 1
      FROM chain c JOIN public.types t ON t.id = c.id
     WHERE t.parent_id IS NOT NULL AND c.depth < 64
  ),
  sources(root, src) AS (
    SELECT c.root, c.id FROM chain c
    UNION
    SELECT c.root, g.id FROM chain c JOIN public.types t ON t.id = c.id
      CROSS JOIN LATERAL unnest(t.field_groups) AS g(id)
  )
  SELECT s.root, f.key INTO clash
    FROM sources s JOIN public.type_fields f ON f.type_id = s.src
   GROUP BY s.root, f.key HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'field key % is already defined along this type''s chain', clash.key
      USING ERRCODE = 'check_violation', CONSTRAINT = 'type_fields_inherited_key';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER types_keys_insert AFTER INSERT ON public.types
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION kept.guard_type_keys();
--> statement-breakpoint
-- A field never turns secret or plain in place (D177: that conversion is per location and the
-- owner's, and later work). The reference seed checks first, and names the field.
CREATE FUNCTION kept.guard_field_secret() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.secret IS DISTINCT FROM OLD.secret THEN
    RAISE EXCEPTION 'field % can''t change to or from secret', OLD.key
      USING ERRCODE = 'check_violation', CONSTRAINT = 'type_fields_secret_fixed';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER type_fields_secret_fixed BEFORE UPDATE OF secret ON public.type_fields
  FOR EACH ROW EXECUTE FUNCTION kept.guard_field_secret();
--> statement-breakpoint

-- 9. Performance ---------------------------------------------------------------------------------
-- A tag statement refreshes each thing's search document once, not once per tag row.
-- (Transition tables take one event per trigger, hence two.)
DROP TRIGGER thing_tags_refresh ON public.thing_tags;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.refresh_thing_doc() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.things SET search_tsv = NULL
     WHERE id IN (SELECT DISTINCT o.thing_id FROM old_rows o);
  ELSE
    UPDATE public.things SET search_tsv = NULL
     WHERE id IN (SELECT DISTINCT n.thing_id FROM new_rows n);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER thing_tags_refresh_insert AFTER INSERT ON public.thing_tags
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION kept.refresh_thing_doc();
--> statement-breakpoint
CREATE TRIGGER thing_tags_refresh_delete AFTER DELETE ON public.thing_tags
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION kept.refresh_thing_doc();
--> statement-breakpoint
-- Reindexing rewrites only the things whose path or search document would change, 1000 at a
-- time: a rename touches a few rows of a location, and a rewrite costs WAL and GIN updates.
-- Returns the things rewritten.
CREATE OR REPLACE FUNCTION kept.reindex_location(p_location uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n integer := 0;
  batch integer;
  last_id uuid;
  batch_ids uuid[];
BEGIN
  IF p_location IS NULL THEN
    RAISE EXCEPTION 'reindexing needs a location' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  LOOP
    batch_ids := ARRAY(SELECT t.id FROM public.things t
                        WHERE t.location_id = p_location AND t.deleted_at IS NULL
                          AND (last_id IS NULL OR t.id > last_id)
                        ORDER BY t.id LIMIT 1000);
    EXIT WHEN cardinality(batch_ids) = 0;
    last_id := batch_ids[cardinality(batch_ids)];
    UPDATE public.things t SET place_path = NULL, search_tsv = NULL
      FROM (SELECT x.id
              FROM public.things x
              CROSS JOIN LATERAL (
                SELECT string_agg(s.e->>'name', ' › ' ORDER BY s.k) AS path
                  FROM jsonb_array_elements(kept.path_of(x.place_id, x.container_id))
                       WITH ORDINALITY AS s(e, k)) np
             WHERE x.id = ANY (batch_ids)
               AND (x.place_path IS DISTINCT FROM np.path
                    OR x.search_tsv IS DISTINCT FROM kept.thing_search_doc(
                         jsonb_populate_record(x, jsonb_build_object('place_path', np.path))))) c
     WHERE t.id = c.id;
    GET DIAGNOSTICS batch = ROW_COUNT;
    n := n + batch;
  END LOOP;
  RETURN n;
END $$;
--> statement-breakpoint

-- Who may call what: the helpers and triggers are kept_owner's; one new door for kept_app.
REVOKE EXECUTE ON FUNCTION kept.guard_thing_custom(), kept.stamp_storage_key(),
  kept.stamp_request_user(), kept.guard_person_member(), kept.guard_field_secret()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.person_contact_writable(uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.person_contact_writable(uuid) TO kept_app;
--> statement-breakpoint

-- 10. Saved views (D42): an owner or admin of a shared view's location may delete it (never
--     edit it), as the search route allows. Permissive, so it adds to app_write's own-views rule.
CREATE POLICY app_delete_shared ON public.saved_views FOR DELETE TO kept_app
  USING (shared AND location_id IN (SELECT kept.admin_location_ids()));
