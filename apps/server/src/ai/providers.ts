/**
 * A language model object per provider kind (D202), and the call settings each kind needs.
 * Factory names and options were read from each installed package's `dist/index.d.ts`:
 * `createOpenAI`, `createAnthropic`, `createGoogle` (the plan's `createGoogleGenerativeAI` is
 * only an alias), `createOpenAICompatible`, `createGroq` and `createOpenRouter`.
 *
 * Always a model **object**: a plain string model id is a `GlobalProviderModelId`, which the
 * `ai` package routes to the Vercel AI Gateway (spike). `ModelObject` refuses strings.
 *
 * Per kind (spike 2026-09-26 §3):
 * - structured output is `json_schema` with **strict off** everywhere (the wire schema leaves
 *   optional fields out of `required`, which strict mode rejects). Never JSON mode: it drops the
 *   schema. An OpenAI-compatible server that says it has no structured outputs gets the schema
 *   written into the prompt instead (`schemaInPrompt`).
 * - OpenRouter ignores `generateText`'s `reasoning`: it goes on the model as
 *   `{reasoning: {effort}}`, with `usage: {include: true}` so each answer carries its cost.
 * - OpenAI image parts are sent with `imageDetail: 'high'` (the estimator's patch budget, shared
 *   `ai.ts`; `auto` means `original` on the newest models).
 *
 * Every factory gets an explicit `baseURL` and `apiKey`: left out, the packages read
 * `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY` and the like from the environment.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ProviderKind, ReasoningLevel } from '@kept/shared';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { EmbeddingModel, LanguageModel } from 'ai';

export type ModelObject = Exclude<LanguageModel, string>;
/** An embeddings model object (never a string id, for the same reason as `ModelObject`). */
export type EmbeddingModelObject = Exclude<EmbeddingModel, string>;
export type Reasoning = ReasoningLevel | 'provider-default';

/** The SDK packages' own default base URLs (read from each package's source), so the user never
 * types one for a named kind. */
export const DEFAULT_BASE_URLS: Readonly<
  Record<Exclude<ProviderKind, 'openai_compatible'>, string>
> = Object.freeze({
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
});

export function baseUrlFor(p: { kind: ProviderKind; baseUrl: string | null }): string {
  const url = p.baseUrl ?? (p.kind === 'openai_compatible' ? null : DEFAULT_BASE_URLS[p.kind]);
  if (!url) throw new Error('an openai_compatible provider needs a base URL');
  return url.replace(/\/+$/, '');
}

export type ModelTarget = {
  kind: ProviderKind;
  baseUrl: string | null;
  model: string;
  reasoning: Reasoning;
  /** `capabilities.structured` for `openai_compatible` (unknown → false). */
  structured?: boolean;
};

type Fetch = typeof fetch;

/** The model object for a resolved provider. The key lives only in the returned closure. */
export function modelFor(t: ModelTarget, apiKey: string | null, fetchFn: Fetch): ModelObject {
  const baseURL = baseUrlFor(t);
  const key = apiKey ?? undefined;
  switch (t.kind) {
    case 'openai':
      return createOpenAI({ apiKey: key, baseURL, fetch: fetchFn })(t.model);
    case 'anthropic':
      return createAnthropic({ apiKey: key, baseURL, fetch: fetchFn })(t.model);
    case 'google':
      return createGoogle({ apiKey: key, baseURL, fetch: fetchFn })(t.model);
    case 'groq':
      return createGroq({ apiKey: key, baseURL, fetch: fetchFn })(t.model);
    case 'openrouter':
      return createOpenRouter({ apiKey: key, baseURL, fetch: fetchFn, compatibility: 'strict' })(
        t.model,
        {
          usage: { include: true },
          structuredOutputs: { strict: false },
          ...(t.reasoning === 'provider-default' ? {} : { reasoning: { effort: t.reasoning } }),
        },
      );
    case 'openai_compatible':
      return createOpenAICompatible({
        name: 'custom',
        baseURL,
        apiKey: key,
        fetch: fetchFn,
        includeUsage: true,
        supportsStructuredOutputs: t.structured ?? false,
      })(t.model);
  }
}

/**
 * The embeddings model for a resolved provider (step-6 T8; spike S6.4), from each package's
 * `embeddingModel(id)` (read in its `dist/index.d.ts`). Anthropic, Groq and OpenRouter have no
 * embeddings model here: the cascade never resolves one for them (`DEFAULT_MODELS`), so asking is
 * a programming error.
 */
export function embeddingModelFor(
  t: Pick<ModelTarget, 'kind' | 'baseUrl' | 'model'>,
  apiKey: string | null,
  fetchFn: Fetch,
): EmbeddingModelObject {
  const baseURL = baseUrlFor(t);
  const key = apiKey ?? undefined;
  switch (t.kind) {
    case 'openai':
      return createOpenAI({ apiKey: key, baseURL, fetch: fetchFn }).embeddingModel(t.model);
    case 'google':
      return createGoogle({ apiKey: key, baseURL, fetch: fetchFn }).embeddingModel(t.model);
    case 'openai_compatible':
      return createOpenAICompatible({
        name: 'custom',
        baseURL,
        apiKey: key,
        fetch: fetchFn,
      }).embeddingModel(t.model);
    default:
      throw new Error(`embeddings: a ${t.kind} provider has no embeddings model in Kept`);
  }
}

/** The provider option that asks for shorter vectors (spike S6.4 finding 2), per kind. */
export function embeddingDimensionsOption(
  kind: ProviderKind,
  dims: number | undefined,
): Record<string, Record<string, number>> | undefined {
  if (dims === undefined) return undefined;
  if (kind === 'openai') return { openai: { dimensions: dims } };
  if (kind === 'google') return { google: { outputDimensionality: dims } };
  return undefined;
}

type ProviderOptions = Record<string, Record<string, string | boolean | number>>;

export type CallSettings = {
  /** `generateText`'s `reasoning`; left out where the provider ignores it (OpenRouter). */
  reasoning: Reasoning | undefined;
  providerOptions: ProviderOptions | undefined;
  /** Put on each image `file` part. */
  imagePartOptions: ProviderOptions | undefined;
  /** No structured outputs: the JSON Schema has to be in the instructions. */
  schemaInPrompt: boolean;
};

export function callSettingsFor(t: ModelTarget): CallSettings {
  const reasoning = t.kind === 'openrouter' ? undefined : t.reasoning;
  switch (t.kind) {
    case 'openai':
      return {
        reasoning,
        providerOptions: { openai: { strictJsonSchema: false } },
        imagePartOptions: { openai: { imageDetail: 'high' } },
        schemaInPrompt: false,
      };
    case 'groq':
      return {
        reasoning,
        providerOptions: { groq: { structuredOutputs: true, strictJsonSchema: false } },
        imagePartOptions: undefined,
        schemaInPrompt: false,
      };
    case 'openai_compatible':
      return {
        reasoning,
        providerOptions: { custom: { strictJsonSchema: false } },
        imagePartOptions: undefined,
        schemaInPrompt: !(t.structured ?? false),
      };
    default:
      return {
        reasoning,
        providerOptions: undefined,
        imagePartOptions: undefined,
        schemaInPrompt: false,
      };
  }
}
