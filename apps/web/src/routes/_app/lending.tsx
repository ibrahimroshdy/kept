/**
 * Lending (plan T22; D56, D57, D119, screens §5): what you lent out and what you borrowed, in
 * every location with Lending on, overdue first, with Mark returned and a reminder to copy.
 *
 * The list standard on the filter strip (D205, surface `lending`): search, location, direction,
 * state (open, overdue, returned) and person, with saved views. Out and In are the direction
 * filter's values, each with its count, not a second row of tabs (D211); pinning a saved view of
 * each gives them as the strip's tabs. The Display button sorts by due (overdue first), since
 * when, or the thing's name, and groups by person or location. All of it is in the URL.
 */
import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { useLoans } from '@/api/household/queries';
import type { LoanRow, LoansParams } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { defaultDir } from '@/components/filters/display';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { ActivityIcon, HandoffIcon, PersonIcon } from '@/components/icons';
import { LoanRowView } from '@/components/lending/loan-row';
import { ListSurface } from '@/components/list-surface';
import { StepFourRouteError } from '@/components/notifications/route-error';
import { EmptyState, Notice, Page } from '@/components/page';
import { accessOf, useModuleAnywhere } from '@/components/schedules/access';
import { oneValue, passes, useOrderedQuery } from '@/components/schedules/list-query';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { listSearch, useListState } from '@/lib/url-state';

export const Route = createFileRoute('/_app/lending')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS.lending),
  component: LendingPage,
  errorComponent: (p) => <StepFourRouteError {...p} page="lending" />,
});

const stateOf = (l: LoanRow) => (l.returnedAt ? 'returned' : l.overdue ? 'overdue' : 'open');
const RANK = { overdue: 0, open: 1, returned: 2 } as const;

function LendingPage() {
  const fmt = useFormat();
  const { t } = useLingui();
  const [list] = useListState();
  const f = useFilterRegistry();
  const locations = useLocations();
  const locationName = useLocationName();
  const module = useModuleAnywhere('lending');
  const online = useOnline();

  const withModule = (locations.data ?? []).filter((l) => accessOf(l).moduleOn('lending'));
  const names = new Map(withModule.map((l) => [l.id, locationName(l)]));

  const direction = oneValue(list, 'direction');
  const state = oneValue(list, 'state');
  const location = oneValue(list, 'location');
  const person = oneValue(list, 'person');
  const params: LoansParams = {
    ...(list.q ? { q: list.q } : {}),
    ...(direction === 'out' || direction === 'in' ? { direction } : {}),
    // An overdue loan is open too: "open" alone is asked for here and narrowed below.
    ...(state === 'open' || state === 'overdue' || state === 'returned' ? { state } : {}),
    ...(location ? { locationId: location } : {}),
    ...(person ? { personId: person } : {}),
  };
  const query = useLoans(params);
  const counts = query.data?.pages[0]?.counts;

  const sort = list.sort === 'since' || list.sort === 'name' ? list.sort : 'due';
  const dir = list.dir || defaultDir(sort === 'name' ? 'text' : sort === 'since' ? 'date' : 'due');
  const group = list.group === 'person' || list.group === 'location' ? list.group : 'none';
  const keep = (l: LoanRow) =>
    passes(list, 'location', l.thing.locationId) &&
    passes(list, 'direction', l.direction) &&
    passes(list, 'person', l.person.id) &&
    (() => {
      const values = list.filters.state;
      if (!values?.length) return true;
      const s = stateOf(l);
      // "Open" takes in the overdue ones: they're open too.
      const hit = values.includes(s) || (s === 'overdue' && values.includes('open'));
      return list.not.includes('state') ? !hit : hit;
    })();
  const compare = (a: LoanRow, b: LoanRow) => {
    const groupKey = (l: LoanRow) =>
      group === 'person'
        ? l.person.name
        : group === 'location'
          ? (names.get(l.thing.locationId) ?? '')
          : '';
    const g = groupKey(a).localeCompare(groupKey(b));
    if (g) return g;
    const by =
      sort === 'name'
        ? (a.thing.name ?? '').localeCompare(b.thing.name ?? '')
        : sort === 'since'
          ? a.startedAt.localeCompare(b.startedAt)
          : RANK[stateOf(a)] - RANK[stateOf(b)] ||
            (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999');
    return dir === 'desc' ? -by : by;
  };
  const ordered = useOrderedQuery(query, keep, compare);

  const filters: FilterDef[] = [
    {
      key: 'direction',
      label: t`Direction`,
      icon: <HandoffIcon />,
      kind: 'multi',
      negatable: false,
      values: {
        from: 'static',
        options: [
          { value: 'out', label: t`Out: lent`, ...(counts ? { count: counts.out } : {}) },
          { value: 'in', label: t`In: borrowed`, ...(counts ? { count: counts.in } : {}) },
        ],
      },
    },
    {
      key: 'state',
      label: t`State`,
      icon: <ActivityIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: [
          { value: 'open', label: t`Out now` },
          {
            value: 'overdue',
            label: t`Overdue`,
            ...(counts ? { count: counts.overdue } : {}),
          },
          { value: 'returned', label: t`Returned` },
        ],
      },
    },
    { ...f.belongsTo(), key: 'person', label: t`Person`, icon: <PersonIcon /> },
    ...(withModule.length > 1
      ? [
          {
            ...f.location(),
            values: {
              from: 'static' as const,
              options: withModule.map((l) => ({ value: l.id, label: locationName(l) })),
            },
          },
        ]
      : []),
  ];

  return (
    <Page title={t`Lending`} wide>
      {module.loaded && !module.on ? (
        <EmptyState icon={<HandoffIcon />} title={<Trans>Lending is off in your locations</Trans>}>
          <Trans>
            An owner or admin turns it on in the location's settings, under What to track.
          </Trans>
        </EmptyState>
      ) : (
        <>
          {!online ? (
            <Notice tone="warn">
              <Trans>
                Needs a connection: marking things returned waits until you're back online.
              </Trans>
            </Notice>
          ) : null}
          {counts && (counts.out > 0 || counts.in > 0) ? (
            <p className="m-0 text-small text-ink-2">
              <Trans>
                {fmt.num(counts.out)} lent out · {fmt.num(counts.in)} borrowed ·{' '}
                {fmt.num(counts.overdue)} overdue
              </Trans>
            </p>
          ) : null}
          <ListSurface<LoanRow>
            label={t`Loans`}
            search={{ label: t`Search loans`, placeholder: t`Search by thing or person` }}
            filters={filters}
            surface="lending"
            sorts={[
              { value: 'due', label: t`Due`, kind: 'due' },
              { value: 'since', label: t`Since`, kind: 'date' },
              { value: 'name', label: t`Name` },
            ]}
            groups={[
              { value: 'none', label: t`None` },
              { value: 'person', label: t`Person`, short: t`by person` },
              { value: 'location', label: t`Location`, short: t`by location` },
            ]}
            query={ordered}
            getKey={(l) => l.id}
            groupOf={(l, by) =>
              by === 'person'
                ? { key: l.person.id, label: <bdi>{l.person.name}</bdi> }
                : by === 'location'
                  ? {
                      key: l.thing.locationId,
                      label: <bdi>{names.get(l.thing.locationId) ?? ''}</bdi>,
                    }
                  : null
            }
            renderRow={(l) => <LoanRowView loan={l} />}
            empty={
              <EmptyState icon={<HandoffIcon />} title={<Trans>Nothing lent or borrowed</Trans>}>
                <Trans>
                  Lend a thing from its page, and it shows here with who has it and when it's due
                  back.
                </Trans>
              </EmptyState>
            }
          />
        </>
      )}
    </Page>
  );
}
