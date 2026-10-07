-- Custom SQL migration file, put your code below! --
-- Step 2, task 6: things, short IDs, links and tag assignments, and the places extension
-- (engineering spec §1.3, §7.2, §7.9, §7.13; D10, D42, D45, D76, D112, D120, D160, D177, D183;
-- plan Q1, Q5, Q11, Q12). The tables and columns are 0015's.
--   1. RLS: location-scoped, read if visible, written if writable; short IDs are never deleted.
--   2. Column grants.
--   3. Short IDs' foreign keys (ON DELETE SET NULL (col)) and the retired tombstone.
--   4. Guards on things and their tags: registries of the location's own account, D10's
--      quantity rule, no container loops.
--   5. The caches (§7.9): place_path and search_tsv, recomputed by kept.thing_cache(); tag
--      changes refresh the document without bumping row_version.
--   6. Indexes Drizzle can't declare: GIN on search_tsv, trigram on normalised names, the
--      normalised serial, the ICU sort key.
--   7. kept.person_contact_visible() gains its things clause (D177, Q5).
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.

-- 1. RLS -------------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['things', 'short_ids', 'thing_links', 'thing_tags'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format($p$
      CREATE POLICY app_select ON public.%I FOR SELECT TO kept_app
        USING (location_id IN (SELECT kept.visible_location_ids()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_insert ON public.%I FOR INSERT TO kept_app
        WITH CHECK (location_id IN (SELECT kept.writable_location_ids()))$p$, t);
  END LOOP;
  -- Updated in place: things and short IDs (printed, primary). Links and tag rows are removed
  -- and made again.
  FOREACH t IN ARRAY ARRAY['things', 'short_ids'] LOOP
    EXECUTE format($p$
      CREATE POLICY app_update ON public.%I FOR UPDATE TO kept_app
        USING (location_id IN (SELECT kept.writable_location_ids()))
        WITH CHECK (location_id IN (SELECT kept.writable_location_ids()))$p$, t);
  END LOOP;
  -- Deleted: things (only ever by purge or a definer in practice; the routes trash), links and
  -- tag rows. Never short IDs (§7.13): no kept_app DELETE policy, so a DELETE finds no row.
  FOREACH t IN ARRAY ARRAY['things', 'thing_links', 'thing_tags'] LOOP
    EXECUTE format($p$
      CREATE POLICY app_delete ON public.%I FOR DELETE TO kept_app
        USING (location_id IN (SELECT kept.writable_location_ids()))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 2. Column grants. Not granted: id, location_id, created_via, created_by, split_from_id,
--    place_path (the cache writes it); short IDs' code, location and targets (moving a code is a
--    definer's, task 9); anything on links and tag rows.
REVOKE UPDATE ON public.things, public.short_ids, public.thing_links, public.thing_tags
  FROM kept_app, kept_system;
--> statement-breakpoint
GRANT UPDATE (place_id, container_id, type_id, name, brand_id, model, serial, barcode, colour,
              quantity, condition, notes, aliases, belongs_to_person_id, purchase_line_id,
              manual_url, expires_on, expiry_lead_days, lifecycle, ended_on, ended_price,
              ended_currency, ended_to, ended_notes, acquired_from, provenance_notes,
              last_seen_at, location_uncertain, custom, archived_custom, field_status,
              review_state, search_tsv, deleted_at, trash_batch_id, updated_at, row_version)
  ON public.things TO kept_app;
--> statement-breakpoint
GRANT UPDATE (printed_at, is_primary, updated_at, row_version) ON public.short_ids TO kept_app;
--> statement-breakpoint
GRANT UPDATE (icon, sort, custom, trash_batch_id) ON public.places TO kept_app;
--> statement-breakpoint

-- 3. Short IDs (D45, D112, D120, §7.13) -------------------------------------------------------
-- The targets are cleared, never cascaded, when a thing or place is purged; the location stays.
-- A move carries the code along (ON UPDATE CASCADE).
ALTER TABLE public.short_ids ADD CONSTRAINT short_ids_thing_fk FOREIGN KEY (location_id, thing_id)
  REFERENCES public.things (location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (thing_id);
--> statement-breakpoint
ALTER TABLE public.short_ids ADD CONSTRAINT short_ids_place_fk FOREIGN KEY (location_id, place_id)
  REFERENCES public.places (location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (place_id);
--> statement-breakpoint
-- An assigned code whose target was purged becomes a retired tombstone (and no longer primary),
-- before the target CHECK sees it. Invoker: it only rewrites the row being updated.
CREATE FUNCTION kept.retire_orphan_code() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'assigned' AND NEW.thing_id IS NULL AND NEW.place_id IS NULL THEN
    NEW.state := 'retired';
    NEW.is_primary := false;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER short_ids_retire BEFORE UPDATE ON public.short_ids
  FOR EACH ROW EXECUTE FUNCTION kept.retire_orphan_code();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.short_ids
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.thing_links
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
-- Tag rows are inserted and deleted, never updated: change_seq on insert, for sync (§7.4).
CREATE TRIGGER touch_row BEFORE INSERT ON public.thing_tags
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- 4. Guards on things ------------------------------------------------------------------------

-- A thing's type, brand and owner-person are of its location's account (or a built-in type,
-- never a field group; §7.13, D178). Invoker: an id the caller can't see is refused exactly like
-- one of another account and one that doesn't exist (42501 things_registry_account, a 404).
-- Runs again on a move (location_id), which a definer (task 9) remaps first.
CREATE FUNCTION kept.guard_thing_refs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  acct uuid;
BEGIN
  SELECT l.owner_account_id INTO acct FROM public.locations l WHERE l.id = NEW.location_id;
  IF (NEW.type_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.types t
         WHERE t.id = NEW.type_id AND NOT t.is_field_group
           AND (t.owner_account_id IS NULL OR t.owner_account_id = acct)))
     OR (NEW.brand_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.brands b WHERE b.id = NEW.brand_id AND b.owner_account_id = acct))
     OR (NEW.belongs_to_person_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.people p
         WHERE p.id = NEW.belongs_to_person_id AND p.owner_account_id = acct)) THEN
    RAISE EXCEPTION 'a thing''s type, brand and person belong to its location''s account'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'things_registry_account';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER things_guard_refs
  BEFORE INSERT OR UPDATE OF type_id, brand_id, belongs_to_person_id, location_id ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.guard_thing_refs();
--> statement-breakpoint

-- D10 (§7.13, plan Q11): quantity is 1 while the type (through inheritance) is serialized or
-- metered (task 7 adds "or has a meter"); 0 only for a consumable.
CREATE FUNCTION kept.guard_thing_quantity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  caps text[] := kept.type_capabilities(NEW.type_id);
BEGIN
  IF NEW.quantity <> 1 AND caps && ARRAY['serialized', 'metered'] THEN
    RAISE EXCEPTION 'a serialized or metered thing has quantity 1'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_quantity_one';
  END IF;
  IF NEW.quantity = 0 AND NOT 'consumable' = ANY (caps) THEN
    RAISE EXCEPTION 'only a consumable can have quantity 0'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_quantity_positive';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER things_guard_quantity BEFORE INSERT OR UPDATE OF quantity, type_id ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.guard_thing_quantity();
--> statement-breakpoint

-- No container loops (D45), as places (0005): a per-location lock while re-parenting, and a walk
-- up the containers within NEW's own location only (a container elsewhere is the foreign key's
-- to refuse). 23514 things_no_loop.
CREATE FUNCTION kept.check_thing_container() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.container_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM pg_advisory_xact_lock(hashtext('kept.things'), hashtext(NEW.location_id::text));
  END IF;
  IF EXISTS (
    WITH RECURSIVE up(id) AS (
      SELECT NEW.container_id
      UNION
      SELECT t.container_id FROM public.things t JOIN up ON t.id = up.id
       WHERE t.location_id = NEW.location_id AND t.container_id IS NOT NULL
    )
    SELECT 1 FROM up WHERE up.id = NEW.id
  ) THEN
    RAISE EXCEPTION 'thing % can''t go inside itself or something inside it', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_no_loop';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER things_container BEFORE INSERT OR UPDATE OF container_id, location_id ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.check_thing_container();
--> statement-breakpoint

-- A tag of the thing's location's account (D76, §7.13). 42501 thing_tags_account.
CREATE FUNCTION kept.guard_thing_tags() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tags g JOIN public.locations l ON l.owner_account_id = g.owner_account_id
     WHERE g.id = NEW.tag_id AND l.id = NEW.location_id
  ) THEN
    RAISE EXCEPTION 'a thing''s tags belong to its location''s account'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'thing_tags_account';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER thing_tags_guard BEFORE INSERT OR UPDATE ON public.thing_tags
  FOR EACH ROW EXECUTE FUNCTION kept.guard_thing_tags();
--> statement-breakpoint

-- 5. Caches (§7.9, D183) ---------------------------------------------------------------------

-- Where something is: from the root place down to the innermost container, as
-- [{id, name, kind: 'place' | 'container'}], for breadcrumbs and place_path. Starts at
-- `p_container` when given, else at `p_place`. Invoker, capped at 64 steps each way.
CREATE FUNCTION kept.path_of(p_place uuid, p_container uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  steps jsonb := '[]'::jsonb;
  cur_thing uuid := p_container;
  cur_place uuid := CASE WHEN p_container IS NULL THEN p_place END;
  r record;
  n integer := 0;
BEGIN
  WHILE cur_thing IS NOT NULL AND n < 64 LOOP
    SELECT t.id, t.name, t.container_id, t.place_id INTO r FROM public.things t WHERE t.id = cur_thing;
    EXIT WHEN NOT FOUND;
    steps := jsonb_build_array(jsonb_build_object('id', r.id, 'name', r.name, 'kind', 'container'))
             || steps;
    cur_thing := r.container_id;
    IF r.container_id IS NULL THEN
      cur_place := r.place_id;
    END IF;
    n := n + 1;
  END LOOP;
  n := 0;
  WHILE cur_place IS NOT NULL AND n < 64 LOOP
    SELECT p.id, p.name, p.parent_id INTO r FROM public.places p WHERE p.id = cur_place;
    EXIT WHEN NOT FOUND;
    steps := jsonb_build_array(jsonb_build_object('id', r.id, 'name', r.name, 'kind', 'place'))
             || steps;
    cur_place := r.parent_id;
    n := n + 1;
  END LOOP;
  RETURN steps;
END $$;
--> statement-breakpoint

-- The search document (D42, screens §8): A = name and aliases; B = model, serial, barcode,
-- brand, type (its own name, or its built-in names), tags; C = notes, colour, where it is, whose
-- it is, and scalar custom values. Money is an object {amount, currency} and never indexed; secret
-- fields never reach `custom`. Every text goes through kept.search_text() (normalised + stripped).
CREATE FUNCTION kept.thing_search_doc(t public.things) RETURNS tsvector
LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('simple', kept.search_text(concat_ws(' ', t.name,
           (SELECT string_agg(v, ' ')
              FROM jsonb_each(t.aliases) e,
                   jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value) = 'array'
                                                  THEN e.value ELSE '[]'::jsonb END) v)))), 'A')
      || setweight(to_tsvector('simple', kept.search_text(concat_ws(' ', t.model, t.serial,
           t.barcode,
           (SELECT b.name FROM public.brands b WHERE b.id = t.brand_id),
           (SELECT coalesce(ty.name, ty.search_names,
                            (SELECT c.search_names FROM public.types c WHERE c.id = ty.copied_from_id))
              FROM public.types ty WHERE ty.id = t.type_id),
           (SELECT string_agg(g.name, ' ') FROM public.thing_tags x
              JOIN public.tags g ON g.id = x.tag_id WHERE x.thing_id = t.id)))), 'B')
      || setweight(to_tsvector('simple', kept.search_text(concat_ws(' ', t.notes, t.colour,
           t.place_path,
           (SELECT p.display_name FROM public.people p WHERE p.id = t.belongs_to_person_id),
           (SELECT string_agg(v #>> '{}', ' ') FROM jsonb_each(t.custom) c(k, v)
             WHERE jsonb_typeof(v) IN ('string', 'number'))))), 'C')
$$;
--> statement-breakpoint

-- Recomputes both caches whenever something they read changes; a caller setting search_tsv
-- (NULL, from kept.refresh_thing_doc()) or place_path (the reindex job) gets them recomputed.
-- touch_row() then sees only quiet columns change, so no row_version bump (Q1).
CREATE FUNCTION kept.thing_cache() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.place_path := (SELECT string_agg(e->>'name', ' › ' ORDER BY n)
                       FROM jsonb_array_elements(kept.path_of(NEW.place_id, NEW.container_id))
                            WITH ORDINALITY AS x(e, n));
  NEW.search_tsv := kept.thing_search_doc(NEW);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER things_cache
  BEFORE INSERT OR UPDATE OF location_id, place_id, container_id, type_id, name, brand_id, model,
    serial, barcode, colour, notes, aliases, belongs_to_person_id, custom, search_tsv, place_path
  ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.thing_cache();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row('place_path,search_tsv', 'last_seen_at');
--> statement-breakpoint

-- A tag added or removed refreshes the thing's document: search_tsv is set to NULL and the
-- BEFORE trigger recomputes it; only a quiet column changed, so row_version stays (Q1).
CREATE FUNCTION kept.refresh_thing_doc() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  thing uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    thing := OLD.thing_id;
  ELSE
    thing := NEW.thing_id;
  END IF;
  UPDATE public.things SET search_tsv = NULL WHERE id = thing;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER thing_tags_refresh AFTER INSERT OR DELETE ON public.thing_tags
  FOR EACH ROW EXECUTE FUNCTION kept.refresh_thing_doc();
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION
  kept.retire_orphan_code(), kept.guard_thing_refs(), kept.guard_thing_quantity(),
  kept.check_thing_container(), kept.guard_thing_tags(), kept.thing_cache(),
  kept.refresh_thing_doc()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
-- The cache helpers: kept_app's (breadcrumbs, and the triggers its writes fire). The reindex
-- and purge doors (task 10) run as kept_owner.
REVOKE EXECUTE ON FUNCTION kept.path_of(uuid, uuid), kept.thing_search_doc(public.things)
  FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.path_of(uuid, uuid), kept.thing_search_doc(public.things)
  TO kept_app;
--> statement-breakpoint

-- 6. Indexes ---------------------------------------------------------------------------------
CREATE INDEX things_search_idx ON public.things USING gin (search_tsv) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX things_name_trgm ON public.things
  USING gin (kept.normalize(name) public.gin_trgm_ops) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX things_serial_idx ON public.things (location_id, kept.normalize(serial));
--> statement-breakpoint
-- Sorting by name in any script (D172).
CREATE INDEX things_name_sort_idx ON public.things (location_id, lower(name) COLLATE "und-x-icu");
--> statement-breakpoint
CREATE INDEX places_name_trgm ON public.places
  USING gin (kept.normalize(name) public.gin_trgm_ops) WHERE deleted_at IS NULL;
--> statement-breakpoint

-- 7. Contact details (D177, Q5): an admin of every location where a live thing belongs to the
--    person; a person used nowhere, an admin of any location of the account (0014's clause).
CREATE OR REPLACE FUNCTION kept.person_contact_visible(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.people p
                  WHERE p.id = p_person AND p.owner_account_id IN (SELECT kept.admin_account_ids()))
     AND NOT EXISTS (SELECT 1 FROM public.things t
                      WHERE t.belongs_to_person_id = p_person AND t.deleted_at IS NULL
                        AND t.location_id NOT IN (SELECT kept.admin_location_ids()))
$$;
