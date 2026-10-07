---
title: AI providers
description: How the server talks to AI providers, how every call is paced, capped and recorded, and how to add a provider.
---

Kept uses AI for three tasks (`AI_TASKS` in `packages/shared/src/ai.ts`): **extraction** (reading a
capture photo), the **assistant** (chat with tool calls), and **embeddings** (semantic search). All
three go through one door in the server, so pacing, spend caps and the call ledger apply to every
call the same way. For the person-facing side, see [AI providers](/users/ai-providers/).

The design lives in the engineering spec
([§2.1 extraction output, §7.8 capture and extraction, §7.15 keys, usage and the ledger](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-engineering-spec.md))
and decisions D19, D121, D167, D202 and D206 in the
[product design](https://github.com/ibrahimroshdy/kept/blob/main/docs/specs/2026-09-25-kept-product-design.md).

## The SDK and the provider kinds

The server uses the [AI SDK](https://github.com/vercel/ai) (`ai` 7.x) with one provider package per
kind. `PROVIDER_KINDS` lists them:

| Kind | Package | Factory |
|---|---|---|
| `openai` | `@ai-sdk/openai` | `createOpenAI` |
| `anthropic` | `@ai-sdk/anthropic` | `createAnthropic` |
| `google` | `@ai-sdk/google` | `createGoogle` |
| `groq` | `@ai-sdk/groq` | `createGroq` |
| `openrouter` | `@openrouter/ai-sdk-provider` | `createOpenRouter` |
| `openai_compatible` | `@ai-sdk/openai-compatible` | `createOpenAICompatible` (any base URL, such as [Ollama](/admin/ollama/)) |

`apps/server/src/ai/providers.ts` turns a resolved provider into a model object (`modelFor`,
`embeddingModelFor`) and the call settings each kind needs (`callSettingsFor`). Two rules from the
[step-3 AI SDK spike](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-09-26-step3-ai-sdk.md):

- **Always a model object, never a string id.** A plain string is routed by the `ai` package to a
  hosted gateway. `ModelObject` refuses strings.
- **Every factory gets an explicit `baseURL` and `apiKey`.** Left out, the packages read
  `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL` and the like from the environment.

Structured output is `json_schema` with strict mode off everywhere. An `openai_compatible` server
that has no structured outputs gets the schema written into the prompt instead (`schemaInPrompt`).

## Where providers come from

Providers are rows in `ai_providers` (`apps/server/src/db/schema/ai.ts`), scoped `instance`,
`account` or `user`; there is no location scope. Each row holds the kind, an optional base URL,
a model per task (`{vision, chat, embeddings}`), a reasoning level, and the key sealed as an
envelope (`key_ciphertext`). People manage them in AI settings, through the routes in
`apps/server/src/ai/api.ts` (`/api/v1/ai/providers`, `/api/v1/ai/caps`, `/api/v1/ai/usage`,
`/api/v1/ai/calls`, and the admin price routes).

Which key pays is a cascade, run inside the database by `kept.ai_provider_for`, the only way
application code reaches a key; `apps/server/src/ai/resolve.ts` states the same order in TypeScript:

- a **Personal** location: its owner's user key, then their account key, then the instance key;
- any **other** location: its owner account's key, then the instance key;
- no location (a private thread): the asker's own key, then their account's, then the instance's.

Per task, the first scope with a model for that task wins: Groq has no embeddings model, so
embeddings fall through.

## One door: `callModel`

`apps/server/src/ai/call.ts` exports `callModel`, and **no other file may call the SDK's
generation functions**. `ai/no-direct-calls.test.ts` fails on any `generateText`, `streamText`,
`embed` or `embedMany` call elsewhere under `src/`. Each call:

1. checks images: JPEG, PNG or WebP with no EXIF;
2. is admitted by the pacer: the circuit breaker, the provider's own token window (from its
   rate-limit headers, `ai/pacing.ts`) and the key's concurrency (1 for Groq, 2 otherwise);
3. reserves its estimated cost against every budget bucket (`kept.ai_reserve`); a cap or a pause
   refuses with one `over_budget` ledger row;
4. runs `generateText` with `maxRetries: 0`, an output-token cap and an 80 s timeout, with no
   database transaction open;
5. maps the result to an outcome (`LEDGER_OUTCOMES`: `ok`, `refused`, `rate_limited`,
   `over_budget`, `provider_error`, `timeout`, `schema_invalid`, `truncated`);
6. settles: works out the cost (`ai/cost.ts`), writes one `llm_calls` row and releases its leases.

## The ledger and spend

`llm_calls` is append-only, partitioned by month, and written only by the `kept.ai_*` database
doors: the application roles have no INSERT policy on it, so a row can't be forged from
application code. A row records the task (`LEDGER_TASKS`, such as `extract_receipt`,
`assistant_turn`, `embed_query`), who paid, tokens, cost and outcome. **It never holds a prompt,
an image, a reply or a key.** Caps and budgets live in `ai_budgets`; reaching 80% and 100% of a
cap sends a notice, and 100% pauses work until the cap resets or is raised. Prices are versioned
rows in `ai_model_prices`. The full table definitions and the pause state machine are in §7.15.

## Extraction

A capture enqueues one `extract` job (`apps/server/src/extraction/job.ts`), which runs in the
capturing person's scope:

1. **claim** the extraction and mark it `running`, committed before any AI work;
2. **prepare** the parts (`extraction/image.ts`): GPS-free images re-encoded on the server, or a
   PDF receipt's text;
3. **call** `extract()` (`ai/extract.ts`) with the mode's prompt (`extraction/prompts/`: `thing`,
   `receipt`, `label`, `reading`, `service-invoice`) and wire schema (`ai/wire.ts`);
4. **parse leniently** against `EXTRACTION_SCHEMAS`: a field that doesn't parse is dropped, not
   the whole answer;
5. **check** in code (`extraction/checks.ts`): receipt lines reconcile with the total, readings
   against their meter, no future dates, VIN checksums; then apply and look for duplicates.

A cap pauses the extraction (`paused_budget`); a provider limit makes it `waiting_provider`
until the reset. Neither spends a retry. Fields below 0.6 confidence always wait for review.

## The assistant and tool calling

`apps/server/src/assistant/loop.ts` runs the loop itself. Every model step is one `callModel`:
one provider request, one reservation, one ledger row. The SDK is never allowed to loop: tools
carry no `execute`, and the stop condition is one step (proven in the
[tool-calling spike](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-09-30-step6-tool-calling.md)).

The tools are the MCP tool definitions (`TOOL_DEFS` from `@kept/mcp`), handled by
`apps/server/src/tools/registry.ts`. Read tools run at once as the person. **Write tools never
run**: each becomes a proposal card the person confirms. See [MCP](/developers/mcp/).

## Embeddings

The source is the instance setting `embeddings_source`, set at boot from `KEPT_EMBEDDINGS`
(`apps/server/src/embeddings/provider.ts`):

- `provider` (the default): each location's resolved embeddings model, through `embedValues` in
  `callModel`. A location with none is keyword-only.
- `off`: no embedding jobs; keyword search only.
- `local` (an on-server model) is **not built in 1.0**: the
  [local-embeddings spike](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-09-30-step6-local-embeddings.md)
  failed on memory, so the server refuses `KEPT_EMBEDDINGS=local`.

Vectors are stored with pgvector and searched with an exact cosine scan inside a database door;
the [embeddings spike](https://github.com/ibrahimroshdy/kept/blob/main/docs/spikes/2026-09-30-step6-embeddings.md)
measured HNSW as worse here.

## The mock provider

With `KEPT_AI_MOCK=1` every call answers from `apps/server/src/ai/mock.ts`, built on the SDK's
`MockLanguageModelV4` and `MockEmbeddingModelV4`. Tests, the e2e run and the evaluation runs in CI
use it; the server refuses it when `NODE_ENV=production`. It answers:

- by the SHA-256 of the first image, from `test/fixtures/eval/mock-answers.json`;
- otherwise with a schema-valid answer for the mode;
- for the assistant, from a script per question (`ai/mock-script.ts`,
  `test/fixtures/assistant/cases.json`).

An answer can act out failures: a `length` stop, invalid JSON, a 429 with `retry-after`, a 401, a
timeout. Real-provider tests in `ai/real-providers.test.ts` are skipped unless `KEPT_AI_SMOKE=1`.

## Evaluations

Three harnesses under `apps/server/eval/`, run from the repo root:

```sh
pnpm eval:extraction --dir apps/server/test/fixtures/eval   # the mock, no network
pnpm eval:assistant
pnpm eval:search
```

Each uses the mock unless `--provider` and `--model` are given. A real run reads its key only from
`KEPT_EVAL_API_KEY`, never prints it, and stops before `--max-calls` or `--max-cost`. Reports go to
[`docs/evals/`](https://github.com/ibrahimroshdy/kept/tree/main/docs/evals) with numbers and case
ids only. The harness README is
[`apps/server/eval/README.md`](https://github.com/ibrahimroshdy/kept/blob/main/apps/server/eval/README.md).

## Adding a provider kind

1. Add the kind to `PROVIDER_KINDS` in `packages/shared/src/ai.ts`, with its key prefix (if it has
   one) in `KEY_PREFIXES`, its `DEFAULT_MODELS` entry and its `DATA_USE_NOTE_KEYS` entry.
2. `ai_providers.kind` is checked against `PROVIDER_KINDS`, so the change needs a
   [migration](/developers/migrations/) for the check constraint.
3. In `apps/server/src/ai/providers.ts`: a default base URL, a case in `modelFor`,
   `callSettingsFor` and, if it has embeddings, `embeddingModelFor`.
4. Its model listing in `ai/models.ts` and its rate-limit headers in `ai/pacing.ts` (a provider
   without such headers is paced by Kept's budgets and the breaker only).
5. The web labels in `apps/web/src/components/ai/` and strings in all five catalogues
   ([i18n](/developers/i18n-rtl/)).
6. Mock-backed tests for the new paths; a real smoke run is the maintainer's step.
