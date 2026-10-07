-- Custom SQL migration file, put your code below! --
-- Tasks 19–20: leaving a location, and the invite page's preview (D33, D46, D180, §7.10).

-- 1. Leaving (task 19). kept_app's app_delete policy on memberships (0006) lets owners and admins
--    remove others; a member or viewer could not remove their own row, so "Leave this location"
--    had no path. This policy adds exactly that: the signed-in user's own membership, never an
--    `owner` row (the owner can't leave; the route answers `last_owner`). A DELETE also needs the
--    row to pass the SELECT policy, so only a visible membership can be left: an expired one is
--    removed by the expire-memberships job, and a require_2fa location is left after enrolling a
--    second factor. Policies for one command are OR'ed, so admins keep their wider app_delete.
CREATE POLICY app_delete_own ON public.memberships FOR DELETE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND role <> 'owner');
--> statement-breakpoint

-- 2. The invite page (task 20). 0006's preview returned the location's name, the role and the
--    inviter; the page also shows the location's kind, when the invite and the membership end,
--    and whether the location requires two-factor (screens §5 Accept invite). Two answers need
--    the caller's scope, and are false/NULL without one:
--    - `email_matches`: the invite is bound to an address and it is the signed-in user's own
--      (case-insensitive). The accept route uses it to mark that address verified: an email
--      invite's link is only ever mailed (never shown to its creator), so holding the token
--      proves the mailbox (task 20; recorded in the commit body).
--    - `member_location_id`: the location's id, only when the caller can already see it (they
--      are a member), so the page can open it instead of offering to join. Never for anyone else.
--    `email_bound` says an address is required without saying which. The membership end date is
--    the one accept_invite() would give: the invite's, capped at its creator's own (D180); an
--    invite whose capped end date has passed is as invalid here as accept_invite() finds it.
--    The return type changes, so the function is dropped and made again.
DROP FUNCTION kept.invite_preview(text);
--> statement-breakpoint
CREATE FUNCTION kept.invite_preview(p_token_hash text)
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
     AND (i.role <> 'admin' OR m.role = 'owner')
     AND (least(i.membership_expires_at, m.expires_at) IS NULL
          OR least(i.membership_expires_at, m.expires_at) > now())
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.invite_preview(text) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.invite_preview(text) TO kept_app;
--> statement-breakpoint

-- 3. Signing up with an invite (task 20; D33, D127): while sign-up is closed, an invite is the
--    only way to create an account, and an email invite only for its own address. Before the
--    account exists there is no scope to compare with, so this answers the one question the
--    sign-up route needs: would this invite take this address? True for a live invite that is
--    either a link invite or bound to `p_email` (case-insensitive). Holding the token is the
--    permission, as for the preview; an email invite's token is only ever mailed to its address.
CREATE FUNCTION kept.invite_accepts_email(p_token_hash text, p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.invites i
      JOIN public.locations l ON l.id = i.location_id
      JOIN public.memberships m
        ON m.location_id = i.location_id AND m.user_id = i.created_by
       AND m.role IN ('owner', 'admin') AND (m.expires_at IS NULL OR m.expires_at > now())
     WHERE i.token_hash = p_token_hash
       AND i.accepted_at IS NULL AND i.expires_at > now() AND l.deleted_at IS NULL
       AND (i.role <> 'admin' OR m.role = 'owner')
       AND (least(i.membership_expires_at, m.expires_at) IS NULL
            OR least(i.membership_expires_at, m.expires_at) > now())
       AND (i.email IS NULL OR lower(i.email) = lower(p_email))
  )
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.invite_accepts_email(text, text) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.invite_accepts_email(text, text) TO kept_app;
