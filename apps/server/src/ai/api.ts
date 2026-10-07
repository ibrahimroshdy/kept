/**
 * The AI settings API (plan T9; D191, D193, D202, D206; engineering spec §7.15 "Routes"), in the
 * shapes of the web contract (apps/web/src/api/capture/types.ts "AI", mock/ai.ts):
 *
 * GET    /api/v1/ai/status?locationId                   → AiStatus (viewers too)
 * GET    /api/v1/ai/providers                           → {providers} the caller manages; never a key
 * PUT    /api/v1/ai/providers/:scope  (If-Match)        → the provider (instance · account · me)
 * DELETE /api/v1/ai/providers/:id                       → 204
 * POST   /api/v1/ai/providers/:id/test                  → AiTestResult: two real calls, ledgered
 * GET    /api/v1/ai/providers/:id/models?refresh=1      → AiModelListing (not a model call)
 * GET    /api/v1/ai/explain?scope&locationId            → "What uses AI in Kept"
 * GET    /api/v1/ai/caps?scope&locationId               → {caps, suggested?}
 * PUT    /api/v1/ai/caps  (If-Match when it exists)     → the cap
 * DELETE /api/v1/ai/caps/:id                            → 204
 * POST   /api/v1/ai/caps/:id/resume                     → {cap, resumed}
 * POST   /api/v1/ai/pause                               → the cap, paused
 * GET    /api/v1/ai/prices?history                      → {prices}
 * POST   /api/v1/admin/ai/prices                        → 201 the new version
 * POST   /api/v1/admin/ai/prices/prefill {providerId}   → proposed rows, not saved
 * DELETE /api/v1/admin/ai/prices/:providerKind/:model   → 204
 * POST   /api/v1/admin/ai/prices/recost                 → {recosted}
 * GET    /api/v1/ai/usage?scope&locationId&from&to&groupBy → AiUsage
 * GET    /api/v1/ai/calls?scope&locationId&<filters>    → {items, next_cursor}
 * GET    /api/v1/ai/calls/:id                           → the call with its attempts
 * GET    /api/v1/ai/calls.csv?<filters>                 → text/csv (5 an hour, audited)
 *
 * Everything runs as the caller on kept_app under row-level security; a scope, provider or cap
 * the caller doesn't manage is a 404, as a random id is. Every write is audited. A model call
 * ("Test connection") runs with no transaction open (D166).
 */
import { createHash } from 'node:crypto';
import { type AiTask, newId, RECOMMENDED_PRICE } from '@kept/shared';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { rateLimited, requireScope } from '../auth/http.js';
import { reserveInWindow } from '../auth/sign-in-limiter.js';
import { NO_PROVIDER as WAITING_FOR_PROVIDER } from '../capture/service.js';
import type { SecretKeys } from '../crypto/keyring.js';
import type { Scope, Tx } from '../db/scope.js';
import { storedSource } from '../embeddings/provider.js';
import type { KeptApp } from '../http/app.js';
import { checkVersion, requireIfMatch } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { When } from '../http/list-filters.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { requireRecoveryKit } from '../secrets/service.js';
import { amount, auditHome, requireCurrency, type Who, whoAmI } from './api-kit.js';
import {
  CallDetailSchema,
  CallPageSchema,
  CallsQuery,
  callDetail,
  callsCsv,
  listCalls,
  timezoneOf,
} from './calls.js';
import {
  AiScope,
  CapSchema,
  capAudit,
  capRow,
  capRows,
  capTarget,
  capViews,
  existingCap,
  PauseBody,
  PutCapBody,
  ResumeBody,
  SuggestedSchema,
  suggestion,
} from './caps.js';
import type { Price } from './cost.js';
import { resolveCapAlerts, resolveKeyRejected } from './notices.js';
import {
  currentPrice,
  listPrices,
  PrefillRow,
  PriceSchema,
  PutPriceBody,
  prefillRows,
  priceById,
} from './prices.js';
import { allowPrivateAddresses } from './runtime.js';
import {
  checkBaseUrl,
  chooseModels,
  chosenMissing,
  kindFor,
  lister,
  listingError,
  listingFetch,
  listProviders,
  ModelListingSchema,
  managedProvider,
  type ProviderRow,
  ProviderSchema,
  ProviderScopeParam,
  PutProviderBody,
  providerAt,
  providerKey,
  providerView,
  retireProvider,
  type StoredModel,
  saveProvider,
  storedModels,
} from './settings.js';
import { NO_PROVIDER, StatusSchema, statusOf } from './status.js';
import { testConnection } from './test-connection.js';
import {
  dayTasks,
  ExplainSchema,
  explainFrom,
  GroupBy,
  mergeGroups,
  scopeId,
  totalsOf,
  UsageGroupSchema,
  usageRows,
} from './usage.js';

const Id = z.uuid().transform((v) => v.toLowerCase());
const Params = z.object({ id: Id });

/** "Test connection" and a model-list refresh: 6 a minute per person (§3.5). */
const TESTS_PER_MINUTE = 6;
/** CSV exports: 5 an hour per person (§3.5). */
const EXPORTS_PER_HOUR = 5;

/** A limiter row's key: hashed, like the sign-in limiter's (auth/sign-in-limiter.ts). */
const limitKey = (kind: string, userId: string) =>
  createHash('sha256').update(`ai-${kind}\0${userId}`).digest('hex');

async function limit(
  deps: InventoryDeps,
  req: FastifyRequest,
  reply: Parameters<typeof rateLimited>[0],
  kind: 'test' | 'models' | 'csv',
  max: number,
  windowSeconds: number,
): Promise<void> {
  const decision = await reserveInWindow(
    deps.pools.auth,
    limitKey(kind, requireScope(req).userId),
    max,
    windowSeconds,
  );
  if (!decision.allowed) throw rateLimited(reply, decision.retryAfter);
}

/**
 * The extraction jobs held for a provider, in the locations a key of `scope` serves and the
 * caller can change, sent again (oldest first):
 * - `auth` (a rejected key), when the key is new (T10: it has no end of its own);
 * - `no_provider` (captured while no provider resolved, capture/service.ts), whenever a key is
 *   saved or passes its test: the photos wait in a queue for the first provider, as the
 *   maintainer expected. Those go back to `queued` first, so the inbox says "Naming…" and a
 *   second save sends nothing twice.
 * Rows the caller can't see (another household's, when an instance key is set) are sent by that
 * person's own next capture there or their inbox's "Name N unnamed photos".
 */
async function resendWaiting(
  deps: InventoryDeps,
  client: pg.ClientBase,
  who: Who,
  scope: 'instance' | 'account' | 'user',
  opts: { rejected: boolean },
): Promise<number> {
  const cond =
    scope === 'instance'
      ? 'true'
      : scope === 'account'
        ? 'l.owner_account_id = $1'
        : `l.owner_account_id = $1 AND l.kind = 'personal'`;
  const params = scope === 'instance' ? [] : [who.accountId];
  const { rows: rejected } = opts.rejected
    ? await client.query<{ id: string }>(
        `SELECT e.id FROM public.extractions e JOIN public.locations l ON l.id = e.location_id
          WHERE e.status = 'waiting_provider' AND e.status_reason = 'auth' AND ${cond}
          ORDER BY e.created_at, e.id`,
        params,
      )
    : { rows: [] };
  const { rows: waiting } = await client.query<{ id: string }>(
    `WITH w AS (
       SELECT e.id FROM public.extractions e JOIN public.locations l ON l.id = e.location_id
        WHERE e.status = 'waiting_provider' AND e.status_reason = '${WAITING_FOR_PROVIDER}' AND ${cond}
          AND e.location_id IN (SELECT kept.writable_location_ids())
          AND kept.ai_provider_resolved(e.location_id)
        FOR UPDATE OF e)
     UPDATE public.extractions x SET status = 'queued', status_reason = NULL, paused_until = NULL
       FROM w WHERE x.id = w.id
     RETURNING x.id, x.created_at`,
    params,
  );
  const ordered = (waiting as unknown as { id: string; created_at: Date }[])
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
    .map((r) => r.id);
  return resend(deps, client, [...rejected.map((r) => r.id), ...ordered]);
}

/**
 * The recommended model priced from its first call (D206, the maintainer's 2026-09-29 ask): when an
 * instance admin saves a key whose photo model is the recommended one and no price is set for it,
 * its price is saved as `provider_listing`: the fresh listing's own, else Groq's as recorded on
 * 2026-09-26 (RECOMMENDED_PRICE, the price REFERENCE_FIGURES were costed at). This month's calls
 * that ran unpriced are then costed (`price_table_later`). Both audited, as the admin's own
 * `ai.price_set` and `ai.price_recost` are. Anyone else saving a key leaves the price to an
 * instance admin, whom AI settings prompts.
 */
async function priceRecommended(
  tx: Tx,
  client: pg.ClientBase,
  who: Who,
  row: ProviderRow,
  requestId: string,
): Promise<void> {
  const rec = RECOMMENDED_PRICE;
  if (!who.instanceAdmin || row.kind !== rec.kind || row.models.vision !== rec.model) return;
  if (await currentPrice(client, rec.kind, rec.model)) return;
  const listed = prefillRows(row).find((p) => p.model === rec.model && p.currency === 'USD');
  const price = listed ?? {
    inputPerMtok: rec.inputPerMtok,
    outputPerMtok: rec.outputPerMtok,
    cachedInputPerMtok: rec.cachedInputPerMtok,
    currency: rec.currency,
    listingFetchedAt: rec.listingFetchedAt,
  };
  const { rows } = await client.query<{ id: string }>('SELECT kept.ai_price_set($1) AS id', [
    JSON.stringify({
      providerKind: rec.kind,
      model: rec.model,
      inputPerMtok: price.inputPerMtok,
      outputPerMtok: price.outputPerMtok,
      ...(price.cachedInputPerMtok ? { cachedInputPerMtok: price.cachedInputPerMtok } : {}),
      currency: price.currency,
      source: 'provider_listing',
      listingFetchedAt: price.listingFetchedAt,
    }),
  ]);
  const priceId = rows[0]?.id as string;
  const saved = await priceById(client, priceId);
  await audited(tx, {
    ...auditHome(who, true),
    actor: { type: 'user', id: who.userId },
    action: 'ai.price_set',
    entity: { type: 'ai_model_price', id: priceId },
    before: null,
    after: {
      provider_kind: saved.providerKind,
      model: saved.model,
      version: saved.version,
      ...saved.rates,
      currency: saved.currency,
      source: saved.source,
      listing_fetched_at: saved.listingFetchedAt,
      with_key: row.id,
    },
    requestId,
  });
  const { rows: recost } = await client.query<{ n: number }>(
    'SELECT kept.ai_recost_unknown($1, $2, $3) AS n',
    [rec.kind, rec.model, rec.listingFetchedAt],
  );
  const recosted = recost[0]?.n ?? 0;
  if (recosted > 0)
    await audited(tx, {
      ...auditHome(who, true),
      actor: { type: 'user', id: who.userId },
      action: 'ai.price_recost',
      entity: { type: 'ai_model_price', id: null },
      before: null,
      after: { provider_kind: rec.kind, model: rec.model, since: rec.listingFetchedAt, recosted },
      requestId,
    });
}

/** Sends `extract` again for each extraction, oldest first (the pacer spaces them). */
async function resend(deps: InventoryDeps, client: pg.ClientBase, ids: string[]): Promise<number> {
  if (!deps.jobs) return 0;
  for (const extractionId of ids) await deps.jobs.sendTenant(client, 'extract', { extractionId });
  return ids.length;
}

/** The current price of the model a scope's photos are read with, for "What uses AI" and the
 * suggested cap: the location's resolved provider, or the scope's own key. */
async function scopePrice(
  client: pg.ClientBase,
  who: Who,
  scope: z.infer<typeof AiScope>,
  locationId: string | null,
): Promise<Price | null> {
  let kind: string | null = null;
  let model: string | null = null;
  if (scope === 'location' && locationId) {
    const { rows } = await client.query<{ kind: string | null; model: string | null }>(
      'SELECT kind, model FROM kept.ai_status($1)',
      [locationId],
    );
    kind = rows[0]?.kind ?? null;
    model = rows[0]?.model ?? null;
  } else {
    const order =
      scope === 'instance' ? ['instance'] : scope === 'me' ? ['me', 'account'] : ['account'];
    for (const s of order) {
      const p = await providerAt(client, who, s as 'instance' | 'account' | 'me').catch(() => null);
      if (p?.models.vision) {
        kind = p.kind;
        model = p.models.vision;
        break;
      }
    }
  }
  if (!kind || !model) return null;
  const { rows } = await client.query<{
    id: string;
    input_per_mtok: string;
    output_per_mtok: string;
    reasoning_per_mtok: string | null;
    cached_input_per_mtok: string | null;
    per_image: string | null;
    currency: string;
  }>(
    `SELECT id, input_per_mtok, output_per_mtok, reasoning_per_mtok, cached_input_per_mtok,
            per_image, currency
       FROM public.ai_model_prices
      WHERE provider_kind = $1 AND model = $2 AND superseded_at IS NULL`,
    [kind, model],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    inputPerMtok: amount(r.input_per_mtok) ?? '0',
    outputPerMtok: amount(r.output_per_mtok) ?? '0',
    reasoningPerMtok: amount(r.reasoning_per_mtok),
    cachedInputPerMtok: amount(r.cached_input_per_mtok),
    perImage: amount(r.per_image),
    currency: r.currency.trim(),
  };
}

/** Where a scope's audit events go: a location's own events in it; the rest under the account
 * (or the instance's, with none). */
function capAuditHome(who: Who, scope: string, locationId: string | null) {
  if (scope === 'location' && locationId) return { locationId };
  return auditHome(who, scope === 'instance' || scope === 'instance_account');
}

export async function registerAiApi(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const needKeys = (): SecretKeys => {
    if (!deps.secretKeys) throw new AppError('internal', 503, 'Secrets are not configured.');
    return deps.secretKeys;
  };
  const listingFetchFor = async (scope: Scope): Promise<typeof fetch> =>
    deps.ai ? (await deps.ai.runtime(scope)).fetch : listingFetch(pools);
  const mock = deps.ai?.mock ?? false;

  // ----- status and providers ----------------------------------------------------------------

  app.get(
    '/api/v1/ai/status',
    {
      schema: {
        querystring: z.object({ locationId: Id.optional() }),
        response: { 200: StatusSchema },
      },
    },
    async (req) => {
      // Step 6 (T14, D207): the server's embeddings source, for AI settings' "Search" line.
      const embeddingsSource = await storedSource(pools);
      const status = await (req.query.locationId
        ? scopedRead(pools, req, (_tx, client) => statusOf(client, req.query.locationId as string))
        : scopedRead(pools, req, async () => NO_PROVIDER));
      return { ...status, embeddingsSource };
    },
  );

  app.get(
    '/api/v1/ai/providers',
    { schema: { response: { 200: z.object({ providers: z.array(ProviderSchema) }) } } },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => ({
        providers: (await listProviders(client)).map(providerView),
      })),
  );

  app.put(
    '/api/v1/ai/providers/:ref',
    {
      schema: {
        params: z.object({ ref: z.string().max(40) }),
        body: PutProviderBody,
        response: { 200: ProviderSchema },
      },
    },
    async (req, reply) => {
      const parsed = ProviderScopeParam.safeParse(req.params.ref);
      if (!parsed.success) throw notFound();
      const target = parsed.data;
      const body = req.body;
      const keys = needKeys();
      const scope = requireScope(req);

      // 1. Who, what is there, and the key a new kind or listing needs, in a short read.
      const pre = await scopedRead(pools, req, async (_tx, client) => {
        const who = await whoAmI(client);
        const existing = await providerAt(client, who, target);
        if (existing) checkVersion({ rowVersion: existing.row_version }, requireIfMatch(req));
        if (body.apiKey) await requireRecoveryKit(client);
        const kind = kindFor(body, existing);
        const sameKind = !!existing && existing.kind === kind;
        const storedKey =
          !body.apiKey && existing ? await providerKey(client, keys, existing.id) : null;
        return { who, existing, kind, sameKind, storedKey };
      });
      const { who, existing, kind, sameKind } = pre;

      // 2. The base URL: filled in for a named kind; typed, and SSRF-checked, for a compatible one.
      let baseUrl: string | null = null;
      if (kind === 'openai_compatible') {
        const raw = body.baseUrl ?? (sameKind ? existing?.base_url : null);
        if (!raw) throw invalid('An OpenAI-compatible provider needs a base URL.');
        baseUrl = await checkBaseUrl(raw, await allowPrivateAddresses(pools));
      }
      const apiKey = body.apiKey ?? pre.storedKey;
      if (kind !== 'openai_compatible' && !apiKey) throw invalid('Paste the API key.');

      // 3. The provider's model list (D202), with no transaction open. A listing that fails
      //    leaves the list unknown; the defaults stand and "Refresh" tries again.
      const relist =
        !!body.apiKey ||
        !sameKind ||
        baseUrl !== (existing?.base_url ?? null) ||
        !existing?.model_list;
      let list: StoredModel[] | null | undefined;
      let listedAt: Date | null = null;
      if (relist) {
        try {
          const listed = await lister({ mock, fetch: await listingFetchFor(scope) })(
            { kind, baseUrl },
            apiKey,
          );
          list = storedModels(listed, sameKind ? (existing?.model_list ?? null) : null);
          listedAt = new Date();
        } catch (e) {
          if (e instanceof AppError) throw e;
          req.log.warn({ ai: { kind, code: (e as { code?: string }).code } }, 'model list failed');
          list = sameKind ? undefined : null;
        }
      }
      const models = chooseModels({
        kind,
        list: list === undefined ? (existing?.model_list ?? null) : list,
        requested: body.models,
        existing: sameKind && existing?.models.vision ? existing.models : null,
      });

      // 4. The write, the audit, and work held for a rejected key sent again.
      return scopedWrite(pools, req, reply, async (tx, client) => {
        const now = await providerAt(client, who, target, true);
        if (
          (now?.id ?? null) !== (existing?.id ?? null) ||
          (now && existing && now.row_version !== existing.row_version)
        ) {
          throw new AppError('precondition_failed', 412, 'Reload to see the latest version.');
        }
        const { row, keyReplaced } = await saveProvider(client, {
          who,
          scope: target,
          existing: now,
          body,
          kind,
          baseUrl,
          models,
          apiKey: body.apiKey ?? (sameKind ? null : pre.storedKey),
          list,
          listedAt,
          keys,
        });
        if (keyReplaced && sameKind && now) {
          await client.query('SELECT kept.ai_clear_trip($1)', [row.id]);
        }
        const summary = (p: ProviderRow | null) =>
          p && {
            kind: p.kind,
            base_url: p.base_url,
            models: p.models,
            reasoning: p.reasoning,
            label: p.label,
            key_hint: p.key_hint,
          };
        const event = await audited(tx, {
          ...auditHome(who, target === 'instance'),
          actor: { type: 'user', id: who.userId },
          action: 'ai.provider_set',
          entity: { type: 'ai_provider', id: row.id },
          before: now ? { ...summary(now), api_key: 'kept' } : null,
          after: { ...summary(row), api_key: keyReplaced ? newId() : 'kept' },
          fieldClasses: { api_key: 'secret' },
          requestId: req.id,
        });
        // D180 (step 6, T16): a new instance provider kind is told to every active user, once,
        // after this commits (notices/transparency.ts reads it from this event).
        if (target === 'instance' && now?.kind !== row.kind && deps.jobs) {
          await deps.jobs.send(client, 'transparency-notice', { auditEventId: event.id });
        }
        const stored = target === 'me' ? 'user' : target;
        await priceRecommended(tx, client, who, row, req.id);
        await resendWaiting(deps, client, who, stored, { rejected: keyReplaced });
        return {
          status: 200,
          body: providerView(row),
          ...(keyReplaced && target === 'instance'
            ? { afterCommit: async () => void (await resolveKeyRejected(pools)) }
            : {}),
        };
      });
    },
  );

  app.delete(
    '/api/v1/ai/providers/:ref',
    { schema: { params: z.object({ ref: z.string().max(40) }) } },
    (req, reply) => {
      const id = z.uuid().safeParse(req.params.ref);
      if (!id.success) throw notFound();
      return scopedWrite(pools, req, reply, async (tx, client) => {
        const who = await whoAmI(client);
        const row = await managedProvider(client, id.data.toLowerCase(), true);
        await retireProvider(client, row.id);
        await audited(tx, {
          ...auditHome(who, row.scope === 'instance'),
          actor: { type: 'user', id: who.userId },
          action: 'ai.provider_remove',
          entity: { type: 'ai_provider', id: row.id },
          before: { kind: row.kind, base_url: row.base_url, key_hint: row.key_hint },
          after: null,
          requestId: req.id,
        });
        return {
          status: 204,
          body: undefined,
          ...(row.scope === 'instance'
            ? { afterCommit: async () => void (await resolveKeyRejected(pools)) }
            : {}),
        };
      });
    },
  );

  app.post(
    '/api/v1/ai/providers/:id/test',
    {
      schema: {
        params: Params,
        response: {
          200: z.object({
            vision: z.object({
              ok: z.boolean(),
              latencyMs: z.number(),
              error: z.string().optional(),
            }),
            structured: z.object({ ok: z.boolean(), error: z.string().optional() }),
            model: z.string(),
            tokens: z.number(),
            cost: z
              .object({
                amount: z.string(),
                currency: z.string(),
                source: z.enum(['provider', 'price_table']),
              })
              .optional(),
          }),
        },
      },
    },
    async (req, reply) => {
      const ai = deps.ai;
      if (!ai) throw new AppError('ai_unavailable', 409, 'AI is not set up on this server.');
      const scope = requireScope(req);
      const id = req.params.id;
      // A random id and another household's answer the same 404 (kept.ai_provider_secret).
      await scopedRead(pools, req, (_tx, client) => managedProvider(client, id));
      await limit(deps, req, reply, 'test', TESTS_PER_MINUTE, 60);
      const rt = await ai.runtime(scope);
      const resolved = await rt.keys.forProvider(id, 'extraction' satisfies AiTask);
      if (!resolved) throw invalid('Choose a model for photos first.');
      // Two real calls, each a `connection_test` ledger row paid by the provider's scope.
      const result = await testConnection(rt, {
        resolved,
        userId: scope.userId,
        requestId: req.id,
        jobId: `test:${req.id}`,
      });
      return scopedWrite(pools, req, reply, async (tx, client) => {
        const who = await whoAmI(client);
        const row = await managedProvider(client, id, true);
        const visionSettled = result.vision.ok
          ? true
          : result.vision.error === 'wrong_answer'
            ? false
            : null;
        const list = row.model_list?.map((m) =>
          m.id === result.model && m.vision === null && visionSettled !== null
            ? { ...m, vision: visionSettled, visionSource: 'test' as const }
            : m,
        );
        const capabilities = {
          ...(visionSettled !== null ? { vision: visionSettled } : {}),
          structured: result.structured.ok,
          testedAt: new Date().toISOString(),
          model: result.model,
        };
        await client.query(
          'UPDATE public.ai_providers SET capabilities = $2, model_list = $3 WHERE id = $1',
          [row.id, JSON.stringify(capabilities), list ? JSON.stringify(list) : null],
        );
        await audited(tx, {
          ...auditHome(who, row.scope === 'instance'),
          actor: { type: 'user', id: who.userId },
          action: 'ai.provider_test',
          entity: { type: 'ai_provider', id: row.id },
          before: null,
          after: {
            model: result.model,
            vision_ok: result.vision.ok,
            structured_ok: result.structured.ok,
            tokens: result.tokens,
            call_ids: result.callIds,
          },
          requestId: req.id,
        });
        // A key that reads a photo: what waited for a provider goes now.
        if (result.vision.ok)
          await resendWaiting(deps, client, who, row.scope, { rejected: false });
        return {
          status: 200,
          body: {
            vision: {
              ok: result.vision.ok,
              latencyMs: result.vision.latencyMs ?? 0,
              ...(result.vision.error ? { error: result.vision.error } : {}),
            },
            structured: {
              ok: result.structured.ok,
              ...(result.structured.error ? { error: result.structured.error } : {}),
            },
            model: result.model,
            tokens: result.tokens,
            ...(result.cost ? { cost: result.cost } : {}),
          },
        };
      });
    },
  );

  app.get(
    '/api/v1/ai/providers/:id/models',
    {
      schema: {
        params: Params,
        querystring: z.object({ refresh: z.enum(['1', 'true', '0', 'false']).optional() }),
        response: { 200: ModelListingSchema },
      },
    },
    async (req, reply) => {
      const scope = requireScope(req);
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const id = req.params.id;
      const pre = await scopedRead(pools, req, async (_tx, client) => {
        const row = await managedProvider(client, id);
        const key =
          refresh || !row.model_list ? await providerKey(client, needKeys(), row.id) : null;
        return { row, key };
      });
      let row = pre.row;
      if (refresh || !row.model_list) {
        if (refresh) await limit(deps, req, reply, 'models', TESTS_PER_MINUTE, 60);
        let list: StoredModel[];
        try {
          list = storedModels(
            await lister({ mock, fetch: await listingFetchFor(scope) })(
              { kind: row.kind, baseUrl: row.base_url },
              pre.key,
            ),
            row.model_list,
          );
        } catch (e) {
          throw listingError(e);
        }
        // Not a model call (§8a): no ledger row; audited as a settings action.
        row = await scopedRead(pools, req, async (tx, client) => {
          const who = await whoAmI(client);
          const { rows } = await client.query<ProviderRow>(
            `UPDATE public.ai_providers SET model_list = $2, model_list_at = now()
              WHERE id = $1 AND disabled_at IS NULL
              RETURNING id, scope, owner_account_id, user_id, kind, model_list, model_list_at,
                        label, base_url, key_hint, models, capabilities, reasoning, disabled_at,
                        row_version`,
            [id, JSON.stringify(list)],
          );
          const updated = rows[0];
          if (!updated) throw notFound();
          await audited(tx, {
            ...auditHome(who, updated.scope === 'instance'),
            actor: { type: 'user', id: who.userId },
            action: 'ai.provider_models',
            entity: { type: 'ai_provider', id },
            before: null,
            after: { models_listed: list.length },
            requestId: req.id,
          });
          return updated;
        });
      }
      const list = row.model_list ?? [];
      return {
        models: list.map((m) => ({
          id: m.id,
          vision: m.vision,
          text: m.text,
          embeddings: m.embeddings,
          visionSource: m.visionSource,
        })),
        fetchedAt: row.model_list_at ? new Date(row.model_list_at).toISOString() : null,
        chosenMissing: chosenMissing(row.models, list),
      };
    },
  );

  // ----- "What uses AI", caps, pause and resume -----------------------------------------------

  const ScopeQuery = z.object({ scope: AiScope.default('me'), locationId: Id.optional() });

  app.get(
    '/api/v1/ai/explain',
    { schema: { querystring: ScopeQuery, response: { 200: ExplainSchema } } },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const who = await whoAmI(client);
        let scope = req.query.scope;
        const locationId = req.query.locationId ?? null;
        if (scope === 'location') {
          // Everyone may read the panel for a location they see; its history is its admins'.
          const { rows } = await client.query<{ admin: boolean; visible: boolean }>(
            `SELECT $1::uuid IN (SELECT kept.admin_location_ids()) AS admin,
                    $1::uuid IN (SELECT kept.visible_location_ids()) AS visible`,
            [locationId],
          );
          if (!rows[0]?.visible) throw notFound();
          if (!rows[0].admin) scope = 'me';
        }
        if (scope === 'instance' && !who.instanceAdmin) throw notFound();
        const to = new Date();
        const from = new Date(to.getTime() - 30 * 86_400_000);
        const rows = await usageRows(
          client,
          scope,
          scopeId(who, scope, locationId),
          from,
          to,
          'task',
        );
        const price = await scopePrice(client, who, req.query.scope, locationId);
        return explainFrom(rows, price);
      }),
  );

  app.get(
    '/api/v1/ai/caps',
    {
      schema: {
        querystring: ScopeQuery,
        response: {
          200: z.object({ caps: z.array(CapSchema), suggested: SuggestedSchema.optional() }),
        },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const who = await whoAmI(client);
        const locationId = req.query.locationId ?? null;
        const caps = await capViews(
          client,
          who,
          await capRows(client, who, req.query.scope, locationId),
        );
        if (caps.some((c) => c.monthlyCap || c.tokensPerMonth)) return { caps };
        // No cap yet: setup suggests one (§3.5), from the last 30 days where the caller may see them.
        const price = await scopePrice(client, who, req.query.scope, locationId);
        let projected: string | null = null;
        if (price) {
          const to = new Date();
          const from = new Date(to.getTime() - 30 * 86_400_000);
          const scope = req.query.scope;
          const allowed =
            scope !== 'location' ||
            (
              await client.query<{ ok: boolean }>(
                'SELECT $1::uuid IN (SELECT kept.admin_location_ids()) AS ok',
                [locationId],
              )
            ).rows[0]?.ok === true;
          if (allowed && (scope !== 'instance' || who.instanceAdmin)) {
            const t = totalsOf(
              mergeGroups(
                await usageRows(client, scope, scopeId(who, scope, locationId), from, to, 'task'),
                'task',
              ),
            );
            projected = t.cost.find((c) => c.currency === price.currency)?.amount ?? null;
          }
        }
        return { caps, suggested: suggestion(price, projected) };
      }),
  );

  app.put(
    '/api/v1/ai/caps',
    { schema: { body: PutCapBody, response: { 200: CapSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client) => {
        const who = await whoAmI(client);
        const b = req.body;
        if (b.monthlyCap) await requireCurrency(client, b.monthlyCap.currency);
        const before = await existingCap(client, who, b);
        if (before && req.headers['if-match'] !== undefined) {
          checkVersion({ rowVersion: before.row_version }, requireIfMatch(req));
        }
        const { rows } = await client.query<{ id: string }>('SELECT kept.ai_cap_set($1) AS id', [
          JSON.stringify({
            ...capTarget(b),
            ...(b.tokensPerMinute ? { tokensPerMinute: b.tokensPerMinute } : {}),
            ...(b.tokensPerDay ? { tokensPerDay: b.tokensPerDay } : {}),
            ...(b.tokensPerMonth ? { tokensPerMonth: b.tokensPerMonth } : {}),
            ...(b.monthlyCap
              ? { monthlyCapAmount: b.monthlyCap.amount, capCurrency: b.monthlyCap.currency }
              : {}),
          }),
        ]);
        const row = await capRow(client, rows[0]?.id as string);
        await audited(tx, {
          ...capAuditHome(who, row.scope, row.location_id),
          actor: { type: 'user', id: who.userId },
          action: 'ai.cap_set',
          entity: { type: 'ai_budget', id: row.id },
          before: capAudit(before),
          after: capAudit(row),
          fieldClasses: { monthly_cap_amount: 'money' },
          requestId: req.id,
        });
        const [view] = await capViews(client, who, [row]);
        return { status: 200, body: view as z.infer<typeof CapSchema> };
      }),
  );

  app.delete('/api/v1/ai/caps/:id', { schema: { params: Params } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client) => {
      const who = await whoAmI(client);
      const row = await capRow(client, req.params.id);
      await client.query('SELECT kept.ai_cap_clear($1)', [row.id]);
      await audited(tx, {
        ...capAuditHome(who, row.scope, row.location_id),
        actor: { type: 'user', id: who.userId },
        action: 'ai.cap_clear',
        entity: { type: 'ai_budget', id: row.id },
        before: capAudit(row),
        after: null,
        fieldClasses: { monthly_cap_amount: 'money' },
        requestId: req.id,
      });
      const instance = row.scope === 'instance' || row.scope === 'instance_account';
      return {
        status: 204,
        body: undefined,
        ...(instance ? { afterCommit: () => resolveCapAlerts(pools, row.id) } : {}),
      };
    }),
  );

  app.post(
    '/api/v1/ai/caps/:id/resume',
    {
      schema: {
        params: Params,
        body: ResumeBody,
        response: { 200: z.object({ cap: CapSchema, resumed: z.number() }) },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client) => {
        const who = await whoAmI(client);
        const before = await capRow(client, req.params.id);
        const b = req.body ?? {};
        let raise: Record<string, unknown> = {};
        if (b.remove) raise = { remove: true };
        else if (b.raiseTo && 'tokens' in b.raiseTo) raise = { tokens: b.raiseTo.tokens };
        else if (b.raiseTo && 'amount' in b.raiseTo) {
          await requireCurrency(client, b.raiseTo.currency);
          raise = { amount: b.raiseTo.amount, currency: b.raiseTo.currency };
        }
        const { rows } = await client.query<{ extraction_id: string }>(
          'SELECT extraction_id FROM kept.ai_resume($1, $2)',
          [before.id, JSON.stringify(raise)],
        );
        // The paused work goes again at once, oldest first; the pacer spaces it (§8a).
        const resumed = await resend(
          deps,
          client,
          rows.map((r) => r.extraction_id),
        );
        const after = await capRow(client, before.id);
        await audited(tx, {
          ...capAuditHome(who, after.scope, after.location_id),
          actor: { type: 'user', id: who.userId },
          action: 'ai.resume',
          entity: { type: 'ai_budget', id: after.id },
          before: capAudit(before),
          after: { ...capAudit(after), resumed: rows.length },
          fieldClasses: { monthly_cap_amount: 'money' },
          requestId: req.id,
        });
        const [cap] = await capViews(client, who, [after]);
        const instance = after.scope === 'instance' || after.scope === 'instance_account';
        return {
          status: 200,
          body: {
            cap: cap as z.infer<typeof CapSchema>,
            resumed: deps.jobs ? resumed : rows.length,
          },
          ...(instance ? { afterCommit: () => resolveCapAlerts(pools, after.id) } : {}),
        };
      }),
  );

  app.post(
    '/api/v1/ai/pause',
    { schema: { body: PauseBody, response: { 200: CapSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client) => {
        const who = await whoAmI(client);
        const { rows } = await client.query<{ id: string }>('SELECT kept.ai_pause($1) AS id', [
          JSON.stringify(capTarget(req.body)),
        ]);
        const row = await capRow(client, rows[0]?.id as string);
        await audited(tx, {
          ...capAuditHome(who, row.scope, row.location_id),
          actor: { type: 'user', id: who.userId },
          action: 'ai.pause',
          entity: { type: 'ai_budget', id: row.id },
          before: null,
          after: capAudit(row),
          fieldClasses: { monthly_cap_amount: 'money' },
          requestId: req.id,
        });
        const [view] = await capViews(client, who, [row]);
        return { status: 200, body: view as z.infer<typeof CapSchema> };
      }),
  );

  // ----- prices --------------------------------------------------------------------------------

  app.get(
    '/api/v1/ai/prices',
    {
      schema: {
        querystring: z.object({ history: z.string().max(5).optional() }),
        response: { 200: z.object({ prices: z.array(PriceSchema) }) },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => ({
        prices: await listPrices(
          client,
          req.query.history !== undefined && !['0', 'false'].includes(req.query.history),
        ),
      })),
  );

  const adminOnly = async (client: pg.ClientBase): Promise<Who> => {
    const who = await whoAmI(client);
    if (!who.instanceAdmin) throw forbidden('Only instance admins can change AI prices.');
    return who;
  };

  app.post(
    '/api/v1/admin/ai/prices',
    { schema: { body: PutPriceBody, response: { 201: PriceSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client) => {
        const who = await adminOnly(client);
        const b = req.body;
        await requireCurrency(client, b.currency);
        const before = await currentPrice(client, b.providerKind, b.model);
        const { rows } = await client.query<{ id: string }>('SELECT kept.ai_price_set($1) AS id', [
          JSON.stringify({
            providerKind: b.providerKind,
            model: b.model,
            inputPerMtok: b.inputPerMtok,
            outputPerMtok: b.outputPerMtok,
            ...(b.reasoningPerMtok ? { reasoningPerMtok: b.reasoningPerMtok } : {}),
            ...(b.cachedInputPerMtok ? { cachedInputPerMtok: b.cachedInputPerMtok } : {}),
            ...(b.perImage ? { perImage: b.perImage } : {}),
            currency: b.currency,
            source: b.listingFetchedAt ? 'provider_listing' : 'admin',
            ...(b.listingFetchedAt ? { listingFetchedAt: b.listingFetchedAt } : {}),
          }),
        ]);
        const price = await priceById(client, rows[0]?.id as string);
        await audited(tx, {
          ...auditHome(who, true),
          actor: { type: 'user', id: who.userId },
          action: 'ai.price_set',
          entity: { type: 'ai_model_price', id: rows[0]?.id as string },
          before: before ? { version: before.version } : null,
          after: {
            provider_kind: price.providerKind,
            model: price.model,
            version: price.version,
            ...price.rates,
            currency: price.currency,
            source: price.source,
          },
          requestId: req.id,
        });
        return { status: 201, body: price };
      }),
  );

  app.post(
    '/api/v1/admin/ai/prices/prefill',
    {
      schema: {
        body: z.object({ providerId: Id }),
        response: { 200: z.object({ prices: z.array(PrefillRow) }) },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client) => {
        const who = await adminOnly(client);
        const provider = await managedProvider(client, req.body.providerId);
        const prices = prefillRows(provider);
        // Nothing is saved; the proposal is audited as a settings action (§8a), like a listing.
        await audited(tx, {
          ...auditHome(who, true),
          actor: { type: 'user', id: who.userId },
          action: 'ai.price_prefill',
          entity: { type: 'ai_provider', id: provider.id },
          before: null,
          after: { proposed: prices.length },
          requestId: req.id,
        });
        return { status: 200, body: { prices } };
      }),
  );

  app.delete(
    '/api/v1/admin/ai/prices/:providerKind/:model',
    {
      schema: {
        params: z.object({ providerKind: z.string().max(40), model: z.string().min(1).max(120) }),
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client) => {
        const who = await adminOnly(client);
        const { providerKind, model } = req.params;
        const before = await currentPrice(client, providerKind, model);
        if (!before) throw notFound();
        await client.query('SELECT kept.ai_price_remove($1, $2)', [providerKind, model]);
        await audited(tx, {
          ...auditHome(who, true),
          actor: { type: 'user', id: who.userId },
          action: 'ai.price_remove',
          entity: { type: 'ai_model_price', id: before.id },
          before: { provider_kind: providerKind, model, version: before.version },
          after: null,
          requestId: req.id,
        });
        return { status: 204, body: undefined };
      }),
  );

  app.post(
    '/api/v1/admin/ai/prices/recost',
    {
      schema: {
        body: z.object({
          providerKind: z.string().max(40),
          model: z.string().min(1).max(120),
          since: When,
        }),
        response: { 200: z.object({ recosted: z.number() }) },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client) => {
        const who = await adminOnly(client);
        const { providerKind, model, since } = req.body;
        const { rows } = await client.query<{ n: number }>(
          'SELECT kept.ai_recost_unknown($1, $2, $3) AS n',
          [providerKind, model, since],
        );
        const recosted = rows[0]?.n ?? 0;
        await audited(tx, {
          ...auditHome(who, true),
          actor: { type: 'user', id: who.userId },
          action: 'ai.price_recost',
          entity: { type: 'ai_model_price', id: null },
          before: null,
          after: { provider_kind: providerKind, model, since, recosted },
          requestId: req.id,
        });
        return { status: 200, body: { recosted } };
      }),
  );

  // ----- usage and the call list ---------------------------------------------------------------

  app.get(
    '/api/v1/ai/usage',
    {
      schema: {
        querystring: ScopeQuery.extend({
          from: When.optional(),
          to: When.optional(),
          groupBy: GroupBy.default('day'),
        }),
        response: {
          200: z.object({
            scope: AiScope,
            from: z.string(),
            to: z.string(),
            soFar: z.boolean(),
            groups: z.array(UsageGroupSchema),
            totals: UsageGroupSchema.omit({ key: true, label: true }),
            caps: z.array(CapSchema),
          }),
        },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const who = await whoAmI(client);
        const { scope, groupBy } = req.query;
        const locationId = req.query.locationId ?? null;
        const now = new Date();
        const from = req.query.from
          ? new Date(req.query.from)
          : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const to = req.query.to ? new Date(req.query.to) : now;
        if (!(from < to)) throw invalid('`from` is before `to`.');
        if (groupBy === 'account' && scope !== 'instance') {
          throw invalid('Grouping by account is for the instance.');
        }
        const id = scopeId(who, scope, locationId);
        const groups = mergeGroups(await usageRows(client, scope, id, from, to, groupBy), groupBy);
        if (groupBy === 'day') {
          const tasks = await dayTasks(client, who, scope, id, from, to);
          for (const g of groups) {
            const t = tasks.get(g.key);
            if (t) g.tasks = t;
          }
        }
        return {
          scope,
          from: from.toISOString(),
          to: to.toISOString(),
          soFar: to.getTime() >= now.getTime() - 60_000,
          groups,
          totals: totalsOf(groups),
          caps: await capViews(client, who, await capRows(client, who, scope, locationId)),
        };
      }),
  );

  app.get(
    '/api/v1/ai/calls',
    { schema: { querystring: CallsQuery, response: { 200: CallPageSchema } } },
    (req) =>
      scopedRead(pools, req, async (tx, client, scope) =>
        listCalls(
          {
            tx,
            client,
            scope,
            who: await whoAmI(client),
            tz: timezoneOf(req.headers['x-kept-timezone']),
          },
          req.query,
        ),
      ),
  );

  app.get('/api/v1/ai/calls.csv', { schema: { querystring: CallsQuery } }, async (req, reply) => {
    await limit(deps, req, reply, 'csv', EXPORTS_PER_HOUR, 3600);
    const csv = await scopedWrite(pools, req, reply, async (tx, client, scope) => {
      const who = await whoAmI(client);
      const out = await callsCsv(
        { tx, client, scope, who, tz: timezoneOf(req.headers['x-kept-timezone']) },
        req.query,
      );
      const { scope: s, locationId } = req.query;
      await audited(tx, {
        ...capAuditHome(who, s === 'instance' ? 'instance' : s, locationId ?? null),
        actor: { type: 'user', id: who.userId },
        action: 'ai.usage_export',
        entity: { type: 'llm_calls', id: null },
        before: null,
        after: { scope: s, rows: out.rows },
        requestId: req.id,
      });
      return { status: 200, body: out.csv };
    });
    reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="ai-calls.csv"')
      .header('cache-control', 'no-store');
    return csv;
  });

  app.get(
    '/api/v1/ai/calls/:id',
    { schema: { params: Params, response: { 200: CallDetailSchema } } },
    (req) =>
      scopedRead(pools, req, async (tx, client, scope) =>
        callDetail(
          {
            tx,
            client,
            scope,
            who: await whoAmI(client),
            tz: timezoneOf(req.headers['x-kept-timezone']),
          },
          req.params.id,
        ),
      ),
  );
}
