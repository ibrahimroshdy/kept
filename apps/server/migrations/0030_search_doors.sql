-- Custom SQL migration file, put your code below! --
-- Step 2, task 24: the RLS benchmark at 10,000 things (master plan risk #3; docs/perf/
-- 2026-09-26-rls-bench.md). Text search found through its indexes again.
--
-- Why: row-level security puts a location's policy qual ahead of every qual a query adds, and a
-- qual may be used as an index condition ahead of the policy only if its operator is leakproof
-- (PostgreSQL's security-barrier rule). `@@` (ts_match_vq) and pg_trgm's `%` are not, so under
-- RLS no text-search query could use things_search_idx or things_name_trgm: every search read
-- every thing it could see and ran kept.normalize() on each name and serial, ~200 ms at 13,000
-- things on the laptop (search: hdmi p50 177 ms, Arabic p95 480 ms) and several times that on a
-- Pi. Marking the operators leakproof needs a superuser and would hold for every table; instead
-- the match itself goes through two doors that run as kept_owner (no policy qual in the way,
-- so the planner takes a BitmapOr over the indexes) and apply the caller's visibility
-- themselves, from the caller's own scope (kept.visible_location_ids() reads app.user_id).
--
-- 1. kept.search_thing_ids(tsq, ptsq, nq, location): the ids of the live things the caller can
--    see (in `location`, when given) whose search document matches either tsquery, whose
--    normalised name is trigram-similar to `nq` (pg_trgm.similarity_threshold, as set by the
--    caller) or whose normalised serial is `nq`. search/query.ts searchThings() selects the rows
--    by these ids; the rows themselves are still read through the policies.
-- 2. kept.near_thing_names(nq, literals, patterns, location): did-you-mean's candidates among
--    things (search/query.ts didYouMean()): names trigram-similar to `nq`, and names whose name
--    or alias words are one edit from a query word. The words come from the visible things'
--    weight-A lexemes (names and aliases, already normalised and stripped by kept.search_text)
--    through ts_stat, so no name is normalised per row; the things holding them are then found
--    through things_search_idx.
-- 3. things_serial_norm_idx: the serial arm of (1) as an index of its own (things_serial_idx
--    leads with location_id, which a search across locations doesn't have).
--
-- 4. things_trash_batch_idx, places_trash_batch_idx: the trash list's batch size (trash/service.ts
--    batchSize) counts a trashed row's batch with `location_id = … AND trash_batch_id = …`; with
--    no index on the batch the only one on location_id was used, and each row of the page read
--    the location's whole heap (5 ms a row, 290 ms a page at 10,000 things). Partial: only rows
--    in the trash carry a batch (restore and undo clear it). Plain partial indexes belong in the
--    Drizzle schema, but 0030's snapshot was committed before this file was written and 0031's
--    is another task's, so they are here. Whoever declares them in src/db/schema later keeps the
--    snapshot and drops the CREATE INDEX drizzle-kit generates for them (they exist already).
--
-- Both doors return only what the caller could already select (a thing's id or its name, never
-- another column), and nothing without a scope. test/leak.test.ts and src/db/migrate.test.ts
-- list them; the leak test probes each with another tenant's words.

CREATE INDEX things_trash_batch_idx ON public.things (location_id, trash_batch_id)
  WHERE trash_batch_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX places_trash_batch_idx ON public.places (location_id, trash_batch_id)
  WHERE trash_batch_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX things_serial_norm_idx ON public.things (kept.normalize(serial))
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE FUNCTION kept.search_thing_ids(p_tsq tsquery, p_ptsq tsquery, p_nq text, p_location uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.id FROM public.things t
   WHERE t.deleted_at IS NULL
     AND t.location_id IN (SELECT kept.visible_location_ids())
     AND (p_location IS NULL OR t.location_id = p_location)
     AND ((p_tsq IS NOT NULL AND t.search_tsv @@ p_tsq)
       OR (p_ptsq IS NOT NULL AND t.search_tsv @@ p_ptsq)
       OR (p_nq <> '' AND kept.normalize(t.name) OPERATOR(public.%) p_nq)
       OR (p_nq <> '' AND kept.normalize(t.serial) = p_nq))
$$;
--> statement-breakpoint

CREATE FUNCTION kept.near_thing_names(p_nq text, p_literals text[], p_patterns text[],
                                      p_location uuid)
RETURNS TABLE (name text, near boolean, sim real)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  near_q tsquery;
BEGIN
  -- The visible names' and aliases' words one edit from a query word, as `'word':A | …` (each
  -- lexeme quoted the way search/query.ts termsCte quotes them, so none becomes syntax).
  SELECT string_agg('''' || replace(replace(s.word, '\', '\\'), '''', '''''') || ''':A', ' | ')
         ::tsquery
    INTO near_q
    FROM ts_stat(format(
           'SELECT ts_filter(search_tsv, %L) FROM public.things
             WHERE deleted_at IS NULL AND name IS NOT NULL
               AND location_id IN (SELECT kept.visible_location_ids()) %s',
           '{a}',
           CASE WHEN p_location IS NULL THEN ''
                ELSE format('AND location_id = %L::uuid', p_location) END)) s
   WHERE s.word = ANY (p_literals) OR s.word LIKE ANY (p_patterns);

  RETURN QUERY
    SELECT t.name, coalesce(t.search_tsv @@ near_q, false),
           public.similarity(kept.normalize(t.name), p_nq)
      FROM public.things t
     WHERE t.deleted_at IS NULL AND t.name IS NOT NULL
       AND t.location_id IN (SELECT kept.visible_location_ids())
       AND (p_location IS NULL OR t.location_id = p_location)
       AND ((near_q IS NOT NULL AND t.search_tsv @@ near_q)
         OR kept.normalize(t.name) OPERATOR(public.%) p_nq);
END $$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION kept.search_thing_ids(tsquery, tsquery, text, uuid),
  kept.near_thing_names(text, text[], text[], uuid) FROM PUBLIC, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.search_thing_ids(tsquery, tsquery, text, uuid),
  kept.near_thing_names(text, text[], text[], uuid) TO kept_app;
