/**
 * The AI call list's filters (D205, D206; screens §5 AI usage §5): date, person, location, task,
 * model, provider, outcome, paid by, has image, tokens, cost (only where money shows) and thing.
 * Each is a FilterDef the filter strip renders like any other list's; `aiCallParams` turns the
 * strip's URL state into `GET /ai/calls` (and its CSV export) parameters, one mapping for both.
 *
 * URL keys: `f.at`, `f.person`, `f.location`, `f.task`, `f.model`, `f.provider`, `f.outcome`,
 * `f.paidBy`, `f.hasImage`, `f.tokensMin`/`f.tokensMax`, `f.costMin`/`f.costMax`/`f.currency`,
 * `f.thing`; with `q` (model or request id) and `dir` (D211).
 */
import { LEDGER_OUTCOMES, LEDGER_TASKS, PROVIDER_KINDS } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { captureApi } from '@/api/capture/queries';
import type { AiCallParams, AiScope } from '@/api/capture/types';
import { inventoryApi } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { filterParams } from '@/components/filters/params';
import { useCanSeeMoney, useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import {
  ActivityIcon,
  AlertIcon,
  AssistantIcon,
  BoxIcon,
  CameraIcon,
  HomeIcon,
  KeyIcon,
  PersonIcon,
  ServerIcon,
} from '@/components/icons';
import { useLocationName } from '@/lib/labels';
import { firstOf, type ListState } from '@/lib/url-state';
import { useOutcomeLabel, useProviderName, useTaskLabel } from './labels';

/** The URL filter names the usage routes declare (`listSearch(AI_CALL_FILTERS, …)`). */
export const AI_CALL_FILTERS = [
  'at',
  'person',
  'location',
  'task',
  'model',
  'provider',
  'outcome',
  'paidBy',
  'hasImage',
  'tokensMin',
  'tokensMax',
  'costMin',
  'costMax',
  'currency',
  'thing',
] as const;

const range = (min: string | undefined, max: string | undefined) =>
  min || max ? `${min ?? ''}..${max ?? ''}` : undefined;

/** The list's URL state as `GET /ai/calls` parameters (§7.15), for the list and the CSV alike. */
export function aiCallParams(
  list: ListState,
  scope: AiScope,
  locationId: string | undefined,
): AiCallParams {
  const mapped = filterParams(list, {
    person: 'person',
    location: 'location',
    task: 'task',
    model: 'model',
    provider: 'provider',
    outcome: 'outcome',
    paidBy: 'paidBy',
    thing: 'thing',
  });
  const tokens = range(firstOf(list, 'tokensMin'), firstOf(list, 'tokensMax'));
  const cost = range(firstOf(list, 'costMin'), firstOf(list, 'costMax'));
  const currency = firstOf(list, 'currency');
  const at = firstOf(list, 'at');
  return {
    scope,
    ...(locationId ? { locationId } : {}),
    ...(list.q ? { q: list.q } : {}),
    ...(mapped as Partial<AiCallParams>),
    ...(at ? { at } : {}),
    ...(firstOf(list, 'hasImage') ? { hasImage: true } : {}),
    ...(tokens ? { tokens } : {}),
    ...(cost ? { cost } : {}),
    ...(cost && currency ? { currency } : {}),
    // The instance's calls come newest first only (T9: the door has one order).
    ...(list.dir === 'asc' && scope !== 'instance' ? { dir: 'asc' as const } : {}),
  };
}

export function useAiCallFilters(scope: AiScope, locationId: string | undefined): FilterDef[] {
  const { t } = useLingui();
  const f = useFilterRegistry();
  const money = useCanSeeMoney();
  const locations = useLocations();
  const nameOf = useLocationName();
  const task = useTaskLabel();
  const outcome = useOutcomeLabel();
  const providerName = useProviderName();
  const grouped = (by: 'person' | 'model') => ({
    from: 'load' as const,
    queryKey: ['ai', 'filters', by, scope, locationId ?? null],
    load: async () => {
      // Usage defaults to this UTC month (T9); the list reaches back as far as the ledger keeps
      // rows (13 months), so the options do too.
      const now = new Date();
      const usage = await captureApi.aiUsage({
        scope,
        ...(locationId ? { locationId } : {}),
        from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1)).toISOString(),
        groupBy: by,
      });
      return usage.groups.map((g) =>
        by === 'person'
          ? {
              value: g.key,
              label: g.key === 'background' ? t`Kept (background)` : g.label || t`A deleted person`,
            }
          : { value: g.label, label: g.label },
      );
    },
  });
  const owned =
    scope === 'account'
      ? (locations.data ?? []).filter((l) => l.role === 'owner')
      : (locations.data ?? []);

  const defs: FilterDef[] = [
    f.date('at', t`Date`),
    {
      key: 'task',
      label: t`Task`,
      icon: <CameraIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: LEDGER_TASKS.map((x) => ({ value: x, label: task(x) })),
      },
    },
    {
      key: 'outcome',
      label: t`Outcome`,
      icon: <AlertIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: LEDGER_OUTCOMES.map((x) => ({ value: x, label: outcome(x) })),
      },
    },
    {
      key: 'person',
      label: t`Person`,
      icon: <PersonIcon />,
      kind: 'multi',
      findLabel: t`Find a person`,
      values: grouped('person'),
    },
    ...(scope === 'location' || scope === 'instance' || owned.length < 2
      ? []
      : [
          {
            key: 'location',
            label: t`Location`,
            icon: <HomeIcon />,
            kind: 'multi' as const,
            findLabel: t`Find a location`,
            values: {
              from: 'static' as const,
              options: owned.map((l) => ({ value: l.id, label: nameOf(l) })),
            },
          },
        ]),
    {
      key: 'model',
      label: t({ message: 'Model', context: 'ai model' }),
      icon: <AssistantIcon />,
      kind: 'multi',
      findLabel: t`Find a model`,
      values: grouped('model'),
    },
    {
      key: 'provider',
      label: t`Provider`,
      icon: <ServerIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: PROVIDER_KINDS.map((k) => ({
          value: k,
          label: k === 'openai_compatible' ? t`OpenAI-compatible` : providerName(k),
        })),
      },
    },
    {
      key: 'paidBy',
      label: t`Paid by`,
      icon: <KeyIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: [
          { value: 'account', label: t`An account's key` },
          { value: 'user', label: t`A personal key` },
          { value: 'instance', label: t`This server's key` },
        ],
      },
    },
    {
      key: 'hasImage',
      label: t`Has an image`,
      icon: <CameraIcon />,
      kind: 'boolean',
      values: { from: 'static', options: [{ value: '1', label: t`Has an image` }] },
    },
    {
      key: 'tokens',
      label: t`Tokens`,
      icon: <ActivityIcon />,
      kind: 'number-range',
      range: { min: 'tokensMin', max: 'tokensMax' },
    },
    ...(money
      ? [
          {
            key: 'cost',
            label: t`Cost`,
            kind: 'number-range' as const,
            range: { min: 'costMin', max: 'costMax', currency: 'currency' },
          },
        ]
      : []),
    ...(scope === 'instance'
      ? []
      : [
          {
            key: 'thing',
            label: t`Thing`,
            icon: <BoxIcon />,
            kind: 'multi' as const,
            findLabel: t`Find a thing`,
            negatable: false,
            values: {
              from: 'server' as const,
              queryKey: ['ai', 'filters', 'thing'],
              search: async (q: string) => {
                if (!q.trim()) return [];
                const res = await inventoryApi.search({ q: q.trim(), kind: 'things', limit: 20 });
                return res.things.items.map((x) => ({
                  value: x.id,
                  label: x.name ?? x.shortCode ?? '',
                }));
              },
              resolve: async (ids: string[]) => {
                const found = await Promise.all(
                  ids.map((id) =>
                    inventoryApi
                      .thing(id)
                      .then((x) => ({ value: x.id, label: x.name ?? x.shortCode ?? '' }))
                      .catch(() => null),
                  ),
                );
                return found.filter((x): x is { value: string; label: string } => x !== null);
              },
            },
          },
        ]),
  ];
  return defs;
}
