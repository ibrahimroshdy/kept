-- Custom SQL migration file, put your code below! --
-- D236 (builds D170): a service line can use stock from a consumable. Above, in 0128, drizzle's
-- part: service_lines.consumable_thing_id and consumed_quantity (the engineering spec's §1.6
-- columns), its index and check (src/db/schema/services.ts). Below:
--   1. The key drizzle can't declare: the line's consumable is of the line's own location
--      (D183's composite keys), ON UPDATE CASCADE so it follows a move, ON DELETE SET NULL
--      (consumable_thing_id) so purging the consumable keeps the line and its words.
--   2. kept.service_line_consumable_follows(): a move that takes a line and its consumable to
--      different locations (the car moves and the shelf stays, or the shelf's box moves and the
--      car stays) drops the link instead of failing, as kept.move_things() drops a link between
--      two things that would cross locations. The line stays with its record; when both moved
--      together (the oil in the car's boot), the link is kept. A cascade runs as the table's
--      owner, so the function needs no definer rights.
-- The stock itself moves in the app (src/services/stock.ts), by the difference between a
-- record's lines before and after each write. src/db/migrate.test.ts lists the function.

-- 1. The key ------------------------------------------------------------------------------------
ALTER TABLE public.service_lines ADD CONSTRAINT service_lines_consumable_fk
  FOREIGN KEY (location_id, consumable_thing_id)
  REFERENCES public.things (location_id, id)
  ON UPDATE CASCADE ON DELETE SET NULL (consumable_thing_id);
--> statement-breakpoint

-- 2. A move that separates them drops the link ----------------------------------------------------
CREATE FUNCTION kept.service_line_consumable_follows() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- The line belongs where its record is (the record's own cascade, or none when only the
  -- consumable moved).
  NEW.location_id := coalesce(
    (SELECT r.location_id FROM public.service_records r WHERE r.id = NEW.service_record_id),
    NEW.location_id);
  IF NOT EXISTS (SELECT 1 FROM public.things t
                  WHERE t.id = NEW.consumable_thing_id AND t.location_id = NEW.location_id) THEN
    NEW.consumable_thing_id := NULL;
    NEW.consumed_quantity := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER service_lines_consumable_follows BEFORE UPDATE OF location_id ON public.service_lines
  FOR EACH ROW
  WHEN (NEW.consumable_thing_id IS NOT NULL AND OLD.location_id IS DISTINCT FROM NEW.location_id)
  EXECUTE FUNCTION kept.service_line_consumable_follows();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.service_line_consumable_follows() FROM PUBLIC, kept_app, kept_system;
