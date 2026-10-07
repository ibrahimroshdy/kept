ALTER TABLE "invites" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "claimed_email" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "created_in_location_id" uuid;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_created_in_location_id_locations_id_fk" FOREIGN KEY ("created_in_location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Security review of tasks 19–21 (D46, D47, D48, D114, D164, D180, D188, D197; §7.14).
-- Columns above (drizzle-kit): invites.claimed_at / claimed_email, a sign-up's hold on an invite
-- (review I1); user_profiles.created_in_location_id, a managed account's home location (I2).
-- Below, by hand: the definers and policies that use them, and the policies that fell short of
-- D48 and D180 (I3). test/leak.test.ts and src/db/migrate.test.ts list every function here.

-- 1. Managed accounts made before this migration: their home location is the first non-Personal
--    location their creator added them to.
UPDATE public.user_profiles p SET created_in_location_id = (
  SELECT m.location_id FROM public.memberships m
    JOIN public.locations l ON l.id = m.location_id
   WHERE m.user_id = p.user_id AND m.invited_by = p.created_by_user_id AND l.kind <> 'personal'
   ORDER BY m.created_at, m.id LIMIT 1)
 WHERE p.managed AND p.created_in_location_id IS NULL;
--> statement-breakpoint
-- A user's own profile never names a home location: only kept.add_managed_member() sets it, and a
-- foreign-key error on an id of the user's choosing would say which locations exist.
DROP POLICY app_insert_own ON public.user_profiles;
--> statement-breakpoint
CREATE POLICY app_insert_own ON public.user_profiles FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND NOT managed AND created_by_user_id IS NULL AND created_in_location_id IS NULL);
--> statement-breakpoint

-- 2. Helpers for the policies and definers below (SECURITY DEFINER, as 0006 §1: they read past
--    the policies of the tables they read).

-- Whether the signed-in user is a managed account (D47): it owns no location but its Personal one.
CREATE FUNCTION kept.current_user_managed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT p.managed FROM public.user_profiles p
                    WHERE p.user_id = kept.current_user_id()), false)
$$;
--> statement-breakpoint
-- The latest end date the signed-in user may give a membership of `loc` (D46, D180): their own,
-- or NULL for no limit (the owner, or an admin with no end date).
CREATE FUNCTION kept.max_member_expiry(loc uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.expires_at FROM public.memberships m
   WHERE m.location_id = loc AND m.user_id = kept.current_user_id()
     AND (m.expires_at IS NULL OR m.expires_at > now())
$$;
--> statement-breakpoint
-- D197: the location in whose name the signed-in user may reset managed account `p_user_id`, or
-- NULL. Only its home location counts: its owner, or its creator while still an unexpired owner
-- or admin there (admin_location_ids() also wants the location live, and a second factor if it
-- requires one). Owners of other locations it joined later have no reset power.
CREATE FUNCTION kept.managed_reset_location(p_user_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.created_in_location_id FROM public.user_profiles p
   WHERE p.user_id = p_user_id AND p.managed AND p.user_id <> kept.current_user_id()
     AND p.created_in_location_id IN (SELECT kept.admin_location_ids())
     AND (kept.owns_location(p.created_in_location_id)
          OR p.created_by_user_id = kept.current_user_id())
$$;
--> statement-breakpoint

-- 3. memberships (D48, D180): admins and their rows are the owner's alone, old row and new, and
--    nobody gives a membership an end date later than their own. 0008's app_delete_own still
--    lets anyone but the owner leave.
DROP POLICY app_update ON public.memberships;
--> statement-breakpoint
CREATE POLICY app_update ON public.memberships FOR UPDATE TO kept_app
  USING (role <> 'owner' AND user_id <> (SELECT kept.current_user_id())
         AND location_id IN (SELECT kept.admin_location_ids())
         AND (role <> 'admin' OR kept.owns_location(location_id)))
  WITH CHECK (role <> 'owner' AND user_id <> (SELECT kept.current_user_id())
              AND location_id IN (SELECT kept.admin_location_ids())
              AND (role <> 'admin' OR kept.owns_location(location_id))
              AND (kept.max_member_expiry(location_id) IS NULL
                   OR (expires_at IS NOT NULL
                       AND expires_at <= kept.max_member_expiry(location_id))));
--> statement-breakpoint
DROP POLICY app_delete ON public.memberships;
--> statement-breakpoint
CREATE POLICY app_delete ON public.memberships FOR DELETE TO kept_app
  USING (role <> 'owner' AND location_id IN (SELECT kept.admin_location_ids())
         AND (role <> 'admin' OR kept.owns_location(location_id)));
--> statement-breakpoint

-- 4. invites are never edited: an admin could otherwise turn the owner's invite into an admin
--    invite. Revoking is a DELETE; accepting and claiming are the definers below.
DROP POLICY app_update ON public.invites;
--> statement-breakpoint
REVOKE UPDATE ON public.invites FROM kept_app;
--> statement-breakpoint

-- 5. Module switches are location settings (D61): owners and admins, as the route requires.
DROP POLICY app_insert ON public.location_modules;
--> statement-breakpoint
DROP POLICY app_update ON public.location_modules;
--> statement-breakpoint
DROP POLICY app_delete ON public.location_modules;
--> statement-breakpoint
CREATE POLICY app_insert ON public.location_modules FOR INSERT TO kept_app
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_update ON public.location_modules FOR UPDATE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()))
  WITH CHECK (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.location_modules FOR DELETE TO kept_app
  USING (location_id IN (SELECT kept.admin_location_ids()));
--> statement-breakpoint

-- 6. A managed account creates no location (D47); its Personal one comes from
--    kept.ensure_account(), which is a definer.
DROP POLICY app_insert ON public.locations;
--> statement-breakpoint
CREATE POLICY app_insert ON public.locations FOR INSERT TO kept_app
  WITH CHECK (owner_account_id = (SELECT kept.current_owner_account_id())
              AND NOT (SELECT kept.current_user_managed()));
--> statement-breakpoint

-- 7. Holding an invite for a sign-up (review I1). While sign-up is closed, a link invite is the
--    only way to make an account, so it is claimed for one address, atomically, before the
--    account exists: concurrent sign-ups with other addresses find it held and fail, and only
--    one account can come of one invite. The hold lasts ten minutes (a sign-in and an accept);
--    the same address may claim again. Both the new-address and the taken-address paths claim,
--    and neither accepts (the person signs in and accepts), so the invite looks the same after
--    either: the preview ignores holds. Replaces 0008's invite_accepts_email(). Returns whether
--    the invite is now held for `p_email`.
DROP FUNCTION kept.invite_accepts_email(text, text);
--> statement-breakpoint
CREATE FUNCTION kept.claim_invite(p_token_hash text, p_email text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.invites i SET claimed_at = now(), claimed_email = lower(p_email)
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL AND i.expires_at > now()
     AND (i.email IS NULL OR lower(i.email) = lower(p_email))
     AND (i.claimed_at IS NULL OR i.claimed_at <= now() - interval '10 minutes'
          OR i.claimed_email = lower(p_email))
     AND EXISTS (
       SELECT 1 FROM public.locations l
         JOIN public.memberships m
           ON m.location_id = l.id AND m.user_id = i.created_by
          AND m.role IN ('owner', 'admin') AND (m.expires_at IS NULL OR m.expires_at > now())
        WHERE l.id = i.location_id AND l.deleted_at IS NULL AND l.kind <> 'personal'
          AND (i.role <> 'admin' OR m.role = 'owner')
          AND (least(i.membership_expires_at, m.expires_at) IS NULL
               OR least(i.membership_expires_at, m.expires_at) > now()));
  RETURN FOUND;
END $$;
--> statement-breakpoint

-- 8. Joining (0006 §5, rewritten). As before, plus:
--    - never a Personal location (D114);
--    - an invite held for another address (section 7) is refused while the hold lasts;
--    - the caller's own expired membership, not yet swept by expire-memberships, gives way to
--      the new one instead of a 409 (review M7);
--    - it writes the join's audit event itself, as the joiner (review M3): a location that
--      requires two-factor is hidden from a session without one, and kept_app could not write
--      that event there.
--    `p_request_id` is the request's id for the event.
DROP FUNCTION kept.accept_invite(text);
--> statement-breakpoint
CREATE FUNCTION kept.accept_invite(p_token_hash text, p_request_id text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  inv record;
  creator record;
  until timestamptz;
  mid uuid := uuidv7();
  replaced uuid;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'accepting an invite needs a signed-in user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT i.id, i.location_id, i.role, i.membership_expires_at, i.email, i.created_by,
         i.claimed_at, i.claimed_email, l.kind, l.owner_account_id INTO inv
    FROM public.invites i JOIN public.locations l ON l.id = i.location_id
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL AND i.expires_at > now() AND l.deleted_at IS NULL
     FOR UPDATE OF i;
  -- No invite leaves `inv` all NULL, and then this finds no creator either.
  SELECT m.role, m.expires_at INTO creator FROM public.memberships m
   WHERE m.location_id = inv.location_id AND m.user_id = inv.created_by
     AND m.role IN ('owner', 'admin') AND (m.expires_at IS NULL OR m.expires_at > now());
  until := least(inv.membership_expires_at, creator.expires_at);
  IF inv.id IS NULL OR creator.role IS NULL OR inv.kind = 'personal'
     OR (inv.role = 'admin' AND creator.role <> 'owner')
     OR (until IS NOT NULL AND until <= now())
     OR (inv.email IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM auth."user" u
            WHERE u.id = uid AND u.email_verified AND lower(u.email) = lower(inv.email)))
     OR (inv.claimed_at > now() - interval '10 minutes' AND NOT EXISTS (
           SELECT 1 FROM auth."user" u
            WHERE u.id = uid AND lower(u.email) = inv.claimed_email)) THEN
    RAISE EXCEPTION 'the invite is not valid'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'invite_invalid';
  END IF;
  DELETE FROM public.memberships m
   WHERE m.location_id = inv.location_id AND m.user_id = uid AND m.role <> 'owner'
     AND m.expires_at IS NOT NULL AND m.expires_at <= now()
  RETURNING m.id INTO replaced;
  INSERT INTO public.memberships (id, location_id, user_id, role, expires_at, invited_by)
  VALUES (mid, inv.location_id, uid, inv.role, until, inv.created_by);
  UPDATE public.invites SET accepted_by = uid, accepted_at = now() WHERE id = inv.id;
  INSERT INTO public.audit_events
    (location_id, owner_account_id, actor_type, actor_id, action, entity_type, entity_id, diff,
     request_id)
  VALUES (inv.location_id, inv.owner_account_id, 'user', uid, 'member.join', 'membership', mid,
          jsonb_build_object(
            'user_id', jsonb_build_object('before', NULL, 'after', uid, 'class', 'plain'),
            'role', jsonb_build_object('before', NULL, 'after', inv.role, 'class', 'plain'),
            'via', jsonb_build_object('before', NULL, 'after', 'invite', 'class', 'plain'))
          || CASE WHEN until IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
               'expires_at', jsonb_build_object('before', NULL, 'after', until, 'class', 'plain'))
             END
          || CASE WHEN replaced IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
               'replaced_membership_id',
               jsonb_build_object('before', NULL, 'after', replaced, 'class', 'plain'))
             END,
          p_request_id);
  RETURN inv.location_id;
END $$;
--> statement-breakpoint

-- 9. The invite page shows nothing for a Personal location's invite, which accept_invite()
--    refuses (same signature and columns as 0008's).
CREATE OR REPLACE FUNCTION kept.invite_preview(p_token_hash text)
RETURNS TABLE (location_name text, location_kind text, role text, inviter_name text,
               expires_at timestamptz, membership_expires_at timestamptz, require_2fa boolean,
               email_bound boolean, email_matches boolean, member_location_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT l.name, l.kind, i.role, p.display_name, i.expires_at,
         least(i.membership_expires_at, m.expires_at), l.require_2fa,
         i.email IS NOT NULL,
         (i.email IS NOT NULL AND EXISTS (
            SELECT 1 FROM auth."user" u
             WHERE u.id = kept.current_user_id() AND lower(u.email) = lower(i.email))),
         CASE WHEN l.id IN (SELECT kept.visible_location_ids()) THEN l.id END
    FROM public.invites i
    JOIN public.locations l ON l.id = i.location_id
    JOIN public.memberships m
      ON m.location_id = i.location_id AND m.user_id = i.created_by
     AND m.role IN ('owner', 'admin') AND (m.expires_at IS NULL OR m.expires_at > now())
    LEFT JOIN public.user_profiles p ON p.user_id = i.created_by
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL AND i.expires_at > now() AND l.deleted_at IS NULL
     AND l.kind <> 'personal'
     AND (i.role <> 'admin' OR m.role = 'owner')
     AND (least(i.membership_expires_at, m.expires_at) IS NULL
          OR least(i.membership_expires_at, m.expires_at) > now())
$$;
--> statement-breakpoint

-- 10. Adding a managed account to a location (0006 §5, rewritten; D47, D180, D197). The caller
--     must be an unexpired owner or admin of the location, which must not be a Personal one;
--     `admin` only from the owner (D48), never `owner`; the end date no later than the caller's
--     own. And the caller must hold reset authority over the account (D197,
--     managed_reset_location()), except on its first add, by its creator, which also records
--     that location as its home. Returns the membership's id.
CREATE OR REPLACE FUNCTION kept.add_managed_member(
  p_location_id uuid, p_user_id uuid, p_role text, p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  caller record;
  prof record;
  found_prof boolean;
  first_add boolean;
  mid uuid := uuidv7();
BEGIN
  SELECT m.role, m.expires_at, l.kind INTO caller
    FROM public.memberships m JOIN public.locations l ON l.id = m.location_id
   WHERE m.location_id = p_location_id AND m.user_id = uid
     AND p_location_id IN (SELECT kept.admin_location_ids());
  SELECT p.created_by_user_id, p.created_in_location_id INTO prof
    FROM public.user_profiles p WHERE p.user_id = p_user_id AND p.managed
     FOR UPDATE;
  found_prof := FOUND;
  first_add := found_prof AND prof.created_in_location_id IS NULL
               AND prof.created_by_user_id IS NOT DISTINCT FROM uid;
  IF caller.role IS NULL OR caller.kind = 'personal' OR NOT found_prof
     OR p_role IS NULL OR p_role NOT IN ('admin', 'member', 'viewer')
     OR (p_role = 'admin' AND caller.role <> 'owner')
     OR NOT (first_add OR kept.managed_reset_location(p_user_id) IS NOT NULL) THEN
    RAISE EXCEPTION 'not a managed account this user may add here'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF first_add THEN
    UPDATE public.user_profiles SET created_in_location_id = p_location_id
     WHERE user_id = p_user_id;
  END IF;
  INSERT INTO public.memberships (id, location_id, user_id, role, expires_at, invited_by)
  VALUES (mid, p_location_id, p_user_id, p_role, least(p_expires_at, caller.expires_at), uid);
  RETURN mid;
END $$;
--> statement-breakpoint

-- 11. The email-invite mail job (review M9): an email invite's link is only ever mailed, and the
--     token is never stored, so the route stores an unusable hash and enqueues the mail in its
--     own transaction; the job (kept_system) makes the real token, stores its hash here, and
--     mails the link. Only for a live, unaccepted email invite; returns what the mail needs, or
--     nothing. A retry makes a new token, so only the last mailed link works.
CREATE FUNCTION kept.rekey_email_invite(p_invite_id uuid, p_token_hash text)
RETURNS TABLE (email text, role text, location_name text, inviter_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  UPDATE public.invites i SET token_hash = p_token_hash
    FROM public.locations l
   WHERE i.id = p_invite_id AND l.id = i.location_id AND l.deleted_at IS NULL
     AND i.email IS NOT NULL AND i.accepted_at IS NULL AND i.expires_at > now()
  RETURNING i.email, i.role, l.name,
            (SELECT p.display_name FROM public.user_profiles p WHERE p.user_id = i.created_by);
END $$;
--> statement-breakpoint

-- 12. Who may call what (0000's default privileges granted both runtime roles EXECUTE).
REVOKE EXECUTE ON FUNCTION
  kept.current_user_managed(), kept.max_member_expiry(uuid), kept.managed_reset_location(uuid),
  kept.claim_invite(text, text), kept.accept_invite(text, text),
  kept.rekey_email_invite(uuid, text)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  kept.current_user_managed(), kept.max_member_expiry(uuid), kept.managed_reset_location(uuid),
  kept.claim_invite(text, text), kept.accept_invite(text, text)
  TO kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.rekey_email_invite(uuid, text) TO kept_system;
