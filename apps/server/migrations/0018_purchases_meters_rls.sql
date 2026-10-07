-- Custom SQL migration file, put your code below! --
-- Step 2, task 7: purchases, lines and core meters (engineering spec §1.4, §1.6, §7.2, §7.13;
-- D10, D13, D113, D115, D161; plan Q11). The tables are 0017's.
--   1. RLS: location-scoped; read if visible, written if writable. The finer rules
--      (logs.edit-own, meters.manage) are can()'s.
--   2. Column grants and touch_row.
--   3. Guards: a thing's purchase line and a purchase's vendor belong where they should; D10
--      now counts a meter.
--   4. kept.thing_purchase(): a thing's purchase and line, even after a move (D115).
--   5. 0014's field-key check, once per statement instead of once per row.
-- The receipts of a thing's purchase (kept.thing_receipts()) need attachments: task 8 (0020).
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.

-- 1-2. RLS, grants, bookkeeping ----------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchases', 'purchase_lines', 'meters', 'meter_readings',
                           'meter_events'] LOOP
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
    EXECUTE format($p$
      CREATE POLICY app_update ON public.%I FOR UPDATE TO kept_app
        USING (location_id IN (SELECT kept.writable_location_ids()))
        WITH CHECK (location_id IN (SELECT kept.writable_location_ids()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_delete ON public.%I FOR DELETE TO kept_app
        USING (location_id IN (SELECT kept.writable_location_ids()))$p$, t);
    EXECUTE format('CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION kept.touch_row()', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Not granted: ids, location_id, purchase_id, meter_id and thing_id (re-homing is a move),
-- created_via/created_by, a meter's kind and unit, a reading's source, logged_by and received_at.
REVOKE UPDATE ON public.purchases, public.purchase_lines, public.meters, public.meter_readings,
  public.meter_events FROM kept_app, kept_system;
--> statement-breakpoint
GRANT UPDATE (vendor_id, purchased_on, currency, total, tax, notes, review_state, updated_at,
              row_version)
  ON public.purchases TO kept_app;
--> statement-breakpoint
GRANT UPDATE (description, quantity, unit_price, sort, updated_at, row_version)
  ON public.purchase_lines TO kept_app;
--> statement-breakpoint
GRANT UPDATE (label, "offset", max_per_day, updated_at, row_version) ON public.meters TO kept_app;
--> statement-breakpoint
GRANT UPDATE (value, taken_at, note, state, review_reason, updated_at, row_version)
  ON public.meter_readings TO kept_app;
--> statement-breakpoint
GRANT UPDATE (at, "offset", updated_at, row_version) ON public.meter_events TO kept_app;
--> statement-breakpoint

-- 3. Guards --------------------------------------------------------------------------------

-- Linking a thing to a purchase line (D115): the line must be one the caller can see, in the
-- thing's own location. A line elsewhere (another tenant, or another of the caller's locations)
-- is refused like one that doesn't exist (42501 things_purchase_line). Only a change is checked,
-- so a thing moved to another location keeps its line (D115); the move definer (task 9) copies it
-- across accounts.
CREATE FUNCTION kept.guard_purchase_line_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.purchase_line_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.purchase_line_id IS DISTINCT FROM OLD.purchase_line_id)
     AND NOT EXISTS (SELECT 1 FROM public.purchase_lines pl
                      WHERE pl.id = NEW.purchase_line_id AND pl.location_id = NEW.location_id) THEN
    RAISE EXCEPTION 'a thing''s purchase line is one of its own location'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'things_purchase_line';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER things_guard_purchase_line BEFORE INSERT OR UPDATE OF purchase_line_id
  ON public.things
  FOR EACH ROW EXECUTE FUNCTION kept.guard_purchase_line_link();
--> statement-breakpoint

-- A purchase's vendor is of its location's account (§7.13). 42501 purchases_vendor_account.
CREATE FUNCTION kept.guard_purchase_vendor() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.vendor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.vendors v JOIN public.locations l ON l.owner_account_id = v.owner_account_id
     WHERE v.id = NEW.vendor_id AND l.id = NEW.location_id
  ) THEN
    RAISE EXCEPTION 'a purchase''s vendor belongs to its location''s account'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'purchases_vendor_account';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER purchases_guard_vendor BEFORE INSERT OR UPDATE OF vendor_id, location_id
  ON public.purchases
  FOR EACH ROW EXECUTE FUNCTION kept.guard_purchase_vendor();
--> statement-breakpoint

-- D10 (plan Q11), now with meters: a thing with a meter has quantity 1, as a serialized or
-- metered one does; 0 only for a consumable. Same signature, so 0016's trigger keeps it.
CREATE OR REPLACE FUNCTION kept.guard_thing_quantity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  caps text[] := kept.type_capabilities(NEW.type_id);
BEGIN
  IF NEW.quantity <> 1
     AND (caps && ARRAY['serialized', 'metered']
          OR EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = NEW.id)) THEN
    RAISE EXCEPTION 'a serialized or metered thing, or one with a meter, has quantity 1'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_quantity_one';
  END IF;
  IF NEW.quantity = 0 AND NOT 'consumable' = ANY (caps) THEN
    RAISE EXCEPTION 'only a consumable can have quantity 0'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_quantity_positive';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- ...and the other way round: no meter on a thing whose quantity isn't 1.
CREATE FUNCTION kept.guard_meter() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.things t WHERE t.id = NEW.thing_id AND t.quantity <> 1) THEN
    RAISE EXCEPTION 'a thing with a meter has quantity 1'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'things_quantity_one';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER meters_guard BEFORE INSERT ON public.meters
  FOR EACH ROW EXECUTE FUNCTION kept.guard_meter();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_purchase_line_link(), kept.guard_purchase_vendor(),
  kept.guard_meter()
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 4. A thing's purchase (§7.2, D115) ---------------------------------------------------------
-- The purchase and line a thing came from, for a thing the caller can see, wherever the purchase
-- is: after a move within the account the line stays in the old location, which the caller may
-- not see. `visible_purchase` says whether they can open the whole purchase. Money is returned
-- as stored; the route strips it by the *thing's* location gate (serialize/gates.ts), never the
-- purchase's. Nothing for a thing the caller can't see (an empty answer, a 404).
CREATE FUNCTION kept.thing_purchase(p_thing uuid)
RETURNS TABLE (purchase_id uuid, location_id uuid, purchased_on date, vendor_name text,
               currency text, total numeric, tax numeric, line_id uuid, line_description text,
               line_quantity numeric, unit_price numeric, visible_purchase boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.id, p.location_id, p.purchased_on, v.name, p.currency::text, p.total, p.tax,
         pl.id, pl.description, pl.quantity, pl.unit_price,
         p.location_id IN (SELECT kept.visible_location_ids())
    FROM public.things t
    JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
    JOIN public.purchases p ON p.id = pl.purchase_id
    LEFT JOIN public.vendors v ON v.id = p.vendor_id
   WHERE t.id = p_thing AND t.location_id IN (SELECT kept.visible_location_ids())
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.thing_purchase(uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.thing_purchase(uuid) TO kept_app;
--> statement-breakpoint

-- 5. The field-key check (0014's kept.guard_type_keys()) once per statement, over every type the
--    statement touched, instead of once per row: a seed, a customise that copies a subtree, or a
--    merge writes many fields at once, and the per-row version walked the same chains for each
--    (the reference seed that test resets run took seconds under load). Same rule, same error
--    (23514 type_fields_inherited_key). Transition tables can't go with a column list, so the
--    types trigger fires on every UPDATE statement and keeps only rows whose parent or field
--    groups changed.
DROP TRIGGER type_fields_keys ON public.type_fields;
--> statement-breakpoint
DROP TRIGGER types_keys ON public.types;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.guard_type_keys() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  starts uuid[];
  clash record;
BEGIN
  -- One query per table: a transition table only has its own table's columns.
  IF TG_TABLE_NAME = 'types' THEN
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
CREATE TRIGGER type_fields_keys_insert AFTER INSERT ON public.type_fields
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION kept.guard_type_keys();
--> statement-breakpoint
CREATE TRIGGER type_fields_keys_update AFTER UPDATE ON public.type_fields
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION kept.guard_type_keys();
--> statement-breakpoint
CREATE TRIGGER types_keys AFTER UPDATE ON public.types
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION kept.guard_type_keys();
