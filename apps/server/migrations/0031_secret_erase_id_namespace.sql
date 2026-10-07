ALTER TABLE "secret_values" DROP CONSTRAINT "secret_values_ciphertext_chk";--> statement-breakpoint
ALTER TABLE "secret_values" ALTER COLUMN "ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_ciphertext_chk" CHECK (ciphertext IS NULL OR jsonb_typeof(ciphertext) = 'object');--> statement-breakpoint
-- Step 2 route security review (items 17, 24, 35). Above, drizzle's part: secret_values.ciphertext
-- may be NULL, meaning erased. Below:
--   1. "Clear" erases (#17, decision): kept.clear_secret() supersedes the current value as before,
--      and also sets the ciphertext of every version of that field of that subject, current and
--      previous, to NULL. The rows stay (who set it and when, the history D116 keeps); what they
--      held is gone. Key rotation skips erased rows (secrets/rotate.ts).
--   2. kept.touch_row() takes an explicit request to bump (#24): a transaction that sets
--      `kept.touch` to 'force' gets row_version and updated_at bumped even by a write that touches
--      only bookkeeping, so a thing whose tags alone changed (thing_tags) moves its version and a
--      stale If-Match is caught. Setting it only ever adds a bump, so any role may.
--   3. Things and places share one id namespace (#35, decision): a deferred constraint trigger on
--      each refuses, at commit, a row whose id the other table holds, anywhere (definer: the
--      other tenant's rows are invisible to the writer). 23505 `inventory_ids_pkey`, which the
--      API answers like any taken client id: 404 (D178). At commit, so the conversions
--      (convert_place_to_container / convert_container_to_place, Q14), which insert the new row
--      before deleting the old one under the same id, pass without an exemption. An advisory
--      lock on the id serialises two transactions racing to take it in both tables.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions.

CREATE OR REPLACE FUNCTION kept.clear_secret(p_thing uuid, p_place uuid, p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  loc uuid;
  n int;
BEGIN
  IF num_nonnulls(p_thing, p_place) <> 1 OR p_key IS NULL THEN
    RAISE EXCEPTION 'a thing or a place, and a field key' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_thing IS NOT NULL THEN
    SELECT t.location_id INTO loc FROM public.things t
     WHERE t.id = p_thing AND t.deleted_at IS NULL;
  ELSE
    SELECT p.location_id INTO loc FROM public.places p
     WHERE p.id = p_place AND p.deleted_at IS NULL;
  END IF;
  IF loc IS NULL OR kept.current_user_id() IS NULL
     OR loc NOT IN (SELECT kept.writable_location_ids()) THEN
    RAISE EXCEPTION 'not a secret this user may clear'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'secret_values_writer';
  END IF;
  UPDATE public.secret_values SET superseded_at = now()
   WHERE superseded_at IS NULL AND field_key = p_key AND location_id = loc
     AND thing_id IS NOT DISTINCT FROM p_thing AND place_id IS NOT DISTINCT FROM p_place;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.secret_values SET ciphertext = NULL
   WHERE ciphertext IS NOT NULL AND field_key = p_key AND location_id = loc
     AND thing_id IS NOT DISTINCT FROM p_thing AND place_id IS NOT DISTINCT FROM p_place;
  RETURN n > 0;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  book  constant text[] := ARRAY['row_version', 'updated_at', 'change_seq'];
  quiet text[] := CASE WHEN TG_NARGS > 0 THEN string_to_array(TG_ARGV[0], ',') ELSE '{}' END;
  seqc  text[] := CASE WHEN TG_NARGS > 1 THEN string_to_array(TG_ARGV[1], ',') ELSE '{}' END;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0
     AND coalesce(current_setting('kept.touch', true), '') <> 'force'
     AND (to_jsonb(NEW) - book - quiet - seqc) = (to_jsonb(OLD) - book - quiet - seqc) THEN
    -- Only cache columns changed (§7.9, D183): no row_version, no updated_at.
    NEW.row_version := OLD.row_version;
    NEW.updated_at  := OLD.updated_at;
    NEW.change_seq  := CASE WHEN (to_jsonb(NEW) - book - quiet) = (to_jsonb(OLD) - book - quiet)
                            THEN OLD.change_seq ELSE nextval('kept.change_seq') END;
    RETURN NEW;
  END IF;
  NEW.change_seq := nextval('kept.change_seq');
  IF TG_OP = 'UPDATE' THEN
    NEW.row_version := OLD.row_version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.guard_inventory_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  taken boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kept.inventory_ids'), hashtext(NEW.id::text));
  IF TG_TABLE_NAME = 'places' THEN
    SELECT EXISTS (SELECT 1 FROM public.things t WHERE t.id = NEW.id) INTO taken;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.places p WHERE p.id = NEW.id) INTO taken;
  END IF;
  IF taken THEN
    RAISE EXCEPTION 'that id is taken' USING ERRCODE = 'unique_violation',
      CONSTRAINT = 'inventory_ids_pkey';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_inventory_id() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER places_inventory_id AFTER INSERT ON public.places
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kept.guard_inventory_id();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER things_inventory_id AFTER INSERT ON public.things
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kept.guard_inventory_id();
