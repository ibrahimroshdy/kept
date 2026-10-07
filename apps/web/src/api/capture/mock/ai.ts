/**
 * Mock handlers for AI settings, caps, prices, usage and the call ledger (T9, §7.15, D206).
 * Keys are write-only: a PUT stores the last four characters as `keyHint` and nothing else. The
 * first AI key anywhere needs the recovery kit (409 `recovery_kit_required`, D193). Home starts
 * paused until the 1st of next month at its money cap.
 *
 * Who may do what follows §7.15, approximated from the caller's roles: a location's owner writes
 * its account's caps and resumes them; its admins read its cap; everyone reads their own calls.
 * Money follows the gate: a viewer's rows in a location that hides money carry no cost and
 * `moneyHidden: true`. The CSV export answers `text/csv` with the list's columns (T29a).
 *
 * As T9's server does (apps/server/src/ai/api.ts): replacing a provider needs If-Match (428
 * without it, 412 when stale); a model listing the provider refuses or doesn't answer is 409
 * `ai_unavailable` (here: an OpenAI-compatible base URL on a `.invalid` host); the instance's own
 * caps and the instance key's calls carry an empty label; Resume with `remove` keeps the cap's row
 * with its monthly limits cleared; the instance's calls are newest first only; usage defaults to
 * the current UTC month; a price saved with `listingFetchedAt` is a `provider_listing` version.
 */
import {
  budgetTaskOf,
  CSV_BOM,
  CSV_EOL,
  type CsvValue,
  DEFAULT_MODELS,
  detectKind,
  type LedgerTask,
  type ProviderKind,
  RECOMMENDED,
  REFERENCE_FIGURES,
  safeCsvCell,
} from '@kept/shared';
import { dateBounds } from '@/components/filters/params';
import { accessOf, newId, now, paginate } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import {
  err,
  forbidden,
  type MockRoute,
  notFound,
  reply,
  route,
  sessionGate,
} from '../../mock/kit';
import { capturePaths as p } from '../paths';
import type {
  AiCall,
  AiCap,
  AiExplain,
  AiModelListing,
  AiProvider,
  AiScope,
  AiStatus,
  AiUsage,
  AiUsageGroup,
  AiUsageGroupBy,
  PauseAiBody,
  PutAiCapBody,
  PutAiPriceBody,
  PutAiProviderBody,
  ResumeAiBody,
} from '../types';

const NO_PROVIDER: AiStatus = {
  resolved: false,
  source: null,
  providerKind: null,
  model: null,
  pausedUntil: null,
  reason: null,
  pausedBy: null,
  waitingProvider: null,
  capPercent: null,
  canResume: false,
  canManage: false,
  manager: null,
  modelMissing: false,
};

/** "What uses AI in Kept", in the screens' order (§5 AI settings). */
const EXPLAIN_TASKS: LedgerTask[] = [
  'extract_thing',
  'extract_receipt',
  'extract_label',
  'extract_reading',
  'assistant_turn',
  'embed_query',
  'connection_test',
];

/** A provider's model listing, per kind, as the list-models endpoints report them (D202). */
const LISTINGS: Record<ProviderKind, AiModelListing['models']> = {
  groq: [
    { id: RECOMMENDED.model, vision: true, text: true, embeddings: false, visionSource: 'listing' },
    {
      id: 'openai/gpt-oss-120b',
      vision: false,
      text: true,
      embeddings: false,
      visionSource: 'listing',
    },
    {
      id: 'llama-3.3-70b-versatile',
      vision: null,
      text: true,
      embeddings: false,
      visionSource: null,
    },
  ],
  openai: [
    { id: 'gpt-6-luna', vision: true, text: true, embeddings: false, visionSource: 'listing' },
    { id: 'gpt-6-sol', vision: true, text: true, embeddings: false, visionSource: 'listing' },
    {
      id: 'text-embedding-3-small',
      vision: false,
      text: false,
      embeddings: true,
      visionSource: 'listing',
    },
  ],
  anthropic: [
    { id: 'claude-sonnet-5', vision: true, text: true, embeddings: false, visionSource: 'listing' },
  ],
  google: [
    {
      id: 'gemini-3.8-flash',
      vision: true,
      text: true,
      embeddings: false,
      visionSource: 'listing',
    },
    {
      id: 'gemini-embedding-001',
      vision: false,
      text: false,
      embeddings: true,
      visionSource: 'listing',
    },
  ],
  openrouter: [
    {
      id: 'openai/gpt-6-luna',
      vision: true,
      text: true,
      embeddings: false,
      visionSource: 'listing',
    },
  ],
  openai_compatible: [
    { id: 'qwen2.5vl:7b', vision: null, text: true, embeddings: false, visionSource: null },
    { id: 'nomic-embed-text', vision: false, text: false, embeddings: true, visionSource: null },
  ],
};

/** A self-hosted endpoint that doesn't answer: a base URL on the reserved `.invalid` TLD. */
const unreachable = (provider: AiProvider) =>
  provider.kind === 'openai_compatible' &&
  !!provider.baseUrl &&
  /^https?:\/\/[^/]+\.invalid(:\d+)?(\/|$)/i.test(provider.baseUrl);

/** `a..b` (either end empty) as numbers. */
function range(value: string | null): { min: number | null; max: number | null } {
  const [a = '', b = ''] = (value ?? '').split('..');
  return { min: a === '' ? null : Number(a), max: b === '' ? null : Number(b) };
}
const within = (n: number, r: { min: number | null; max: number | null }) =>
  (r.min === null || n >= r.min) && (r.max === null || n <= r.max);

/** Input plus output; the output already includes reasoning (§7.15's cost note). */
const totalTokens = (c: AiCall) => (c.tokens.input ?? 0) + (c.tokens.output ?? 0);

/** Sums per currency, as canonical decimal strings. */
function addCost(into: Map<string, number>, c: AiCall) {
  if (c.cost) into.set(c.cost.currency, (into.get(c.cost.currency) ?? 0) + Number(c.cost.amount));
}
const costList = (m: Map<string, number>) =>
  [...m].map(([currency, amount]) => ({ currency, amount: amount.toFixed(4) }));

function aggregate(calls: AiCall[]): Omit<AiUsageGroup, 'key' | 'label'> {
  const cost = new Map<string, number>();
  const outcomes: AiUsageGroup['outcomes'] = {};
  for (const c of calls) {
    addCost(cost, c);
    outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
  }
  return {
    calls: calls.length,
    sentCalls: calls.filter((c) => c.sent).length,
    tokens: {
      input: calls.reduce((n, c) => n + (c.tokens.input ?? 0), 0),
      output: calls.reduce((n, c) => n + (c.tokens.output ?? 0), 0),
      reasoning: calls.reduce((n, c) => n + (c.tokens.reasoning ?? 0), 0),
      cached: calls.reduce((n, c) => n + (c.tokens.cached ?? 0), 0),
    },
    images: calls.reduce((n, c) => n + (c.sent ? c.images.count : 0), 0),
    cost: costList(cost),
    unknownCostCalls: calls.filter((c) => c.sent && !c.cost && !c.moneyHidden).length,
    outcomes,
  };
}

/** Calls and tokens per budget task, for the day chart's stacks. */
function byTask(calls: AiCall[]): AiUsageGroup['tasks'] {
  const out: NonNullable<AiUsageGroup['tasks']> = {};
  for (const c of calls) {
    const k = budgetTaskOf(c.task);
    const e = out[k] ?? { calls: 0, tokens: 0 };
    e.calls += 1;
    e.tokens += totalTokens(c);
    out[k] = e;
  }
  return out;
}

const CSV_COLUMNS = [
  'at',
  'request_id',
  'attempt',
  'task',
  'provider',
  'model',
  'location',
  'person',
  'paid_by',
  'fell_back',
  'sent',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cached_tokens',
  'images',
  'image_bytes',
  'latency_ms',
  'outcome',
  'error_code',
] as const;
const MONEY_COLUMNS = ['cost', 'currency', 'cost_source'] as const;

export function aiRoutes(state: MockState): MockRoute[] {
  const cap = () => state.capture;
  const access = () => accessOf(state);
  const isAdmin = () => state.me.user.instanceAdmin;
  const meId = () => state.me.user.id;
  const gated = <T>(fn: () => T) => sessionGate(state) ?? fn();
  const roleIn = (id: string) => state.locations.find((l) => l.id === id)?.role ?? null;
  const locationOf = (id: string) => state.locations.find((l) => l.id === id);
  /** The caller owns this location, so they write its account's caps (§7.15). */
  const ownsLocation = (id: string) => roleIn(id) === 'owner';
  /** Who can resume or fix AI in a location: its owner (the sample cast's Ibrahim). */
  const ownerName = (locationId: string) => {
    const acct = locationOf(locationId)?.ownerAccountId;
    return (
      state.inventory.accounts.find((a) => a.id === acct)?.ownerDisplayName ??
      state.me.user.displayName
    );
  };

  const statusFor = (locationId: string | null): AiStatus => {
    if (!locationId || !access().visible(locationId)) return NO_PROVIDER;
    const s = cap().aiStatus[locationId];
    if (!s) return NO_PROVIDER;
    const owner = ownsLocation(locationId);
    return {
      ...s,
      canResume: owner && s.canResume,
      canManage: owner && s.canManage,
      manager: owner ? null : { displayName: ownerName(locationId) },
    };
  };

  /** Who may edit a cap, from its scope and the caller's roles. */
  const canEdit = (c: AiCap): boolean => {
    switch (c.scope) {
      case 'instance':
      case 'instance_account':
        return isAdmin();
      case 'location':
        return !!c.target.id && ownsLocation(c.target.id);
      case 'user':
        return c.target.id === meId();
      default:
        return state.locations.some((l) => l.role === 'owner' && l.kind !== 'personal');
    }
  };
  const canRead = (c: AiCap): boolean =>
    canEdit(c) ||
    (c.scope === 'location' && !!c.target.id && access().isAdmin(c.target.id)) ||
    (c.scope === 'member' && c.target.id === meId());
  const withEdit = (c: AiCap): AiCap => ({ ...c, canEdit: canEdit(c) });

  /** Resume or remove a cap: the pause ends everywhere it was the reason. */
  const unpause = (label: string) => {
    let resumed = 0;
    for (const s of Object.values(cap().aiStatus)) {
      if (s.pausedBy?.label === label) {
        s.pausedUntil = null;
        s.reason = null;
        s.pausedBy = null;
        s.canResume = false;
        s.capPercent = null;
      }
    }
    for (const list of Object.values(cap().extractions)) {
      for (const x of list) {
        if (x.status === 'paused_budget') {
          x.status = 'queued';
          x.pausedUntil = null;
          x.statusReason = null;
          resumed += 1;
        }
      }
    }
    return resumed;
  };

  /** The calls a scope may see (§7.15's visibility table), with money per the gate. */
  const callsIn = (scope: AiScope, locationId: string | null): AiCall[] | null => {
    const all = cap().calls;
    const gate = (c: AiCall): AiCall => {
      const loc = c.location ? locationOf(c.location.id) : undefined;
      const hidden =
        !!loc && loc.role === 'viewer' && !(loc.moneyVisibleToViewers ?? false) && !!c.cost;
      if (!hidden) return c;
      const { cost: _cost, ...rest } = c;
      return { ...rest, moneyHidden: true };
    };
    switch (scope) {
      case 'me':
        return all.filter((c) => c.person !== 'background' && c.person?.id === meId()).map(gate);
      case 'location':
        if (!locationId || !access().isAdmin(locationId)) return null;
        return all.filter((c) => c.location?.id === locationId).map(gate);
      case 'account': {
        const owned = state.locations
          .filter((l) => l.role === 'owner' && l.kind !== 'personal')
          .map((l) => l.id);
        if (owned.length === 0) return null;
        return all.filter(
          (c) =>
            (c.location && owned.includes(c.location.id)) ||
            (!c.location && c.paidBy.scope === 'account'),
        );
      }
      case 'instance':
        if (!isAdmin()) return null;
        return all
          .filter((c) => c.paidBy.scope === 'instance')
          .map((c) => {
            const { location: _l, links: _k, ...rest } = c;
            return { ...rest, links: {} };
          });
    }
  };

  /** The list's filters (§7.15), from the query string. */
  const filtered = (calls: AiCall[], query: URLSearchParams): AiCall[] => {
    const not = new Set(query.getAll('not'));
    const any = (param: string, value: string | undefined) => {
      const wanted = query.getAll(param);
      if (wanted.length === 0) return true;
      const hit = value !== undefined && wanted.includes(value);
      return not.has(param) ? !hit : hit;
    };
    const { from, to } = dateBounds(query.get('at') ?? undefined);
    const tokens = range(query.get('tokens'));
    const cost = range(query.get('cost'));
    const currency = query.get('currency');
    const q = query.get('q')?.toLowerCase();
    const dir = query.get('dir') === 'asc' ? 1 : -1;
    return calls
      .filter((c) => (!from || c.at >= from) && (!to || c.at < to))
      .filter((c) => any('task', c.task))
      .filter((c) => any('outcome', c.outcome))
      .filter((c) => any('model', c.model))
      .filter((c) => any('provider', c.providerKind))
      .filter((c) => any('paidBy', c.paidBy.scope))
      .filter((c) => any('location', c.location?.id))
      .filter((c) => any('thing', c.links.thingId))
      .filter((c) =>
        any('person', c.person === 'background' ? 'background' : (c.person?.id ?? undefined)),
      )
      .filter((c) => query.get('hasImage') !== 'true' || c.images.count > 0)
      .filter((c) => !query.get('tokens') || within(totalTokens(c), tokens))
      .filter(
        (c) =>
          !query.get('cost') ||
          (!!c.cost &&
            (!currency || c.cost.currency === currency) &&
            within(Number(c.cost.amount), cost)),
      )
      .filter((c) => !q || c.model.toLowerCase().includes(q) || c.requestId.includes(q))
      .sort((a, b) => dir * a.at.localeCompare(b.at));
  };

  const groupKey = (c: AiCall, by: AiUsageGroupBy): { key: string; label: string } => {
    switch (by) {
      case 'day':
        return { key: c.at.slice(0, 10), label: c.at.slice(0, 10) };
      case 'task':
        return { key: c.task, label: c.task };
      case 'model':
        return { key: `${c.providerKind}:${c.model}`, label: c.model };
      case 'person':
        return c.person === 'background' || !c.person
          ? { key: 'background', label: 'background' }
          : { key: c.person.id, label: c.person.name };
      case 'location':
        return c.location
          ? { key: c.location.id, label: c.location.name }
          : { key: 'none', label: '' };
      case 'account':
        return { key: c.paidBy.label, label: c.paidBy.label };
    }
  };

  const capsFor = (scope: AiScope, locationId: string | null): AiCap[] => {
    const all = cap().caps.filter(canRead).map(withEdit);
    switch (scope) {
      case 'instance':
        return all.filter((c) => c.scope === 'instance' || c.scope === 'instance_account');
      case 'me':
        return all.filter(
          (c) => (c.scope === 'user' || c.scope === 'member') && c.target.id === meId(),
        );
      case 'location':
        return all.filter(
          (c) =>
            (c.scope === 'location' && c.target.id === locationId) ||
            (c.scope === 'member' && c.target.id === meId()),
        );
      case 'account':
        return all.filter((c) => ['account', 'location', 'member'].includes(c.scope));
    }
  };

  const scopeOf = (query: URLSearchParams): AiScope =>
    (['me', 'location', 'account', 'instance'] as const).find((s) => s === query.get('scope')) ??
    'me';

  return [
    route('GET', p.aiStatus, ({ query }) => gated(() => statusFor(query.get('locationId')))),

    route('GET', p.aiProviders, () =>
      gated(() => ({
        providers: cap().providers.filter(
          (x) =>
            (x.scope === 'instance' && isAdmin()) ||
            x.scope === 'user' ||
            (x.scope === 'account' &&
              state.locations.some((l) => l.role === 'owner' && l.kind !== 'personal')),
        ),
      })),
    ),

    route('PUT', p.aiProvider(':scope'), ({ params, body, headers }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const scope = params.scope as 'instance' | 'account' | 'me';
      if (!['instance', 'account', 'me'].includes(scope)) return notFound();
      if (scope === 'instance' && !isAdmin()) return notFound();
      const b = body as PutAiProviderBody;
      const stored = scope === 'me' ? 'user' : scope;
      const existing = cap().providers.find((x) => x.scope === stored);
      if (existing) {
        const ifMatch = headers['if-match']?.trim();
        if (!ifMatch)
          return err(
            428,
            'precondition_failed',
            'Send If-Match with the row_version you started from.',
          );
        if (ifMatch !== String(existing.rowVersion))
          return err(412, 'precondition_failed', 'Reload to see the latest version.', undefined, {
            conflicts: [],
            row_version: existing.rowVersion,
          });
      }
      if (!existing && cap().providers.length === 0 && !state.me.instance.recoveryKitAcknowledged)
        return err(409, 'recovery_kit_required', 'Download the recovery kit first.');
      const kind = b.kind ?? (b.apiKey ? detectKind(b.apiKey) : existing?.kind) ?? null;
      if (!kind) return err(400, 'validation', 'Choose a provider.');
      if (kind === 'openai_compatible' && !b.baseUrl && !existing?.baseUrl)
        return err(400, 'validation', 'An OpenAI-compatible provider needs a base URL.');
      if (
        b.baseUrl &&
        !state.admin.settings.ssrfAllowPrivate &&
        /^https?:\/\/(10\.|192\.168\.|127\.|localhost)/.test(b.baseUrl)
      )
        return err(400, 'private_address', 'That address is on a private network.');
      const listing = LISTINGS[kind];
      if (kind !== 'openai_compatible' && b.models) {
        for (const id of Object.values(b.models))
          if (id && !listing.some((m) => m.id === id))
            return err(400, 'validation', "That model isn't in the provider's list.");
      }
      const defaults = DEFAULT_MODELS[kind].models;
      const offered = (id: string | null) =>
        id && listing.some((m) => m.id === id) ? id : undefined;
      const kindChanged = !!existing && existing.kind !== kind;
      const provider: AiProvider = {
        id: existing?.id ?? newId(),
        scope: stored,
        kind,
        label: b.label ?? existing?.label ?? null,
        baseUrl: b.baseUrl ?? (kindChanged ? null : (existing?.baseUrl ?? null)),
        keyHint: b.apiKey ? b.apiKey.trim().slice(-4) : (existing?.keyHint ?? null),
        models:
          b.models ??
          (existing && !kindChanged
            ? existing.models
            : {
                vision:
                  kind === RECOMMENDED.kind
                    ? RECOMMENDED.model
                    : (offered(defaults.extraction) ?? listing.find((m) => m.vision)?.id),
                chat: offered(defaults.assistant) ?? listing.find((m) => m.text)?.id,
                embeddings: offered(defaults.embeddings),
              }),
        capabilities: b.apiKey ? {} : (existing?.capabilities ?? {}),
        reasoning: b.reasoning ?? existing?.reasoning ?? 'low',
        disabled: false,
        rowVersion: (existing?.rowVersion ?? 0) + 1,
      };
      // Clean the undefined model slots so the JSON is what the server would send.
      for (const [k, v] of Object.entries(provider.models))
        if (!v) delete provider.models[k as keyof AiProvider['models']];
      cap().providers = [...cap().providers.filter((x) => x.id !== provider.id), provider];
      return provider;
    }),

    route('POST', p.aiProviderTest(':id'), ({ params }) => {
      const provider = cap().providers.find((x) => x.id === params.id);
      if (!provider) return notFound();
      provider.capabilities = { vision: true, structured: true };
      const t = REFERENCE_FIGURES.tasks.connection_test;
      const model = provider.models.vision ?? RECOMMENDED.model;
      const listed = LISTINGS[provider.kind].find((m) => m.id === model);
      if (listed && listed.vision === null) {
        listed.vision = true;
        listed.visionSource = 'test';
      }
      const priced = cap().prices.find(
        (x) => x.providerKind === provider.kind && x.model === model && !x.supersededAt,
      );
      return {
        vision: { ok: true, latencyMs: 820 },
        structured: { ok: true },
        model,
        tokens: (t.inputTokens + t.outputTokens) * 2,
        ...(priced
          ? {
              cost: {
                amount: (Number(t.cost) * 2).toFixed(4),
                currency: priced.currency,
                source: 'price_table',
              },
            }
          : {}),
      };
    }),

    route('GET', p.aiProviderModels(':id'), ({ params }) => {
      const provider = cap().providers.find((x) => x.id === params.id);
      if (!provider) return notFound();
      if (unreachable(provider))
        return err(
          409,
          'ai_unavailable',
          "AI isn't available for this location right now.",
          'The provider did not answer. Try again in a minute.',
        );
      const models = LISTINGS[provider.kind];
      const chosenMissing = (['vision', 'chat', 'embeddings'] as const).filter((slot) => {
        const id = provider.models[slot];
        return !!id && !models.some((m) => m.id === id);
      });
      return { models, fetchedAt: now(), chosenMissing } satisfies AiModelListing;
    }),

    route('DELETE', p.aiProvider(':id'), ({ params }) => {
      const provider = cap().providers.find((x) => x.id === params.id);
      if (!provider) return notFound();
      cap().providers = cap().providers.filter((x) => x.id !== provider.id);
      return reply(204);
    }),

    route('GET', p.aiExplain, ({ query }) =>
      gated((): AiExplain => {
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const recent = (callsIn(scopeOf(query), query.get('locationId')) ?? []).filter(
          (c) => c.at >= since,
        );
        const priced = (task: LedgerTask) =>
          cap().prices.some(
            (x) => x.model === REFERENCE_FIGURES.model && !x.supersededAt && task !== 'embed_query',
          );
        const projection = aggregate(recent);
        return {
          actions: EXPLAIN_TASKS.map((task) => {
            const mine = recent.filter((c) => c.task === task && c.sent);
            const perAction = task === 'connection_test' ? 2 : 1;
            if (mine.length >= 5) {
              const costs = mine.filter((c) => c.cost);
              const avgCost =
                costs.reduce((n, c) => n + Number(c.cost?.amount ?? 0), 0) / (costs.length || 1);
              return {
                task,
                callsPerAction: perAction,
                tokensTypical: Math.round(
                  mine.reduce((n, c) => n + totalTokens(c), 0) / mine.length,
                ),
                ...(costs.length
                  ? {
                      costTypical: {
                        amount: avgCost.toFixed(4),
                        currency: costs[0]?.cost?.currency ?? 'USD',
                      },
                    }
                  : {}),
                basis: 'history' as const,
              };
            }
            const f = REFERENCE_FIGURES.tasks[task as keyof typeof REFERENCE_FIGURES.tasks];
            return {
              task,
              callsPerAction: perAction,
              tokensTypical: f ? f.inputTokens + f.outputTokens : 0,
              ...(f && priced(task)
                ? { costTypical: { amount: f.cost, currency: REFERENCE_FIGURES.currency } }
                : {}),
              basis: 'reference' as const,
              referenceDate: REFERENCE_FIGURES.asOf,
            };
          }),
          projection: {
            days: 30,
            calls: projection.calls,
            tokens: projection.tokens.input + projection.tokens.output,
            cost: projection.cost,
            unknownCostCalls: projection.unknownCostCalls,
          },
        };
      }),
    ),

    route('GET', p.aiCaps, ({ query }) =>
      gated(() => {
        const caps = capsFor(scopeOf(query), query.get('locationId'));
        const priced = cap().prices.find((x) => !x.supersededAt);
        return caps.length > 0
          ? { caps }
          : {
              caps,
              suggested: priced
                ? { monthlyCap: { amount: '5', currency: priced.currency } }
                : { tokensPerMonth: 3_000_000 },
            };
      }),
    ),

    route('PUT', p.aiCaps, ({ body, headers }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as PutAiCapBody;
      if (b.scope === 'location' && (!b.locationId || !ownsLocation(b.locationId)))
        return notFound();
      if ((b.scope === 'instance' || b.scope === 'instance_account') && !isAdmin())
        return notFound();
      const account = cap().caps.find((c) => c.scope === 'account' && c.monthlyCap);
      if (
        b.scope === 'location' &&
        b.monthlyCap &&
        account?.monthlyCap &&
        account.monthlyCap.currency === b.monthlyCap.currency &&
        Number(b.monthlyCap.amount) > Number(account.monthlyCap.amount)
      )
        return err(400, 'cap_above_account', "A location's cap can't be above the account's.");
      const targetId =
        b.scope === 'user'
          ? meId()
          : (b.locationId ?? b.userId ?? b.accountId ?? (b.scope === 'account' ? 'account' : null));
      const existing = cap().caps.find(
        (c) => c.scope === b.scope && c.target.id === targetId && c.task === (b.task ?? null),
      );
      if (existing && headers['if-match'] && headers['if-match'] !== String(existing.rowVersion))
        return err(412, 'precondition_failed', 'This changed since you opened it.');
      // The instance's own caps carry no label (T9's capViews); the web names them.
      const label =
        existing?.target.label ??
        (b.locationId
          ? (locationOf(b.locationId)?.name ?? '')
          : b.scope === 'user'
            ? state.me.user.displayName
            : b.scope === 'instance' || b.scope === 'instance_account'
              ? ''
              : (state.inventory.accounts.find((a) => a.isOwn)?.ownerDisplayName ?? ''));
      const next: AiCap = {
        id: existing?.id ?? newId(),
        scope: b.scope,
        target: { id: targetId, label },
        task: b.task ?? null,
        ...(b.monthlyCap ? { monthlyCap: b.monthlyCap } : {}),
        ...(b.tokensPerMonth ? { tokensPerMonth: b.tokensPerMonth } : {}),
        ...(b.tokensPerDay ? { tokensPerDay: b.tokensPerDay } : {}),
        ...(b.tokensPerMinute ? { tokensPerMinute: b.tokensPerMinute } : {}),
        used: existing?.used ?? { tokens: 0, cost: [], unknownCostCalls: 0 },
        percent: existing?.percent ?? 0,
        state: existing?.state ?? 'active',
        ...(existing?.pausedUntil ? { pausedUntil: existing.pausedUntil } : {}),
        ...(existing?.reason ? { reason: existing.reason } : {}),
        cappedByAccount: false,
        rowVersion: (existing?.rowVersion ?? 0) + 1,
        canEdit: true,
      };
      cap().caps = [...cap().caps.filter((c) => c.id !== next.id), next];
      return next;
    }),

    route('DELETE', p.aiCap(':id'), ({ params }) => {
      const found = cap().caps.find((c) => c.id === params.id);
      if (!found || !canEdit(found)) return notFound();
      cap().caps = cap().caps.filter((c) => c.id !== found.id);
      unpause(found.target.label);
      return reply(204);
    }),

    route('POST', p.aiCapResume(':id'), ({ params, body }) => {
      const found = cap().caps.find((c) => c.id === params.id);
      if (!found || !canEdit(found)) return notFound();
      const b = (body ?? {}) as ResumeAiBody;
      if (b.remove) {
        // `kept.ai_resume` with remove: the row stays, its monthly limits cleared (T9).
        delete found.monthlyCap;
        delete found.tokensPerMonth;
        found.percent = null;
      }
      if (b.raiseTo && 'amount' in b.raiseTo) found.monthlyCap = b.raiseTo;
      if (b.raiseTo && 'tokens' in b.raiseTo) found.tokensPerMonth = b.raiseTo.tokens;
      found.state = 'active';
      delete found.pausedUntil;
      delete found.reason;
      if (found.monthlyCap) {
        const used = found.used.cost.find((x) => x.currency === found.monthlyCap?.currency);
        found.percent = Math.round(
          (Number(used?.amount ?? 0) / Number(found.monthlyCap.amount)) * 100,
        );
      }
      found.rowVersion += 1;
      const resumed = unpause(found.target.label);
      return { cap: withEdit(found), resumed };
    }),

    route('POST', p.aiPause, ({ body }) => {
      const b = body as PauseAiBody;
      if (b.scope === 'location' && (!b.locationId || !ownsLocation(b.locationId)))
        return notFound();
      const label = b.locationId
        ? (locationOf(b.locationId)?.name ?? '')
        : b.scope === 'instance' || b.scope === 'instance_account'
          ? ''
          : state.me.user.displayName;
      const statuses = b.locationId
        ? [cap().aiStatus[b.locationId]].filter((s): s is AiStatus => !!s)
        : Object.values(cap().aiStatus);
      for (const status of statuses) {
        status.pausedUntil = 'infinity';
        status.reason = 'manual';
        status.pausedBy = { scope: b.scope, label };
        status.canResume = true;
      }
      const targetId = b.locationId ?? (b.scope === 'account' ? 'account' : meId());
      const existing = cap().caps.find((c) => c.scope === b.scope && c.target.id === targetId);
      const paused: AiCap = {
        ...(existing ?? {
          id: newId(),
          scope: b.scope,
          target: { id: targetId, label },
          task: null,
          used: { tokens: 0, cost: [], unknownCostCalls: 0 },
          percent: null,
          cappedByAccount: false,
          rowVersion: 0,
          canEdit: true,
        }),
        state: 'paused',
        pausedUntil: 'infinity',
        reason: 'manual',
      };
      paused.rowVersion += 1;
      cap().caps = [...cap().caps.filter((c) => c.id !== paused.id), paused];
      return paused;
    }),

    route('GET', p.aiPrices, ({ query }) =>
      gated(() => ({
        prices: query.get('history')
          ? cap().prices
          : cap().prices.filter((x) => x.supersededAt === null),
      })),
    ),
    route('POST', p.adminAiPrices, ({ body }) => {
      if (!isAdmin()) return forbidden();
      const b = body as PutAiPriceBody;
      const current = cap().prices.find(
        (x) => x.providerKind === b.providerKind && x.model === b.model && x.supersededAt === null,
      );
      const at = now();
      if (current) current.supersededAt = at;
      const created = {
        providerKind: b.providerKind,
        model: b.model,
        version:
          Math.max(
            0,
            ...cap()
              .prices.filter((x) => x.providerKind === b.providerKind && x.model === b.model)
              .map((x) => x.version),
          ) + 1,
        rates: {
          inputPerMtok: b.inputPerMtok,
          outputPerMtok: b.outputPerMtok,
          reasoningPerMtok: b.reasoningPerMtok ?? null,
          cachedInputPerMtok: b.cachedInputPerMtok ?? null,
          perImage: b.perImage ?? null,
        },
        currency: b.currency,
        effectiveFrom: at,
        supersededAt: null,
        source: b.listingFetchedAt ? ('provider_listing' as const) : ('admin' as const),
        listingFetchedAt: b.listingFetchedAt ?? null,
      };
      cap().prices.push(created);
      return reply(201, created);
    }),
    route('POST', p.adminAiPricesPrefill, ({ body }) => {
      if (!isAdmin()) return forbidden();
      const provider = cap().providers.find(
        (x) => x.id === (body as { providerId?: string }).providerId,
      );
      if (!provider) return notFound();
      // Groq and OpenRouter list USD per token; the server converts to per million (§7.15).
      // Fixture numbers for the screens, not the provider's list price.
      return {
        prices:
          provider.kind === 'groq' || provider.kind === 'openrouter'
            ? [
                {
                  providerKind: provider.kind,
                  model: provider.models.vision ?? RECOMMENDED.model,
                  inputPerMtok: '0.10',
                  outputPerMtok: '0.30',
                  currency: 'USD',
                  listingFetchedAt: now(),
                },
              ]
            : [],
      };
    }),
    route('DELETE', p.adminAiPrice(':providerKind', ':model'), ({ params }) => {
      if (!isAdmin()) return forbidden();
      const current = cap().prices.find(
        (x) =>
          x.providerKind === params.providerKind && x.model === params.model && !x.supersededAt,
      );
      if (!current) return notFound();
      current.supersededAt = now();
      return reply(204);
    }),
    route('POST', p.adminAiPricesRecost, ({ body }) => {
      if (!isAdmin()) return forbidden();
      const b = body as { providerKind: string; model: string };
      const recosted = cap().calls.filter(
        (c) => c.sent && !c.cost && c.providerKind === b.providerKind && c.model === b.model,
      ).length;
      return { recosted };
    }),

    route('GET', p.aiUsage, ({ query }) =>
      gated(() => {
        const scope = scopeOf(query);
        const locationId = query.get('locationId');
        const visible = callsIn(scope, locationId);
        if (!visible) return notFound();
        // Without `from`, the current month in UTC so far (T9), as caps count it (D188).
        const nowIso = now();
        const d = new Date(nowIso);
        const from =
          query.get('from') ??
          new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
        const to = query.get('to') ?? nowIso;
        const calls = visible.filter((c) => c.at >= from && c.at < to);
        const by = (query.get('groupBy') as AiUsageGroupBy | null) ?? 'day';
        if (by === 'account' && scope !== 'instance')
          return err(400, 'validation', 'Grouping by account is for the instance.');
        const groups = new Map<string, { label: string; calls: AiCall[] }>();
        for (const c of calls) {
          const g = groupKey(c, by);
          const entry = groups.get(g.key) ?? { label: g.label, calls: [] };
          entry.calls.push(c);
          groups.set(g.key, entry);
        }
        return {
          scope,
          from,
          to,
          soFar: to >= new Date(Date.parse(nowIso) - 60_000).toISOString(),
          groups: [...groups].map(([key, g]) => ({
            key,
            label: g.label,
            ...aggregate(g.calls),
            ...(by === 'day' ? { tasks: byTask(g.calls) } : {}),
          })),
          totals: aggregate(calls),
          caps: capsFor(scope, locationId),
        } satisfies AiUsage;
      }),
    ),

    route('GET', p.aiCalls, ({ query }) =>
      gated(() => {
        const scope = scopeOf(query);
        const visible = callsIn(scope, query.get('locationId'));
        if (!visible) return notFound();
        // The instance door has one order, newest first (T9): `dir` is not read there.
        if (scope === 'instance') query.delete('dir');
        return paginate(filtered(visible, query), query, 20);
      }),
    ),
    route('GET', p.aiCallsCsv, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const visible = callsIn(scopeOf(query), query.get('locationId'));
      if (!visible) return notFound();
      const rows = filtered(visible, query);
      const money = !rows.some((c) => c.moneyHidden);
      const header = [...CSV_COLUMNS, ...(money ? MONEY_COLUMNS : [])];
      const lines = rows.map((c) =>
        [
          c.at,
          c.requestId,
          c.attempt,
          c.task,
          c.providerKind,
          c.model,
          c.location?.name ?? '',
          c.person === 'background' ? 'Kept (background)' : (c.person?.name ?? ''),
          c.paidBy.label,
          c.paidBy.fellBack,
          c.sent,
          c.tokens.input,
          c.tokens.output,
          c.tokens.reasoning,
          c.tokens.cached,
          c.images.count,
          c.images.bytes,
          c.latencyMs,
          c.outcome,
          c.errorCode,
          ...(money ? [c.cost?.amount, c.cost?.currency, c.cost?.source ?? 'unknown'] : []),
        ]
          .map((v) => safeCsvCell(v as CsvValue))
          .join(','),
      );
      // The server's shape (D169): a BOM, CRLF after every row, @kept/shared's cell writer.
      return new Response(CSV_BOM + [header.join(','), ...lines].map((l) => l + CSV_EOL).join(''), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="ai-calls.csv"',
        },
      });
    }),
    route('GET', p.aiCall(':id'), ({ params }) => {
      const all = [
        ...(callsIn('me', null) ?? []),
        ...(callsIn('account', null) ?? []),
        ...(callsIn('instance', null) ?? []),
        ...state.locations.flatMap((l) => callsIn('location', l.id) ?? []),
      ];
      const found = all.find((c) => c.id === params.id);
      if (!found) return notFound();
      return {
        ...found,
        attempts: all
          .filter((c) => c.requestId === found.requestId && c.id !== found.id)
          .filter((c, i, list) => list.findIndex((x) => x.id === c.id) === i),
      };
    }),
  ];
}
