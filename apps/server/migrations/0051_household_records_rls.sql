-- Custom SQL migration file, put your code below! --
-- Step 4, task 5: warranties, claims, loans, service records, typed attachments and the thing's
-- state bump (engineering spec §1.6, §1.7, §7.1, §7.13; D10, D26, D29, D53–D57, D113, D158,
-- D172, D177, D195; plan Q1, Q14–Q18, Q26). Above, in 0050, drizzle's part: warranties, claims,
-- loans, service_records, service_lines (src/db/schema/{warranties,lending,services}.ts), the six
-- new attachment subjects, brands.logo_file_id and things.state_version. Below:
--   1. Row-level security: read wherever the thing (or place) is seen, written by its writers
--      (members and above); a service record and its lines are its logger's to change, or any
--      admin's (§7.1 "Readings, services, fuel: add · edit or delete others'").
--   2. The keys drizzle can't declare: ON DELETE SET NULL (col) for a claim's warranty and
--      incident, a loan's return place and split source, a service's reading; a brand's logo.
--   3. Guards: a claim's or service's vendor and a loan's person are of the location's account
--      (§7.13, as kept.guard_thing_refs() holds a thing's brand; 42501, a 404), and a claim's
--      warranty is its own thing's (23514); a claim's status moves only as @kept/shared
--      CLAIM_TRANSITIONS says (23514 claims_transition), except for kept_owner and the undo path
--      (Q18: the undo handler sets `app.undo` to 'on' for its own transaction, set_config(...,
--      true)); D10: a thing with a warranty has quantity 1 (23514 warranties_quantity_one on the
--      warranty, things_quantity_one on the thing).
--   4. things.state_version, the 0047 pattern: it joins kept.touch_row's quiet columns, and
--      kept.touch_thing_state() bumps it when a loan or claim starts, ends or changes whom the
--      thing is with (its status, vendor, person, due date, return), only on a real change, so a
--      move's cascade never fires it. The snapshot then resends the thing with its derived states.
--   5. kept.move_things() (Q17): a thing on loan or in repair stays in its location (23514
--      things_move_open_loan, things_move_in_repair); one leaving drops its incidents (returned
--      as dropped_incident_ids, so the return type changes and the function is made again), its
--      claims' incident and its loans' return place; across accounts its loans' people and its
--      claims' and services' vendors are mapped as its own registries are; the files of its new
--      subjects are re-homed as its own are.
--   6. kept.person_use_locations() counts a loan (step-2 Q5, D177): contact details need admin
--      where the person has borrowed or lent too.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-household.ts fills
-- the tables; src/db/household-records.test.ts tests them.

-- 1. Row-level security -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warranties', 'claims', 'loans', 'service_records',
                           'service_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('REVOKE UPDATE ON public.%I FROM kept_app, kept_system', t);
    EXECUTE format(
      'CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION kept.touch_row()', t);
    EXECUTE format($p$
      CREATE POLICY app_select ON public.%I FOR SELECT TO kept_app
        USING (location_id IN (SELECT kept.visible_location_ids()))$p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['warranties', 'claims', 'loans'] LOOP
    EXECUTE format($p$
      CREATE POLICY app_insert ON public.%I FOR INSERT TO kept_app
        WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
                    AND created_by = (SELECT kept.current_user_id()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_update ON public.%I FOR UPDATE TO kept_app
        USING (location_id IN (SELECT kept.writable_location_ids()))
        WITH CHECK (location_id IN (SELECT kept.writable_location_ids()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_delete ON public.%I FOR DELETE TO kept_app
        USING (location_id IN (SELECT kept.writable_location_ids()))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT UPDATE (kind, provider, starts_on, ends_on, term_months, lifetime, lead_days, claim_contact,
              registered, registration_deadline, updated_at, row_version)
  ON public.warranties TO kept_app;
--> statement-breakpoint
GRANT UPDATE (warranty_id, incident_id, opened_on, reference, vendor_id, status, cost, currency,
              covered_amount, notes, closed_on, updated_at, row_version)
  ON public.claims TO kept_app;
--> statement-breakpoint
GRANT UPDATE (person_id, started_at, due_on, returned_at, return_place_id, previous_place_id,
              previous_container_id, lead_days, notes, updated_at, row_version)
  ON public.loans TO kept_app;
--> statement-breakpoint
-- A service record: logged by its writer; changed or removed by whoever logged it, or an admin.
CREATE POLICY app_insert ON public.service_records FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND logged_by = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_update ON public.service_records FOR UPDATE TO kept_app
  USING ((location_id IN (SELECT kept.writable_location_ids())
          AND logged_by = (SELECT kept.current_user_id()))
         OR location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.service_records FOR DELETE TO kept_app
  USING ((location_id IN (SELECT kept.writable_location_ids())
          AND logged_by = (SELECT kept.current_user_id()))
         OR location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
GRANT UPDATE (serviced_on, meter_reading_id, vendor_id, total, currency, notes, updated_at,
              row_version)
  ON public.service_records TO kept_app;
--> statement-breakpoint
-- Its lines follow it: whoever may change the record changes its lines.
CREATE FUNCTION kept.service_record_changeable(p_record uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.service_records r
     WHERE r.id = p_record
       AND ((r.location_id IN (SELECT kept.writable_location_ids())
             AND r.logged_by = kept.current_user_id())
            OR r.location_id IN (SELECT kept.admin_location_ids())))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.service_record_changeable(uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.service_record_changeable(uuid) TO kept_app;
--> statement-breakpoint
CREATE POLICY app_insert ON public.service_lines FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND kept.service_record_changeable(service_record_id));
--> statement-breakpoint
CREATE POLICY app_update ON public.service_lines FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids())
         AND kept.service_record_changeable(service_record_id))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.service_lines FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids())
         AND kept.service_record_changeable(service_record_id));
--> statement-breakpoint
GRANT UPDATE (kind, description, quantity, unit_cost, sort, updated_at, row_version)
  ON public.service_lines TO kept_app;
--> statement-breakpoint

-- 2. Keys drizzle can't declare -----------------------------------------------------------------------
ALTER TABLE public.claims ADD CONSTRAINT claims_warranty_fk
  FOREIGN KEY (location_id, warranty_id)
  REFERENCES public.warranties (location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (warranty_id);
--> statement-breakpoint
ALTER TABLE public.claims ADD CONSTRAINT claims_incident_fk
  FOREIGN KEY (location_id, incident_id)
  REFERENCES public.incidents (location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (incident_id);
--> statement-breakpoint
ALTER TABLE public.loans ADD CONSTRAINT loans_return_place_fk
  FOREIGN KEY (location_id, return_place_id)
  REFERENCES public.places (location_id, id) ON UPDATE CASCADE ON DELETE SET NULL (return_place_id);
--> statement-breakpoint
ALTER TABLE public.loans ADD CONSTRAINT loans_split_from_fk
  FOREIGN KEY (location_id, split_from_thing_id)
  REFERENCES public.things (location_id, id) ON UPDATE CASCADE
  ON DELETE SET NULL (split_from_thing_id);
--> statement-breakpoint
ALTER TABLE public.service_records ADD CONSTRAINT service_records_reading_fk
  FOREIGN KEY (location_id, meter_reading_id)
  REFERENCES public.meter_readings (location_id, id) ON UPDATE CASCADE
  ON DELETE SET NULL (meter_reading_id);
--> statement-breakpoint
ALTER TABLE public.brands ADD CONSTRAINT brands_logo_file_fk
  FOREIGN KEY (logo_file_id) REFERENCES public.files (id) ON DELETE SET NULL;
--> statement-breakpoint

-- 3. Guards -----------------------------------------------------------------------------------------
-- Invoker, as kept.guard_thing_refs(): a vendor or person the caller can't see is refused exactly
-- like one of another account (42501, a 404). Fires on the reference only, never on a move's
-- cascade of location_id: kept.move_things() maps them once the rows are in the target.
CREATE FUNCTION kept.guard_household_refs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  acct uuid;
BEGIN
  SELECT l.owner_account_id INTO acct FROM public.locations l WHERE l.id = NEW.location_id;
  IF TG_TABLE_NAME = 'loans' THEN
    IF NOT EXISTS (SELECT 1 FROM public.people p
                    WHERE p.id = NEW.person_id AND p.owner_account_id = acct) THEN
      RAISE EXCEPTION 'a loan''s person belongs to its location''s account'
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'loans_person_account';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.vendor_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.vendors v WHERE v.id = NEW.vendor_id AND v.owner_account_id = acct) THEN
    RAISE EXCEPTION 'a vendor belongs to the location''s account'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = TG_TABLE_NAME || '_vendor_account';
  END IF;
  -- Nested: plpgsql doesn't short-circuit, and service_records has no warranty_id.
  IF TG_TABLE_NAME = 'claims' THEN
    IF NEW.warranty_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.warranties w
          WHERE w.id = NEW.warranty_id AND w.thing_id = NEW.thing_id) THEN
      RAISE EXCEPTION 'a claim''s warranty is its own thing''s'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'claims_warranty_thing';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER claims_guard_refs BEFORE INSERT OR UPDATE OF vendor_id, warranty_id ON public.claims
  FOR EACH ROW EXECUTE FUNCTION kept.guard_household_refs();
--> statement-breakpoint
CREATE TRIGGER service_records_guard_refs BEFORE INSERT OR UPDATE OF vendor_id
  ON public.service_records
  FOR EACH ROW EXECUTE FUNCTION kept.guard_household_refs();
--> statement-breakpoint
CREATE TRIGGER loans_guard_refs BEFORE INSERT OR UPDATE OF person_id ON public.loans
  FOR EACH ROW EXECUTE FUNCTION kept.guard_household_refs();
--> statement-breakpoint
-- @kept/shared CLAIM_TRANSITIONS. The undo handler reopens a closed claim with `app.undo` = 'on'
-- in its own transaction (Q18); kept_owner's paths (seeds, the operator's CLI) keep theirs.
CREATE FUNCTION kept.guard_claim_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user = 'kept_owner' OR current_setting('app.undo', true) = 'on'
     OR (OLD.status = 'open' AND NEW.status IN ('in_repair', 'resolved', 'rejected'))
     OR (OLD.status = 'in_repair' AND NEW.status IN ('resolved', 'rejected', 'open')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a claim can''t go from % to %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation', CONSTRAINT = 'claims_transition';
END $$;
--> statement-breakpoint
CREATE TRIGGER claims_guard_transition BEFORE UPDATE OF status ON public.claims
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION kept.guard_claim_transition();
--> statement-breakpoint
-- D10 (step-2 Q11, plan Q26): a thing with a warranty record has quantity 1. Same signature, so
-- 0016's trigger keeps it.
CREATE OR REPLACE FUNCTION kept.guard_thing_quantity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  caps text[] := kept.type_capabilities(NEW.type_id);
BEGIN
  IF NEW.quantity <> 1
     AND (caps && ARRAY['serialized', 'metered']
          OR EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = NEW.id)
          OR EXISTS (SELECT 1 FROM public.warranties w WHERE w.thing_id = NEW.id)) THEN
    RAISE EXCEPTION 'a serialized or metered thing, or one with a meter or a warranty, has quantity 1'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_quantity_one';
  END IF;
  IF NEW.quantity = 0 AND NOT 'consumable' = ANY (caps) THEN
    RAISE EXCEPTION 'only a consumable can have quantity 0'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_quantity_positive';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- ...and the other way round: no warranty on a thing whose quantity isn't 1 ("Split it first").
CREATE FUNCTION kept.guard_warranty_quantity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.things t WHERE t.id = NEW.thing_id AND t.quantity <> 1) THEN
    RAISE EXCEPTION 'a thing with a warranty has quantity 1'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'warranties_quantity_one';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER warranties_guard_quantity BEFORE INSERT ON public.warranties
  FOR EACH ROW EXECUTE FUNCTION kept.guard_warranty_quantity();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_household_refs(), kept.guard_claim_transition(),
  kept.guard_warranty_quantity()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 4. The thing's state bump -------------------------------------------------------------------------
DROP TRIGGER touch_row ON public.things;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row('place_path,search_tsv',
                                               'last_seen_at,cover_file_id,meter_version,state_version');
--> statement-breakpoint
-- A definer: things.state_version has no column grant. A loan or claim deleted with its thing
-- finds no thing left to bump.
CREATE FUNCTION kept.touch_thing_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  ids uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    ids := ARRAY[OLD.thing_id];
  ELSIF TG_OP = 'UPDATE' AND OLD.thing_id IS DISTINCT FROM NEW.thing_id THEN
    ids := ARRAY[NEW.thing_id, OLD.thing_id];
  ELSE
    ids := ARRAY[NEW.thing_id];
  END IF;
  UPDATE public.things t SET state_version = t.state_version + 1 WHERE t.id = ANY (ids);
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.touch_thing_state() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER loans_thing_state AFTER INSERT OR DELETE ON public.loans
  FOR EACH ROW EXECUTE FUNCTION kept.touch_thing_state();
--> statement-breakpoint
-- Only a real change: a move's cascade sets location_id and thing_id to themselves.
CREATE TRIGGER loans_thing_state_update
  AFTER UPDATE OF returned_at, person_id, due_on, thing_id ON public.loans
  FOR EACH ROW
  WHEN (OLD.returned_at IS DISTINCT FROM NEW.returned_at OR OLD.person_id IS DISTINCT FROM NEW.person_id
        OR OLD.due_on IS DISTINCT FROM NEW.due_on OR OLD.thing_id IS DISTINCT FROM NEW.thing_id)
  EXECUTE FUNCTION kept.touch_thing_state();
--> statement-breakpoint
CREATE TRIGGER claims_thing_state AFTER INSERT OR DELETE ON public.claims
  FOR EACH ROW EXECUTE FUNCTION kept.touch_thing_state();
--> statement-breakpoint
CREATE TRIGGER claims_thing_state_update
  AFTER UPDATE OF status, vendor_id, thing_id ON public.claims
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.vendor_id IS DISTINCT FROM NEW.vendor_id
        OR OLD.thing_id IS DISTINCT FROM NEW.thing_id)
  EXECUTE FUNCTION kept.touch_thing_state();
--> statement-breakpoint

-- 5. Moving things across locations ---------------------------------------------------------------
DROP FUNCTION kept.move_things(uuid[], uuid, uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION kept.move_things(p_ids uuid[], p_to_location uuid, p_place uuid,
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
                                        WHERE s.thing_id = ANY (set_ids)))
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
REVOKE EXECUTE ON FUNCTION kept.move_things(uuid[], uuid, uuid, uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.move_things(uuid[], uuid, uuid, uuid) TO kept_app;
--> statement-breakpoint

-- 6. Contact details: a loan uses its person where it is ----------------------------------------------
CREATE OR REPLACE FUNCTION kept.person_use_locations(p_person uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT t.location_id
    FROM public.people p
    JOIN public.locations l ON l.owner_account_id = p.owner_account_id
    JOIN public.things t ON t.location_id = l.id
   WHERE p.id = p_person AND t.deleted_at IS NULL
     AND (t.belongs_to_person_id = p_person
          OR jsonb_path_exists(t.custom, '$.*[*] ? (@ == $id)',
                               jsonb_build_object('id', p_person::text)))
  UNION
  SELECT o.location_id FROM public.loans o WHERE o.person_id = p_person
$$;
