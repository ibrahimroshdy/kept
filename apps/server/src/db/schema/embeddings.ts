import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { tstz } from './common.js';
import { locations } from './tenancy.js';
import { things } from './things.js';

// Semantic search's storage (step-6 plan T6; D200, D207; plan Q12–Q15; spike S6.4). Both tables
// are definer-only: vectors are derived from things, and only the kept.embedding_* and
// kept.semantic_* doors (0076) touch them; kept_app never reads a vector. pgvector's distance
// operator isn't leakproof, so a match under RLS couldn't use an index anyway (§7.2): the door
// runs an exact scan within the location and model (S6.4: 40 ms p95 at 10,000 things, 1,536
// dimensions; T14 asks for 768).

/**
 * pgvector's `vector` without a dimension (Q13): several models' vectors side by side, each row's
 * length in `dims`. Drizzle's own `vector` column requires a dimension, so this is a custom type,
 * as `xid8` and `tsvector` are. It reads back as pgvector's text form, `[1,2,3]`.
 */
const vector = customType<{ data: string }>({ dataType: () => 'vector' });

/**
 * One thing's vector for one model: `model_key` is `<source>:<provider_kind>:<model>` or
 * `local:<model>`; `content_hash` is the SHA-256 of the text it was made from
 * (kept.embedding_text()), so a changed thing is pending again. It follows its thing across a
 * move (ON UPDATE CASCADE) and is then marked stale (0076).
 */
export const thingEmbeddings = pgTable(
  'thing_embeddings',
  {
    thingId: uuid('thing_id').notNull(),
    locationId: uuid('location_id').notNull(),
    modelKey: text('model_key').notNull(),
    dims: smallint('dims').notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding').notNull(),
    embeddedAt: tstz('embedded_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'thing_embeddings_pk', columns: [t.thingId, t.modelKey] }),
    foreignKey({
      name: 'thing_embeddings_thing_fk',
      columns: [t.locationId, t.thingId],
      foreignColumns: [things.locationId, things.id],
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('thing_embeddings_model_key_chk', sql`char_length(model_key) BETWEEN 1 AND 200`),
    // S6.4: never 3,072 (pgvector's HNSW stops at 2,000, and the exact scan is at its edge there).
    check('thing_embeddings_dims_chk', sql`dims BETWEEN 1 AND 2000`),
    check('thing_embeddings_hash_chk', sql`content_hash ~ '^[0-9a-f]{64}$'`),
    check('thing_embeddings_vector_chk', sql`vector_dims(embedding) = dims`),
    index('thing_embeddings_loc_model_idx').on(t.locationId, t.modelKey),
  ],
);

/** Per location: the model in use, where it runs, and the backfill's progress (D207). */
export const embeddingState = pgTable(
  'embedding_state',
  {
    locationId: uuid('location_id')
      .primaryKey()
      .references(() => locations.id, { onDelete: 'cascade' }),
    modelKey: text('model_key'),
    source: text('source'),
    pending: integer('pending').notNull().default(0),
    lastRunAt: tstz('last_run_at'),
    pausedReason: text('paused_reason'),
    /** When the last run's pause ends (a cap's reset, a provider's wait), if it does (0099). The
     * backfill doesn't try the location again before then. */
    pausedUntil: tstz('paused_until'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  () => [
    check('embedding_state_model_key_chk', sql`char_length(model_key) BETWEEN 1 AND 200`),
    check('embedding_state_source_chk', sql`source IN ('provider', 'local')`),
    check('embedding_state_pending_chk', sql`pending >= 0`),
    check('embedding_state_paused_reason_chk', sql`char_length(paused_reason) <= 60`),
  ],
);
