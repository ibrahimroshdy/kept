-- Custom SQL migration file, put your code below! --
-- Step 2, task 11: where a registry row is used, across the whole account (engineering spec
-- §7.9, §7.13; D11, D92, D123). The routes need it twice, and both reach past the caller's own
-- locations:
--   - DELETE of a brand, vendor, person or tag answers 409 `in_use` while a live thing (or, for a
--     vendor, a purchase) uses it anywhere in the account. The foreign keys are ON DELETE SET
--     NULL (or CASCADE for tags), and referential actions ignore RLS, so without this an admin of
--     one location could silently strip the brand off things in a location they can't see, with
--     no audit row there.
--   - Renaming a type, brand, person or tag leaves the search documents of the things using it
--     stale (§7.9) until kept.reindex_location() runs (T20). The route enqueues the `reindex` job
--     for each location returned here, in its own transaction.
-- Only the account's admins may ask (D123: they manage its registries), and the answer is
-- location ids only, which go into job data and never into a response. A definer: things and
-- purchases in the account's other locations are invisible to the caller. 42501 (a 404) for a
-- row the caller doesn't administer, a built-in (no account), or an id that exists nowhere.
-- test/leak.test.ts and src/db/migrate.test.ts list it.

CREATE FUNCTION kept.registry_use_locations(p_kind text, p_id uuid) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tbl text;
  acct uuid;
  ref jsonb := jsonb_build_object('id', p_id::text);
BEGIN
  tbl := CASE p_kind WHEN 'type' THEN 'types' WHEN 'brand' THEN 'brands'
                     WHEN 'vendor' THEN 'vendors' WHEN 'person' THEN 'people'
                     WHEN 'tag' THEN 'tags' END;
  IF tbl IS NULL THEN
    RAISE EXCEPTION 'unknown registry %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  EXECUTE format('SELECT owner_account_id FROM public.%I WHERE id = $1', tbl) INTO acct USING p_id;
  IF kept.current_user_id() IS NULL OR acct IS NULL
     OR NOT coalesce(acct IN (SELECT kept.admin_account_ids()), false) THEN
    RAISE EXCEPTION 'no such % of yours', p_kind USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT DISTINCT u.location_id FROM (
    SELECT t.location_id
      FROM public.things t JOIN public.locations l ON l.id = t.location_id
     WHERE l.owner_account_id = acct AND t.deleted_at IS NULL
       AND CASE p_kind
             WHEN 'type' THEN t.type_id = p_id
             WHEN 'brand' THEN t.brand_id = p_id
             WHEN 'person' THEN t.belongs_to_person_id = p_id
                                OR jsonb_path_exists(t.custom, '$.*[*] ? (@ == $id)', ref)
             WHEN 'vendor' THEN jsonb_path_exists(t.custom, '$.*[*] ? (@ == $id)', ref)
             ELSE EXISTS (SELECT 1 FROM public.thing_tags x
                           WHERE x.thing_id = t.id AND x.tag_id = p_id)
           END
    UNION ALL
    SELECT p.location_id
      FROM public.purchases p JOIN public.locations l ON l.id = p.location_id
     WHERE p_kind = 'vendor' AND l.owner_account_id = acct AND p.vendor_id = p_id
  ) u;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.registry_use_locations(text, uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.registry_use_locations(text, uuid) TO kept_app;
