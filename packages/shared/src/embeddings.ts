/**
 * Semantic search (D200, D207; step-6 plan Q12–Q15). Things are embedded from a text built of
 * what describes them, never secrets, serials, money or a file's raw text. `kept.embedding_text()`
 * in SQL is this function's twin and is checked against the same cases.
 */

/** Where vectors come from (D207): the location's AI provider, a local model, or nowhere. */
export const EMBEDDINGS_SOURCES = ['provider', 'local', 'off'] as const;
export type EmbeddingsSource = (typeof EMBEDDINGS_SOURCES)[number];

/** Reciprocal rank fusion's k (Q14): score = Σ 1 / (RRF_K + rank). */
export const RRF_K = 60;
/** The semantic side's candidates per query (Q14). */
export const SEMANTIC_LIMIT = 50;

/**
 * The vector length Kept asks of every provider model that can shorten its vectors (spike S6.4
 * finding 2: 768 is the fastest exact scan, one shape for every model, and never 3,072). OpenAI
 * takes it as `dimensions`, Google as `outputDimensionality`; an OpenAI-compatible server answers
 * its model's own length.
 */
export const EMBED_DIMS = 768;

/**
 * Why a search answered on keywords only (step-6 plan T14, §7.15), as GET /search's `semantic`
 * says it: a cap paused the query's embedding (`paused`, until when), the provider asked to wait
 * (`waiting`), the server's embeddings are off (`off`), or no searched location has an embeddings
 * model (`keyword_only`). Absent or null: meaning was searched too.
 */
export const SEMANTIC_STATES = ['paused', 'waiting', 'off', 'keyword_only'] as const;
export type SemanticState = { state: (typeof SEMANTIC_STATES)[number]; until?: string };

/**
 * What a thing's embedding text is built from. Only these fields are read: an object carrying a
 * secret, a serial, a price or a file's text as extra keys contributes none of them.
 */
export type EmbedTextInput = {
  name: string;
  /** Every alias, in every language. */
  aliases?: readonly string[];
  typeName?: string | null;
  brand?: string | null;
  model?: string | null;
  notes?: string | null;
  /** Place names from the location down to the thing's container. */
  placePath?: readonly string[];
  /** From the receipt's extraction: the vendor and the lines' descriptions, never an amount (Q12). */
  receipt?: { vendor?: string | null; lines?: readonly { description?: string | null }[] } | null;
};

/** The text a thing is embedded from: one field per line, empty fields left out. */
export function embedText(thing: EmbedTextInput): string {
  const lines: string[] = [];
  const add = (label: string, value: string | null | undefined) => {
    const v = value?.replace(/\s+/g, ' ').trim();
    if (v) lines.push(`${label}: ${v}`);
  };
  add('name', thing.name);
  for (const alias of thing.aliases ?? []) add('alias', alias);
  add('type', thing.typeName);
  add('brand', thing.brand);
  add('model', thing.model);
  add('notes', thing.notes);
  if (thing.placePath?.length) add('place', thing.placePath.join(' › '));
  add('vendor', thing.receipt?.vendor);
  for (const line of thing.receipt?.lines ?? []) add('item', line.description);
  return lines.join('\n');
}
