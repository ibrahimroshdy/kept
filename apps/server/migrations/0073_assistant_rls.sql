-- Custom SQL migration file, put your code below! --
-- Step 6, task 5: the assistant's private threads, turns, messages, tool results and proposals
-- (engineering spec §1.8, §3.3, §7.13; D22, D23, D123, D164, D179; plan Q3, Q11, Q17, Q21).
-- Above, in 0072, drizzle's part (src/db/schema/assistant.ts): the five tables, each child
-- keyed to its thread through (user_id, thread_id), one live turn per thread
-- (assistant_turns_one_live_uq), and proposals' location key. Below:
--   1. Row-level security. Every row is its user's own, private even from admins and instance
--      admins (D23), and never a token's (`app.token_id` unset). kept_system has no policy: its
--      only way in is kept.prune_assistant(). Messages and tool results are append-only (no
--      UPDATE grant: redaction is a definer); a tool result's location is one the user sees; a
--      proposal's location one they may write, so a viewer never holds one (D123).
--   2. Retention (D23, §3.3, Q17): `instance_settings.assistant_thread_days` (90 by default,
--      clamped to 7–365) sets a thread's expires_at when it is made and again at each new turn
--      (kept.assistant_expiry()). kept.prune_assistant(now) deletes threads past it (their turns,
--      messages, results and proposals cascade) and marks open proposals past their 10 minutes
--      expired.
--   3. The search text (Q17): the thread's title and the person's own questions and the
--      assistant's answers, never tool results, kept by triggers (kept.assistant_thread_tsv()),
--      so kept_app never writes it.
--   4. Redaction (D164, Q11): kept.redact_assistant_for(user, location) blanks the user's tool
--      results from that location, replaces each tool_result part holding one with
--      {"type":"redacted","reason":"access_ended"} (the rest of that message stays), replaces
--      every assistant answer citing the location with that part alone, cancels the user's open
--      proposals there, and rebuilds the touched threads' search text. Nothing names the
--      location. 0070's membership trigger now calls it on every path that ends a membership,
--      including a location's purge (the results keep no key to the location, so they are still
--      there to redact).
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-assistant.ts fills
-- the tables; src/db/assistant.test.ts tests them.

-- 1. Row-level security -------------------------------------------------------------------------------
ALTER TABLE public.assistant_threads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assistant_threads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assistant_turns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assistant_turns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assistant_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assistant_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assistant_tool_results ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assistant_tool_results FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assistant_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.assistant_proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.assistant_threads FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY owner_all ON public.assistant_turns FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY owner_all ON public.assistant_messages FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY owner_all ON public.assistant_tool_results FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY owner_all ON public.assistant_proposals FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.assistant_threads
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.assistant_turns
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.assistant_proposals
  FOR EACH ROW EXECUTE FUNCTION kept.touch_row();
--> statement-breakpoint

-- Threads: the person's own, to read, start, rename and delete.
CREATE POLICY app_select ON public.assistant_threads FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_insert ON public.assistant_threads FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_update ON public.assistant_threads FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL)
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
CREATE POLICY app_delete ON public.assistant_threads FOR DELETE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
-- Not granted: the id, user_id, the locale it was asked in, and the search text (triggers keep
-- it, section 3).
REVOKE UPDATE ON public.assistant_threads FROM kept_app, kept_system;
--> statement-breakpoint
GRANT UPDATE (title, context, expires_at, updated_at, row_version)
  ON public.assistant_threads TO kept_app;
--> statement-breakpoint

-- Turns: started by the person, run in their scope by the assistant-turn job (D166).
CREATE POLICY app_select ON public.assistant_turns FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_insert ON public.assistant_turns FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_update ON public.assistant_turns FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL)
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.assistant_turns FROM kept_app, kept_system;
--> statement-breakpoint
GRANT UPDATE (status, status_reason, paused_until, steps, location_ids, finished_at, updated_at,
              row_version)
  ON public.assistant_turns TO kept_app;
--> statement-breakpoint

-- Messages and tool results: appended by the person's turn, never changed by kept_app.
CREATE POLICY app_select ON public.assistant_messages FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_insert ON public.assistant_messages FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL
              AND redacted_at IS NULL);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.assistant_messages FROM kept_app, kept_system;
--> statement-breakpoint
CREATE POLICY app_select ON public.assistant_tool_results FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_insert ON public.assistant_tool_results FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL
              AND redacted_at IS NULL
              AND (location_id IS NULL OR location_id IN (SELECT kept.visible_location_ids())));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.assistant_tool_results FROM kept_app, kept_system;
--> statement-breakpoint

-- Proposals: made where the person may write; confirmed, cancelled or failed by them.
CREATE POLICY app_select ON public.assistant_proposals FOR SELECT TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL);
--> statement-breakpoint
CREATE POLICY app_insert ON public.assistant_proposals FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL
              AND status = 'open'
              AND location_id IN (SELECT kept.writable_location_ids()));
--> statement-breakpoint
CREATE POLICY app_update ON public.assistant_proposals FOR UPDATE TO kept_app
  USING (user_id = (SELECT kept.current_user_id()) AND (SELECT kept.current_token_id()) IS NULL)
  WITH CHECK (user_id = (SELECT kept.current_user_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON public.assistant_proposals FROM kept_app, kept_system;
--> statement-breakpoint
-- Not granted: what was proposed (tool, args, its hash, before, refs), where, and when it ends.
GRANT UPDATE (status, result, audit_event_id, updated_at, row_version)
  ON public.assistant_proposals TO kept_app;
--> statement-breakpoint

-- 2. Retention ----------------------------------------------------------------------------------------
-- When a thread made or asked in now expires: assistant_thread_days (a number, 7–365; 90 when
-- unset or not a number). Owner-only: the triggers below call it (kept_app can't read
-- instance_settings).
CREATE FUNCTION kept.assistant_expiry() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT now() + make_interval(days => coalesce(
    (SELECT least(365, greatest(7, round((s.value #>> '{}')::numeric)))::int
       FROM public.instance_settings s
      WHERE s.key = 'assistant_thread_days' AND jsonb_typeof(s.value) = 'number'),
    90))
$$;
--> statement-breakpoint
CREATE FUNCTION kept.assistant_thread_expiry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.expires_at := kept.assistant_expiry();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER assistant_threads_expiry BEFORE INSERT ON public.assistant_threads
  FOR EACH ROW EXECUTE FUNCTION kept.assistant_thread_expiry();
--> statement-breakpoint
CREATE FUNCTION kept.assistant_turn_bumps_thread() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.assistant_threads th
     SET expires_at = greatest(th.expires_at, kept.assistant_expiry())
   WHERE th.id = NEW.thread_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER assistant_turns_bump_thread AFTER INSERT ON public.assistant_turns
  FOR EACH ROW EXECUTE FUNCTION kept.assistant_turn_bumps_thread();
--> statement-breakpoint
-- The daily assistant-maintenance job (SYS): expired threads go, with everything in them; open
-- proposals past their 10 minutes are marked expired.
CREATE FUNCTION kept.prune_assistant(p_now timestamptz)
RETURNS TABLE (what text, removed bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM public.assistant_threads th WHERE th.expires_at < p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'assistant_threads'; removed := n; RETURN NEXT;

  UPDATE public.assistant_proposals p SET status = 'expired'
   WHERE p.status = 'open' AND p.expires_at < p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'assistant_proposals'; removed := n; RETURN NEXT;
END $$;
--> statement-breakpoint

-- 3. The search text ----------------------------------------------------------------------------------
-- The title (weighted A), then the questions and answers' text parts, in order; never tool
-- results or reasoning. Owner-only.
CREATE FUNCTION kept.assistant_thread_tsv(p_thread uuid, p_title text) RETURNS tsvector
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT setweight(to_tsvector('simple', kept.search_text(coalesce(p_title, ''))), 'A')
      || to_tsvector('simple', kept.search_text(left(coalesce(
           (SELECT string_agg(e.part ->> 'text', ' ' ORDER BY m.created_at, m.id, e.ord)
              FROM public.assistant_messages m
             CROSS JOIN LATERAL jsonb_array_elements(m.parts) WITH ORDINALITY AS e(part, ord)
             WHERE m.thread_id = p_thread AND m.role IN ('user', 'assistant')
               AND e.part ->> 'type' = 'text'),
           ''), 100000)))
$$;
--> statement-breakpoint
CREATE FUNCTION kept.assistant_message_tsv() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.assistant_threads th
     SET search_tsv = kept.assistant_thread_tsv(th.id, th.title)
   WHERE th.id = NEW.thread_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER assistant_messages_tsv AFTER INSERT ON public.assistant_messages
  FOR EACH ROW WHEN (NEW.role IN ('user', 'assistant'))
  EXECUTE FUNCTION kept.assistant_message_tsv();
--> statement-breakpoint
CREATE FUNCTION kept.assistant_title_tsv() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.search_tsv := kept.assistant_thread_tsv(NEW.id, NEW.title);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER assistant_threads_title_tsv BEFORE INSERT OR UPDATE OF title
  ON public.assistant_threads
  FOR EACH ROW EXECUTE FUNCTION kept.assistant_title_tsv();
--> statement-breakpoint

-- 4. Redaction ----------------------------------------------------------------------------------------
-- The work (owner-only; the door below and the membership trigger call it). Returns the number of
-- tool results and messages redacted.
CREATE FUNCTION kept.redact_assistant_in(p_user uuid, p_location uuid) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  placeholder constant jsonb := '{"type":"redacted","reason":"access_ended"}';
  loc text := p_location::text;
  results integer;
  messages integer;
  touched uuid[];
BEGIN
  UPDATE public.assistant_tool_results r SET output = NULL, redacted_at = now()
   WHERE r.user_id = p_user AND r.location_id = p_location AND r.redacted_at IS NULL;
  GET DIAGNOSTICS results = ROW_COUNT;

  -- A part is the location's when it says so (locationIds) or its call's result row does.
  WITH hit AS (
    SELECT m.id, m.thread_id,
           CASE WHEN m.role = 'assistant' THEN jsonb_build_array(placeholder)
                ELSE (SELECT jsonb_agg(
                         CASE WHEN e.part ->> 'type' = 'tool_result'
                                   AND (coalesce(e.part -> 'locationIds', '[]'::jsonb) ? loc
                                        OR EXISTS (SELECT 1 FROM public.assistant_tool_results r
                                                    WHERE r.message_id = m.id
                                                      AND r.call_id = e.part ->> 'callId'
                                                      AND r.location_id = p_location))
                              THEN placeholder ELSE e.part END
                         ORDER BY e.ord)
                        FROM jsonb_array_elements(m.parts) WITH ORDINALITY AS e(part, ord))
           END AS parts
      FROM public.assistant_messages m
     WHERE m.user_id = p_user
       AND ((m.role = 'assistant' AND p_location = ANY (m.cited_location_ids)
             AND m.parts IS DISTINCT FROM jsonb_build_array(placeholder))
            OR (m.role = 'tool' AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(m.parts) AS e(part)
                   WHERE e.part ->> 'type' = 'tool_result'
                     AND (coalesce(e.part -> 'locationIds', '[]'::jsonb) ? loc
                          OR EXISTS (SELECT 1 FROM public.assistant_tool_results r
                                      WHERE r.message_id = m.id
                                        AND r.call_id = e.part ->> 'callId'
                                        AND r.location_id = p_location)))))
  ), done AS (
    UPDATE public.assistant_messages m
       SET parts = hit.parts, redacted_at = coalesce(m.redacted_at, now())
      FROM hit WHERE m.id = hit.id
    RETURNING m.thread_id)
  SELECT count(*)::int, array_agg(DISTINCT thread_id) INTO messages, touched FROM done;

  IF EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location) THEN
    UPDATE public.assistant_proposals p SET status = 'cancelled'
     WHERE p.user_id = p_user AND p.location_id = p_location AND p.status = 'open';
  END IF;

  UPDATE public.assistant_threads th SET search_tsv = kept.assistant_thread_tsv(th.id, th.title)
   WHERE th.id = ANY (coalesce(touched, '{}'::uuid[]));
  RETURN results + messages;
END $$;
--> statement-breakpoint
-- The door (SYS for the jobs; APP for the membership routes): the user themself, or an admin of
-- the location. Never a token.
CREATE FUNCTION kept.redact_assistant_for(p_user uuid, p_location uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'kept_system'
     AND (kept.current_user_id() IS NULL OR kept.current_token_id() IS NOT NULL
          OR (p_user IS DISTINCT FROM kept.current_user_id()
              AND NOT coalesce(p_location IN (SELECT kept.admin_location_ids()), false))) THEN
    RAISE EXCEPTION 'not a location you administer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN kept.redact_assistant_in(p_user, p_location);
END $$;
--> statement-breakpoint
-- 0070's, with redaction on every path that ends a membership, a purge included.
CREATE OR REPLACE FUNCTION kept.membership_access_ended() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  purged boolean := NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = OLD.location_id);
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM kept.redact_assistant_in(OLD.user_id, OLD.location_id);
    IF NOT purged THEN
      PERFORM kept.revoke_tokens_in(OLD.user_id, OLD.location_id, 'membership_ended');
    END IF;
  ELSIF NOT purged AND NEW.role = 'viewer' AND OLD.role <> 'viewer' THEN
    PERFORM kept.revoke_tokens_in(OLD.user_id, OLD.location_id, 'role_lost');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.assistant_expiry(), kept.assistant_thread_expiry(),
  kept.assistant_turn_bumps_thread(), kept.assistant_thread_tsv(uuid, text),
  kept.assistant_message_tsv(), kept.assistant_title_tsv(), kept.redact_assistant_in(uuid, uuid),
  kept.redact_assistant_for(uuid, uuid), kept.prune_assistant(timestamptz)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.redact_assistant_for(uuid, uuid) TO kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.prune_assistant(timestamptz) TO kept_system;
