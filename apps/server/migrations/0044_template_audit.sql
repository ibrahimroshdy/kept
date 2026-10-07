-- Custom SQL migration file, put your code below! --
-- Step 3, task 19: template history is account-level, like the registries' (plan T19; Q15, D123).
-- 0012 let an account's admins write and read account-level audit rows only for the registry
-- entity types; a template is managed by the same owners and admins (D123), so 'template' joins
-- that list. Without it only the account owner could write a template's audit row, and an admin's
-- create, edit or delete was refused. Both policies are made again with every earlier branch
-- unchanged (0012).
DROP POLICY app_select ON public.audit_events;
--> statement-breakpoint
CREATE POLICY app_select ON public.audit_events FOR SELECT TO kept_app
  USING (
    location_id IN (SELECT kept.visible_location_ids())
    OR (location_id IS NULL
        AND owner_account_id = (SELECT kept.current_owner_account_id()))
    OR (location_id IS NULL
        AND entity_type = ANY (ARRAY['type', 'type_field', 'place_kind', 'brand', 'vendor',
                                     'person', 'tag', 'template'])
        AND owner_account_id IN (SELECT kept.admin_account_ids()))
  );
--> statement-breakpoint
DROP POLICY app_insert ON public.audit_events;
--> statement-breakpoint
CREATE POLICY app_insert ON public.audit_events FOR INSERT TO kept_app
  WITH CHECK (
    actor_type = 'user'
    AND actor_id = (SELECT kept.current_user_id())
    AND (
      (location_id IN (SELECT kept.visible_location_ids())
       AND (owner_account_id IS NULL
            OR owner_account_id = (SELECT l.owner_account_id FROM public.locations l
                                    WHERE l.id = audit_events.location_id)))
      OR (location_id IS NULL
          AND owner_account_id = (SELECT kept.current_owner_account_id()))
      OR (location_id IS NULL AND owner_account_id IS NULL
          AND (SELECT kept.is_instance_admin()))
      OR (location_id IS NULL
          AND entity_type = ANY (ARRAY['type', 'type_field', 'place_kind', 'brand', 'vendor',
                                       'person', 'tag'])
          AND owner_account_id IN (SELECT kept.writable_account_ids()))
      OR (location_id IS NULL
          AND entity_type = 'template'
          AND owner_account_id IN (SELECT kept.admin_account_ids()))
    )
  );
