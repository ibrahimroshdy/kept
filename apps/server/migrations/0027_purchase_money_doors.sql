-- Custom SQL migration file, put your code below! --
-- Step 2, task 12: currencies and purchases (engineering spec §3.4, §7.13; D115, D136, D161,
-- D168). Three things the routes need that reach past the caller's own locations, and one
-- backlog item:
--   1. Which currencies a location uses as its default (D168: those stay on). An instance admin
--      sees only their own locations, so the admin currency list asks a definer. Codes only.
--   2. The currency switch refuses, underneath the route, to turn off one of the five defaults
--      (D136) or a currency any location uses, deleted ones included (a restore brings it back).
--      kept_app's writes only: kept_owner (seeds, the CLI) is the operator.
--   3. Whether a purchase's lines are still used by things in another location (a thing moved
--      within the account keeps its line, D115). Deleting the purchase or the line would clear
--      those links by ON DELETE SET NULL, which ignores RLS: an editor of one location could
--      strip the purchase off things in a location they can't see, with no audit row there. The
--      route answers 409 `in_use` instead. A count only, for writers of the purchase's location.
--   4. kept.thing_purchase() also returns the vendor's id (T14's backlog), so a thing's purchase
--      links to its vendor without a lookup by name.
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.

-- 1. Currencies in use --------------------------------------------------------------------------
CREATE FUNCTION kept.currencies_in_use() RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT kept.is_instance_admin() THEN
    RAISE EXCEPTION 'instance admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT DISTINCT l.currency::text FROM public.locations l;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.currencies_in_use() FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.currencies_in_use() TO kept_app;
--> statement-breakpoint

-- 2. The switch's guard (D136, D168): 23514, a 409. Only instance admins reach the UPDATE (0012's
--    policy), so the in-use check can ask kept.currencies_in_use(). kept_owner's paths (the seed,
--    the operator's CLI, test fixtures) keep theirs, as with kept.stamp_request_user().
CREATE FUNCTION kept.guard_currency_enabled() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user = 'kept_owner' OR NOT (OLD.enabled AND NOT NEW.enabled) THEN
    RETURN NEW;
  END IF;
  IF NEW.code IN ('USD', 'CAD', 'GBP', 'EUR', 'EGP') THEN
    RAISE EXCEPTION 'the five default currencies stay on'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'currencies_default_fixed';
  END IF;
  IF NEW.code::text IN (SELECT kept.currencies_in_use()) THEN
    RAISE EXCEPTION 'a location uses this currency'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'currencies_in_use';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER currencies_guard_enabled BEFORE UPDATE OF enabled ON public.currencies
  FOR EACH ROW EXECUTE FUNCTION kept.guard_currency_enabled();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_currency_enabled() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint

-- 3. Lines used elsewhere (D115). `p_lines` NULL means every line of the purchase. 42501 (a 404)
--    unless the caller writes in the purchase's location.
CREATE FUNCTION kept.purchase_lines_used_elsewhere(p_purchase uuid, p_lines uuid[])
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  loc uuid;
  n integer;
BEGIN
  SELECT p.location_id INTO loc FROM public.purchases p WHERE p.id = p_purchase;
  IF loc IS NULL OR NOT loc IN (SELECT kept.writable_location_ids()) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*)::integer INTO n
    FROM public.things t
    JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
   WHERE pl.purchase_id = p_purchase
     AND (p_lines IS NULL OR pl.id = ANY (p_lines))
     AND t.location_id <> loc;
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.purchase_lines_used_elsewhere(uuid, uuid[])
  FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.purchase_lines_used_elsewhere(uuid, uuid[]) TO kept_app;
--> statement-breakpoint

-- 4. A thing's purchase, with the vendor's id. As 0024's otherwise: total and tax only when the
--    caller can open the whole purchase. The new column goes last, so readers that name their
--    columns are unchanged.
DROP FUNCTION kept.thing_purchase(uuid);
--> statement-breakpoint
CREATE FUNCTION kept.thing_purchase(p_thing uuid)
RETURNS TABLE (purchase_id uuid, location_id uuid, purchased_on date, vendor_name text,
               currency text, total numeric, tax numeric, line_id uuid, line_description text,
               line_quantity numeric, unit_price numeric, visible_purchase boolean,
               vendor_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.id, p.location_id, p.purchased_on, v.name, p.currency::text,
         CASE WHEN w.ok THEN p.total END, CASE WHEN w.ok THEN p.tax END,
         pl.id, pl.description, pl.quantity, pl.unit_price, w.ok, v.id
    FROM public.things t
    JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
    JOIN public.purchases p ON p.id = pl.purchase_id
    LEFT JOIN public.vendors v ON v.id = p.vendor_id
    CROSS JOIN LATERAL (SELECT p.location_id IN (SELECT kept.visible_location_ids()) AS ok) w
   WHERE t.id = p_thing AND t.location_id IN (SELECT kept.visible_location_ids())
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.thing_purchase(uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.thing_purchase(uuid) TO kept_app;
