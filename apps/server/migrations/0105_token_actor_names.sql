-- Custom SQL migration file, put your code below! --
-- Steps 6–8 UI review L3: a change made with a token read "Kept" as its author in a thing's
-- History and the Activity feed, because api_tokens are their creator's alone under the
-- policies (0070) and the history's actor join found no name. kept.token_actor_names(ids) names
-- the tokens among `ids` that the caller can see acting: a token whose events reach a location
-- the caller can see (the audit actor index), or the caller's own. It returns the token's name
-- and its creator's id and display name, nothing else (never the lookup, hash, scope or dates).
-- A token principal gets nothing (tokens never read api_tokens). The decision (members of a
-- location see the names of the tokens that changed it, with whose they are) is in the spec's
-- decision log; src/history/service.ts renders it, test/leak.test.ts and src/db/migrate.test.ts
-- list it.
CREATE FUNCTION kept.token_actor_names(p_ids uuid[])
RETURNS TABLE (id uuid, name text, owner_id uuid, owner_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.id, t.name, t.user_id, up.display_name
    FROM public.api_tokens t
    LEFT JOIN public.user_profiles up ON up.user_id = t.user_id
   WHERE t.id = ANY (p_ids)
     AND (SELECT kept.current_token_id()) IS NULL
     AND (SELECT kept.current_user_id()) IS NOT NULL
     AND (t.user_id = (SELECT kept.current_user_id())
          OR EXISTS (SELECT 1 FROM public.audit_events e
                      WHERE e.actor_type = 'token' AND e.actor_id = t.id
                        AND e.location_id IN (SELECT kept.visible_location_ids())))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.token_actor_names(uuid[]) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.token_actor_names(uuid[]) TO kept_app;
