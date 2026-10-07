/**
 * The provider's model list (D202): what the settings' picker offers, split into models that
 * can read a photo (capture and extraction) and text models (the assistant). Capabilities come
 * from the listing's own metadata; where a listing doesn't report them the value is `null`
 * ("unknown") until a Test call settles it (T9). Ids are kept verbatim and nothing is inferred
 * from a model's name. Loading the list is not a model call: no tokens, no ledger row.
 *
 * Endpoints, each from the provider's API reference (base URLs are the SDK packages' own
 * defaults, providers.ts):
 * - OpenAI `GET /models` (Bearer): `{data: [{id, created, owned_by, shutdown_date?}]}`. No
 *   capability metadata.
 * - Anthropic `GET /v1/models?limit=1000` (`x-api-key`, `anthropic-version: 2023-06-01`),
 *   paged by `has_more`/`last_id` → `after_id`: `capabilities.image_input.supported`.
 * - Google `GET /v1beta/models?pageSize=1000` (`x-goog-api-key`, the header the SDK sends),
 *   paged by `nextPageToken`: `supportedGenerationMethods` (`generateContent`,
 *   `embedContent`); no input modalities.
 * - OpenRouter `GET /api/v1/models` (Bearer), one page (the spike's 458 came in one):
 *   `architecture.input_modalities` / `output_modalities`, `expiration_date`, `pricing`.
 * - Groq `GET /openai/v1/models` (Bearer): top-level `input_modalities` / `output_modalities`,
 *   `active`, `context_window`, `pricing`.
 * - An OpenAI-compatible server: `GET <base>/models`; no list endpoint (404/405/501) → [] and
 *   the picker offers "Custom model id".
 *
 * Left out of the picker (spike §1): `:free` (a shared upstream pool that 429s), `:batch`,
 * `~…` aliases and `openrouter/free` (routers), anything retiring within 30 days, inactive
 * models, and text models with under 8,192 tokens of context (Groq's prompt guards).
 */
import type { ProviderKind } from '@kept/shared';
import { PrivateAddressError } from '../net/ssrf.js';
import { baseUrlFor } from './providers.js';

export type ListedModel = {
  id: string;
  /** Accepts images. Null: the listing doesn't say (a Test call settles it). */
  vision: boolean | null;
  /** Answers in text (chat, the assistant). Null: the listing doesn't say. */
  text: boolean | null;
  embeddings: boolean | null;
  /** USD per token as the listing gives it, for the price prefill (T9); `-1` is dropped. */
  pricing: { prompt: string | null; completion: string | null; cachedInput: string | null } | null;
};

export type ListModelsErrorCode = 'auth' | 'retryable' | 'provider_error';

export class ListModelsError extends Error {
  constructor(
    readonly code: ListModelsErrorCode,
    readonly status: number | null,
  ) {
    super(`model listing failed: ${code}${status === null ? '' : ` (HTTP ${status})`}`);
    this.name = 'ListModelsError';
  }
}

export type ListTarget = { kind: ProviderKind; baseUrl: string | null };

const MIN_TEXT_CONTEXT = 8192;
const RETIRING_WITHIN_MS = 30 * 86_400_000;
const LIST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 20;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
const price = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s === '' || s === '-1' || !Number.isFinite(Number(s)) || Number(s) < 0 ? null : s;
};

function retiringSoon(date: unknown, now: Date): boolean {
  if (typeof date !== 'string' && typeof date !== 'number') return false;
  const t = typeof date === 'number' ? date * 1000 : Date.parse(date);
  return Number.isFinite(t) && t - now.getTime() < RETIRING_WITHIN_MS;
}

function fromModalities(
  m: Obj,
  inputs: string[] | null,
  outputs: string[] | null,
  context: unknown,
) {
  const vision = inputs ? inputs.includes('image') : null;
  let text = inputs && outputs ? inputs.includes('text') && outputs.includes('text') : null;
  if (text && typeof context === 'number' && context < MIN_TEXT_CONTEXT) text = false;
  const embeddings = outputs ? outputs.includes('embeddings') : null;
  const p = obj(m.pricing);
  const pricing = m.pricing
    ? {
        prompt: price(p.prompt),
        completion: price(p.completion),
        cachedInput: price(p.input_cache_read),
      }
    : null;
  return { vision, text, embeddings, pricing };
}

function excludedId(id: string): boolean {
  return (
    id.endsWith(':free') || id.endsWith(':batch') || id.startsWith('~') || id === 'openrouter/free'
  );
}

type Fetch = typeof fetch;

async function getJson(
  fetchFn: Fetch,
  url: string,
  headers: Record<string, string>,
  allowMissing: boolean,
) {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e) {
    if (e instanceof PrivateAddressError) throw e; // 400 private_address, with its hint
    throw new ListModelsError('retryable', null);
  }
  if (allowMissing && (res.status === 404 || res.status === 405 || res.status === 501)) return null;
  if (res.status === 401 || res.status === 403) throw new ListModelsError('auth', res.status);
  if (res.status === 429 || res.status >= 500) throw new ListModelsError('retryable', res.status);
  if (!res.ok) throw new ListModelsError('provider_error', res.status);
  try {
    return obj(await res.json());
  } catch {
    throw new ListModelsError('provider_error', res.status);
  }
}

/**
 * The provider's models for the picker. `fetchFn` is the SSRF-guarded fetch for user-typed
 * base URLs (net/ssrf.ts); a listing never counts against budgets.
 */
export async function listModels(
  target: ListTarget,
  apiKey: string | null,
  fetchFn: Fetch,
  now: Date = new Date(),
): Promise<ListedModel[]> {
  const base = baseUrlFor(target);
  const bearer: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const out: ListedModel[] = [];

  switch (target.kind) {
    case 'openai': {
      const body = await getJson(fetchFn, `${base}/models`, bearer, false);
      for (const m of (body?.data as unknown[]) ?? []) {
        const o = obj(m);
        if (typeof o.id !== 'string' || retiringSoon(o.shutdown_date, now)) continue;
        out.push({ id: o.id, vision: null, text: null, embeddings: null, pricing: null });
      }
      break;
    }
    case 'anthropic': {
      const headers = { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' };
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const q: string = after ? `&after_id=${encodeURIComponent(after)}` : '';
        const body = await getJson(fetchFn, `${base}/models?limit=1000${q}`, headers, false);
        for (const m of (body?.data as unknown[]) ?? []) {
          const o = obj(m);
          if (typeof o.id !== 'string') continue;
          const image = obj(obj(o.capabilities).image_input).supported;
          out.push({
            id: o.id,
            vision: typeof image === 'boolean' ? image : null,
            text: true,
            embeddings: false,
            pricing: null,
          });
        }
        if (body?.has_more !== true || typeof body.last_id !== 'string') break;
        after = body.last_id;
      }
      break;
    }
    case 'google': {
      const headers = { 'x-goog-api-key': apiKey ?? '' };
      let token: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const q: string = token ? `&pageToken=${encodeURIComponent(token)}` : '';
        const body = await getJson(fetchFn, `${base}/models?pageSize=1000${q}`, headers, false);
        for (const m of (body?.models as unknown[]) ?? []) {
          const o = obj(m);
          if (typeof o.name !== 'string') continue;
          const methods = strings(o.supportedGenerationMethods) ?? [];
          out.push({
            id: o.name.replace(/^models\//, ''),
            vision: null,
            text: methods.includes('generateContent'),
            embeddings: methods.includes('embedContent'),
            pricing: null,
          });
        }
        if (typeof body?.nextPageToken !== 'string' || body.nextPageToken === '') break;
        token = body.nextPageToken;
      }
      break;
    }
    case 'openrouter': {
      const body = await getJson(fetchFn, `${base}/models`, bearer, false);
      for (const m of (body?.data as unknown[]) ?? []) {
        const o = obj(m);
        if (typeof o.id !== 'string' || excludedId(o.id) || retiringSoon(o.expiration_date, now))
          continue;
        const arch = obj(o.architecture);
        const caps = fromModalities(
          o,
          strings(arch.input_modalities),
          strings(arch.output_modalities),
          o.context_length,
        );
        out.push({ id: o.id, ...caps, embeddings: caps.embeddings ?? false });
      }
      break;
    }
    case 'groq': {
      const body = await getJson(fetchFn, `${base}/models`, bearer, false);
      for (const m of (body?.data as unknown[]) ?? []) {
        const o = obj(m);
        if (typeof o.id !== 'string' || o.active === false) continue;
        const caps = fromModalities(
          o,
          strings(o.input_modalities),
          strings(o.output_modalities),
          o.context_window,
        );
        out.push({ id: o.id, ...caps, embeddings: caps.embeddings ?? false });
      }
      break;
    }
    case 'openai_compatible': {
      const body = await getJson(fetchFn, `${base}/models`, bearer, true);
      for (const m of (body?.data as unknown[]) ?? []) {
        const o = obj(m);
        if (typeof o.id !== 'string') continue;
        const inputs = strings(o.input_modalities) ?? strings(obj(o.architecture).input_modalities);
        const outputs =
          strings(o.output_modalities) ?? strings(obj(o.architecture).output_modalities);
        out.push({
          id: o.id,
          ...fromModalities(o, inputs, outputs, o.context_window ?? o.context_length),
        });
      }
      break;
    }
  }
  return out;
}

/** The picker's two lists (D202): vision-capable (and unknown, flagged) and text models. */
export function splitForPicker(models: ListedModel[]) {
  return {
    vision: models.filter((m) => m.vision !== false && m.embeddings !== true),
    text: models.filter((m) => m.text !== false && m.embeddings !== true),
    embeddings: models.filter((m) => m.embeddings === true),
  };
}
