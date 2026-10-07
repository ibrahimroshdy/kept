-- Custom SQL migration file, put your code below! --
-- Step 5, task 6: fuel, document costs and the vehicle report's thing (engineering spec §1.6,
-- §7.1, §7.13; D11, D26, D28, D51, D150, D170, D201; plan Q5, Q11, Q14, Q17). Above, in 0064,
-- drizzle's part: fuel_entries (src/db/schema/fuel.ts), attachments.fuel_entry_id (a pump
-- receipt) in attachments_one_subject_chk, expiring_documents.issued_on/cost/currency, and
-- report_runs.thing_id with 'vehicle_history' in report_runs_kind_chk. Below:
--   1. Row-level security on fuel_entries, as step 4's service records (0051): read wherever the
--      thing is seen; logged by its writer; changed or removed by whoever logged it, or an admin
--      (§7.1 "Readings, services, fuel": logs.edit-own vs logs.edit-delete-others). A real
--      DELETE, undoable through the audit (Q14): the undo puts the logger back (0056's
--      kept.undo_keep_creator(), now naming fuel_entries' logged_by) and the insert policy accepts
--      them. No kept_system policy: no job reads fills (the vehicle report runs as its requester).
--   2. The keys drizzle can't declare: a fill's reading, ON DELETE SET NULL (meter_reading_id);
--      a vehicle report's thing, cascading (its run goes with the car). A car's run follows it
--      across a move, and kept.report_run_follows_thing() keeps location_ids = {location_id}
--      (report_runs_locations_chk) as the cascade rewrites location_id.
--   3. Guards: a fill's station is of the location's account (0051's kept.guard_household_refs(),
--      42501 fuel_entries_vendor_account, a 404); a fill's reading is one the caller sees in its
--      location (42501 fuel_entries_reading) of a meter of its own thing (23514
--      fuel_entries_reading_thing). The plan's kept.guard_currency_enabled() guards
--      turning a currency off, not a row's currency: fuel's currency is a key to currencies, as
--      service records' is.
--   4. The document's cost: issued_on, cost and currency join expiring_documents' column grant.
--   5. kept.move_things() (0051's, every clause kept): across accounts a fill's station is mapped
--      as a service's vendor is, and the files of a moved thing's fills (and of its expiring
--      documents, which 0051 left behind) are re-homed as its own are.
--   6. kept.merge_registry() (0024's, every clause kept): merging a vendor moves claims', service
--      records' and fills' references too, where it moved only purchases'. Without it the fills'
--      key would null their station (ON DELETE SET NULL), and claims and services kept an id of
--      a vendor that no longer exists.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-vehicles.ts fills
-- the tables; src/db/fuel.test.ts tests them.

-- 1. Row-level security -----------------------------------------------------------------------------
ALTER TABLE public.fuel_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.fuel_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.fuel_entries FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE UPDATE ON public.fuel_entries FROM kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.fuel_entries
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE POLICY app_select ON public.fuel_entries FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.fuel_entries FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND (logged_by = (SELECT kept.current_user_id())
                   OR logged_by = kept.undo_creator(location_id, id)));
--> statement-breakpoint
CREATE POLICY app_update ON public.fuel_entries FOR UPDATE TO kept_app
  USING ((location_id IN (SELECT kept.writable_location_ids())
          AND logged_by = (SELECT kept.current_user_id()))
         OR location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.fuel_entries FOR DELETE TO kept_app
  USING ((location_id IN (SELECT kept.writable_location_ids())
          AND logged_by = (SELECT kept.current_user_id()))
         OR location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
-- Not granted: id, location_id and thing_id (re-homing is a move), logged_by.
GRANT UPDATE (taken_at, amount, unit, currency, cost, is_full, missed_before, vendor_id,
              meter_reading_id, note, updated_at, row_version)
  ON public.fuel_entries TO kept_app;
--> statement-breakpoint
-- 0056's, with fuel_entries' maker in logged_by.
CREATE OR REPLACE FUNCTION kept.undo_keep_creator() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  maker uuid;
  col text := CASE WHEN TG_TABLE_NAME IN ('service_records', 'fuel_entries') THEN 'logged_by'
                   ELSE 'created_by' END;
BEGIN
  IF coalesce(current_setting('app.undo', true), '') !~ '^[0-9a-f-]{36}$' THEN
    RETURN NEW;
  END IF;
  maker := kept.undo_creator(NEW.location_id, NEW.id);
  IF maker IS NOT NULL THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(col, maker));
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER undo_keep_creator BEFORE INSERT ON public.fuel_entries
  FOR EACH ROW EXECUTE FUNCTION kept.undo_keep_creator();
--> statement-breakpoint

-- 2. Keys drizzle can't declare ---------------------------------------------------------------------
ALTER TABLE public.fuel_entries ADD CONSTRAINT fuel_entries_reading_fk
  FOREIGN KEY (location_id, meter_reading_id)
  REFERENCES public.meter_readings (location_id, id) ON UPDATE CASCADE
  ON DELETE SET NULL (meter_reading_id);
--> statement-breakpoint
ALTER TABLE public.report_runs ADD CONSTRAINT report_runs_thing_fk
  FOREIGN KEY (location_id, thing_id)
  REFERENCES public.things (location_id, id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX report_runs_thing_idx ON public.report_runs (thing_id) WHERE thing_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION kept.report_run_follows_thing() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.location_ids := ARRAY[NEW.location_id];
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER report_runs_follow_thing BEFORE UPDATE OF location_id ON public.report_runs
  FOR EACH ROW
  WHEN (NEW.thing_id IS NOT NULL AND OLD.location_id IS DISTINCT FROM NEW.location_id)
  EXECUTE FUNCTION kept.report_run_follows_thing();
--> statement-breakpoint

-- 3. Guards -----------------------------------------------------------------------------------------
CREATE TRIGGER fuel_entries_guard_refs BEFORE INSERT OR UPDATE OF vendor_id ON public.fuel_entries
  FOR EACH ROW EXECUTE FUNCTION kept.guard_household_refs();
--> statement-breakpoint
-- Invoker: a reading the caller can't see is refused like one that doesn't exist (42501, a 404,
-- before the insert policy speaks); one of another of their things is 23514.
CREATE FUNCTION kept.guard_fuel_reading() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  owner_thing uuid;
BEGIN
  IF NEW.meter_reading_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.thing_id INTO owner_thing
    FROM public.meter_readings r JOIN public.meters m ON m.id = r.meter_id
   WHERE r.id = NEW.meter_reading_id AND r.location_id = NEW.location_id;
  IF owner_thing IS NULL THEN
    RAISE EXCEPTION 'no such reading'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'fuel_entries_reading';
  END IF;
  IF owner_thing IS DISTINCT FROM NEW.thing_id THEN
    RAISE EXCEPTION 'a fill''s reading is of its own vehicle''s meter'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fuel_entries_reading_thing';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fuel_entries_guard_reading BEFORE INSERT ON public.fuel_entries
  FOR EACH ROW EXECUTE FUNCTION kept.guard_fuel_reading();
--> statement-breakpoint
-- Only a real change: a move's cascade sets meter_reading_id to itself.
CREATE TRIGGER fuel_entries_guard_reading_update BEFORE UPDATE OF meter_reading_id
  ON public.fuel_entries
  FOR EACH ROW WHEN (OLD.meter_reading_id IS DISTINCT FROM NEW.meter_reading_id)
  EXECUTE FUNCTION kept.guard_fuel_reading();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_fuel_reading(), kept.report_run_follows_thing()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 4. The document's cost -------------------------------------------------------------------------------
GRANT UPDATE (issued_on, currency, cost) ON public.expiring_documents TO kept_app;
--> statement-breakpoint

-- 5. Moving things across locations ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION kept.move_things(p_ids uuid[], p_to_location uuid, p_place uuid,
                                            p_container uuid)
RETURNS TABLE (thing_id uuid, from_location uuid, dropped_link_ids uuid[],
               dropped_incident_ids uuid[])
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
  inc_thing uuid[] := '{}';
  inc_id uuid[] := '{}';
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

  -- 0051 (Q17): a thing out on loan (or borrowed in and not yet given back), or in repair, stays
  -- in its location until that ends.
  IF EXISTS (SELECT 1 FROM public.loans o
              WHERE o.thing_id = ANY (leaving) AND o.returned_at IS NULL) THEN
    RAISE EXCEPTION 'a thing on loan stays in its location until it is returned'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_move_open_loan';
  END IF;
  IF EXISTS (SELECT 1 FROM public.claims k
              WHERE k.thing_id = ANY (leaving) AND k.status = 'in_repair') THEN
    RAISE EXCEPTION 'a thing in repair stays in its location until the claim moves on'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_move_in_repair';
  END IF;

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

  -- 0051: what stays behind. A thing leaving leaves its incidents (returned, for the audit), its
  -- claims leave their incident, and its loans their return place (the place stays).
  FOR dropped IN
    DELETE FROM public.incident_things i
     WHERE i.thing_id = ANY (leaving)
    RETURNING i.thing_id, i.incident_id
  LOOP
    inc_thing := inc_thing || dropped.thing_id;
    inc_id := inc_id || dropped.incident_id;
  END LOOP;
  UPDATE public.claims k SET incident_id = NULL
   WHERE k.thing_id = ANY (leaving) AND k.incident_id IS NOT NULL;
  UPDATE public.loans o SET return_place_id = NULL
   WHERE o.thing_id = ANY (leaving) AND o.return_place_id IS NOT NULL;

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
                                       WHERE m.thing_id = ANY (set_ids))
            -- 0051: the files of its warranties, claims, loans, valuations and services.
            OR a.warranty_id IN (SELECT w.id FROM public.warranties w
                                  WHERE w.thing_id = ANY (set_ids))
            OR a.claim_id IN (SELECT k.id FROM public.claims k WHERE k.thing_id = ANY (set_ids))
            OR a.loan_id IN (SELECT o.id FROM public.loans o WHERE o.thing_id = ANY (set_ids))
            OR a.valuation_id IN (SELECT v.id FROM public.valuations v
                                   WHERE v.thing_id = ANY (set_ids))
            OR a.service_record_id IN (SELECT s.id FROM public.service_records s
                                        WHERE s.thing_id = ANY (set_ids))
            -- 0065: the files of its expiring documents and of its fills.
            OR a.expiring_document_id IN (SELECT d.id FROM public.expiring_documents d
                                           WHERE d.thing_id = ANY (set_ids))
            OR a.fuel_entry_id IN (SELECT f.id FROM public.fuel_entries f
                                    WHERE f.thing_id = ANY (set_ids)))
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

  -- 0051, across accounts: the people of its loans and the vendors of its claims and services,
  -- mapped by name as the thing's own registries are (a closed loan to Murdock moves with
  -- Murdock copied into the target account). Now that the rows are in the target location, so
  -- the guards (kept.guard_household_refs) see the target account.
  UPDATE public.loans o SET person_id = kept.map_registry('person', o.person_id, target_acct)
    FROM public.people p
   WHERE p.id = o.person_id AND o.thing_id = ANY (set_ids) AND p.owner_account_id <> target_acct;
  UPDATE public.claims k SET vendor_id = kept.map_registry('vendor', k.vendor_id, target_acct)
    FROM public.vendors v
   WHERE v.id = k.vendor_id AND k.thing_id = ANY (set_ids) AND v.owner_account_id <> target_acct;
  UPDATE public.service_records s
     SET vendor_id = kept.map_registry('vendor', s.vendor_id, target_acct)
    FROM public.vendors v
   WHERE v.id = s.vendor_id AND s.thing_id = ANY (set_ids) AND v.owner_account_id <> target_acct;
  -- 0065: a fill's station, as a service's vendor.
  UPDATE public.fuel_entries f
     SET vendor_id = kept.map_registry('vendor', f.vendor_id, target_acct)
    FROM public.vendors v
   WHERE v.id = f.vendor_id AND f.thing_id = ANY (set_ids) AND v.owner_account_id <> target_acct;

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
                         WHERE d.f = x.id OR d.t = x.id), '{}'::uuid[]),
         coalesce(ARRAY(SELECT i.inc FROM unnest(inc_thing, inc_id) AS i(t, inc)
                         WHERE i.t = x.id), '{}'::uuid[])
    FROM unnest(set_ids, set_locs) AS x(id, loc);
END $$;
--> statement-breakpoint

-- 6. Merging vendors -----------------------------------------------------------------------------------
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
    -- 0065: claims', service records' and fills' vendors too.
    UPDATE public.claims SET vendor_id = p_into WHERE vendor_id = p_from;
    GET DIAGNOSTICS more = ROW_COUNT;
    n := n + more;
    UPDATE public.service_records SET vendor_id = p_into WHERE vendor_id = p_from;
    GET DIAGNOSTICS more = ROW_COUNT;
    n := n + more;
    UPDATE public.fuel_entries SET vendor_id = p_into WHERE vendor_id = p_from;
    GET DIAGNOSTICS more = ROW_COUNT;
    n := n + more;
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
