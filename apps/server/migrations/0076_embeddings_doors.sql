-- Custom SQL migration file, put your code below! --
-- Step 6, task 6: semantic search's storage and doors (D200, D207; plan Q12–Q15; spike S6.4).
-- Above, in 0075, drizzle's part (src/db/schema/embeddings.ts): thing_embeddings (one
-- undimensioned `vector` per thing and model, its length in dims, checked) and embedding_state
-- (per location: the model, its source, the backfill's progress). pgvector itself is created with
-- the database (docker/initdb, docker/initdb-prod), as pg_trgm and unaccent are. Below:
--   1. Both tables are definer-only: RLS forced, owner_all, no grant to any runtime role.
--      kept_app never reads a vector. A thing's rows follow it across a move (ON UPDATE CASCADE)
--      and are marked stale there (the new location may use another model).
--   2. The text a thing is embedded from: kept.embedding_text_of(), the SQL twin of @kept/shared
--      embedText() (src/db/embeddings.test.ts runs both on the same cases), fed by
--      kept.embedding_text(thing): its name, aliases in every language, type (its own name or
--      the built-in's names), brand, model, notes, the path from the location's name down to its
--      innermost container (kept.path_of()), and its receipt line's description and vendor (Q12).
--      Never a secret (secret values live apart, D116), a serial, money, or a file's text.
--   3. The doors (§7.2: the distance operator isn't leakproof, so a match under RLS couldn't use
--      an index; it goes through a door, as keyword matches do):
--      - kept.embedding_backlog(location, model_key, limit): live, named things whose vector for
--        that model is missing or made from other text, missing ones first, with their text and
--        its hash (SYS for the backfill; APP for a location the caller sees);
--      - kept.embedding_store(location, model_key, rows): upserts vectors of things still live in
--        that location and drops their other models' rows (SYS; APP for a writable location);
--      - kept.embedding_mark(location, model_key, source, pending, paused_reason): the backfill's
--        progress (SYS; APP for a writable location). Added beside the plan's list: nothing else
--        writes embedding_state;
--      - kept.semantic_thing_ids(model_key, query, location, limit): an exact cosine scan over
--        the caller's visible locations (a token's through its locations), one model, vectors of
--        the query's length, live things only, at most 50 (SEMANTIC_LIMIT). The only way to a
--        semantic match;
--      - kept.embedding_status(location) for its admins, kept.embedding_status_instance() for
--        instance admins (counts per source and model, no location names);
--      - kept.ai_provider_for_system(location, task): 0040's cascade for `embeddings` only, with no
--        caller, so the background backfill finds its payer ("Kept (background)", D206).
-- test/leak.test.ts and src/db/migrate.test.ts list the functions; test/leak-assistant.ts fills
-- the tables; src/db/embeddings.test.ts tests them.

-- 1. Definer-only tables --------------------------------------------------------------------------------
ALTER TABLE public.thing_embeddings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.thing_embeddings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.thing_embeddings FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON public.thing_embeddings FROM kept_app, kept_system, kept_auth;
--> statement-breakpoint
ALTER TABLE public.embedding_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.embedding_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_all ON public.embedding_state FOR ALL TO kept_owner USING (true)
  WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON public.embedding_state FROM kept_app, kept_system, kept_auth;
--> statement-breakpoint
-- A moved thing's vector is stale: an all-zero hash matches no text.
CREATE FUNCTION kept.embedding_moved() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.content_hash := repeat('0', 64);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER thing_embeddings_moved BEFORE UPDATE OF location_id ON public.thing_embeddings
  FOR EACH ROW WHEN (OLD.location_id IS DISTINCT FROM NEW.location_id)
  EXECUTE FUNCTION kept.embedding_moved();
--> statement-breakpoint

-- 2. The text --------------------------------------------------------------------------------------------
-- embedText()'s twin: one `label: value` line per non-empty field, whitespace runs collapsed to a
-- space and the ends trimmed, the path joined with ' › '.
CREATE FUNCTION kept.embedding_text_of(p_name text, p_aliases text[], p_type text, p_brand text,
                                       p_model text, p_notes text, p_place_path text[],
                                       p_vendor text, p_items text[])
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(string_agg(f.label || ': ' || f.v, E'\n' ORDER BY f.major, f.minor), '')
    FROM (
      SELECT x.major, x.minor, x.label,
             btrim(regexp_replace(x.value, '[[:space:]]+', ' ', 'g'), ' ') AS v
        FROM (
          SELECT 1 AS major, 0::bigint AS minor, 'name' AS label, p_name AS value
          UNION ALL
          SELECT 2, a.ord, 'alias', a.v FROM unnest(p_aliases) WITH ORDINALITY AS a(v, ord)
          UNION ALL SELECT 3, 0, 'type', p_type
          UNION ALL SELECT 4, 0, 'brand', p_brand
          UNION ALL SELECT 5, 0, 'model', p_model
          UNION ALL SELECT 6, 0, 'notes', p_notes
          UNION ALL
          SELECT 7, 0, 'place', array_to_string(p_place_path, ' › ')
           WHERE cardinality(p_place_path) > 0
          UNION ALL SELECT 8, 0, 'vendor', p_vendor
          UNION ALL
          SELECT 9, i.ord, 'item', i.v FROM unnest(p_items) WITH ORDINALITY AS i(v, ord)
        ) x
    ) f
   WHERE f.v <> ''
$$;
--> statement-breakpoint
-- A thing's text, from its row and what it points to. Owner-only: the doors call it.
CREATE FUNCTION kept.embedding_text(t public.things) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT kept.embedding_text_of(
    t.name,
    ARRAY(SELECT v FROM jsonb_each(t.aliases) e,
                 jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value) = 'array'
                                                THEN e.value ELSE '[]'::jsonb END) v),
    (SELECT coalesce(ty.name, ty.search_names,
                     (SELECT c.search_names FROM public.types c WHERE c.id = ty.copied_from_id))
       FROM public.types ty WHERE ty.id = t.type_id),
    (SELECT b.name FROM public.brands b WHERE b.id = t.brand_id),
    t.model,
    t.notes,
    (SELECT l.name FROM public.locations l WHERE l.id = t.location_id)
      || ARRAY(SELECT s ->> 'name'
                 FROM jsonb_array_elements(kept.path_of(t.place_id, t.container_id))
                      WITH ORDINALITY AS p(s, ord)
                ORDER BY p.ord),
    (SELECT v.name FROM public.purchase_lines pl
       JOIN public.purchases pu ON pu.id = pl.purchase_id
       JOIN public.vendors v ON v.id = pu.vendor_id
      WHERE pl.id = t.purchase_line_id),
    ARRAY(SELECT pl.description FROM public.purchase_lines pl WHERE pl.id = t.purchase_line_id))
$$;
--> statement-breakpoint

-- 3. The doors -------------------------------------------------------------------------------------------
CREATE FUNCTION kept.embedding_backlog(p_location uuid, p_model_key text, p_limit integer)
RETURNS TABLE (thing_id uuid, text text, content_hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
BEGIN
  IF session_user <> 'kept_system'
     AND NOT coalesce(p_location IN (SELECT kept.visible_location_ids()), false) THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT b.id, b.txt, b.hash
    FROM (SELECT t.id, x.txt, encode(sha256(convert_to(x.txt, 'UTF8')), 'hex') AS hash,
                 e.content_hash AS had
            FROM public.things t
           CROSS JOIN LATERAL (SELECT kept.embedding_text(t) AS txt) x
            LEFT JOIN public.thing_embeddings e
              ON e.thing_id = t.id AND e.model_key = p_model_key
           WHERE t.location_id = p_location AND t.deleted_at IS NULL AND t.name IS NOT NULL) b
   WHERE b.had IS DISTINCT FROM b.hash
   ORDER BY (b.had IS NULL) DESC, b.id
   LIMIT greatest(1, least(coalesce(p_limit, 64), 500));
END $$;
--> statement-breakpoint
-- rows: [{thing_id, content_hash, embedding: [number, …]}]. A thing no longer live in the
-- location is skipped. Returns the number stored.
CREATE FUNCTION kept.embedding_store(p_location uuid, p_model_key text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n integer;
BEGIN
  IF session_user <> 'kept_system'
     AND NOT coalesce(p_location IN (SELECT kept.writable_location_ids()), false) THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rows is an array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH r AS (
    SELECT DISTINCT ON (x.thing_id) x.thing_id, x.content_hash, x.embedding
      FROM (SELECT (a.x ->> 'thing_id')::uuid AS thing_id, a.x ->> 'content_hash' AS content_hash,
                   (a.x ->> 'embedding')::vector AS embedding, a.o
              FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS a(x, o)) x
      JOIN public.things t ON t.id = x.thing_id
     WHERE t.location_id = p_location AND t.deleted_at IS NULL
     ORDER BY x.thing_id, x.o DESC),
  up AS (
    INSERT INTO public.thing_embeddings AS e (thing_id, location_id, model_key, dims,
                                              content_hash, embedding, embedded_at)
    SELECT r.thing_id, p_location, p_model_key, vector_dims(r.embedding), r.content_hash,
           r.embedding, now()
      FROM r
    ON CONFLICT (thing_id, model_key) DO UPDATE
      SET dims = EXCLUDED.dims, content_hash = EXCLUDED.content_hash,
          embedding = EXCLUDED.embedding, embedded_at = EXCLUDED.embedded_at
    RETURNING e.thing_id),
  other AS (
    DELETE FROM public.thing_embeddings e USING r
     WHERE e.thing_id = r.thing_id AND e.model_key <> p_model_key
    RETURNING e.thing_id)
  SELECT count(*)::int INTO n FROM up;
  RETURN n;
END $$;
--> statement-breakpoint
CREATE FUNCTION kept.embedding_mark(p_location uuid, p_model_key text, p_source text,
                                    p_pending integer, p_paused_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF session_user <> 'kept_system'
     AND NOT coalesce(p_location IN (SELECT kept.writable_location_ids()), false) THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.embedding_state AS s (location_id, model_key, source, pending, last_run_at,
                                           paused_reason, updated_at)
  VALUES (p_location, p_model_key, p_source, greatest(coalesce(p_pending, 0), 0), now(),
          p_paused_reason, now())
  ON CONFLICT (location_id) DO UPDATE
    SET model_key = EXCLUDED.model_key, source = EXCLUDED.source, pending = EXCLUDED.pending,
        last_run_at = EXCLUDED.last_run_at, paused_reason = EXCLUDED.paused_reason,
        updated_at = EXCLUDED.updated_at;
END $$;
--> statement-breakpoint
-- The only way to a semantic match (§7.2): exact, within the caller's visible locations (or one of
-- them), one model, vectors of the query's length, live things only.
CREATE FUNCTION kept.semantic_thing_ids(p_model_key text, p_query vector, p_location uuid,
                                        p_limit integer)
RETURNS TABLE (thing_id uuid, distance real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.thing_id, (e.embedding <=> p_query)::real
    FROM public.thing_embeddings e
    JOIN public.things t ON t.id = e.thing_id AND t.deleted_at IS NULL
   WHERE e.location_id IN (SELECT kept.visible_location_ids())
     AND (p_location IS NULL OR e.location_id = p_location)
     AND e.model_key = p_model_key
     AND e.dims = vector_dims(p_query)
   ORDER BY e.embedding <=> p_query
   LIMIT greatest(1, least(coalesce(p_limit, 50), 50))
$$;
--> statement-breakpoint
-- The index's state for a location's admins: its source and model, how many things have a vector
-- for that model, and the backfill's progress. A location with no state yet answers one row of
-- nothing.
CREATE FUNCTION kept.embedding_status(p_location uuid)
RETURNS TABLE (source text, model_key text, embedded integer, pending integer,
               last_run_at timestamptz, paused_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
BEGIN
  IF NOT coalesce(p_location IN (SELECT kept.admin_location_ids()), false) THEN
    RAISE EXCEPTION 'no such location of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT s.source, s.model_key,
         (SELECT count(*)::int FROM public.thing_embeddings e
           WHERE e.location_id = p_location AND e.model_key = s.model_key),
         coalesce(s.pending, 0), s.last_run_at, s.paused_reason
    FROM (SELECT p_location AS id) l
    LEFT JOIN public.embedding_state s ON s.location_id = l.id;
END $$;
--> statement-breakpoint
-- For instance admins (the admin status page, D207): counts per source and model, no location.
CREATE FUNCTION kept.embedding_status_instance()
RETURNS TABLE (source text, model_key text, locations integer, embedded bigint, pending bigint,
               paused integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
BEGIN
  IF NOT kept.is_instance_admin() THEN
    RAISE EXCEPTION 'instance admins only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT s.source, s.model_key, count(*)::int,
         coalesce(sum((SELECT count(*) FROM public.thing_embeddings e
                         WHERE e.location_id = s.location_id AND e.model_key = s.model_key)),
                  0)::bigint,
         coalesce(sum(s.pending), 0)::bigint,
         count(*) FILTER (WHERE s.paused_reason IS NOT NULL)::int
    FROM public.embedding_state s
   GROUP BY s.source, s.model_key
   ORDER BY s.source, s.model_key;
END $$;
--> statement-breakpoint
-- The backfill's payer (SYS): 0040's cascade for embeddings only, with no caller to check.
CREATE FUNCTION kept.ai_provider_for_system(p_location uuid, p_task text)
RETURNS TABLE (provider_id uuid, scope text, kind text, base_url text, model text,
               reasoning text, structured boolean, key_ciphertext jsonb, key_version integer,
               paying_scope text, paying_account_id uuid, paying_user_id uuid,
               fell_back boolean, owner_account_id uuid, tripped_until timestamptz,
               trip_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_task IS DISTINCT FROM 'embeddings' OR p_location IS NULL THEN
    RAISE EXCEPTION 'the background finds a payer for embeddings in a location only'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY SELECT * FROM kept.ai_cascade(p_location, NULL, p_task);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.embedding_moved(),
  kept.embedding_text_of(text, text[], text, text, text, text, text[], text, text[]),
  kept.embedding_text(public.things), kept.embedding_backlog(uuid, text, integer),
  kept.embedding_store(uuid, text, jsonb),
  kept.embedding_mark(uuid, text, text, integer, text),
  kept.semantic_thing_ids(text, vector, uuid, integer), kept.embedding_status(uuid),
  kept.embedding_status_instance(), kept.ai_provider_for_system(uuid, text)
  FROM PUBLIC, kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.embedding_backlog(uuid, text, integer),
  kept.embedding_store(uuid, text, jsonb), kept.embedding_mark(uuid, text, text, integer, text)
  TO kept_app, kept_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.semantic_thing_ids(text, vector, uuid, integer),
  kept.embedding_status(uuid), kept.embedding_status_instance()
  TO kept_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.ai_provider_for_system(uuid, text) TO kept_system;
