/**
 * AI constants shared by the server's provider layer and the AI settings UI (D19, D83, D121,
 * D167, D191; lessons L42, L43, L49, L63; plan Q5–Q7). Pure data and arithmetic: no SDK here.
 */

/** The providers Kept talks to. `openrouter` and `groq` have their own kinds (D202): each has
 * its own SDK package, model listing, pacing headers and key prefix, which a generic
 * OpenAI-compatible base URL would hide. */
export const PROVIDER_KINDS = [
  'openai',
  'anthropic',
  'google',
  'openai_compatible',
  'openrouter',
  'groq',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** What a provider is used for; each has its own model (D19). */
export const AI_TASKS = ['extraction', 'assistant', 'embeddings'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** The per-provider reasoning setting (Q6). `none` is offered; `low` is the default. */
export const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export const DEFAULT_REASONING: ReasoningLevel = 'low';

/**
 * Key prefixes, most specific first (D202): `sk-ant-` and `sk-or-` are also `sk-` prefixes, so
 * OpenAI's bare `sk-` comes last. The OpenRouter (`sk-or-`) and Groq (`gsk_`) prefixes are the
 * ones seen on real keys in the spike (docs/spikes/2026-09-26-step3-ai-sdk.md §6); neither
 * provider's API reference states them, so a key that doesn't match is simply not preselected.
 */
const KEY_PREFIXES: readonly (readonly [string, ProviderKind])[] = [
  ['sk-ant-', 'anthropic'],
  ['sk-or-', 'openrouter'],
  ['gsk_', 'groq'],
  ['AIza', 'google'],
  ['sk-', 'openai'],
];

/**
 * The provider a pasted key belongs to, from its prefix, so "Paste your key → Test" can
 * preselect it (D191). Null when the prefix is not one of these; the person picks.
 */
export function detectKind(apiKey: string): ProviderKind | null {
  const key = apiKey.trim();
  for (const [prefix, kind] of KEY_PREFIXES) if (key.startsWith(prefix)) return kind;
  return null;
}

export type DefaultModels = {
  /** The day these were read from the providers' docs. */
  readonly asOf: string;
  readonly models: Readonly<Record<AiTask, string | null>>;
  /**
   * The tasks whose default no Kept call has exercised yet, so AI settings can say "untested"
   * (D206). Only Groq's extraction model was called (spike 2026-09-26); OpenRouter's key had no
   * credit, and OpenAI, Anthropic and Google had no keys.
   */
  readonly untested: readonly AiTask[];
};

/**
 * Suggested models per provider and task, read from each provider's own model docs on
 * 2026-09-26 (developers.openai.com/api/docs/models and /models/all; platform.claude.com
 * models overview; ai.google.dev/gemini-api/docs/models). Model lists go stale: these are
 * only the prefilled suggestion, and an admin can type any model name (L49). Anthropic offers
 * no embeddings model; an OpenAI-compatible server (Ollama, LM Studio, OpenRouter) has no
 * default, so its admin names the model.
 *
 * - openai: `gpt-6-luna` is the docs' "most efficient model for focused, high-volume tasks";
 *   `gpt-6-sol` balances capability and cost for the assistant.
 * - anthropic: `claude-sonnet-5` ("the best combination of speed and intelligence").
 *   `claude-haiku-4-5` is cheaper but is due to retire no sooner than 2026-10-15, weeks away.
 * - google: `gemini-3.8-flash`, which the docs recommend for new projects;
 *   `gemini-embedding-001` is the stable embeddings model.
 * - groq (D202; from Groq's model listing, docs/spikes/2026-09-26-step3-ai-sdk.md §7):
 *   `qwen/qwen3.8-27b` is its only vision model and passed structured output with an image;
 *   `openai/gpt-oss-120b` for the assistant. Groq lists no embeddings model.
 * - openrouter (D202, same source): `openai/gpt-6-luna`, the cheapest current major with
 *   structured outputs in its listing. Provisional: the spike's key had no credit, so no
 *   OpenRouter chat call has run yet. OpenRouter lists no embeddings model.
 */
export const DEFAULT_MODELS: Readonly<Record<ProviderKind, DefaultModels>> = Object.freeze({
  openai: {
    asOf: '2026-09-26',
    untested: ['extraction', 'assistant', 'embeddings'],
    models: {
      extraction: 'gpt-6-luna',
      assistant: 'gpt-6-sol',
      embeddings: 'text-embedding-3-small',
    },
  },
  anthropic: {
    asOf: '2026-09-26',
    untested: ['extraction', 'assistant'],
    models: { extraction: 'claude-sonnet-5', assistant: 'claude-sonnet-5', embeddings: null },
  },
  google: {
    asOf: '2026-09-26',
    untested: ['extraction', 'assistant', 'embeddings'],
    models: {
      extraction: 'gemini-3.8-flash',
      assistant: 'gemini-3.8-flash',
      embeddings: 'gemini-embedding-001',
    },
  },
  openai_compatible: {
    asOf: '2026-09-26',
    untested: [],
    models: { extraction: null, assistant: null, embeddings: null },
  },
  openrouter: {
    asOf: '2026-09-26',
    untested: ['extraction', 'assistant'],
    models: {
      extraction: 'openai/gpt-6-luna',
      assistant: 'openai/gpt-6-luna',
      embeddings: null,
    },
  },
  groq: {
    asOf: '2026-09-26',
    untested: ['assistant'],
    models: {
      extraction: 'qwen/qwen3.8-27b',
      assistant: 'openai/gpt-oss-120b',
      embeddings: null,
    },
  },
});

export type AiBudget = {
  readonly tokensPerMinute: number;
  readonly tokensPerDay: number;
  readonly tokensPerMonth: number;
  /** No money cap until an admin sets one (Q7, D167). */
  readonly moneyPerMonth: null;
  /** Concurrent jobs per paying account (§3.2). */
  readonly concurrency: number;
};

/** The budget that applies when no row exists, per paying account (Q7, D19). */
export const DEFAULT_BUDGETS: Readonly<{ extraction: AiBudget }> = Object.freeze({
  extraction: {
    tokensPerMinute: 60_000,
    tokensPerDay: 2_000_000,
    tokensPerMonth: 20_000_000,
    moneyPerMonth: null,
    concurrency: 2,
  },
});

/**
 * The i18n key of each provider's "what happens to what you send" note in settings (D83, L63).
 * The text lives in the web's catalogue; a key per kind keeps the server from shipping copy.
 */
export const DATA_USE_NOTE_KEYS: Readonly<Record<ProviderKind, string>> = Object.freeze({
  openai: 'ai.data_use.openai',
  anthropic: 'ai.data_use.anthropic',
  google: 'ai.data_use.google',
  openai_compatible: 'ai.data_use.openai_compatible',
  openrouter: 'ai.data_use.openrouter',
  groq: 'ai.data_use.groq',
});

/**
 * Text tokens, estimated high for pacing (L43): one token per 2.4 UTF-16 code units, for every
 * language. Arabic runs denser than English per character, so one ratio errs on the safe side
 * for both. The settlement after the call uses the provider's real usage.
 */
export function estimateTextTokens(s: string): number {
  return Math.ceil(s.length / 2.4);
}

function assertSize(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new RangeError(`image size must be positive integers, got ${w}×${h}`);
  }
}

/**
 * Claude, high-resolution tier (Claude 4.7 and later, which includes every current default):
 * 28×28 px patches, a 2576 px long edge and at most 4784 visual tokens. Downscaling keeps the
 * aspect ratio. The standard tier (1568 px, 1568 tokens) always costs less, so this is the
 * upper bound for both.
 */
function anthropicTokens(w: number, h: number): number {
  const scale = Math.min(1, 2576 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  return Math.min(4784, Math.ceil(sw / 28) * Math.ceil(sh / 28));
}

/**
 * OpenAI's patch method at `detail: 'high'`: 32×32 px patches, a 2,500-patch budget, and the
 * 1.2 multiplier the docs give every current GPT-5.2+ and GPT-6 model they list. The
 * extraction call must send `detail: 'high'`: `auto` means `original` on the newest models,
 * with no patch budget. `gpt-6-luna` is not in the docs' multiplier table; 1.2 is inferred from
 * its siblings, and the settlement corrects the reservation either way.
 */
function openaiTokens(w: number, h: number): number {
  const budget = 2500;
  let patches = Math.ceil(w / 32) * Math.ceil(h / 32);
  if (patches > budget) {
    const shrink = Math.sqrt((32 * 32 * budget) / (w * h));
    const adjusted =
      shrink *
      Math.min(
        Math.floor((w * shrink) / 32) / ((w * shrink) / 32),
        Math.floor((h * shrink) / 32) / ((h * shrink) / 32),
      );
    patches = Math.ceil(Math.floor(w * adjusted) / 32) * Math.ceil(Math.floor(h * adjusted) / 32);
  }
  return Math.ceil(patches * 1.2);
}

/**
 * Gemini: 258 tokens when both sides are ≤ 384 px; otherwise the crop unit is
 * floor(min side / 1.5) and each tile of it costs 258. Gemini 3's `media_resolution` caps the
 * tokens per image; its per-level numbers were not in the docs read, so this stays the
 * documented tile formula.
 */
function googleTokens(w: number, h: number): number {
  if (w <= 384 && h <= 384) return 258;
  const unit = Math.max(1, Math.floor(Math.min(w, h) / 1.5));
  return Math.ceil(w / unit) * Math.ceil(h / unit) * 258;
}

/** Groq: a flat 2048 tokens per image (its vision docs), which the spike's rate-limit headers
 * matched (docs/spikes/2026-09-26-step3-ai-sdk.md §4). */
const GROQ_IMAGE_TOKENS = 2048;

/**
 * Input tokens for one image of `w`×`h` pixels, as sent (L43: estimate high, settle on the
 * provider's reported usage). An OpenAI-compatible server's tokenizer is unknown, so it takes
 * the highest of the three documented formulas; OpenRouter routes to any model, so it takes the
 * highest of every figure here.
 */
export function estimateImageTokens(kind: ProviderKind, w: number, h: number): number {
  assertSize(w, h);
  switch (kind) {
    case 'anthropic':
      return anthropicTokens(w, h);
    case 'openai':
      return openaiTokens(w, h);
    case 'google':
      return googleTokens(w, h);
    case 'groq':
      return GROQ_IMAGE_TOKENS;
    case 'openai_compatible':
      return Math.max(anthropicTokens(w, h), openaiTokens(w, h), googleTokens(w, h));
    case 'openrouter':
      return Math.max(
        anthropicTokens(w, h),
        openaiTokens(w, h),
        googleTokens(w, h),
        GROQ_IMAGE_TOKENS,
      );
  }
}

// --- D206: the call ledger, the recommendation, caps -------------------------------------------

/**
 * The recommended default (D206): pasting a Groq key pre-selects it, and the model picker marks
 * it "Recommended". The cheapest reliable result measured (spike 2026-09-26, synthetic images);
 * the evaluation set re-checks it (V37).
 */
export const RECOMMENDED = Object.freeze({
  kind: 'groq',
  model: 'qwen/qwen3.8-27b',
  asOf: '2026-09-26',
} as const satisfies { kind: ProviderKind; model: string; asOf: string });

/**
 * The recommended model's price, as Groq's own model listing gave it on 2026-09-26: USD per
 * token 0.0000008 prompt, 0.000004 completion, 0.0000004 cached input
 * (docs/spikes/code/step3/server/models-groq-2026-09-26.json, `pricing`), per million tokens.
 * REFERENCE_FIGURES' costs were worked out from it (ai.test.ts checks they agree). Saved as a
 * `provider_listing` price, with the listing's date (the recording has the day only), when an
 * instance admin connects the recommended model and no price is set, so its cost shows from the
 * first call (the maintainer's iPhone showed "cost unknown" on every call, 2026-09-29). A fresh
 * listing's own price wins over it; the admin can change it in the price table.
 */
export const RECOMMENDED_PRICE = Object.freeze({
  kind: 'groq',
  model: 'qwen/qwen3.8-27b',
  inputPerMtok: '0.8',
  outputPerMtok: '4',
  cachedInputPerMtok: '0.4',
  currency: 'USD',
  listingFetchedAt: '2026-09-26T00:00:00.000Z',
} as const satisfies {
  kind: ProviderKind;
  model: string;
  inputPerMtok: string;
  outputPerMtok: string;
  cachedInputPerMtok: string;
  currency: string;
  listingFetchedAt: string;
});

/** `llm_calls.task` (engineering spec §7.15): what a call was for. */
export const LEDGER_TASKS = [
  'extract_thing',
  'extract_receipt',
  'extract_label',
  'extract_reading',
  'assistant_turn',
  'assistant_followup',
  'embed_thing',
  'embed_query',
  'connection_test',
  // Step 7 (D69, plan Q21): search aliases proposed for imported things, opt-in after an import.
  'enrich_aliases',
] as const;
export type LedgerTask = (typeof LEDGER_TASKS)[number];

/** `llm_calls.outcome` (D206, product design §8a). */
export const LEDGER_OUTCOMES = [
  'ok',
  'refused',
  'rate_limited',
  'over_budget',
  'provider_error',
  'timeout',
  'schema_invalid',
  'truncated',
] as const;
export type LedgerOutcome = (typeof LEDGER_OUTCOMES)[number];

/** `llm_calls.cost_source` (§7.15): where a call's cost came from. */
export const COST_SOURCES = [
  'provider',
  'price_table',
  'price_table_later',
  'unknown',
  'not_sent',
] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export type BudgetTask = AiTask | 'test';

/** The budget a ledger task counts against: `llm_calls.budget_task`, the generated column. */
export function budgetTaskOf(task: LedgerTask): BudgetTask {
  // Alias enrichment counts against the extraction budget and caps (step-7 plan Q21).
  if (task.startsWith('extract_') || task === 'enrich_aliases') return 'extraction';
  if (task.startsWith('assistant_')) return 'assistant';
  if (task.startsWith('embed_')) return 'embeddings';
  return 'test';
}

/**
 * Concurrent calls a key allows, by kind (§3.5): one at a time on Groq (spike 2026-09-26: an
 * 8,000 tokens-a-minute tier fits 2–3 photos a minute), two otherwise.
 */
export const KIND_CONCURRENCY: Readonly<Partial<Record<ProviderKind, number>>> = Object.freeze({
  groq: 1,
});
export function concurrencyOf(kind: ProviderKind): number {
  return KIND_CONCURRENCY[kind] ?? 2;
}

export type ReferenceFigure = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** USD, a canonical decimal string. */
  readonly cost: string;
};

/**
 * "What uses AI in Kept" before a scope has five calls of a task (D206, §3.5): one call's tokens
 * and cost as measured on Groq `qwen/qwen3.8-27b` on 2026-09-26, costed from Groq's listed prices
 * that day. Copied from docs/spikes/2026-09-26-step3-ai-sdk.md §2 (the first run of each case;
 * the THING row is the nameplate in THING mode), never estimated. Synthetic images: the
 * evaluation set (V1, V3) replaces them.
 */
export const REFERENCE_FIGURES = Object.freeze({
  asOf: '2026-09-26',
  basis: 'synthetic images',
  kind: 'groq',
  model: 'qwen/qwen3.8-27b',
  currency: 'USD',
  tasks: {
    extract_receipt: { inputTokens: 1917, outputTokens: 585, reasoningTokens: 257, cost: '0.0039' },
    extract_label: { inputTokens: 1904, outputTokens: 364, reasoningTokens: 253, cost: '0.0030' },
    extract_thing: { inputTokens: 1923, outputTokens: 376, reasoningTokens: 258, cost: '0.0030' },
    extract_reading: { inputTokens: 877, outputTokens: 194, reasoningTokens: 157, cost: '0.0015' },
    connection_test: { inputTokens: 1334, outputTokens: 10, reasoningTokens: 0, cost: '0.0011' },
  },
} as const satisfies {
  asOf: string;
  basis: string;
  kind: ProviderKind;
  model: string;
  currency: string;
  tasks: Partial<Record<LedgerTask, ReferenceFigure>>;
});

/** §3.5: the token cap suggested when the model has no price (about 1,200 photos at ~2.5k). */
export const SUGGESTED_TOKENS_PER_MONTH = 3_000_000;
const SUGGESTED_MIN_MONEY = 5;

export type SuggestedCap =
  | { monthlyCap: { amount: string; currency: string } }
  | { tokensPerMonth: number };

/**
 * The cap AI setup suggests (§3.5; no cap is set by default): in money, the larger of 5 and three
 * times the projected month, in the price's currency, rounded up to a whole unit; without a
 * price (`currency` null), 3,000,000 tokens a month. `projectedMonth` is a canonical decimal
 * string, or null when there is no history yet.
 */
export function suggestedCap(input: {
  projectedMonth: string | null;
  currency: string | null;
}): SuggestedCap {
  if (input.currency === null) return { tokensPerMonth: SUGGESTED_TOKENS_PER_MONTH };
  const projected = input.projectedMonth === null ? 0 : Number(input.projectedMonth);
  const amount = Math.ceil(
    Math.max(SUGGESTED_MIN_MONEY, 3 * (Number.isFinite(projected) ? projected : 0)),
  );
  return { monthlyCap: { amount: String(amount), currency: input.currency } };
}

/**
 * The assistant's output per model step (step-6 plan T8; spike S6.3 measured 36–85 output tokens a
 * step on Groq, so these over-reserve by design): `maxTokens` is the answer's allowance, sent with
 * the reasoning allowance on top (`REASONING_ALLOWANCE`, Q6 of step 3); the expected figures feed
 * the provider's output window (V36).
 */
export const ASSISTANT_OUTPUT = Object.freeze({
  maxTokens: 1200,
  expectedToolStep: 400,
  expectedAnswer: 800,
});

/** The most values one embeddings request carries (spike S6.4 finding 4: fits OpenAI's 2,048 and
 * Google's 100 per call, so `embedMany` never splits a batch). */
export const EMBED_BATCH_MAX = 64;
