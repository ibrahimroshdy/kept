import { EMBEDDINGS_SOURCES } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { localEmbeddingsInstalled } from '../config/env.js';
import type { Pools } from '../db/pools.js';
import { storedSource } from './provider.js';

// Admin → Status → Embeddings (D207; step-6 plan T14, T24), the web's EmbeddingsStatus
// (apps/web/src/api/types.ts): the source, how much is indexed, and whether the local model can be
// offered. Read through `kept.embedding_status_instance()` as an instance admin: counts per source
// and model only, never a location's name.
//
// - `indexed`: things with a vector for their location's current model; `total` is `indexed` plus
//   the backlog the last backfill counted (each location's read stops at 500, so a big unindexed
//   location reads low until its backlog shrinks).
// - `paused`: the index is paused when every location the backfill marked is, and the earliest
//   end among them is a cap's (embedding_state.paused_until, 0099): that end and its reason. A
//   provider's wait or a failure isn't a pause the person can act on, so it shows as none.
// - `local`: the on-server model isn't built in 1.0 (S6.5): available only where its runtime is
//   installed, which no Kept build does yet.

export const EmbeddingsStatusSchema = z.object({
  source: z.enum(EMBEDDINGS_SOURCES),
  indexed: z.number().int(),
  total: z.number().int(),
  paused: z
    .object({
      until: z.string(),
      reason: z.enum(['manual', 'cap_money', 'cap_tokens', 'tokens_day']),
    })
    .nullable(),
  local: z.object({
    available: z.boolean(),
    downloadBytes: z.number().int().nullable(),
    downloadedBytes: z.number().int().nullable(),
  }),
});
export type EmbeddingsStatus = z.infer<typeof EmbeddingsStatusSchema>;

const CAP_REASONS = ['manual', 'cap_money', 'cap_tokens', 'tokens_day'] as const;

/** Paused when every marked location is, and the soonest end is a cap's; see the header. */
function pausedOf(
  rows: readonly {
    locations: number;
    paused: number;
    paused_until: Date | null;
    paused_reason: string | null;
  }[],
): EmbeddingsStatus['paused'] {
  if (rows.length === 0 || rows.some((r) => r.paused < r.locations)) return null;
  const first = rows
    .filter((r) => r.paused_until !== null)
    .sort((a, b) => (a.paused_until as Date).getTime() - (b.paused_until as Date).getTime())[0];
  const reason = CAP_REASONS.find((c) => c === first?.paused_reason);
  return first?.paused_until && reason ? { until: first.paused_until.toISOString(), reason } : null;
}

/** The status as an instance admin reads it, on their scoped transaction. */
export async function embeddingsStatus(
  client: pg.ClientBase,
  pools: Pick<Pools, 'system'>,
  installed: () => boolean = localEmbeddingsInstalled,
  /** The source just written on `client`'s transaction (the system pool can't see it yet). */
  source?: EmbeddingsStatus['source'],
): Promise<EmbeddingsStatus> {
  const { rows } = await client.query<{
    embedded: string;
    pending: string;
    locations: number;
    paused: number;
    paused_until: Date | null;
    paused_reason: string | null;
  }>(
    `SELECT embedded::text, pending::text, locations, paused, paused_until, paused_reason
       FROM kept.embedding_status_instance()`,
  );
  const indexed = rows.reduce((n, r) => n + Number(r.embedded), 0);
  const pending = rows.reduce((n, r) => n + Number(r.pending), 0);
  return {
    source: source ?? (await storedSource(pools)),
    indexed,
    total: indexed + pending,
    paused: pausedOf(rows),
    local: { available: installed(), downloadBytes: null, downloadedBytes: null },
  };
}
