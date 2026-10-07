-- Custom SQL migration file, put your code below! --
-- Step 6 (T10): a personal token's writes fan out to the things they touched. 0070 let a token
-- write its own audit events (actor_type 'token', actor_id = the token) but audit_event_subjects'
-- insert policy (0006) still named the user actor only, so a token's write that touched a thing
-- was refused (a 404). The policy now takes the same two actors as audit_events': the request's
-- user, or its token. Subjects are still added only to an event the caller itself wrote.
DROP POLICY app_insert ON public.audit_event_subjects;
--> statement-breakpoint
CREATE POLICY app_insert ON public.audit_event_subjects FOR INSERT TO kept_app
  WITH CHECK (
    location_id IN (SELECT kept.visible_location_ids())
    AND EXISTS (
      SELECT 1 FROM public.audit_events e
       WHERE e.id = audit_event_subjects.event_id AND e.at = audit_event_subjects.event_at
         AND ((e.actor_type = 'user' AND e.actor_id = (SELECT kept.current_user_id()))
              OR (e.actor_type = 'token' AND e.actor_id = (SELECT kept.current_token_id())))
    )
  );
