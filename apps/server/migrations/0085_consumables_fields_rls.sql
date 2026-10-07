-- Custom SQL migration file, put your code below! --
-- Step 7, task 6: stock rules and field conversion (engineering spec §1.6, §7.13; D14, D172,
-- D177; step-7 plan Q19, Q20). Above, in 0084, drizzle's part: stock_rules
-- (src/db/schema/consumables.ts). Below:
--   1. stock_rules under row-level security: read where the thing is seen, written by its
--      location's writers (things.edit: owners, admins and members), only on a thing whose type is
--      consumable through its chain (23514 stock_rules_consumable); an undo puts the creator back
--      (kept.undo_keep_creator(), 0056).
--   2. Field conversion (D172, D177; §7.13 "converting a field to secret moves its values and
--      scrubs custom, search_tsv and past audit diffs"). Sealing needs the keyring, which SQL
--      doesn't hold, so the app works between three doors, all the field's account owner's alone
--      (kept.current_owner_account_id(); an admin is refused, 42501; a built-in field is
--      customised first):
--      - kept.field_conversion_preview(): per location, how many things and places hold a value,
--        how many convert and how many go to the notes. Counts, never a value;
--      - kept.field_conversion_rows(): the values themselves, a page of at most 1,000 by subject
--        id: `custom -> key`, or a secret field's current ciphertext;
--      - kept.apply_field_conversion(): writes one batch the app converted (sealed for a secret),
--        and with p_finish changes the field's kind (its options, unit), scrubs past audit diffs
--        of the key to `{changed: true}` (to secret), and reindexes the account's locations.
--        To or from secret, the flag flips with the first batch, because the secret store takes
--        only a secret field's values (0020) and `custom` only a plain field's (0024). The job
--        runs the whole conversion in one transaction, so nobody sees it half done.
--      kept.guard_field_secret() (0024) lets the flag change only inside that door: kept_app has
--      no grant on type_fields.secret or .kind at all, and the door marks the one field it may
--      flip in a transaction-local setting, so the operator's own login still can't flip one in
--      place. A place has no notes: a place-kind field converts to or from secret only.
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-portability.ts
-- fills the rows; src/db/consumables.test.ts and field-convert.test.ts test them.

-- 1. stock_rules ------------------------------------------------------------------------------------
ALTER TABLE public.stock_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.stock_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.stock_rules FOR ALL TO kept_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE UPDATE ON public.stock_rules FROM kept_app, kept_system;
--> statement-breakpoint
REVOKE INSERT, DELETE ON public.stock_rules FROM kept_system;
--> statement-breakpoint
CREATE POLICY app_select ON public.stock_rules FOR SELECT TO kept_app
  USING (location_id IN (SELECT kept.visible_location_ids()));
--> statement-breakpoint
CREATE POLICY app_insert ON public.stock_rules FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids())
              AND (created_by = (SELECT kept.current_user_id())
                   OR created_by = kept.undo_creator(location_id, id)));
--> statement-breakpoint
CREATE POLICY app_update ON public.stock_rules FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.stock_rules FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
GRANT UPDATE (min_quantity, updated_at, row_version) ON public.stock_rules TO kept_app;
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.stock_rules
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER undo_keep_creator BEFORE INSERT ON public.stock_rules
  FOR EACH ROW EXECUTE FUNCTION kept.undo_keep_creator();
--> statement-breakpoint
-- Invoker: the writer sees the thing and its type. A thing the writer can't see (or one in another
-- location) is refused as the policy would refuse it (42501), before the consumable check.
CREATE FUNCTION kept.guard_stock_rule() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  ty uuid;
BEGIN
  SELECT t.type_id INTO ty FROM public.things t
   WHERE t.id = NEW.thing_id AND t.location_id = NEW.location_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such thing' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce('consumable' = ANY (kept.type_capabilities(ty)), false) THEN
    RAISE EXCEPTION 'only a consumable thing keeps a minimum'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_rules_consumable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_stock_rule() FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE TRIGGER stock_rules_consumable BEFORE INSERT OR UPDATE OF thing_id, location_id
  ON public.stock_rules FOR EACH ROW EXECUTE FUNCTION kept.guard_stock_rule();
--> statement-breakpoint

-- 2. Field conversion ---------------------------------------------------------------------------
-- 0024's guard, with the door's one exception.
CREATE OR REPLACE FUNCTION kept.guard_field_secret() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.secret IS DISTINCT FROM OLD.secret
     AND coalesce(current_setting('kept.field_convert', true), '') IS DISTINCT FROM OLD.id::text
  THEN
    RAISE EXCEPTION 'field % can''t change to or from secret', OLD.key
      USING ERRCODE = 'check_violation', CONSTRAINT = 'type_fields_secret_fixed';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- The field, locked, when the caller owns its account; else 42501. Owner-only: the doors call it.
CREATE FUNCTION kept.field_convert_field(p_field uuid) RETURNS public.type_fields
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  f public.type_fields%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.type_fields x WHERE x.id = p_field FOR UPDATE;
  IF f.id IS NULL OR f.owner_account_id IS NULL OR kept.current_user_id() IS NULL
     OR f.owner_account_id IS DISTINCT FROM kept.current_owner_account_id() THEN
    RAISE EXCEPTION 'no such field of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN f;
END $$;
--> statement-breakpoint
-- What `p_to` asks of field `f`: 'to_secret', 'from_secret' or 'kind'; 22023 for anything the
-- field can't become (@kept/shared field-convert.ts CONVERSIONS, canConvertSecret). `p_started`:
-- the flag already flipped by an earlier batch. Owner-only.
CREATE FUNCTION kept.field_convert_mode(f public.type_fields, p_to jsonb, p_started boolean)
RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  to_kind text := p_to->>'kind';
BEGIN
  IF jsonb_typeof(p_to->'toSecret') = 'boolean' AND NOT p_to ? 'kind' THEN
    IF f.kind <> 'text' OR f.secret = ((p_to->>'toSecret')::boolean <> p_started) THEN
      RAISE EXCEPTION 'this field can''t change that way' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN CASE WHEN (p_to->>'toSecret')::boolean THEN 'to_secret' ELSE 'from_secret' END;
  END IF;
  IF to_kind IS NULL OR p_to ? 'toSecret' OR f.secret OR f.type_id IS NULL
     OR NOT coalesce(to_kind = ANY (CASE f.kind
          WHEN 'text' THEN ARRAY['number', 'date', 'url', 'select']
          WHEN 'number' THEN ARRAY['text']
          WHEN 'date' THEN ARRAY['text']
          WHEN 'select' THEN ARRAY['text', 'multi_select']
          WHEN 'boolean' THEN ARRAY['text']
          ELSE ARRAY[]::text[] END), false) THEN
    RAISE EXCEPTION 'this field can''t change that way' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN 'kind';
END $$;
--> statement-breakpoint
-- Every thing and place holding a value of field `f`, in its account's locations, by subject id
-- (things and places share one id space, 0031): a thing whose type resolves the field through its
-- chain or field groups, a place of the field's kind. Owner-only.
CREATE FUNCTION kept.field_values(f public.type_fields)
RETURNS TABLE (subject_kind text, subject_id uuid, location_id uuid, value jsonb,
               ciphertext jsonb, key_version integer)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT 'thing', t.id, t.location_id, CASE WHEN NOT f.secret THEN t.custom -> f.key END,
         s.ciphertext, s.key_version
    FROM public.things t
    JOIN public.locations l ON l.id = t.location_id AND l.owner_account_id = f.owner_account_id
    LEFT JOIN public.secret_values s
      ON f.secret AND s.thing_id = t.id AND s.type_field_id = f.id
         AND s.superseded_at IS NULL AND s.ciphertext IS NOT NULL
   WHERE f.type_id IS NOT NULL
     AND (CASE WHEN f.secret THEN s.id IS NOT NULL ELSE t.custom ? f.key END)
     AND EXISTS (SELECT 1 FROM kept.type_chain(t.type_id) ch JOIN public.types ty ON ty.id = ch.id
                  WHERE ty.id = f.type_id OR f.type_id = ANY (ty.field_groups))
  UNION ALL
  SELECT 'place', p.id, p.location_id, CASE WHEN NOT f.secret THEN p.custom -> f.key END,
         s.ciphertext, s.key_version
    FROM public.places p
    JOIN public.locations l ON l.id = p.location_id AND l.owner_account_id = f.owner_account_id
    JOIN public.place_kinds k ON k.id = f.place_kind_id AND k.key = p.kind_key
    LEFT JOIN public.secret_values s
      ON f.secret AND s.place_id = p.id AND s.type_field_id = f.id
         AND s.superseded_at IS NULL AND s.ciphertext IS NOT NULL
   WHERE f.place_kind_id IS NOT NULL
     AND (CASE WHEN f.secret THEN s.id IS NOT NULL ELSE p.custom ? f.key END)
$$;
--> statement-breakpoint
-- Whether a value becomes kind `p_to` (the preview's estimate; the app converts, by the same
-- rules). Owner-only.
CREATE FUNCTION kept.field_value_converts(p_value jsonb, p_to jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE p_to->>'kind'
    WHEN 'number' THEN jsonb_typeof(p_value) = 'number'
                       OR (jsonb_typeof(p_value) = 'string'
                           AND p_value #>> '{}' ~ '^\s*-?[0-9]+([.,][0-9]+)?\s*$')
    WHEN 'date' THEN jsonb_typeof(p_value) = 'string'
                     AND p_value #>> '{}' ~ '^\s*[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])\s*$'
    WHEN 'url' THEN jsonb_typeof(p_value) = 'string'
                    AND p_value #>> '{}' ~* '^\s*https?://\S+\s*$'
    WHEN 'select' THEN jsonb_typeof(p_value) = 'string'
                       AND (jsonb_typeof(p_to->'options') IS DISTINCT FROM 'array'
                            OR p_to->'options' @> jsonb_build_array(btrim(p_value #>> '{}')))
    ELSE true END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.field_convert_field(uuid),
  kept.field_convert_mode(public.type_fields, jsonb, boolean),
  kept.field_values(public.type_fields), kept.field_value_converts(jsonb, jsonb)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
CREATE FUNCTION kept.field_conversion_preview(p_field uuid, p_to jsonb)
RETURNS TABLE (location_id uuid, location_name text, "values" integer, convertible integer,
               to_notes integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  f public.type_fields := kept.field_convert_field(p_field);
  mode text := kept.field_convert_mode(f, p_to, false);
BEGIN
  RETURN QUERY
  SELECT v.location_id, l.name, count(*)::int,
         count(*) FILTER (WHERE mode <> 'kind' OR kept.field_value_converts(v.value, p_to))::int,
         count(*) FILTER (WHERE mode = 'kind'
                            AND NOT kept.field_value_converts(v.value, p_to))::int
    FROM kept.field_values(f) v JOIN public.locations l ON l.id = v.location_id
   GROUP BY v.location_id, l.name
   ORDER BY l.name, v.location_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.field_conversion_rows(p_field uuid, p_after uuid, p_limit integer)
RETURNS TABLE (subject_kind text, subject_id uuid, location_id uuid, value jsonb,
               ciphertext jsonb, key_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  f public.type_fields := kept.field_convert_field(p_field);
BEGIN
  RETURN QUERY
  SELECT v.* FROM kept.field_values(f) v
   WHERE p_after IS NULL OR v.subject_id > p_after
   ORDER BY v.subject_id
   LIMIT least(greatest(coalesce(p_limit, 0), 0), 1000);
END $$;
--> statement-breakpoint
-- p_rows: [{subjectKind: 'thing'|'place', subjectId, value?, ciphertext?, keyVersion?,
-- toNotes?}], at most 1,000:
-- - to secret: the sealed value and the new secret_values row's `id` it was sealed for (AAD
--   `secret_values|<id>|<key>`, secrets/rotate.ts), and `custom` loses the key;
-- - from secret: the opened value as plain text in `custom`, and the field's secret values are
--   erased (kept as history of when they were set, as kept.clear_secret does);
-- - a kind change: the converted value in `custom`, or with `toNotes` the old one appended to the
--   thing's notes as "<label>: <value>" and the key gone.
-- Returns the subjects written.
CREATE FUNCTION kept.apply_field_conversion(p_field uuid, p_to jsonb, p_rows jsonb,
                                            p_finish boolean)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  f public.type_fields := kept.field_convert_field(p_field);
  uid uuid := kept.current_user_id();
  target boolean := (p_to->>'toSecret')::boolean;
  mode text;
  r jsonb;
  subj uuid;
  thing boolean;
  loc uuid;
  label text;
  n integer := 0;
  loc_id uuid;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'a batch is an array of at most 1,000 rows'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  mode := kept.field_convert_mode(f, p_to,
                                  jsonb_typeof(p_to->'toSecret') = 'boolean' AND f.secret = target);
  -- To or from secret: the flag first (the secret store and `custom` each check it).
  IF mode <> 'kind' AND f.secret IS DISTINCT FROM target THEN
    PERFORM set_config('kept.field_convert', f.id::text, true);
    UPDATE public.type_fields x SET secret = target WHERE x.id = f.id;
    PERFORM set_config('kept.field_convert', '', true);
  END IF;
  label := coalesce(f.label, f.key);

  FOR r IN SELECT e FROM jsonb_array_elements(p_rows) e LOOP
    thing := r->>'subjectKind' = 'thing';
    subj := (r->>'subjectId')::uuid;
    IF NOT thing AND r->>'subjectKind' IS DISTINCT FROM 'place' THEN
      RAISE EXCEPTION 'a row names a thing or a place' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF thing THEN
      SELECT t.location_id INTO loc FROM public.things t
        JOIN public.locations l ON l.id = t.location_id AND l.owner_account_id = f.owner_account_id
       WHERE t.id = subj;
    ELSE
      SELECT p.location_id INTO loc FROM public.places p
        JOIN public.locations l ON l.id = p.location_id AND l.owner_account_id = f.owner_account_id
       WHERE p.id = subj;
    END IF;
    IF loc IS NULL THEN
      RAISE EXCEPTION 'no such thing or place of yours' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF mode = 'to_secret' THEN
      IF jsonb_typeof(r->'ciphertext') IS DISTINCT FROM 'object'
         OR jsonb_typeof(r->'keyVersion') IS DISTINCT FROM 'number'
         OR jsonb_typeof(r->'id') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'a secret arrives sealed' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      INSERT INTO public.secret_values (id, location_id, thing_id, place_id, type_field_id,
                                        field_key, ciphertext, key_version, updated_by)
      VALUES ((r->>'id')::uuid, loc, CASE WHEN thing THEN subj END,
              CASE WHEN NOT thing THEN subj END, f.id, f.key, r->'ciphertext',
              (r->>'keyVersion')::int, uid);
      IF thing THEN
        UPDATE public.things t SET custom = t.custom - f.key WHERE t.id = subj;
      ELSE
        UPDATE public.places p SET custom = p.custom - f.key WHERE p.id = subj;
      END IF;
    ELSIF mode = 'from_secret' THEN
      IF jsonb_typeof(r->'value') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'an opened secret is text' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      UPDATE public.secret_values s SET ciphertext = NULL,
                                       superseded_at = coalesce(s.superseded_at, now())
       WHERE s.type_field_id = f.id AND s.ciphertext IS NOT NULL
         AND (CASE WHEN thing THEN s.thing_id ELSE s.place_id END) = subj;
      IF thing THEN
        UPDATE public.things t SET custom = t.custom || jsonb_build_object(f.key, r->'value')
         WHERE t.id = subj;
      ELSE
        UPDATE public.places p SET custom = p.custom || jsonb_build_object(f.key, r->'value')
         WHERE p.id = subj;
      END IF;
    ELSE
      IF NOT thing THEN
        RAISE EXCEPTION 'a place''s field converts only to or from secret'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF coalesce((r->>'toNotes')::boolean, false) THEN
        UPDATE public.things t
           SET notes = concat_ws(E'\n', nullif(t.notes, ''),
                                 label || ': ' || coalesce(t.custom ->> f.key, '')),
               custom = t.custom - f.key
         WHERE t.id = subj;
      ELSIF r ? 'value' THEN
        UPDATE public.things t SET custom = t.custom || jsonb_build_object(f.key, r->'value')
         WHERE t.id = subj;
      ELSE
        RAISE EXCEPTION 'a row carries its converted value or goes to the notes'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END IF;
    n := n + 1;
  END LOOP;

  IF p_finish THEN
    IF mode = 'kind' THEN
      UPDATE public.type_fields x
         SET kind = p_to->>'kind',
             options = CASE WHEN p_to->>'kind' IN ('select', 'multi_select')
                            THEN coalesce(p_to->'options', x.options) ELSE NULL END,
             unit = CASE WHEN p_to->>'kind' = 'number' THEN p_to->>'unit' ELSE NULL END
       WHERE x.id = f.id;
    ELSIF mode = 'to_secret' THEN
      -- Past diffs of the key, in every location of the account: changed, never the values.
      UPDATE public.audit_events e
         SET diff = e.diff
                    || CASE WHEN e.diff ? ('custom.' || f.key) THEN jsonb_build_object(
                         'custom.' || f.key, '{"changed": true, "class": "secret"}'::jsonb)
                       ELSE '{}'::jsonb END
                    || CASE WHEN e.diff ? ('archived_custom.' || f.key) THEN jsonb_build_object(
                         'archived_custom.' || f.key, '{"changed": true, "class": "secret"}'::jsonb)
                       ELSE '{}'::jsonb END
       WHERE e.location_id IN (SELECT l.id FROM public.locations l
                                WHERE l.owner_account_id = f.owner_account_id)
         AND (e.diff ? ('custom.' || f.key) OR e.diff ? ('archived_custom.' || f.key));
    END IF;
    FOR loc_id IN SELECT l.id FROM public.locations l
                   WHERE l.owner_account_id = f.owner_account_id LOOP
      PERFORM kept.reindex_location(loc_id);
    END LOOP;
  END IF;
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.field_conversion_preview(uuid, jsonb),
  kept.field_conversion_rows(uuid, uuid, integer),
  kept.apply_field_conversion(uuid, jsonb, jsonb, boolean)
  FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.field_conversion_preview(uuid, jsonb),
  kept.field_conversion_rows(uuid, uuid, integer),
  kept.apply_field_conversion(uuid, jsonb, jsonb, boolean)
  TO kept_app;
