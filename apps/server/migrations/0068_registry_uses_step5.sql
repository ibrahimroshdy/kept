-- Custom SQL migration file, put your code below! --
-- Step 5's migration owner, after Phase A (step-5 notes, items 1 and 4). Above, in 0067,
-- drizzle's part: notification_preferences_kind_chk holds `reading_stale` (@kept/shared
-- NOTIFY_KIND_SLOTS), so the stale-reading nudge (D52) can take a preference once T14 makes it
-- an active source. Below:
--   1. kept.registry_use_locations() (0026's, every clause kept) counts the records steps 4 and 5
--      added that name a registry row without a key to it: a vendor used by a service record, a
--      claim or a fill (service_records, claims, fuel_entries.vendor_id), where it counted only
--      purchases; and a person used by a loan (loans.person_id), as kept.person_use_locations()
--      already does (0051). Deleting such a row answers 409 in_use (registries/service.ts
--      deleteItem) instead of leaving an id that points nowhere.
-- test/leak.test.ts and src/db/migrate.test.ts already list it; src/db/registry-uses.test.ts
-- tests it.

CREATE OR REPLACE FUNCTION kept.registry_use_locations(p_kind text, p_id uuid) RETURNS SETOF uuid
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
    UNION ALL
    SELECT s.location_id
      FROM public.service_records s JOIN public.locations l ON l.id = s.location_id
     WHERE p_kind = 'vendor' AND l.owner_account_id = acct AND s.vendor_id = p_id
    UNION ALL
    SELECT c.location_id
      FROM public.claims c JOIN public.locations l ON l.id = c.location_id
     WHERE p_kind = 'vendor' AND l.owner_account_id = acct AND c.vendor_id = p_id
    UNION ALL
    SELECT f.location_id
      FROM public.fuel_entries f JOIN public.locations l ON l.id = f.location_id
     WHERE p_kind = 'vendor' AND l.owner_account_id = acct AND f.vendor_id = p_id
    UNION ALL
    SELECT o.location_id
      FROM public.loans o JOIN public.locations l ON l.id = o.location_id
     WHERE p_kind = 'person' AND l.owner_account_id = acct AND o.person_id = p_id
  ) u;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.registry_use_locations(text, uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.registry_use_locations(text, uuid) TO kept_app;
