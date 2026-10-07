-- Custom SQL migration file, put your code below! --
-- Step 3, task 4: sync foundations (engineering spec §1.10, §2.3, §7.4, §7.13; D40, D112, D146,
-- D156, D175, D195; plan Q1). Above, in 0035, drizzle's part: change_xid on the five synced
-- tables, things' capture_batch_id / merged_into_id / cover_file_id, and the tables sync_ops,
-- legacy_codes, box_checks and box_check_lines (src/db/schema/sync.ts). Below:
--   1. The watermark (Q1). A sequence value can't be compared with a transaction horizon: a
--      transaction that took change_seq 100 can commit after one that took 101. So beside
--      change_seq every synced row carries change_xid, the id of the transaction that last moved
--      its change_seq, and the snapshot asks for `change_xid >= <pg_snapshot_xmin of its previous
--      complete pass>`: a late commit is always re-read (a duplicate is harmless). The trigger is
--      named touch_row_xid so it fires after touch_row (BEFORE triggers fire in name order) and
--      compares the change_seq touch_row decided; a quiet update (search_tsv only) keeps both.
--      Rows written before this migration keep change_xid NULL, which reads as older than any
--      watermark: a phone's first pass is always a full one. No role holds UPDATE on change_xid.
--   2. things' touch_row learns cover_file_id as a change_seq-only column: a new photo reaches the
--      snapshot without bumping row_version (no If-Match conflict).
--   3. The cover cache (D195): kept.refresh_thing_cover(), a definer (things.cover_file_id has no
--      UPDATE grant), keeps things.cover_file_id at the first photo attachment's file. Its
--      composite foreign key to files is DEFERRABLE INITIALLY DEFERRED: a cross-location move
--      (kept.move_things) moves the thing a statement before it re-homes the photo's file, and the
--      trigger then points the cover at the copy.
--   4. A tombstone goes when its entity arrives (kept.clear_tombstone_on_arrival): a thing moved
--      A → B → A must not keep A's tombstone from the first move, or phones in A would drop it.
--   5. Row-level security, grants and touch_row on the new tables:
--      - sync_ops: the person's own rows only, even within one location; append-only.
--      - legacy_codes: read if visible, written if writable; only the target moves.
--      - box_checks, box_check_lines: read if visible, inserted if writable (checked_by = me);
--        append-only.
--   6. kept.prune_stale_rows() also removes sync_ops older than 30 days (§3.3).
--   7. Legacy codes follow their target through a conversion or a place merge (§7.13 "Changing
--      identity"): convert_place_to_container, convert_container_to_place (as 0024's) and
--      merge_places (as 0021's) each gain one UPDATE of legacy_codes.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-capture.ts fills the
-- tables.

-- 1. The watermark ------------------------------------------------------------------------------
CREATE FUNCTION kept.stamp_change_xid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.change_seq IS DISTINCT FROM OLD.change_seq THEN
    NEW.change_xid := pg_current_xact_id();
  ELSE
    NEW.change_xid := OLD.change_xid;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.stamp_change_xid() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['places', 'things', 'short_ids', 'sync_tombstones', 'legacy_codes'] LOOP
    EXECUTE format('CREATE TRIGGER touch_row_xid BEFORE INSERT OR UPDATE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION kept.stamp_change_xid()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 2. things: cover_file_id bumps change_seq only -------------------------------------------------
DROP TRIGGER touch_row ON public.things;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row('place_path,search_tsv', 'last_seen_at,cover_file_id');
--> statement-breakpoint

-- 3. The cover cache -----------------------------------------------------------------------------
ALTER TABLE public.things ADD CONSTRAINT things_cover_file_fk FOREIGN KEY (location_id, cover_file_id)
  REFERENCES public.files (location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (cover_file_id)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION kept.refresh_thing_cover() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.thing_id IS NOT NULL THEN
    ids := ids || OLD.thing_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') AND NEW.thing_id IS NOT NULL THEN
    ids := ids || NEW.thing_id;
  END IF;
  IF cardinality(ids) = 0 THEN
    RETURN NULL;
  END IF;
  UPDATE public.things t
     SET cover_file_id = c.file_id
    FROM (SELECT x.id,
                 (SELECT a.file_id FROM public.attachments a
                   WHERE a.thing_id = x.id AND a.role = 'photo' AND a.file_id IS NOT NULL
                   ORDER BY a.sort, a.created_at, a.id LIMIT 1) AS file_id
            FROM unnest(ids) AS x(id)) c
   WHERE t.id = c.id AND t.cover_file_id IS DISTINCT FROM c.file_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.refresh_thing_cover() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER attachments_thing_cover
  AFTER INSERT OR DELETE OR UPDATE OF role, sort, thing_id, file_id ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION kept.refresh_thing_cover();
--> statement-breakpoint

-- 4. A tombstone goes when its entity arrives ----------------------------------------------------
-- Invoker: an arrival is a write in a location the writer may write, whose tombstones its
-- policies let it delete (and a definer move runs as kept_owner).
CREATE FUNCTION kept.clear_tombstone_on_arrival() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.sync_tombstones z
   WHERE z.location_id = NEW.location_id AND z.entity_type = TG_ARGV[0] AND z.entity_id = NEW.id;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.clear_tombstone_on_arrival() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER things_tombstone_arrival AFTER INSERT OR UPDATE OF location_id ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.clear_tombstone_on_arrival('thing');
--> statement-breakpoint
CREATE TRIGGER places_tombstone_arrival AFTER INSERT OR UPDATE OF location_id ON public.places
  FOR EACH ROW EXECUTE FUNCTION kept.clear_tombstone_on_arrival('place');
--> statement-breakpoint

-- 5. Row-level security on the new tables ---------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sync_ops', 'legacy_codes', 'box_checks', 'box_check_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE ON public.%I FROM kept_app, kept_system', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- sync_ops: a person's own ledger. Append-only: no UPDATE, no DELETE (the prune is a door).
REVOKE DELETE ON public.sync_ops FROM kept_app, kept_system;
--> statement-breakpoint
CREATE POLICY app_select ON public.sync_ops FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.sync_ops FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids())));
--> statement-breakpoint
-- legacy_codes: as short IDs; only the target moves (a conversion, a merge, a CSV re-run).
CREATE POLICY app_select ON public.legacy_codes FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.legacy_codes FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_update ON public.legacy_codes FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.legacy_codes FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (thing_id, place_id, updated_at, row_version) ON public.legacy_codes TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.legacy_codes
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
-- box_checks and their lines: records of what someone counted. Append-only.
REVOKE DELETE ON public.box_checks, public.box_check_lines FROM kept_app, kept_system;
--> statement-breakpoint
CREATE POLICY app_select ON public.box_checks FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.box_checks FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND checked_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_select ON public.box_check_lines FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.box_check_lines FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint

-- 6. The nightly prune: every clause of 0011's, and sync_ops past 30 days ------------------------
CREATE OR REPLACE FUNCTION kept.prune_stale_rows()
RETURNS TABLE (what text, removed bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM auth.sign_in_failures f
   WHERE greatest(f.window_start, f.last_failure_at) < now() - interval '25 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'auth.sign_in_failures'; removed := n; RETURN NEXT;

  DELETE FROM auth.session_mfa m USING auth.session s
   WHERE s.id = m.session_id AND s.expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'auth.session_mfa'; removed := n; RETURN NEXT;

  DELETE FROM public.idempotency_keys k WHERE k.created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'idempotency_keys'; removed := n; RETURN NEXT;

  DELETE FROM public.sync_ops o WHERE o.received_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'sync_ops'; removed := n; RETURN NEXT;
END $$;
--> statement-breakpoint

-- 7. Legacy codes follow their target ------------------------------------------------------------
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
  UPDATE public.legacy_codes SET thing_id = p.id, place_id = NULL
   WHERE place_id = p.id AND location_id = p.location_id;
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
  UPDATE public.legacy_codes SET place_id = t.id, thing_id = NULL
   WHERE thing_id = t.id AND location_id = t.location_id;
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
CREATE OR REPLACE FUNCTION kept.merge_places(p_from uuid, p_into uuid) RETURNS integer
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
  UPDATE public.legacy_codes SET place_id = p_into WHERE place_id = p_from;
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
