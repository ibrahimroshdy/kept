/**
 * The versioned price table (plan T9; D167, D206; engineering spec §7.15 "Prices"): read by
 * everyone signed in, written by instance admins through `kept.ai_price_set` /
 * `ai_price_remove` / `ai_recost_unknown`. Nothing is seeded (Q8), but the recommended model is
 * priced from Groq's listing when an instance admin connects it (api.ts priceRecommended). A
 * prefill proposes rows from a provider's cached model listing (Groq and OpenRouter list USD per
 * token; × 1,000,000; `-1`, a router's "varies", skipped) and saves nothing: the admin confirms
 * them.
 */
import { PROVIDER_KINDS } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { amount, Currency, Decimal } from './api-kit.js';
import type { ProviderRow } from './settings.js';

export const PriceSchema = z.object({
  providerKind: z.enum(PROVIDER_KINDS),
  model: z.string(),
  version: z.number(),
  rates: z.object({
    inputPerMtok: z.string(),
    outputPerMtok: z.string(),
    reasoningPerMtok: z.string().nullable(),
    cachedInputPerMtok: z.string().nullable(),
    perImage: z.string().nullable(),
  }),
  currency: z.string(),
  effectiveFrom: z.string(),
  supersededAt: z.string().nullable(),
  source: z.enum(['admin', 'provider_listing']),
  listingFetchedAt: z.string().nullable(),
});
export type PriceView = z.infer<typeof PriceSchema>;

/** POST /api/v1/admin/ai/prices. `listingFetchedAt` comes with a prefilled row (the listing's
 * date), which is then saved as `provider_listing`. */
export const PutPriceBody = z.object({
  providerKind: z.enum(PROVIDER_KINDS),
  model: z.string().trim().min(1).max(120),
  inputPerMtok: Decimal,
  outputPerMtok: Decimal,
  reasoningPerMtok: Decimal.optional(),
  cachedInputPerMtok: Decimal.optional(),
  perImage: Decimal.optional(),
  currency: Currency,
  listingFetchedAt: z.iso.datetime({ offset: true }).optional(),
});
export type PutPriceBody = z.infer<typeof PutPriceBody>;

export const PrefillRow = z.object({
  providerKind: z.enum(PROVIDER_KINDS),
  model: z.string(),
  inputPerMtok: z.string(),
  outputPerMtok: z.string(),
  cachedInputPerMtok: z.string().optional(),
  currency: z.string(),
  listingFetchedAt: z.string(),
});

type PriceRow = {
  id: string;
  provider_kind: PriceView['providerKind'];
  model: string;
  version: number;
  input_per_mtok: string;
  output_per_mtok: string;
  reasoning_per_mtok: string | null;
  cached_input_per_mtok: string | null;
  per_image: string | null;
  currency: string;
  effective_from: Date;
  superseded_at: Date | null;
  source: PriceView['source'];
  listing_fetched_at: Date | null;
};

const view = (r: PriceRow): PriceView => ({
  providerKind: r.provider_kind,
  model: r.model,
  version: r.version,
  rates: {
    inputPerMtok: amount(r.input_per_mtok) ?? '0',
    outputPerMtok: amount(r.output_per_mtok) ?? '0',
    reasoningPerMtok: amount(r.reasoning_per_mtok),
    cachedInputPerMtok: amount(r.cached_input_per_mtok),
    perImage: amount(r.per_image),
  },
  currency: r.currency.trim(),
  effectiveFrom: r.effective_from.toISOString(),
  supersededAt: r.superseded_at?.toISOString() ?? null,
  source: r.source,
  listingFetchedAt: r.listing_fetched_at?.toISOString() ?? null,
});

const PRICE_COLUMNS = `id, provider_kind, model, version, input_per_mtok, output_per_mtok,
  reasoning_per_mtok, cached_input_per_mtok, per_image, currency, effective_from, superseded_at,
  source, listing_fetched_at`;

/** The current versions, or every version with `history`. */
export async function listPrices(client: pg.ClientBase, history: boolean): Promise<PriceView[]> {
  const { rows } = await client.query<PriceRow>(
    `SELECT ${PRICE_COLUMNS} FROM public.ai_model_prices
      ${history ? '' : 'WHERE superseded_at IS NULL'}
      ORDER BY provider_kind, model, version DESC`,
  );
  return rows.map(view);
}

export async function priceById(client: pg.ClientBase, id: string): Promise<PriceView> {
  const { rows } = await client.query<PriceRow>(
    `SELECT ${PRICE_COLUMNS} FROM public.ai_model_prices WHERE id = $1`,
    [id],
  );
  return view(rows[0] as PriceRow);
}

/** The current price of a model, or null ("cost unknown"). */
export async function currentPrice(
  client: pg.ClientBase,
  kind: string,
  model: string,
): Promise<{ id: string; currency: string; version: number } | null> {
  const { rows } = await client.query<{ id: string; currency: string; version: number }>(
    `SELECT id, currency, version FROM public.ai_model_prices
      WHERE provider_kind = $1 AND model = $2 AND superseded_at IS NULL`,
    [kind, model],
  );
  const r = rows[0];
  return r ? { ...r, currency: r.currency.trim() } : null;
}

/** USD per token from a listing, per million tokens, as a decimal string; null for none or `-1`. */
export function perMillion(perToken: string | null | undefined): string | null {
  if (perToken === null || perToken === undefined || perToken.trim() === '') return null;
  const n = Number(perToken);
  if (!Number.isFinite(n) || n < 0) return null;
  if (/e/i.test(perToken)) return amount((n * 1e6).toFixed(6));
  // Scale in decimal, not binary: shift the point six places.
  const [int = '0', frac = ''] = perToken.trim().replace(/^\+/, '').split('.');
  const digits = `${int}${frac.padEnd(6, '0')}`;
  const whole = digits.slice(0, int.length + 6).replace(/^0+(?=\d)/, '') || '0';
  const rest = digits.slice(int.length + 6).replace(/0+$/, '');
  return rest ? `${whole}.${rest}` : whole;
}

/** Proposed rows for a provider's chosen models, from its cached listing's prices. */
export function prefillRows(p: ProviderRow): z.infer<typeof PrefillRow>[] {
  if (!p.model_list || !p.model_list_at) return [];
  const chosen = new Set(Object.values(p.models).filter((m): m is string => !!m));
  const out: z.infer<typeof PrefillRow>[] = [];
  for (const m of p.model_list) {
    if (!chosen.has(m.id) || !m.pricing) continue;
    const input = perMillion(m.pricing.prompt);
    const output = perMillion(m.pricing.completion);
    if (input === null || output === null) continue;
    const cached = perMillion(m.pricing.cachedInput);
    out.push({
      providerKind: p.kind,
      model: m.id,
      inputPerMtok: input,
      outputPerMtok: output,
      ...(cached !== null ? { cachedInputPerMtok: cached } : {}),
      currency: 'USD',
      listingFetchedAt: new Date(p.model_list_at).toISOString(),
    });
  }
  return out;
}
