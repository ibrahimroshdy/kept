import { COST_SOURCES, LEDGER_OUTCOMES, LEDGER_TASKS, PROVIDER_KINDS } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id, mutable, textEnum, tstz } from './common.js';
import { currencies } from './currencies.js';
import { locations, ownerAccounts } from './tenancy.js';

// AI providers, caps and budgets, pacing and the call ledger (step-3 plan T6; engineering spec
// §1.8, §3.3, §3.5, §7.13, §7.15; D19, D121, D167, D202, D206; plan Q5–Q8, Q31). Row-level
// security, the partitions, the column privileges and every `kept.ai_*` door are in the custom
// migration that follows (0040); see src/db/ai.test.ts and src/ai/db-*.ts.

export const PAYER_SCOPES = ['instance', 'account', 'user'] as const;
export const AI_REASONING = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
] as const;
export const BUDGET_SCOPES = [
  'instance',
  'instance_account',
  'account',
  'location',
  'member',
  'user',
] as const;
export const BUDGET_TASKS = ['extraction', 'assistant', 'embeddings'] as const;
export const PAUSE_REASONS = ['manual', 'cap_money', 'cap_tokens', 'tokens_day'] as const;
export const BREAKER_REASONS = ['rate_limited', 'quota', 'auth', 'provider_down'] as const;

const providerScope = textEnum('scope', PAYER_SCOPES);
const providerKind = textEnum('kind', PROVIDER_KINDS);

/**
 * An AI provider and its key (D15, D121, D202, D206): at the instance, an owner account or a
 * person; never a location. The key is write-only: kept_app may INSERT and UPDATE
 * `key_ciphertext` but holds no SELECT on it (column privileges, 0040); only
 * `kept.ai_provider_for` / `kept.ai_provider_secret` hand it to ai/db-keys.ts.
 */
export const aiProviders = pgTable(
  'ai_providers',
  {
    id: id(),
    scope: providerScope.col().notNull(),
    ownerAccountId: uuid('owner_account_id').references(() => ownerAccounts.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    kind: providerKind.col().notNull(),
    /** The provider's model listing, cached by T9 (D202). */
    modelList: jsonb('model_list'),
    modelListAt: tstz('model_list_at'),
    label: text('label'),
    baseUrl: text('base_url'),
    /** An envelope (crypto/envelope.ts `Sealed`), AAD `ai_providers|<id>|api_key`. */
    keyCiphertext: jsonb('key_ciphertext'),
    keyVersion: integer('key_version'),
    keyHint: text('key_hint'),
    /** `{vision, chat, embeddings}`: the model per task (D19). */
    models: jsonb('models').notNull().default(sql`'{}'::jsonb`),
    /** `{vision, structured, testedAt, model}` from "Test connection" (T9). */
    capabilities: jsonb('capabilities').notNull().default(sql`'{}'::jsonb`),
    reasoning: text('reasoning').notNull().default('low'),
    disabledAt: tstz('disabled_at'),
    createdBy: uuid('created_by').notNull(),
    ...mutable(),
  },
  (t) => [
    providerScope.check('ai_providers'),
    providerKind.check('ai_providers'),
    check(
      'ai_providers_reasoning_chk',
      sql`reasoning IN ('provider-default', 'none', 'minimal', 'low', 'medium', 'high')`,
    ),
    check('ai_providers_label_chk', sql`char_length(label) <= 60`),
    check(
      'ai_providers_base_url_chk',
      sql`base_url IS NULL OR (base_url ~ '^https?://' AND char_length(base_url) <= 300)`,
    ),
    check('ai_providers_key_hint_chk', sql`key_hint ~ '^[A-Za-z0-9_-]{0,4}$'`),
    check('ai_providers_models_chk', sql`jsonb_typeof(models) = 'object'`),
    check('ai_providers_capabilities_chk', sql`jsonb_typeof(capabilities) = 'object'`),
    check(
      'ai_providers_scope_ids_chk',
      sql`CASE scope WHEN 'instance' THEN owner_account_id IS NULL AND user_id IS NULL
                     WHEN 'account' THEN owner_account_id IS NOT NULL AND user_id IS NULL
                     ELSE user_id IS NOT NULL AND owner_account_id IS NULL END`,
    ),
    check('ai_providers_key_pair_chk', sql`(key_ciphertext IS NULL) = (key_version IS NULL)`),
    check('ai_providers_compatible_chk', sql`kind <> 'openai_compatible' OR base_url IS NOT NULL`),
    check(
      'ai_providers_keyed_chk',
      sql`kind = 'openai_compatible' OR key_ciphertext IS NOT NULL OR disabled_at IS NOT NULL`,
    ),
    // One active provider per scope and owner.
    uniqueIndex('ai_providers_active_uq')
      .on(
        t.scope,
        sql`coalesce(owner_account_id, user_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`disabled_at IS NULL`),
    index('ai_providers_account_idx').on(t.ownerAccountId),
    index('ai_providers_user_idx').on(t.userId),
  ],
);

const budgetScope = textEnum('scope', BUDGET_SCOPES);
const budgetTask = textEnum('task', BUDGET_TASKS);
const pauseReason = textEnum('paused_reason', PAUSE_REASONS);

/** The per-task budgets (D19) and the monthly caps (D167, D206) in one table (§7.15). The pause
 * and the warnings change only through the `kept.ai_*` doors. */
export const aiBudgets = pgTable(
  'ai_budgets',
  {
    id: id(),
    scope: budgetScope.col().notNull(),
    ownerAccountId: uuid('owner_account_id').references(() => ownerAccounts.id, {
      onDelete: 'cascade',
    }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    task: budgetTask.col(),
    tokensPerMinute: integer('tokens_per_minute'),
    tokensPerDay: integer('tokens_per_day'),
    tokensPerMonth: bigint('tokens_per_month', { mode: 'number' }),
    monthlyCapAmount: numeric('monthly_cap_amount', { precision: 16, scale: 4 }),
    capCurrency: char('cap_currency', { length: 3 }).references(() => currencies.code),
    pausedUntil: tstz('paused_until'),
    pausedReason: pauseReason.col(),
    warned80Month: date('warned_80_month'),
    warned100Month: date('warned_100_month'),
    setBy: uuid('set_by').notNull(),
    ...mutable(),
  },
  (t) => [
    budgetScope.check('ai_budgets'),
    budgetTask.check('ai_budgets'),
    pauseReason.check('ai_budgets'),
    check('ai_budgets_tpm_chk', sql`tokens_per_minute > 0`),
    check('ai_budgets_tpd_chk', sql`tokens_per_day > 0`),
    check('ai_budgets_month_tokens_chk', sql`tokens_per_month > 0`),
    check('ai_budgets_money_chk', sql`monthly_cap_amount >= 0`),
    check('ai_budgets_money_pair_chk', sql`(monthly_cap_amount IS NULL) = (cap_currency IS NULL)`),
    check('ai_budgets_pause_pair_chk', sql`(paused_until IS NULL) = (paused_reason IS NULL)`),
    check(
      'ai_budgets_scope_ids_chk',
      sql`CASE scope
            WHEN 'instance' THEN owner_account_id IS NULL AND location_id IS NULL AND user_id IS NULL
            WHEN 'instance_account' THEN location_id IS NULL AND user_id IS NULL
            WHEN 'account' THEN owner_account_id IS NOT NULL AND location_id IS NULL AND user_id IS NULL
            WHEN 'location' THEN owner_account_id IS NOT NULL AND location_id IS NOT NULL AND user_id IS NULL
            WHEN 'member' THEN owner_account_id IS NOT NULL AND location_id IS NULL AND user_id IS NOT NULL
            ELSE owner_account_id IS NULL AND location_id IS NULL AND user_id IS NOT NULL END`,
    ),
    check(
      'ai_budgets_minute_day_chk',
      sql`(tokens_per_minute IS NULL AND tokens_per_day IS NULL)
          OR (scope IN ('instance', 'account') AND task IS NOT NULL)`,
    ),
    unique('ai_budgets_scope_uq')
      .on(t.scope, t.ownerAccountId, t.locationId, t.userId, t.task)
      .nullsNotDistinct(),
    index('ai_budgets_account_idx').on(t.ownerAccountId),
    index('ai_budgets_location_idx').on(t.locationId),
    index('ai_budgets_user_idx').on(t.userId),
    index('ai_budgets_paused_idx').on(t.pausedUntil).where(sql`paused_until IS NOT NULL`),
  ],
);

// --- Counters: definer-only (RLS forced, owner_all only, no grants) ---------------------------

export const WINDOW_KINDS = ['minute', 'day', 'month'] as const;
const windowKind = textEnum('window_kind', WINDOW_KINDS);

/** Tokens and calls per bucket (§7.15's bucket strings) and window. */
export const aiUsageWindows = pgTable(
  'ai_usage_windows',
  {
    bucket: text('bucket').notNull(),
    windowKind: windowKind.col().notNull(),
    windowStart: tstz('window_start').notNull(),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    calls: integer('calls').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'ai_usage_windows_pk', columns: [t.bucket, t.windowKind, t.windowStart] }),
    windowKind.check('ai_usage_windows'),
    index('ai_usage_windows_start_idx').on(t.windowKind, t.windowStart),
  ],
);

/** Money per bucket, month and currency; never converted here. */
export const aiCostWindows = pgTable(
  'ai_cost_windows',
  {
    bucket: text('bucket').notNull(),
    monthStart: date('month_start').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amount: numeric('amount', { precision: 16, scale: 6 }).notNull().default('0'),
  },
  (t) => [
    primaryKey({ name: 'ai_cost_windows_pk', columns: [t.bucket, t.monthStart, t.currency] }),
  ],
);

/** Concurrency slots: `payer:<scope>:<id>` (2) and `key:<provider_id>` (the kind's, §3.5). */
export const aiLeases = pgTable(
  'ai_leases',
  {
    leaseKey: text('lease_key').notNull(),
    slot: smallint('slot').notNull(),
    jobId: text('job_id').notNull(),
    leaseUntil: tstz('lease_until').notNull(),
  },
  (t) => [
    primaryKey({ name: 'ai_leases_pk', columns: [t.leaseKey, t.slot] }),
    check('ai_leases_slot_chk', sql`slot BETWEEN 1 AND 4`),
  ],
);

const breakerReason = textEnum('reason', BREAKER_REASONS);

/** A key's circuit breaker (L45; ai/breaker.ts is the state machine, this its store). */
export const aiBreakers = pgTable(
  'ai_breakers',
  {
    providerId: uuid('provider_id')
      .primaryKey()
      .references(() => aiProviders.id, { onDelete: 'cascade' }),
    reason: breakerReason.col(),
    until: timestamp('until', { withTimezone: true }),
    trips: integer('trips').notNull().default(0),
    recentErrors: timestamp('recent_errors', { withTimezone: true })
      .array()
      .notNull()
      .default(sql`'{}'::timestamptz[]`),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  () => [
    breakerReason.check('ai_breakers'),
    check('ai_breakers_trip_pair_chk', sql`(reason IS NULL) = (until IS NULL)`),
    check('ai_breakers_trips_chk', sql`trips >= 0`),
  ],
);

/** The provider's own rate-limit window, from its headers after each call (pacing.ts). */
export const aiProviderLimits = pgTable('ai_provider_limits', {
  providerId: uuid('provider_id')
    .primaryKey()
    .references(() => aiProviders.id, { onDelete: 'cascade' }),
  limitTokens: integer('limit_tokens'),
  remainingTokens: integer('remaining_tokens'),
  resetAt: tstz('reset_at'),
  /** An output-token (OTPM) limit a provider's 429 named, and this minute's output against it
   * (ai/pacing.ts; step-3 T9, 0045). No provider reports it in a header. */
  outputLimitTokens: integer('output_limit_tokens'),
  outputUsed: integer('output_used').notNull().default(0),
  outputWindowStart: tstz('output_window_start'),
  updatedAt: tstz('updated_at').notNull(),
});

// --- Prices -----------------------------------------------------------------------------------

export const PRICE_SOURCES = ['admin', 'provider_listing'] as const;
const priceSource = textEnum('source', PRICE_SOURCES);

/** Versioned prices per provider kind and model (D167, D206): rows are added, never edited but
 * for `superseded_at`, and only through `kept.ai_price_set` / `kept.ai_price_remove`. Nothing
 * is seeded (Q8). */
export const aiModelPrices = pgTable(
  'ai_model_prices',
  {
    id: id(),
    providerKind: text('provider_kind').notNull(),
    model: text('model').notNull(),
    version: integer('version').notNull(),
    inputPerMtok: numeric('input_per_mtok', { precision: 16, scale: 6 }).notNull(),
    outputPerMtok: numeric('output_per_mtok', { precision: 16, scale: 6 }).notNull(),
    reasoningPerMtok: numeric('reasoning_per_mtok', { precision: 16, scale: 6 }),
    cachedInputPerMtok: numeric('cached_input_per_mtok', { precision: 16, scale: 6 }),
    perImage: numeric('per_image', { precision: 16, scale: 6 }),
    currency: char('currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    effectiveFrom: tstz('effective_from').notNull().defaultNow(),
    supersededAt: tstz('superseded_at'),
    source: priceSource.col().notNull(),
    listingFetchedAt: tstz('listing_fetched_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    priceSource.check('ai_model_prices'),
    check(
      'ai_model_prices_kind_chk',
      sql`provider_kind IN ('openai', 'anthropic', 'google', 'openai_compatible', 'openrouter', 'groq')`,
    ),
    check('ai_model_prices_model_chk', sql`char_length(model) BETWEEN 1 AND 120`),
    check('ai_model_prices_version_chk', sql`version >= 1`),
    check(
      'ai_model_prices_rates_chk',
      sql`input_per_mtok >= 0 AND output_per_mtok >= 0 AND reasoning_per_mtok >= 0
          AND cached_input_per_mtok >= 0 AND per_image >= 0`,
    ),
    check('ai_model_prices_listing_chk', sql`source = 'admin' OR listing_fetched_at IS NOT NULL`),
    check(
      'ai_model_prices_superseded_chk',
      sql`superseded_at IS NULL OR superseded_at >= effective_from`,
    ),
    unique('ai_model_prices_version_uq').on(t.providerKind, t.model, t.version),
    uniqueIndex('ai_model_prices_current_uq')
      .on(t.providerKind, t.model)
      .where(sql`superseded_at IS NULL`),
  ],
);

// --- The ledger -------------------------------------------------------------------------------

const ledgerTask = textEnum('task', LEDGER_TASKS);
const ledgerOutcome = textEnum('outcome', LEDGER_OUTCOMES);
const costSource = textEnum('cost_source', COST_SOURCES);
const payingScope = textEnum('paying_scope', PAYER_SCOPES);

/**
 * The AI call ledger (§7.15, D206, L47): one row per call attempt, Kept's held-back ones too.
 * Partitioned by RANGE (`at`), monthly (§7.13): the generated CREATE TABLE in 0039 was edited to
 * add `PARTITION BY RANGE ("at")`, hence `at` in the primary key; the partitions are made by
 * `kept.ensure_llm_partitions()`. Append-only (no row_version), no foreign keys (it outlives what
 * it describes), written only by `kept.ai_reserve` / `kept.ai_settle`. **Nothing here can hold a
 * prompt, an image, a reply, a provider message or a key.**
 */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').notNull().default(sql`uuidv7()`),
    at: tstz('at').notNull().default(sql`date_trunc('milliseconds', now())`),
    requestId: text('request_id').notNull(),
    attempt: smallint('attempt').notNull().default(1),
    task: ledgerTask.col().notNull(),
    budgetTask: text('budget_task').generatedAlwaysAs(
      sql`CASE WHEN task LIKE 'extract\\_%' OR task = 'enrich_aliases' THEN 'extraction'
               WHEN task LIKE 'assistant\\_%' THEN 'assistant'
               WHEN task LIKE 'embed\\_%' THEN 'embeddings' ELSE 'test' END`,
    ),
    locationId: uuid('location_id'),
    ownerAccountId: uuid('owner_account_id'),
    userId: uuid('user_id'),
    payingScope: payingScope.col().notNull(),
    payingAccountId: uuid('paying_account_id'),
    payingUserId: uuid('paying_user_id'),
    fellBack: boolean('fell_back').notNull().default(false),
    providerId: uuid('provider_id'),
    providerKind: text('provider_kind').notNull(),
    model: text('model').notNull(),
    reasoning: text('reasoning'),
    promptVersion: text('prompt_version'),
    sent: boolean('sent').notNull(),
    estimateTokens: integer('estimate_tokens'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    /** The provider reported no token counts (Google's embeddings, spike S6.4 finding 5):
     * `input_tokens` is Kept's estimate, and the cost is priced from it (0093). */
    usageEstimated: boolean('usage_estimated').notNull().default(false),
    imageCount: smallint('image_count').notNull().default(0),
    imageTokensEach: integer('image_tokens_each'),
    imageBytes: integer('image_bytes'),
    attachmentIds: uuid('attachment_ids').array(),
    latencyMs: integer('latency_ms'),
    finishReason: text('finish_reason'),
    outcome: ledgerOutcome.col().notNull(),
    errorCode: text('error_code'),
    httpStatus: smallint('http_status'),
    costAmount: numeric('cost_amount', { precision: 16, scale: 6 }),
    costCurrency: char('cost_currency', { length: 3 }),
    costSource: costSource.col().notNull(),
    priceId: uuid('price_id'),
    extractionId: uuid('extraction_id'),
    threadId: uuid('thread_id'),
    thingId: uuid('thing_id'),
    rlRemainingTokens: integer('rl_remaining_tokens'),
    rlResetAt: tstz('rl_reset_at'),
  },
  (t) => [
    primaryKey({ name: 'llm_calls_pk', columns: [t.id, t.at] }),
    ledgerTask.check('llm_calls'),
    ledgerOutcome.check('llm_calls'),
    costSource.check('llm_calls'),
    payingScope.check('llm_calls'),
    check('llm_calls_request_id_chk', sql`char_length(request_id) <= 64`),
    check('llm_calls_attempt_chk', sql`attempt BETWEEN 1 AND 20`),
    check('llm_calls_prompt_version_chk', sql`char_length(prompt_version) <= 20`),
    check('llm_calls_image_count_chk', sql`image_count >= 0`),
    check('llm_calls_finish_reason_chk', sql`char_length(finish_reason) <= 40`),
    check('llm_calls_error_code_chk', sql`error_code ~ '^[a-z0-9_]{1,40}$'`),
    check('llm_calls_cost_pair_chk', sql`(cost_amount IS NULL) = (cost_currency IS NULL)`),
    check(
      'llm_calls_not_sent_chk',
      sql`sent OR (input_tokens IS NULL AND output_tokens IS NULL AND cost_amount IS NULL)`,
    ),
    check('llm_calls_sent_source_chk', sql`sent = (cost_source <> 'not_sent')`),
    check(
      'llm_calls_price_chk',
      sql`cost_source NOT IN ('price_table', 'price_table_later') OR price_id IS NOT NULL`,
    ),
    check(
      'llm_calls_payer_chk',
      sql`CASE paying_scope
            WHEN 'instance' THEN paying_account_id IS NULL AND paying_user_id IS NULL
            WHEN 'account' THEN paying_account_id IS NOT NULL AND paying_user_id IS NULL
            ELSE paying_user_id IS NOT NULL AND paying_account_id IS NULL END`,
    ),
    index('llm_calls_user_idx').on(t.userId, t.at.desc()),
    index('llm_calls_location_idx').on(t.locationId, t.at.desc()),
    index('llm_calls_owner_idx').on(t.ownerAccountId, t.at.desc()),
    index('llm_calls_payer_idx').on(t.payingAccountId, t.at.desc()),
    index('llm_calls_instance_idx').on(t.at.desc()).where(sql`paying_scope = 'instance'`),
    index('llm_calls_thing_idx').on(t.thingId, t.at.desc()).where(sql`thing_id IS NOT NULL`),
    index('llm_calls_extraction_idx').on(t.extractionId).where(sql`extraction_id IS NOT NULL`),
  ],
);

/** Monthly totals kept 5 years (§3.3), written by `kept.ai_rollup_and_drop` before a ledger
 * partition goes; read through `kept.ai_usage` with the ledger's visibility. */
export const aiUsageMonths = pgTable(
  'ai_usage_months',
  {
    month: date('month').notNull(),
    payingScope: payingScope.col().notNull(),
    payingAccountId: uuid('paying_account_id'),
    payingUserId: uuid('paying_user_id'),
    locationId: uuid('location_id'),
    ownerAccountId: uuid('owner_account_id'),
    userId: uuid('user_id'),
    task: text('task').notNull(),
    providerKind: text('provider_kind').notNull(),
    model: text('model').notNull(),
    costCurrency: char('cost_currency', { length: 3 }),
    calls: integer('calls').notNull(),
    sentCalls: integer('sent_calls').notNull(),
    tokens: bigint('tokens', { mode: 'number' }).notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
    cachedTokens: bigint('cached_tokens', { mode: 'number' }).notNull().default(0),
    images: integer('images').notNull(),
    costAmount: numeric('cost_amount', { precision: 18, scale: 6 }),
    unknownCostCalls: integer('unknown_cost_calls').notNull(),
    outcomes: jsonb('outcomes').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    payingScope.check('ai_usage_months'),
    unique('ai_usage_months_uq')
      .on(
        t.month,
        t.payingScope,
        t.payingAccountId,
        t.payingUserId,
        t.locationId,
        t.userId,
        t.task,
        t.providerKind,
        t.model,
        t.costCurrency,
      )
      .nullsNotDistinct(),
    index('ai_usage_months_owner_idx').on(t.ownerAccountId, t.month),
    index('ai_usage_months_location_idx').on(t.locationId, t.month),
    index('ai_usage_months_user_idx').on(t.userId, t.month),
    index('ai_usage_months_payer_idx').on(t.payingAccountId, t.month),
  ],
);
