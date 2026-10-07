# Spike S6.4: embeddings and pgvector

Date: 2026-09-30. Step-6 plan, Task 0 (it feeds T6, T8, T14 and Q13). Result: **PASS on a quiet
laptop. Q13's exact scan stands; HNSW isn't needed and did worse.**
- **The exact cosine scan through a `SECURITY DEFINER` door**, run as kept_app in a member's scope
  over 10,210 things of one location, measured by the follow-up once the machine was quiet:

  | Vectors | p50 | p95 | Gate |
  |---|---|---|---|
  | 1,536 dimensions | 35.7 ms | **40.0 ms** | pass (< 150 ms) |
  | 768 dimensions | 28.5 ms | 34.8 ms | pass |
  | 3,072 dimensions | 116.8 ms | 142.9 ms | pass, barely |

- **The first run was taken while other agents' image builds and a model container shared the
  laptop.** It gave 1,536 dims p50 82 ms, p95 287 ms, and 3,072 dims p95 897 ms. Those numbers are
  contention, not the scan, but they show how thin the margin is under load. They are kept below,
  labelled as such.
- **HNSW, per the plan's fallback, was measured and is worse here.** A partial expression index
  (`(embedding::vector(1536)) vector_cosine_ops WHERE model_key = '…'`, 100 MB) gave p95 6.6 ms, but:
  - recall@50 against the exact scan was **0.18** on random vectors (a worst case);
  - one query returned **33 rows instead of 50**: the location filter is applied after the index's
    candidate list.

  Exact is the right answer at this size.
- **pgvector 0.8.6, asked directly:** HNSW on `vector(3072)` fails with "column cannot have more
  than 2000 dimensions for hnsw index". HNSW on `halfvec(3072)` was created.
- **The provider half ran without keys** (none for OpenAI or Google in `.env`). `embed` and
  `embedMany` ran against a stubbed `fetch` answering in each provider's own response schema: the
  request count, paths, `usage` and headers are real SDK behaviour; rate limits and real vector
  lengths stay **pending keys**.
- **The door works as T6 plans it:**
  - an undimensioned `vector` column holds several models' vectors (768, 1,536 and 3,072 side by
    side);
  - `CHECK (vector_dims(embedding) = dims)` guards each row;
  - kept_app reads 0 rows from the table directly (RLS forced, `owner_all` only);
  - a user with no membership gets 0 rows from the door;
  - `kept.visible_location_ids()` runs once, as a hashed SubPlan (a One-Time Filter).
- The scratch database was dropped afterwards; nothing is left in Postgres.

Code: `docs/spikes/code/step6/embeddings/`:
- `pgvector.spike.ts`: makes a scratch database on 5452, migrates it, seeds `bench` (10,000 things
  in "Bench 10k", 12,810 in all), adds the table and door, measures, and drops the database. Run it
  from `apps/server`; its header says how. Results are in `pgvector-results.json` (the vector
  literals in the plans are replaced with `[…]`).
- `pgvector-hnsw.spike.ts` + `pgvector-hnsw-results.json`: the follow-up on the same database
  (the exact scan again, 768 dimensions, an HNSW partial expression index with recall@50, and
  pgvector's own answer at 3,072 dimensions), which then dropped the database.
- `embed-wire.spike.ts` + `embed-wire-results.json`: the stubbed provider calls.
- `package.json` + `package-lock.json` (for `embed-wire` only: `ai` 7.0.116, `@ai-sdk/openai`
  4.0.78, `@ai-sdk/google` 4.0.82).

## The database half: what was run

- Postgres 18.6, pgvector **0.8.6** (`pg_extension.extversion`), in the dev compose container.
- `spike_thing_embeddings (thing_id, location_id, model_key, dims, embedding vector)` with primary
  key `(thing_id, model_key)` and a b-tree on `(location_id, model_key)`. It holds 12,810 things
  × 2 models of random vectors in 276 MB.
- The door, as T6 describes:

  ```sql
  CREATE FUNCTION kept.spike_semantic_thing_ids(p_location uuid, p_model text, p_q vector, p_limit int)
  RETURNS TABLE (id uuid, distance double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT e.thing_id, e.embedding <=> p_q
      FROM spike_thing_embeddings e JOIN things t ON t.id = e.thing_id AND t.deleted_at IS NULL
     WHERE e.location_id = p_location AND p_location IN (SELECT kept.visible_location_ids())
       AND e.model_key = p_model
     ORDER BY e.embedding <=> p_q LIMIT least(p_limit, 50) $$;
  ```

- **First run (contended laptop, see above).** 200 timed runs after 20 warm-ups. Each ran in its own `withScope` transaction as kept_app for
  the bench member, with a new random query vector each time:

| Case | Rows | Query p50 | p95 | p99 | max | With the transaction p95 |
|---|---|---|---|---|---|---|
| 1,536 dims, member | 50 | 81.7 ms | 286.8 ms | 867.4 ms | 1,603 ms | 313.1 ms |
| 1,536 dims, viewer | 50 | 79.7 ms | 358.1 ms | 865.6 ms | 1,085 ms | 397.9 ms |
| 3,072 dims, member | 50 | 198.6 ms | 897.0 ms | 1,520 ms | 3,216 ms | 905.6 ms |

**Where the time goes (the owner's plan during the contended run, 121.6 ms):**
- the b-tree finds the 10,210 rows in 2.4 ms and the join with `things` takes 21 ms;
- **computing 10,210 distances takes about 97 ms and 32,500 buffer hits**. A 1,536-dimension vector
  is 6 KB, over the TOAST threshold, so every distance first de-TOASTs the vector.
- The top-50 sort is a heapsort in 30 kB.

The distance work dominates; the quiet follow-up below does the same work in 36 ms p50, so the
first run's tail was the machine, not the scan.

## The provider half (stubbed fetch)

| Call | OpenAI `text-embedding-3-small` | Google `gemini-embedding-001` |
|---|---|---|
| Path | `/v1/embeddings` | `…:embedContent` (1 value), `…:batchEmbedContents` (2+) |
| Most values per request (`maxEmbeddingsPerCall`, in the provider source) | 2,048 | 100 |
| `embedMany` of 3, 64 values | 1 request | 1 request |
| `embedMany` of 150 values | 1 request | **2 requests** |
| `embedMany` of 2,100 values | 2 requests | **21 requests, all 21 in flight at once** by default; 1 at a time with `maxParallelCalls: 1` |
| `usage.tokens` | from `usage.prompt_tokens` | **`NaN`**: the provider returns `usage: undefined`, and `embedMany` sums it to `NaN` |
| Response headers reach the result | yes: `embed().response.headers`, `embedMany().responses[i].headers` | yes |
| Shorter vectors | `providerOptions.openai.dimensions` | `providerOptions.google.outputDimensionality` ("excessive values … are truncated from the end") |

## The follow-up (quiet laptop, same database)

| Case | p50 | p95 | p99 | max |
|---|---|---|---|---|
| exact, 1,536 dims | 35.65 ms | 39.95 ms | 42.11 ms | 51.57 ms |
| exact, 768 dims | 28.45 ms | 34.77 ms | 44.52 ms | 46.76 ms |
| exact, 3,072 dims (100 runs) | 116.81 ms | 142.90 ms | 157.58 ms | 159.02 ms |
| HNSW, 1,536 dims, partial on the model | 4.35 ms | 6.56 ms | 9.90 ms | 35.22 ms |

- HNSW recall@50 against the exact door: **0.178** (30 random queries).
- The HNSW plan: an index scan ordered by `(embedding)::vector(1536) <=> …`, then
  `Filter: (location_id = …)` removing rows after the scan, and `rows=33` at the Limit.
- The index was built during the interrupted first attempt, so its build time isn't recorded.

## Findings for the plan

1. **Q13 holds: one undimensioned `vector` column and an exact scan through the door.** At 10,000
   things, 1,536 dimensions take 40 ms p95 on a quiet laptop, well under 150 ms. **No HNSW in 1.0.**
   HNSW's post-filtering loses rows and recall inside a location, and it needs a partial index and
   a literal statement per model.
2. **Store 768 or 1,536 dimensions, never 3,072.** 3,072 sits at the edge (143 ms p95 quiet,
   897 ms p95 contended), and HNSW refuses it on `vector`. Both providers shorten vectors on
   request (`dimensions`, `outputDimensionality`). **Recommended for T14:** request 768 for every
   provider model that allows it. It is the fastest, and one shape holds for all models.
   `DEFAULT_MODELS`' embeddings entries gain the requested dims.
3. **Headroom under load is small.** Contention took p95 from 40 ms to 287 ms. T26's
   `semantic.perf.test.ts` gate should run on a quiet machine, like the RLS bench, with the 300 ms
   search budget (§3.1) as the product limit and 150 ms as the laptop gate.
4. **`embedValues` must make exactly one request** (T8 step 6, "one ledger row per request"). By
   default `embedMany` splits a batch by `maxEmbeddingsPerCall` and sends the parts **in parallel
   with no limit**. So T8:
   - chunks by the model's `maxEmbeddingsPerCall` (read from the model object), taking the smaller
     of that and T14's 64;
   - passes `maxParallelCalls: 1`;
   - asserts `values.length <= model.maxEmbeddingsPerCall` before calling. 64 fits both providers.
5. **Google reports no embedding tokens.** `usage.tokens` is `NaN`. T8 records the estimate
   (`estimateCall`'s chars ÷ 2.4) with the ledger row marked estimated, and never writes `NaN`.
   The cost is `unknown` or computed from the estimate, as the price table allows.
6. **The pacer sees headers** from both providers (`responses[i].headers` for `embedMany`). The real
   header names are pending keys.
7. **The door's shape is right:** the visibility check runs once; kept_app has no direct read; a
   stranger gets nothing; `CHECK (vector_dims(embedding) = dims)` works on an undimensioned column.

## What changes in the plan

- **T6 / Q13:** as planned (exact scan in the door); **no HNSW**. The door's statement takes the
  model and the location as parameters.
- **T8:** findings 4 and 5 (chunking, `maxParallelCalls: 1`, the Google token estimate).
- **T14:** request 768-dimension vectors (finding 2); never store 3,072.
- **T26:** the semantic perf gate runs quiet, like the RLS bench (finding 3).
