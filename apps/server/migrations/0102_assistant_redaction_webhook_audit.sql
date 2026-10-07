-- Custom SQL migration file, put your code below! --
-- The step-6 security review's schema items S1–S3 (docs/audits/security-step6-2026-10-06.md; S4 is
-- 0099, S5 is the webhook fan-out's query in src/webhooks/fanout.ts):
--   S1. kept.redact_assistant_in() (0073) also blanks the args, before, refs and result of every
--       proposal the user has in the location, any status, not only cancels the open ones (the
--       read hid them; now the rows don't hold them).
--   S2. assistant_messages' app_insert: an answer cites only locations the caller sees, so one
--       built from a location can't be inserted after the membership delete already redacted.
--   S3. Data: webhook audit events from before the M2 fix keep their URL as "changed", class
--       secret, as audit/classes.ts now writes it (`webhook.url`).
-- src/db/assistant.test.ts and src/webhooks/webhooks.test.ts test them.

-- S1 ------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kept.redact_assistant_in(p_user uuid, p_location uuid) RETURNS integer
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

  -- S1: every proposal of the user's there, whatever its status, keeps no arguments, before
  -- image, references or result (they hold the location's names and values); an open one is
  -- cancelled, as before. (A purged location's proposals go with it, by cascade.)
  UPDATE public.assistant_proposals p
     SET args = '{}'::jsonb, before = '{}'::jsonb, refs = '{}'::jsonb, result = NULL,
         status = CASE WHEN p.status = 'open' THEN 'cancelled' ELSE p.status END
   WHERE p.user_id = p_user AND p.location_id = p_location
     AND (p.status = 'open' OR p.args <> '{}'::jsonb OR p.before <> '{}'::jsonb
          OR p.refs <> '{}'::jsonb OR p.result IS NOT NULL);

  UPDATE public.assistant_threads th SET search_tsv = kept.assistant_thread_tsv(th.id, th.title)
   WHERE th.id = ANY (coalesce(touched, '{}'::uuid[]));
  RETURN results + messages;
END $$;
--> statement-breakpoint

-- S2 ------------------------------------------------------------------------------------------------
DROP POLICY app_insert ON public.assistant_messages;
--> statement-breakpoint
CREATE POLICY app_insert ON public.assistant_messages FOR INSERT TO kept_app
  WITH CHECK (user_id = (SELECT kept.current_user_id())
              AND (SELECT kept.current_token_id()) IS NULL
              AND redacted_at IS NULL
              AND cited_location_ids <@ ARRAY(SELECT kept.visible_location_ids()));
--> statement-breakpoint

-- S3 ------------------------------------------------------------------------------------------------
UPDATE public.audit_events
   SET diff = jsonb_set(diff, '{url}', '{"changed": true, "class": "secret"}'::jsonb)
 WHERE entity_type = 'webhook' AND jsonb_typeof(diff) = 'object' AND diff ? 'url'
   AND diff -> 'url' IS DISTINCT FROM '{"changed": true, "class": "secret"}'::jsonb;
