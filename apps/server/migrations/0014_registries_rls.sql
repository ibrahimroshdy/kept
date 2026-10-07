-- Custom SQL migration file, put your code below! --
-- Step 2, task 5: the account registries' RLS, guards and indexes (engineering spec §1.1, §7.2,
-- §7.9, §7.13; D11, D92, D123, D154, D177, D192; plan Q3, Q4, Q5). The tables are 0013's.
--   1. RLS enabled and forced, kept_owner's owner_all, and kept_app's policies by account:
--      built-ins (owner NULL) readable by any signed-in request; the rest by visible account;
--      created by admin accounts (types, fields, kinds, brands) or writable ones (vendors,
--      people, tags: members create them inline, D11); changed and removed by admin accounts.
--   2. Column grants: never an id, a key or owner_account_id.
--   3. touch_row on every table.
--   4. Normalised-name uniques (brands, tags) and trigram indexes for search.
--   5. Contact details: kept.person_contact_visible() (D177, Q5).
--   6. The type tree's guards (D92, §7.13): parents and field groups in the same account or
--      built in, no loops, no key defined twice along a chain; kept.type_chain() and
--      kept.type_capabilities() for the thing triggers and the routes.
-- test/leak.test.ts and src/db/migrate.test.ts list every function here.

-- 1. RLS -------------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'place_kinds', 'types', 'type_fields', 'brands', 'vendors', 'people', 'person_contacts', 'tags'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO kept_owner USING (true) WITH CHECK (true)',
      t);
    EXECUTE format('CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.%I
                      FOR EACH ROW EXECUTE FUNCTION kept.touch_row()', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- The type library and place kinds: built-ins to every signed-in request (never without a
-- scope: fail closed, like everything else), the account's own to whoever can see the account.
-- Only admins of the account change them (D123); a built-in can't be written through kept_app
-- (owner_account_id NULL is in no account set).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['place_kinds', 'types', 'type_fields'] LOOP
    EXECUTE format($p$
      CREATE POLICY app_select ON public.%I FOR SELECT TO kept_app
        USING ((owner_account_id IS NULL AND (SELECT kept.current_user_id()) IS NOT NULL)
               OR owner_account_id IN (SELECT kept.visible_account_ids()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_insert ON public.%I FOR INSERT TO kept_app
        WITH CHECK (owner_account_id IN (SELECT kept.admin_account_ids()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_update ON public.%I FOR UPDATE TO kept_app
        USING (owner_account_id IN (SELECT kept.admin_account_ids()))
        WITH CHECK (owner_account_id IN (SELECT kept.admin_account_ids()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_delete ON public.%I FOR DELETE TO kept_app
        USING (owner_account_id IN (SELECT kept.admin_account_ids()))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint

-- brands: admins create them; vendors, people and tags: anyone who writes in a location of the
-- account creates them inline (D11; `tags.create`). Changing or removing any of them is an
-- admin's (`registries-types.manage`, `tags.edit-delete`); can() holds the finer rules.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['brands', 'vendors', 'people', 'tags'] LOOP
    EXECUTE format($p$
      CREATE POLICY app_select ON public.%I FOR SELECT TO kept_app
        USING (owner_account_id IN (SELECT kept.visible_account_ids()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_insert ON public.%I FOR INSERT TO kept_app
        WITH CHECK (owner_account_id IN (SELECT %s))$p$,
      t, CASE WHEN t = 'brands' THEN 'kept.admin_account_ids()' ELSE 'kept.writable_account_ids()' END);
    EXECUTE format($p$
      CREATE POLICY app_update ON public.%I FOR UPDATE TO kept_app
        USING (owner_account_id IN (SELECT kept.admin_account_ids()))
        WITH CHECK (owner_account_id IN (SELECT kept.admin_account_ids()))$p$, t);
    EXECUTE format($p$
      CREATE POLICY app_delete ON public.%I FOR DELETE TO kept_app
        USING (owner_account_id IN (SELECT kept.admin_account_ids()))$p$, t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 5. Contact details (D177, Q5): only for someone who administers every location that uses the
--    person; a person used nowhere, for an admin of any location of the account. "Uses" means a
--    non-deleted thing there belongs to them (task 6 adds that clause, once `things` exists;
--    loans join in step 4). A definer: it must see things in locations the caller can't.
CREATE FUNCTION kept.person_contact_visible(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.people p
                  WHERE p.id = p_person AND p.owner_account_id IN (SELECT kept.admin_account_ids()))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.person_contact_visible(uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.person_contact_visible(uuid) TO kept_app;
--> statement-breakpoint
CREATE POLICY app_select ON public.person_contacts FOR SELECT TO kept_app
  USING (kept.person_contact_visible(person_id));
--> statement-breakpoint
CREATE POLICY app_insert ON public.person_contacts FOR INSERT TO kept_app
  WITH CHECK (owner_account_id IN (SELECT kept.writable_account_ids()));
--> statement-breakpoint
CREATE POLICY app_update ON public.person_contacts FOR UPDATE TO kept_app
  USING (kept.person_contact_visible(person_id))
  WITH CHECK (kept.person_contact_visible(person_id));
--> statement-breakpoint
CREATE POLICY app_delete ON public.person_contacts FOR DELETE TO kept_app
  USING (kept.person_contact_visible(person_id));
--> statement-breakpoint

-- 2. Column grants (0006 §3's rule). Not granted: ids, keys, owner_account_id, builtin_key,
--    copied_from_id, is_field_group, search_names; a field's key, kind and secret flag
--    (converting a kind or a secret is later work, Q3, Q11).
REVOKE UPDATE ON public.place_kinds, public.types, public.type_fields, public.brands,
  public.vendors, public.people, public.person_contacts, public.tags
  FROM kept_app, kept_system;
--> statement-breakpoint
GRANT UPDATE (name, icon, archived_at, updated_at, row_version) ON public.place_kinds TO kept_app;
--> statement-breakpoint
GRANT UPDATE (parent_id, name, icon, colour, capabilities, default_meter, field_groups,
              default_warranty_months, archived_at, updated_at, row_version)
  ON public.types TO kept_app;
--> statement-breakpoint
GRANT UPDATE (label, unit, options, repeatable, required, sort, archived_at, updated_at,
              row_version)
  ON public.type_fields TO kept_app;
--> statement-breakpoint
GRANT UPDATE (name, website, support_phone, claim_url, default_warranty_months, updated_at,
              row_version)
  ON public.brands TO kept_app;
--> statement-breakpoint
GRANT UPDATE (name, kind, address, phone, website, updated_at, row_version)
  ON public.vendors TO kept_app;
--> statement-breakpoint
GRANT UPDATE (display_name, member_user_id, updated_at, row_version) ON public.people TO kept_app;
--> statement-breakpoint
GRANT UPDATE (phone, email, notes, updated_at, row_version) ON public.person_contacts TO kept_app;
--> statement-breakpoint
GRANT UPDATE (name, colour, updated_at, row_version) ON public.tags TO kept_app;
--> statement-breakpoint

-- 4. Names: a brand or tag is one per account after normalisation (D42), so "Samsung" and
--    "SAMSUNG" can't both exist (409 `conflict`, the route adds `existingId`). Vendors and people
--    may share names (two shops called "Carrefour"); the routes offer possibleDuplicates.
CREATE UNIQUE INDEX brands_name_uq ON public.brands (owner_account_id, kept.normalize(name));
--> statement-breakpoint
CREATE UNIQUE INDEX tags_name_uq ON public.tags (owner_account_id, kept.normalize(name));
--> statement-breakpoint
CREATE INDEX brands_name_trgm ON public.brands USING gin (kept.normalize(name) public.gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendors_name_trgm ON public.vendors USING gin (kept.normalize(name) public.gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX people_name_trgm ON public.people
  USING gin (kept.normalize(display_name) public.gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX tags_name_trgm ON public.tags USING gin (kept.normalize(name) public.gin_trgm_ops);
--> statement-breakpoint

-- 6. The type tree ---------------------------------------------------------------------------

-- A type's chain, itself first (depth 0) up to its root; field groups are not part of it.
-- Invoker: the caller sees built-ins and its visible accounts' types, which is every type a
-- chain can hold (parents are built in or in the same account). Capped at 64 levels.
CREATE FUNCTION kept.type_chain(p_type uuid) RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up(id, parent_id, depth) AS (
    SELECT t.id, t.parent_id, 0 FROM public.types t WHERE t.id = p_type
    UNION ALL
    SELECT t.id, t.parent_id, up.depth + 1
      FROM public.types t JOIN up ON t.id = up.parent_id
     WHERE up.depth < 64
  )
  SELECT up.id, up.depth FROM up ORDER BY up.depth
$$;
--> statement-breakpoint
-- The capabilities a type has, its own and inherited (D154), sorted; '{}' for NULL.
CREATE FUNCTION kept.type_capabilities(p_type uuid) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(DISTINCT c ORDER BY c), '{}'::text[])
    FROM kept.type_chain(p_type) ch
    JOIN public.types t ON t.id = ch.id
    CROSS JOIN LATERAL unnest(t.capabilities) AS c
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.type_chain(uuid), kept.type_capabilities(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.type_chain(uuid) FROM kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.type_chain(uuid) TO kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.type_capabilities(uuid) TO kept_app, kept_system;
--> statement-breakpoint

-- Parents and field groups (D92, Q4). Invoker: a parent or group the caller can't see is the
-- same refusal as one in another account, and as an id that exists nowhere (42501, a 404).
-- - The parent is a type, not a field group, and built in or of the same account.
-- - Every field group is a field group, built in or of the same account.
-- - Re-parenting takes the account's type lock and refuses a loop (23514 types_no_loop).
CREATE FUNCTION kept.guard_type() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  p record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kept.types'),
                                hashtext(coalesce(NEW.owner_account_id::text, '')));
  IF NEW.parent_id IS NOT NULL THEN
    SELECT t.owner_account_id, t.is_field_group INTO p FROM public.types t WHERE t.id = NEW.parent_id;
    IF NOT FOUND OR p.is_field_group
       OR (p.owner_account_id IS NOT NULL
           AND p.owner_account_id IS DISTINCT FROM NEW.owner_account_id) THEN
      RAISE EXCEPTION 'a type''s parent is a type of the same account, or a built-in'
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'types_parent_account';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
      WITH RECURSIVE up(id) AS (
        SELECT NEW.parent_id
        UNION
        SELECT t.parent_id FROM public.types t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL
      )
      SELECT 1 FROM up WHERE up.id = NEW.id
    ) THEN
      RAISE EXCEPTION 'a type can''t sit under itself or one of its descendants'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'types_no_loop';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.field_groups) AS g(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.types t
        WHERE t.id = g.id AND t.is_field_group
          AND (t.owner_account_id IS NULL OR t.owner_account_id = NEW.owner_account_id))
  ) THEN
    RAISE EXCEPTION 'a field group is a field group of the same account, or a built-in'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'types_field_group_account';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.is_field_group AND NOT OLD.is_field_group AND EXISTS (
    SELECT 1 FROM public.types t WHERE t.parent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'a field group is nobody''s parent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'types_field_group_chk';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER types_guard BEFORE INSERT OR UPDATE OF parent_id, field_groups, owner_account_id,
  is_field_group ON public.types
  FOR EACH ROW EXECUTE FUNCTION kept.guard_type();
--> statement-breakpoint

-- A field belongs to its type's or kind's account (NULL for a built-in's): the composite
-- foreign keys skip a NULL owner (MATCH SIMPLE), so this covers it. Takes the account's type
-- lock, so two fields can't race past the key check below.
CREATE FUNCTION kept.guard_type_field() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  owner uuid;
BEGIN
  IF NEW.type_id IS NOT NULL THEN
    SELECT t.owner_account_id INTO owner FROM public.types t WHERE t.id = NEW.type_id;
  ELSE
    SELECT k.owner_account_id INTO owner FROM public.place_kinds k WHERE k.id = NEW.place_kind_id;
  END IF;
  IF NOT FOUND OR owner IS DISTINCT FROM NEW.owner_account_id THEN
    RAISE EXCEPTION 'a field belongs to its type''s or place kind''s account'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'type_fields_account';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kept.types'), hashtext(coalesce(owner::text, '')));
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER type_fields_guard BEFORE INSERT OR UPDATE ON public.type_fields
  FOR EACH ROW EXECUTE FUNCTION kept.guard_type_field();
--> statement-breakpoint

-- No field key twice along a type's resolved chain (§7.13, D192): its own fields, its
-- ancestors', and the field groups of each (Q4). Checked after the row is written, for the type
-- and every type that resolves through it (its descendants and, for a group, the types that
-- carry it), so both "a child redefines an inherited key" and "a parent adds a key a child
-- already has" are refused, as is a re-parent or regroup that would bring two together
-- (23514 type_fields_inherited_key). A type's own duplicate is the unique index's (23505).
CREATE FUNCTION kept.guard_type_keys() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  start uuid;
  clash record;
BEGIN
  -- Two statements, not one CASE: a record's missing field fails even in an untaken branch.
  IF TG_TABLE_NAME = 'types' THEN
    start := NEW.id;
  ELSE
    start := NEW.type_id;
  END IF;
  IF start IS NULL THEN
    RETURN NULL; -- a place kind's field: no inheritance
  END IF;
  WITH RECURSIVE affected(id) AS (
    SELECT start
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
CREATE TRIGGER type_fields_keys AFTER INSERT OR UPDATE OF key, type_id ON public.type_fields
  FOR EACH ROW EXECUTE FUNCTION kept.guard_type_keys();
--> statement-breakpoint
CREATE TRIGGER types_keys AFTER UPDATE OF parent_id, field_groups ON public.types
  FOR EACH ROW EXECUTE FUNCTION kept.guard_type_keys();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.guard_type(), kept.guard_type_field(), kept.guard_type_keys()
  FROM PUBLIC, kept_app, kept_system;
