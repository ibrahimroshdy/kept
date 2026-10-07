/**
 * AI providers and keys (plan T9; D191, D193, D202, D206; engineering spec §7.3, §7.15):
 * listing the providers a caller manages, saving a key, removing one, and a provider's model
 * list. Keys are **write-only**: sealed with the keyring on the way in (AAD
 * `ai_providers|<id>|api_key`, db-keys.ts), kept_app can't read the ciphertext back (0040's column
 * grants), and nothing here returns more than the last four characters (`keyHint`). Only
 * `kept.ai_provider_secret` opens a key, for the provider's own manager, to list its models.
 *
 * Every base URL a person types goes through the SSRF guard twice: its host is checked when it is
 * saved, and every request to it goes through `guardedFetch` (net/ssrf.ts), which checks again at
 * connect time and refuses redirects. `instance_settings.ssrf_allow_private` lets a self-hosted
 * server reach Ollama on the LAN (Q9).
 *
 * Loading a model list is not a model call (§8a): no tokens, no ledger row; a refresh is audited
 * as a settings action and rate-limited like "Test connection".
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  DEFAULT_MODELS,
  detectKind,
  newId,
  PROVIDER_KINDS,
  type ProviderKind,
  REASONING_LEVELS,
  RECOMMENDED,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { open, type Sealed, seal } from '../crypto/envelope.js';
import type { SecretKeys } from '../crypto/keyring.js';
import type { Pools } from '../db/pools.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import { guardedFetch, isPrivateAddress, PrivateAddressError } from '../net/ssrf.js';
import type { Who } from './api-kit.js';
import { providerKeyAad } from './db-keys.js';
import { type ListedModel, ListModelsError, listModels } from './models.js';
import { allowPrivateAddresses } from './runtime.js';

export const ProviderScopeParam = z.enum(['instance', 'account', 'me']);
export type ProviderScopeParam = z.infer<typeof ProviderScopeParam>;
type StoredScope = 'instance' | 'account' | 'user';
const stored = (s: ProviderScopeParam): StoredScope => (s === 'me' ? 'user' : s);

const Reasoning = z.enum([...REASONING_LEVELS, 'provider-default']);
const ModelId = z.string().trim().min(1).max(120);
export const ModelsSchema = z.object({
  vision: ModelId.optional(),
  chat: ModelId.optional(),
  embeddings: ModelId.optional(),
});
export type Models = z.infer<typeof ModelsSchema>;

export const ProviderSchema = z.object({
  id: z.uuid(),
  scope: z.enum(['instance', 'account', 'user']),
  kind: z.enum(PROVIDER_KINDS),
  label: z.string().nullable(),
  baseUrl: z.string().nullable(),
  keyHint: z.string().nullable(),
  models: ModelsSchema,
  capabilities: z.object({ vision: z.boolean().optional(), structured: z.boolean().optional() }),
  reasoning: Reasoning,
  disabled: z.boolean(),
  rowVersion: z.number(),
});
export type ProviderView = z.infer<typeof ProviderSchema>;

export const PutProviderBody = z.object({
  apiKey: z.string().trim().min(8).max(500).optional(),
  kind: z.enum(PROVIDER_KINDS).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  models: ModelsSchema.optional(),
  reasoning: Reasoning.optional(),
  label: z.string().trim().max(60).optional(),
});
export type PutProviderBody = z.infer<typeof PutProviderBody>;

/** One model in the cached list (`ai_providers.model_list`): the listing's facts, plus what a
 * Test call settled (`visionSource: 'test'`) and the listing's own prices (for the prefill). */
export type StoredModel = {
  id: string;
  vision: boolean | null;
  text: boolean;
  embeddings: boolean;
  visionSource: 'listing' | 'test' | null;
  pricing?: ListedModel['pricing'];
};

export const ModelListingSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      vision: z.boolean().nullable(),
      text: z.boolean(),
      embeddings: z.boolean(),
      visionSource: z.enum(['listing', 'test']).nullable(),
    }),
  ),
  fetchedAt: z.string().nullable(),
  chosenMissing: z.array(z.enum(['vision', 'chat', 'embeddings'])),
});

export type ProviderRow = {
  id: string;
  scope: StoredScope;
  owner_account_id: string | null;
  user_id: string | null;
  kind: ProviderKind;
  model_list: StoredModel[] | null;
  model_list_at: Date | null;
  label: string | null;
  base_url: string | null;
  key_hint: string | null;
  models: Models;
  capabilities: { vision?: boolean; structured?: boolean; testedAt?: string; model?: string };
  reasoning: z.infer<typeof Reasoning>;
  disabled_at: Date | null;
  row_version: number;
};

/** Every column kept_app may read (0040: never key_ciphertext or key_version). */
const COLUMNS = `id, scope, owner_account_id, user_id, kind, model_list, model_list_at, label,
  base_url, key_hint, models, capabilities, reasoning, disabled_at, row_version`;

export function providerView(r: ProviderRow): ProviderView {
  const caps: ProviderView['capabilities'] = {};
  if (typeof r.capabilities.vision === 'boolean') caps.vision = r.capabilities.vision;
  if (typeof r.capabilities.structured === 'boolean') caps.structured = r.capabilities.structured;
  const models: Models = {};
  for (const slot of ['vision', 'chat', 'embeddings'] as const) {
    const id = r.models[slot];
    if (typeof id === 'string' && id) models[slot] = id;
  }
  return {
    id: r.id,
    scope: r.scope,
    kind: r.kind,
    label: r.label,
    baseUrl: r.base_url,
    keyHint: r.key_hint,
    models,
    capabilities: caps,
    reasoning: r.reasoning,
    disabled: r.disabled_at !== null,
    rowVersion: r.row_version,
  };
}

/** The providers the caller manages (the policy's rule), active ones only. Never a key. */
export async function listProviders(client: pg.ClientBase): Promise<ProviderRow[]> {
  const { rows } = await client.query<ProviderRow>(
    `SELECT ${COLUMNS} FROM public.ai_providers
      WHERE disabled_at IS NULL
      ORDER BY CASE scope WHEN 'user' THEN 1 WHEN 'account' THEN 2 ELSE 3 END, id`,
  );
  return rows;
}

/** One provider the caller manages, or 404 (a random id and another household's alike). */
export async function managedProvider(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<ProviderRow> {
  const { rows } = await client.query<ProviderRow>(
    `SELECT ${COLUMNS} FROM public.ai_providers WHERE id = $1 AND disabled_at IS NULL
     ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** The active provider at a scope the caller may set, or null. 404 for the instance to anyone
 * but an instance admin. */
export async function providerAt(
  client: pg.ClientBase,
  who: Who,
  scope: ProviderScopeParam,
  lock = false,
): Promise<ProviderRow | null> {
  if (scope === 'instance' && !who.instanceAdmin) throw notFound();
  if (scope === 'account' && !who.accountId) throw notFound();
  const where =
    scope === 'instance'
      ? `scope = 'instance'`
      : scope === 'account'
        ? `scope = 'account' AND owner_account_id = $1`
        : `scope = 'user' AND user_id = $1`;
  const args = scope === 'instance' ? [] : [scope === 'account' ? who.accountId : who.userId];
  const { rows } = await client.query<ProviderRow>(
    `SELECT ${COLUMNS} FROM public.ai_providers WHERE ${where} AND disabled_at IS NULL
     ${lock ? 'FOR UPDATE' : ''}`,
    args,
  );
  return rows[0] ?? null;
}

/** A provider's key, opened for its manager (`kept.ai_provider_secret`: 42501, a 404, for anyone
 * else). Lives only in the caller's frame; never logged. */
export async function providerKey(
  client: pg.ClientBase,
  keys: SecretKeys,
  id: string,
): Promise<string | null> {
  const { rows } = await client.query<{ key_ciphertext: Sealed | null }>(
    `SELECT key_ciphertext FROM kept.ai_provider_secret($1, 'extraction')`,
    [id],
  );
  const sealed = rows[0]?.key_ciphertext;
  if (!sealed) return null;
  if (!keys.get().keyring.has(sealed.kv)) await keys.refresh();
  return open(keys.get().keyring, sealed, providerKeyAad(id)).toString('utf8');
}

// ---------------------------------------------------------------------------------------------
// Base URLs and the SSRF check at save time
// ---------------------------------------------------------------------------------------------

export type HostResolver = (host: string) => Promise<string[]>;
const systemResolver: HostResolver = async (host) =>
  (await dnsLookup(host, { all: true })).map((a) => a.address);

/** A base URL a person typed: http(s), and not a private address unless the instance allows it.
 * A host that doesn't resolve now is kept: the connect-time guard checks it on every request. */
export async function checkBaseUrl(
  raw: string,
  allowPrivate: boolean,
  resolve: HostResolver = systemResolver,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('The base URL is not a valid address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalid('The base URL starts with http:// or https://.');
  }
  if (url.username || url.password) throw invalid("A base URL can't carry a user name.");
  const clean = url.toString().replace(/\/+$/, '');
  if (clean.length > 300) throw invalid('The base URL is at most 300 characters.');
  if (allowPrivate) return clean;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new PrivateAddressError(host);
    return clean;
  }
  let addresses: string[] = [];
  try {
    addresses = await resolve(host);
  } catch {
    return clean;
  }
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (bad) throw new PrivateAddressError(bad);
  return clean;
}

// ---------------------------------------------------------------------------------------------
// The model list
// ---------------------------------------------------------------------------------------------

export function storedModels(listed: ListedModel[], previous: StoredModel[] | null): StoredModel[] {
  const settled = new Map(
    (previous ?? []).filter((m) => m.visionSource === 'test').map((m) => [m.id, m.vision]),
  );
  return listed.map((m) => {
    const tested = settled.get(m.id);
    const vision = m.vision ?? tested ?? null;
    return {
      id: m.id,
      vision,
      text: m.text !== false,
      embeddings: m.embeddings === true,
      visionSource: m.vision !== null ? 'listing' : tested !== undefined ? 'test' : null,
      ...(m.pricing ? { pricing: m.pricing } : {}),
    };
  });
}

/** KEPT_AI_MOCK: a listing made of the kind's defaults, so a dev or e2e run needs no network. */
function mockListing(kind: ProviderKind): ListedModel[] {
  const d = DEFAULT_MODELS[kind].models;
  const out = new Map<string, ListedModel>();
  const add = (id: string | null, over: Partial<ListedModel>) => {
    if (!id) return;
    const had = out.get(id);
    out.set(id, {
      id,
      vision: over.vision ?? had?.vision ?? false,
      text: over.text ?? had?.text ?? true,
      embeddings: over.embeddings ?? had?.embeddings ?? false,
      pricing: null,
    });
  };
  add(d.extraction, { vision: true, text: true });
  add(d.assistant, { text: true });
  add(d.embeddings, { vision: false, text: false, embeddings: true });
  return [...out.values()];
}

export type Lister = (
  target: { kind: ProviderKind; baseUrl: string | null },
  apiKey: string | null,
) => Promise<ListedModel[]>;

/** How a provider's list is fetched: the mock's, or the provider's list endpoint through the
 * guarded fetch. */
export function lister(opts: { mock: boolean; fetch: typeof fetch }): Lister {
  return (target, apiKey) =>
    opts.mock ? Promise.resolve(mockListing(target.kind)) : listModels(target, apiKey, opts.fetch);
}

/** A fetch for listing: the SSRF guard with the instance's setting (Q9). */
export async function listingFetch(pools: Pick<Pools, 'app' | 'system'>): Promise<typeof fetch> {
  return guardedFetch({ allowPrivate: await allowPrivateAddresses(pools) });
}

/** The provider refused or failed a listing: in words, never the provider's own message. */
export function listingError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ListModelsError) {
    return new AppError(
      'ai_unavailable',
      409,
      e.code === 'auth'
        ? 'The provider rejected the key. Check it, or paste a new one.'
        : 'The provider did not answer. Try again in a minute.',
    );
  }
  return new AppError('ai_unavailable', 409, 'The provider did not answer. Try again in a minute.');
}

/** Slots whose chosen model the (non-empty) list no longer offers (D202). */
export function chosenMissing(
  models: Models,
  list: StoredModel[] | null,
): ('vision' | 'chat' | 'embeddings')[] {
  if (!list || list.length === 0) return [];
  const ids = new Set(list.map((m) => m.id));
  return (['vision', 'chat', 'embeddings'] as const).filter((slot) => {
    const id = models[slot];
    return !!id && !ids.has(id);
  });
}

/**
 * The models a provider gets (D202, D206). Asked-for models must be in the list (a custom id
 * only on `openai_compatible`; with no list at all nothing can be checked). Otherwise a new key or
 * kind gets the kind's defaults where the list offers them (a Groq key gets RECOMMENDED's model
 * for photos), else the first listed vision and text models; an unchanged provider keeps its own.
 */
export function chooseModels(input: {
  kind: ProviderKind;
  list: StoredModel[] | null;
  requested: Models | undefined;
  existing: Models | null;
}): Models {
  const { kind, list, requested, existing } = input;
  const ids = list ? new Set(list.map((m) => m.id)) : null;
  const listed = (id: string | null | undefined): id is string =>
    !!id && (ids === null || ids.size === 0 ? true : ids.has(id));
  if (requested) {
    const out: Models = { ...(existing ?? {}) };
    for (const slot of ['vision', 'chat', 'embeddings'] as const) {
      const id = requested[slot];
      if (id === undefined) continue;
      if (kind !== 'openai_compatible' && ids && ids.size > 0 && !ids.has(id)) {
        throw invalid(`${id} isn't in the provider's model list. Refresh the list and pick again.`);
      }
      out[slot] = id;
    }
    return out;
  }
  if (existing) return existing;
  const d = DEFAULT_MODELS[kind].models;
  const out: Models = {};
  const vision = kind === RECOMMENDED.kind && listed(RECOMMENDED.model) ? RECOMMENDED.model : null;
  const firstVision = list?.find((m) => m.vision === true && !m.embeddings)?.id;
  const firstText = list?.find((m) => m.text && !m.embeddings)?.id;
  const v = vision ?? (listed(d.extraction) ? d.extraction : firstVision);
  const c = listed(d.assistant) ? d.assistant : firstText;
  const e = listed(d.embeddings) ? d.embeddings : null;
  if (v) out.vision = v;
  if (c) out.chat = c;
  if (e) out.embeddings = e;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Saving a key
// ---------------------------------------------------------------------------------------------

/** The last four characters a key hint may show (the column allows `[A-Za-z0-9_-]{0,4}`). */
export function keyHint(apiKey: string): string {
  return apiKey
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(-4);
}

export type SaveInput = {
  who: Who;
  scope: ProviderScopeParam;
  existing: ProviderRow | null;
  body: PutProviderBody;
  kind: ProviderKind;
  baseUrl: string | null;
  models: Models;
  /** The key to seal: the one pasted, or the provider's own carried to a new row (a new kind);
   * null keeps the stored one. */
  apiKey: string | null;
  /** The fresh listing, or undefined to keep the cached one. */
  list: StoredModel[] | null | undefined;
  listedAt: Date | null;
  keys: SecretKeys;
};

/**
 * Writes the provider (the key sealed on the way in; the plaintext never leaves this frame).
 * kept_app may update a provider's settings and key but not its kind (0040's column grants), so
 * a new kind retires the old row and starts a new one: one active provider per scope.
 */
export async function saveProvider(
  client: pg.ClientBase,
  s: SaveInput,
): Promise<{ row: ProviderRow; keyReplaced: boolean }> {
  const { current } = s.keys.get();
  const kindChanged = !!s.existing && s.existing.kind !== s.kind;
  const reasoning = s.body.reasoning ?? s.existing?.reasoning ?? 'low';
  const label = s.body.label ?? s.existing?.label ?? null;
  const list = s.list === undefined ? (s.existing?.model_list ?? null) : s.list;
  const listedAt = s.list === undefined ? (s.existing?.model_list_at ?? null) : s.listedAt;
  const hint = s.apiKey ? keyHint(s.apiKey) : null;

  if (s.existing && !kindChanged) {
    const id = s.existing.id;
    const sealed = s.apiKey ? seal(current, s.apiKey, providerKeyAad(id)) : null;
    const capabilities = sealed || s.existing.base_url !== s.baseUrl ? {} : s.existing.capabilities;
    const sets = [
      'base_url = $2',
      'models = $3',
      'capabilities = $4',
      'reasoning = $5',
      'label = $6',
      'model_list = $7',
      'model_list_at = $8',
    ];
    const args: unknown[] = [
      id,
      s.baseUrl,
      JSON.stringify(s.models),
      JSON.stringify(capabilities),
      reasoning,
      label,
      list === null ? null : JSON.stringify(list),
      listedAt,
    ];
    if (sealed) {
      args.push(JSON.stringify(sealed), current.keyVersion, hint);
      sets.push('key_ciphertext = $9', 'key_version = $10', 'key_hint = $11');
    }
    const { rows } = await client.query<ProviderRow>(
      `UPDATE public.ai_providers SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
      args,
    );
    return { row: rows[0] as ProviderRow, keyReplaced: sealed !== null };
  }

  if (s.existing) await retireProvider(client, s.existing.id);
  const id = newId();
  const sealed = s.apiKey ? seal(current, s.apiKey, providerKeyAad(id)) : null;
  const scope = stored(s.scope);
  const { rows } = await client.query<ProviderRow>(
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, user_id, kind, base_url,
                                      models, capabilities, reasoning, label, model_list,
                                      model_list_at, key_ciphertext, key_version, key_hint,
                                      created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', $8, $9, $10, $11, $12, $13, $14,
             kept.current_user_id())
     RETURNING ${COLUMNS}`,
    [
      id,
      scope,
      scope === 'account' ? s.who.accountId : null,
      scope === 'user' ? s.who.userId : null,
      s.kind,
      s.baseUrl,
      JSON.stringify(s.models),
      reasoning,
      label,
      list === null ? null : JSON.stringify(list),
      listedAt,
      sealed ? JSON.stringify(sealed) : null,
      sealed ? current.keyVersion : null,
      hint,
    ],
  );
  return { row: rows[0] as ProviderRow, keyReplaced: sealed !== null };
}

/** Removes a provider: disabled, its key and hint gone (DELETE /ai/providers/:id). */
export async function retireProvider(client: pg.ClientBase, id: string): Promise<void> {
  await client.query(
    `UPDATE public.ai_providers
        SET disabled_at = now(), key_ciphertext = NULL, key_version = NULL, key_hint = NULL
      WHERE id = $1 AND disabled_at IS NULL`,
    [id],
  );
}

/** The kind a save uses: named, detected from the key's prefix, or the provider's own. 400 with
 * "choose a provider" when none (the web then shows Advanced, D191). */
export function kindFor(body: PutProviderBody, existing: ProviderRow | null): ProviderKind {
  const kind = body.kind ?? (body.apiKey ? detectKind(body.apiKey) : null) ?? existing?.kind;
  if (!kind) {
    throw invalid("Kept can't tell which provider this key is for. Choose a provider.");
  }
  return kind;
}
