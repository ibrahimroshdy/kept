-- Custom SQL migration file, put your code below! --
-- First run and instance administration (tasks 22–23; D32, D164, D165, D180, D190, D193,
-- §7.10, §7.14).
--
-- The setup code's hash, the recovery-kit acknowledgement and `signup_open` are rows of
-- instance_settings (key → jsonb), which kept_system already reads and writes (0006 system_all)
-- and kept_app reaches only as an instance admin. What neither role's policies allow is below,
-- as three SECURITY DEFINER doors, each doing one thing:
-- - kept_system gets no policy on instance_admins (it would then read the whole table and could
--   write any row); it can only ask whether an admin exists, and make the *first* one;
-- - an instance admin's user list needs every user's role counts, across locations its own
--   policies don't show it; it gets counts, never locations or their contents.

-- 1. Whether the instance has an instance admin, i.e. whether setup is done. kept_system asks it
--    at web boot (the setup code, §7.10) and for the anonymous setup routes.
CREATE FUNCTION kept.instance_has_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.instance_admins)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.instance_has_admin() FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.instance_has_admin() TO kept_system;
--> statement-breakpoint

-- 2. The first instance admin (POST /api/v1/setup, once the setup code has checked out). Only
--    while there is none: the table lock makes two racing callers queue, and the second finds
--    the first's row and fails by name (a 409). The user must exist in auth.
CREATE FUNCTION kept.claim_first_instance_admin(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  LOCK TABLE public.instance_admins IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.instance_admins) THEN
    RAISE EXCEPTION 'this instance is already set up'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'instance_already_set_up';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth."user" u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'no such user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.instance_admins (user_id) VALUES (p_user_id);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.claim_first_instance_admin(uuid) FROM PUBLIC, kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.claim_first_instance_admin(uuid) TO kept_system;
--> statement-breakpoint

-- 3. The instance admin's user list (task 23, GET /api/v1/admin/users): for the given users, the
--    profile's name, whether the account is managed or an instance admin, and how many live
--    memberships of each role it holds. Only for an instance admin (42501 otherwise, a 404).
--    Location names, ids and contents stay behind the ordinary policies.
CREATE FUNCTION kept.admin_user_summaries(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, display_name text, managed boolean, instance_admin boolean,
               owner_of integer, admin_of integer, member_of integer, viewer_of integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT kept.is_instance_admin() THEN
    RAISE EXCEPTION 'instance admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT u.id,
         p.display_name,
         coalesce(p.managed, false),
         EXISTS (SELECT 1 FROM public.instance_admins ia WHERE ia.user_id = u.id),
         (count(m.id) FILTER (WHERE m.role = 'owner'))::integer,
         (count(m.id) FILTER (WHERE m.role = 'admin'))::integer,
         (count(m.id) FILTER (WHERE m.role = 'member'))::integer,
         (count(m.id) FILTER (WHERE m.role = 'viewer'))::integer
    FROM unnest(p_user_ids) AS u(id)
    LEFT JOIN public.user_profiles p ON p.user_id = u.id
    LEFT JOIN public.memberships m
      ON m.user_id = u.id AND (m.expires_at IS NULL OR m.expires_at > now())
   GROUP BY u.id, p.display_name, p.managed;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.admin_user_summaries(uuid[]) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.admin_user_summaries(uuid[]) TO kept_app;
