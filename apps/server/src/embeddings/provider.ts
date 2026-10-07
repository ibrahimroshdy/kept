import { EMBED_DIMS, EMBEDDINGS_SOURCES, type EmbeddingsSource } from '@kept/shared';
import type pg from 'pg';
import type { Resolved } from '../ai/ports.js';
import type { Pools } from '../db/pools.js';

// Where semantic search's vectors come from (D200, D207; step-6 plan T14, Q13, spike S6.4).
//
// - The source is the instance setting `embeddings_source` (D207): KEPT_EMBEDDINGS writes it at
//   boot (mirrorEmbeddingsSource), the admin status page's switch writes it after (routes.ts).
//   With no row yet, the environment's default (`provider`) holds.
// - `provider`: each location's resolved `embeddings` model (ai/resolve.ts's cascade); a
//   location whose cascade has none is keyword-only (Groq has no embeddings model, §8a).
// - `local`: the on-server model (S6.5). Not built in 1.0: its runtime isn't installed, so
//   config/env.ts refuses KEPT_EMBEDDINGS=local and the switch refuses it; a row saying `local`
//   (an older install) is treated as `off` here.
// - `off`: no jobs, no query embeddings, keyword search only.
//
// A vector's model key names what made it: `provider:<kind>:<model>` (T6's convention), and
// every provider that can shorten vectors is asked for EMBED_DIMS (S6.4 finding 2).

export const EMBEDDINGS_SOURCE_KEY = 'embeddings_source';

const isSource = (v: unknown): v is EmbeddingsSource =>
  typeof v === 'string' && (EMBEDDINGS_SOURCES as readonly string[]).includes(v);

/** The source as stored, read as kept_system (kept_app reads instance_settings only as an
 * instance admin); `fallback` when no row. */
export async function storedSource(
  pools: Pick<Pools, 'system'>,
  fallback: EmbeddingsSource = 'provider',
): Promise<EmbeddingsSource> {
  const { rows } = await pools.system.query<{ value: unknown }>(
    'SELECT value FROM public.instance_settings WHERE key = $1',
    [EMBEDDINGS_SOURCE_KEY],
  );
  const v = rows[0]?.value;
  return isSource(v) ? v : fallback;
}

/** The source that runs: `local` runs nowhere in 1.0, so it is `off`. */
export async function embeddingsSource(
  pools: Pick<Pools, 'system'>,
  fallback: EmbeddingsSource = 'provider',
): Promise<'provider' | 'off'> {
  const s = await storedSource(pools, fallback);
  return s === 'provider' ? 'provider' : 'off';
}

/** Writes the source on `client` (kept_system at boot, or an instance admin's kept_app
 * transaction for the switch); answers the value it replaced. */
export async function writeSource(
  client: pg.ClientBase,
  source: EmbeddingsSource,
): Promise<EmbeddingsSource | null> {
  const before = await client.query<{ value: unknown }>(
    'SELECT value FROM public.instance_settings WHERE key = $1 FOR UPDATE',
    [EMBEDDINGS_SOURCE_KEY],
  );
  const was = before.rows[0]?.value;
  if (before.rows.length === 0) {
    await client.query(
      `INSERT INTO public.instance_settings (key, value) VALUES ($1, to_jsonb($2::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [EMBEDDINGS_SOURCE_KEY, source],
    );
  } else if (was !== source) {
    await client.query(
      'UPDATE public.instance_settings SET value = to_jsonb($2::text) WHERE key = $1',
      [EMBEDDINGS_SOURCE_KEY, source],
    );
  }
  return isSource(was) ? was : null;
}

/** At boot: KEPT_EMBEDDINGS becomes the stored source (D207, "mirrored to instance_settings"). */
export async function mirrorEmbeddingsSource(
  pools: Pick<Pools, 'system'>,
  source: EmbeddingsSource,
): Promise<void> {
  const client = await pools.system.connect();
  try {
    await client.query('BEGIN');
    await writeSource(client, source);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The vectors' model key (T6): `provider:<kind>:<model>`, at most 200 characters. */
export function modelKeyOf(r: Pick<Resolved, 'provider'>): string {
  return `provider:${r.provider.kind}:${r.provider.model}`.slice(0, 200);
}

/** The length to ask for: EMBED_DIMS where the provider shortens vectors, else its own. */
export function requestedDims(r: Pick<Resolved, 'provider'>): number | undefined {
  return r.provider.kind === 'openai' || r.provider.kind === 'google' ? EMBED_DIMS : undefined;
}

/** The most dimensions a stored vector may have (thing_embeddings_dims_chk). */
export const MAX_STORED_DIMS = 2000;

/** A vector as the doors take it: pgvector's text form. */
export const vectorLiteral = (v: readonly number[]): string => `[${v.join(',')}]`;
