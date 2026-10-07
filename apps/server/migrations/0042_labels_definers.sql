-- Custom SQL migration file, put your code below! --
-- Step 3, task 7: labels, blank claims and duplicate merges (D36, D43, D44, D112, D137, D172,
-- D175; engineering spec §2.4, §3.1b; plan Q16, Q24). Above, in 0041, drizzle's part:
-- label_batches and label_batch_codes (src/db/schema/labels.ts). Below:
--   1. Row-level security: a location's batches are read by whoever sees it and made by its
--      writers (`labels.use`: owners, admins, members); a batch's codes are its location's own
--      visible codes, so a batch can't probe another household's codes through the foreign key.
--      Only "Printed OK?" is ever updated; codes are never updated or deleted.
--   2. The blank-label cap (§3.1b): at most 1,000 unclaimed blank codes per location, checked
--      under a per-location advisory lock (23514 short_ids_blank_cap, 409 blank_cap_reached).
--   3. kept.claim_blank_code(): claiming a pre-printed blank label for a thing or a place of the
--      location it was printed for, decided by the server (D43, D112): `claimed`, or
--      `already_claimed` with who has it when it was claimed first, in a location the caller
--      sees. Anything else (missing, retired, another location, invisible) is the same 42501 a
--      missing code gives (D137, §2.4, Q24).
--   4. kept.merge_things(): a duplicate merged into its survivor, keeping both histories (D36,
--      Q16). The merged thing is trashed with merged_into_id; its attachments, contents, tags,
--      links, legacy codes, meters (when the survivor has none), secret values (for fields the
--      survivor has no value for) and purchase line (when the survivor has none) move to the
--      survivor, and its short IDs become the survivor's secondary codes, so an old label still
--      finds it. Returns the references moved. It doesn't audit: the route does (T15).
--   6. kept.set_file_display() (T13, `PUT /files/:id/display`): the phone's display, thumb and
--      share renditions of a photo, and `derivative_state = 'ready'`, on a file the caller may see
--      (through an attachment, or as its uploader before it is attached: files' own rule, 0020)
--      in a location the caller writes. kept_app may not UPDATE files (append-only), so this is
--      the door; the route keeps its own rules (the uploader only, within 24 hours).
--   5. The tombstone-on-arrival triggers (0036) fire on an update only when location_id really
--      changes: a move within a location sets location_id to itself, and 200 things moved that way
--      paid 200 needless tombstone deletes.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-capture.ts fills the
-- tables.

-- 1. Row-level security --------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['label_batches', 'label_batch_codes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM kept_app, kept_system', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY app_select ON public.label_batches FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.label_batches FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND created_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.label_batches FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (printed_confirmed_at, updated_at, row_version) ON public.label_batches TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.label_batches
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE POLICY app_select ON public.label_batch_codes FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.label_batch_codes FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND EXISTS (SELECT 1 FROM public.short_ids s
                           WHERE s.code = label_batch_codes.code
                             AND s.location_id = label_batch_codes.location_id));
--> statement-breakpoint

-- 2. The blank-label cap --------------------------------------------------------------------------
-- Invoker: it counts the location's blank codes, which a writer of that location sees.
CREATE FUNCTION kept.guard_blank_cap() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kept.blank'), hashtext(NEW.location_id::text));
  IF (SELECT count(*) FROM public.short_ids s
       WHERE s.location_id = NEW.location_id AND s.state = 'blank') >= 1000 THEN
    RAISE EXCEPTION 'a location holds at most 1,000 unclaimed blank labels'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'short_ids_blank_cap';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_blank_cap() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER short_ids_blank_cap BEFORE INSERT ON public.short_ids
  FOR EACH ROW WHEN (NEW.state = 'blank') EXECUTE FUNCTION kept.guard_blank_cap();
--> statement-breakpoint
CREATE INDEX short_ids_blank_idx ON public.short_ids (location_id) WHERE state = 'blank';
--> statement-breakpoint

-- 3. Claiming a blank label ------------------------------------------------------------------------
CREATE FUNCTION kept.claim_blank_code(p_code character(6), p_thing uuid, p_place uuid)
RETURNS TABLE (outcome text, thing_id uuid, place_id uuid, name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE
  uid uuid := kept.current_user_id();
  loc uuid;
  claimed public.short_ids%ROWTYPE;
  held public.short_ids%ROWTYPE;
BEGIN
  IF p_thing IS NOT NULL AND p_place IS NULL THEN
    SELECT t.location_id INTO loc FROM public.things t
     WHERE t.id = p_thing AND t.deleted_at IS NULL;
  ELSIF p_place IS NOT NULL AND p_thing IS NULL THEN
    SELECT p.location_id INTO loc FROM public.places p
     WHERE p.id = p_place AND p.deleted_at IS NULL;
  END IF;
  IF uid IS NULL OR loc IS NULL
     OR NOT coalesce(loc IN (SELECT kept.writable_location_ids()), false) THEN
    RAISE EXCEPTION 'not in your Kept' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.short_ids s
     SET state = 'assigned', thing_id = p_thing, place_id = p_place,
         is_primary = NOT EXISTS (
           SELECT 1 FROM public.short_ids x
            WHERE x.state = 'assigned' AND x.is_primary
              AND (x.thing_id = p_thing OR x.place_id = p_place)),
         claimed_at = now(), claimed_by = uid
   WHERE s.code = upper(p_code) AND s.state = 'blank' AND s.location_id = loc
  RETURNING * INTO claimed;
  IF claimed.code IS NOT NULL THEN
    RETURN QUERY SELECT 'claimed'::text, p_thing, p_place,
      coalesce((SELECT t.name FROM public.things t WHERE t.id = p_thing),
               (SELECT p.name FROM public.places p WHERE p.id = p_place));
    RETURN;
  END IF;
  SELECT * INTO held FROM public.short_ids s
   WHERE s.code = upper(p_code) AND s.state = 'assigned'
     AND s.location_id IN (SELECT kept.visible_location_ids());
  IF held.code IS NOT NULL THEN
    RETURN QUERY SELECT 'already_claimed'::text, held.thing_id, held.place_id,
      coalesce((SELECT t.name FROM public.things t WHERE t.id = held.thing_id),
               (SELECT p.name FROM public.places p WHERE p.id = held.place_id));
    RETURN;
  END IF;
  RAISE EXCEPTION 'not in your Kept' USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint

-- 4. Merging a duplicate --------------------------------------------------------------------------
CREATE FUNCTION kept.merge_things(p_from uuid, p_into uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  f public.things%ROWTYPE;
  i public.things%ROWTYPE;
  n integer := 0;
  more integer;
BEGIN
  SELECT * INTO f FROM public.things t
   WHERE t.id = p_from AND t.deleted_at IS NULL
     AND t.location_id IN (SELECT kept.writable_location_ids());
  SELECT * INTO i FROM public.things t
   WHERE t.id = p_into AND t.deleted_at IS NULL AND t.location_id = f.location_id;
  IF uid IS NULL OR f.id IS NULL OR i.id IS NULL OR p_from = p_into THEN
    RAISE EXCEPTION 'no such things of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kept.things'), hashtext(f.location_id::text));
  -- The survivor can't be inside the duplicate.
  IF EXISTS (WITH RECURSIVE up(id) AS (
               SELECT i.container_id
               UNION
               SELECT t.container_id FROM public.things t JOIN up ON t.id = up.id
                WHERE t.container_id IS NOT NULL)
             SELECT 1 FROM up WHERE up.id = p_from) THEN
    RAISE EXCEPTION 'a thing can''t be merged into one inside it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_no_loop';
  END IF;
  IF EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = p_from)
     AND EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = p_into) THEN
    RAISE EXCEPTION 'both things have meters; remove one first'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_merge_meters';
  END IF;
  IF EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = p_from) AND i.quantity <> 1 THEN
    RAISE EXCEPTION 'a metered thing has quantity 1'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_quantity_one';
  END IF;

  UPDATE public.attachments SET thing_id = p_into WHERE thing_id = p_from;
  GET DIAGNOSTICS more = ROW_COUNT; n := n + more;
  UPDATE public.things SET container_id = p_into
   WHERE container_id = p_from AND location_id = f.location_id;
  GET DIAGNOSTICS more = ROW_COUNT; n := n + more;
  INSERT INTO public.thing_tags (location_id, thing_id, tag_id)
  SELECT f.location_id, p_into, x.tag_id FROM public.thing_tags x WHERE x.thing_id = p_from
  ON CONFLICT DO NOTHING;
  DELETE FROM public.thing_tags x WHERE x.thing_id = p_from;
  GET DIAGNOSTICS more = ROW_COUNT; n := n + more;
  -- Links: the one between the two goes; one the survivor already has goes; the rest move.
  DELETE FROM public.thing_links k
   WHERE (k.from_thing_id = p_from AND k.to_thing_id = p_into)
      OR (k.from_thing_id = p_into AND k.to_thing_id = p_from)
      OR (k.from_thing_id = p_from AND EXISTS (
            SELECT 1 FROM public.thing_links o
             WHERE o.from_thing_id = p_into AND o.to_thing_id = k.to_thing_id AND o.kind = k.kind))
      OR (k.to_thing_id = p_from AND EXISTS (
            SELECT 1 FROM public.thing_links o
             WHERE o.to_thing_id = p_into AND o.from_thing_id = k.from_thing_id AND o.kind = k.kind));
  UPDATE public.thing_links SET from_thing_id = p_into WHERE from_thing_id = p_from;
  GET DIAGNOSTICS more = ROW_COUNT; n := n + more;
  UPDATE public.thing_links SET to_thing_id = p_into WHERE to_thing_id = p_from;
  GET DIAGNOSTICS more = ROW_COUNT; n := n + more;
  UPDATE public.legacy_codes SET thing_id = p_into
   WHERE thing_id = p_from AND location_id = f.location_id;
  GET DIAGNOSTICS more = ROW_COUNT; n := n + more;
  UPDATE public.meters SET thing_id = p_into WHERE thing_id = p_from;
  GET DIAGNOSTICS more = ROW_COUNT; n := n + more;
  -- Secret values of fields the survivor resolves the same way and holds no current value for;
  -- the rest stay with the merged thing, as its history.
  UPDATE public.secret_values s SET thing_id = p_into
   WHERE s.thing_id = p_from
     AND kept.field_for_key(i.type_id, s.field_key) = s.type_field_id
     AND NOT EXISTS (SELECT 1 FROM public.secret_values c
                      WHERE c.thing_id = p_into AND c.field_key = s.field_key
                        AND c.superseded_at IS NULL);
  GET DIAGNOSTICS more = ROW_COUNT; n := n + more;
  IF i.purchase_line_id IS NULL AND f.purchase_line_id IS NOT NULL THEN
    UPDATE public.things SET purchase_line_id = f.purchase_line_id WHERE id = p_into;
    n := n + 1;
  END IF;
  -- An old label of the duplicate now finds the survivor, as a secondary code.
  UPDATE public.short_ids SET thing_id = p_into, is_primary = false
   WHERE thing_id = p_from AND state = 'assigned';
  GET DIAGNOSTICS more = ROW_COUNT; n := n + more;
  UPDATE public.things
     SET deleted_at = now(), merged_into_id = p_into, trash_batch_id = uuidv7()
   WHERE id = p_from;
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.claim_blank_code(character, uuid, uuid),
  kept.merge_things(uuid, uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.claim_blank_code(character, uuid, uuid),
  kept.merge_things(uuid, uuid) TO kept_app;
--> statement-breakpoint

-- 5. Tombstones on arrival, only on a real arrival ------------------------------------------------
DROP TRIGGER things_tombstone_arrival ON public.things;
--> statement-breakpoint
DROP TRIGGER places_tombstone_arrival ON public.places;
--> statement-breakpoint
CREATE TRIGGER things_tombstone_arrival AFTER INSERT ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.clear_tombstone_on_arrival('thing');
--> statement-breakpoint
CREATE TRIGGER things_tombstone_moved AFTER UPDATE OF location_id ON public.things
  FOR EACH ROW WHEN (OLD.location_id IS DISTINCT FROM NEW.location_id)
  EXECUTE FUNCTION kept.clear_tombstone_on_arrival('thing');
--> statement-breakpoint
CREATE TRIGGER places_tombstone_arrival AFTER INSERT ON public.places
  FOR EACH ROW EXECUTE FUNCTION kept.clear_tombstone_on_arrival('place');
--> statement-breakpoint
CREATE TRIGGER places_tombstone_moved AFTER UPDATE OF location_id ON public.places
  FOR EACH ROW WHEN (OLD.location_id IS DISTINCT FROM NEW.location_id)
  EXECUTE FUNCTION kept.clear_tombstone_on_arrival('place');
--> statement-breakpoint

-- 6. A photo's display from the phone ------------------------------------------------------------
-- p_variants: [{variant: display|thumb|share, width, height, bytes}]. Each replaces that variant's
-- row, keyed `d/<file>/<variant>.jpg` (storage/blob-store.ts derivativeKey). Anything the caller
-- can't see or write is 42501.
CREATE FUNCTION kept.set_file_display(p_file uuid, p_variants jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  f public.files%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.files x
   WHERE x.id = p_file
     AND x.location_id IN (SELECT kept.writable_location_ids())
     AND (x.created_by = uid
          OR EXISTS (SELECT 1 FROM public.attachments a
                      WHERE a.file_id = x.id
                        AND a.location_id IN (SELECT kept.visible_location_ids())));
  IF uid IS NULL OR f.id IS NULL THEN
    RAISE EXCEPTION 'no such file of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_variants) <> 'array' OR jsonb_array_length(p_variants) = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_variants) v
                 WHERE v->>'variant' NOT IN ('display', 'thumb', 'share')) THEN
    RAISE EXCEPTION 'renditions are display, thumb and share'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.file_derivatives d
   WHERE d.file_id = f.id
     AND d.variant IN (SELECT v->>'variant' FROM jsonb_array_elements(p_variants) v);
  INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width, height,
                                       bytes)
  SELECT f.id, v->>'variant', f.location_id, 'd/' || f.id::text || '/' || (v->>'variant') || '.jpg',
         (v->>'width')::int, (v->>'height')::int, (v->>'bytes')::bigint
    FROM jsonb_array_elements(p_variants) v;
  UPDATE public.files x SET derivative_state = 'ready' WHERE x.id = f.id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.set_file_display(uuid, jsonb) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.set_file_display(uuid, jsonb) TO kept_app;
