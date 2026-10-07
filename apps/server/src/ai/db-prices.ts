/**
 * The DB-backed price lookup for callModel (call.ts `PriceLookup`; step-3 T6): the
 * `ai_model_prices` version in effect at `at` for a provider kind and model, read through the
 * table's policy (every signed-in request reads it). No version: null, and the call's cost is
 * "unknown" (Q8), never guessed.
 */
import type { ProviderKind } from '@kept/shared';
import type { PriceLookup } from './call.js';
import type { Price } from './cost.js';
import type { DoorRunner } from './db-run.js';

type PriceRow = {
  id: string;
  input_per_mtok: string;
  output_per_mtok: string;
  reasoning_per_mtok: string | null;
  cached_input_per_mtok: string | null;
  per_image: string | null;
  currency: string;
};

/** Drops the trailing zeros numeric(16,6) reads back with (`0.200000` → `0.2`). */
const trim = (v: string) => v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const trimOrNull = (v: string | null) => (v === null ? null : trim(v));

export function dbPriceLookup(run: DoorRunner): PriceLookup {
  return (kind: ProviderKind, model: string, at: Date): Promise<Price | null> =>
    run(async (client) => {
      const { rows } = await client.query<PriceRow>(
        `SELECT id, input_per_mtok, output_per_mtok, reasoning_per_mtok, cached_input_per_mtok,
                per_image, currency
           FROM public.ai_model_prices
          WHERE provider_kind = $1 AND model = $2 AND effective_from <= $3
            AND (superseded_at IS NULL OR superseded_at > $3)
          ORDER BY version DESC LIMIT 1`,
        [kind, model, at],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        inputPerMtok: trim(r.input_per_mtok),
        outputPerMtok: trim(r.output_per_mtok),
        reasoningPerMtok: trimOrNull(r.reasoning_per_mtok),
        cachedInputPerMtok: trimOrNull(r.cached_input_per_mtok),
        perImage: trimOrNull(r.per_image),
        currency: r.currency.trim(),
      };
    });
}
