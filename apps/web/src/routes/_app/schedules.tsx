/**
 * Schedules (plan T21; D29, D39, D52, D162, screens §5): every schedule on things and places
 * across your locations with Schedules on, next due first, with Complete, Snooze and Skip.
 *
 * The list standard on the filter strip (D205, surface `schedules`): search, location, state
 * (overdue, due, upcoming) and what it's for (a thing or a place), with saved views; the Display
 * button (D211) sorts by due (soonest first) or name and groups by location or by what it's for.
 * All of it is in the URL. Each row's due point is the server's (the agenda's), never recomputed
 * here. A new schedule is made here (choosing its thing or place) or from a thing's page. The
 * engineering spec's "Starter schedules" belong to vehicles (D52): not offered in step 4.
 */
import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useSchedules } from '@/api/household/queries';
import type { Schedule, SchedulesParams } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { defaultDir } from '@/components/filters/display';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { ActivityIcon, BoxIcon, PlusIcon, ScheduleIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { StepFourRouteError } from '@/components/notifications/route-error';
import { EmptyState, Notice, Page } from '@/components/page';
import { accessOf, useModuleAnywhere } from '@/components/schedules/access';
import { CompleteSheet } from '@/components/schedules/complete-sheet';
import { useScheduleStateLabels } from '@/components/schedules/labels';
import { oneValue, passes, useOrderedQuery } from '@/components/schedules/list-query';
import { type ScheduleRowAction, ScheduleRowView } from '@/components/schedules/schedule-row';
import { ScheduleSheet } from '@/components/schedules/schedule-sheet';
import { SnoozeSheet } from '@/components/schedules/snooze-sheet';
import { LogServiceSheet } from '@/components/services/log-service-sheet';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { listSearch, useListState } from '@/lib/url-state';

export const Route = createFileRoute('/_app/schedules')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS.schedules),
  component: SchedulesPage,
  errorComponent: (p) => <StepFourRouteError {...p} page="schedules" />,
});

const RANK = { overdue: 0, due: 1, upcoming: 2 } as const;

type Open = { action: ScheduleRowAction | 'new'; schedule: Schedule | null } | null;

function SchedulesPage() {
  const fmt = useFormat();
  const { t } = useLingui();
  const [list] = useListState();
  const f = useFilterRegistry();
  const locations = useLocations();
  const locationName = useLocationName();
  const stateLabels = useScheduleStateLabels();
  const module = useModuleAnywhere('schedules');
  const online = useOnline();
  const [open, setOpen] = useState<Open>(null);

  const withModule = (locations.data ?? []).filter((l) => accessOf(l).moduleOn('schedules'));
  const canAdd = withModule.some((l) => accessOf(l).can('schedules-claims.manage'));
  const names = new Map(withModule.map((l) => [l.id, locationName(l)]));
  const nameOf = (id: string) => names.get(id) ?? '';

  const state = oneValue(list, 'state');
  const subject = oneValue(list, 'subject');
  const location = oneValue(list, 'location');
  const params: SchedulesParams = {
    ...(list.q ? { q: list.q } : {}),
    ...(location ? { locationId: location } : {}),
    ...(state === 'upcoming' || state === 'due' || state === 'overdue' ? { state } : {}),
    ...(subject === 'thing' || subject === 'place' ? { subjectType: subject } : {}),
  };
  const query = useSchedules(params);
  const counts = query.data?.pages[0]?.counts;

  const sort = list.sort === 'name' ? 'name' : 'due';
  const dir = list.dir || defaultDir(sort === 'name' ? 'text' : 'due');
  const group = list.group === 'location' || list.group === 'subject' ? list.group : 'none';
  const keep = (s: Schedule) =>
    passes(list, 'location', s.locationId) &&
    passes(list, 'state', s.next.state) &&
    passes(list, 'subject', s.subject.type);
  const compare = (a: Schedule, b: Schedule) => {
    const groupKey = (s: Schedule) =>
      group === 'location'
        ? (names.get(s.locationId) ?? '')
        : group === 'subject'
          ? `${s.subject.path} › ${s.subject.name}`
          : '';
    const g = groupKey(a).localeCompare(groupKey(b));
    if (g) return g;
    const by =
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : RANK[a.next.state] - RANK[b.next.state] ||
          (a.next.dueOn ?? '9999').localeCompare(b.next.dueOn ?? '9999');
    return dir === 'desc' ? -by : by;
  };
  const ordered = useOrderedQuery(query, keep, compare);

  const filters: FilterDef[] = [
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
    {
      key: 'state',
      label: t`State`,
      icon: <ActivityIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: (['overdue', 'due', 'upcoming'] as const).map((s) => ({
          value: s,
          label: stateLabels[s],
          ...(s !== 'upcoming' && counts ? { count: counts[s] } : {}),
        })),
      },
    },
    {
      key: 'subject',
      label: t`For`,
      icon: <BoxIcon />,
      kind: 'multi',
      negatable: false,
      values: {
        from: 'static',
        options: [
          { value: 'thing', label: t`Things` },
          { value: 'place', label: t`Places` },
        ],
      },
    },
  ];

  const openSchedule = open?.schedule ?? null;
  const close = () => setOpen(null);

  return (
    <Page
      title={t`Schedules`}
      wide
      actions={
        canAdd ? (
          <Button
            size="small"
            isDisabled={!online}
            onPress={() => setOpen({ action: 'new', schedule: null })}
          >
            <PlusIcon className="size-4" />
            <Trans>New schedule</Trans>
          </Button>
        ) : undefined
      }
    >
      {module.loaded && !module.on ? (
        <EmptyState
          icon={<ScheduleIcon />}
          title={<Trans>Schedules are off in your locations</Trans>}
        >
          <Trans>
            An owner or admin turns them on in the location's settings, under What to track.
          </Trans>
        </EmptyState>
      ) : (
        <>
          {!online ? (
            <Notice tone="warn">
              <Trans>
                Needs a connection: completing, snoozing and changing schedules wait until you're
                back online.
              </Trans>
            </Notice>
          ) : null}
          {counts && (counts.due > 0 || counts.overdue > 0) ? (
            <p className="m-0 text-small text-ink-2">
              <Trans>
                {fmt.num(counts.overdue)} overdue · {fmt.num(counts.due)} due
              </Trans>
            </p>
          ) : null}
          <ListSurface<Schedule>
            label={t`Schedules`}
            search={{ label: t`Search schedules`, placeholder: t`Search by name or thing` }}
            filters={filters}
            surface="schedules"
            sorts={[
              { value: 'due', label: t`Due`, kind: 'due' },
              { value: 'name', label: t`Name` },
            ]}
            groups={[
              { value: 'none', label: t`None` },
              { value: 'location', label: t`Location`, short: t`by location` },
              { value: 'subject', label: t`Thing or place`, short: t`by thing or place` },
            ]}
            query={ordered}
            getKey={(s) => s.id}
            groupOf={(s, by) =>
              by === 'location'
                ? { key: s.locationId, label: <bdi>{nameOf(s.locationId)}</bdi> }
                : by === 'subject'
                  ? {
                      key: `${s.subject.type}:${s.subject.id}`,
                      label: (
                        <bdi>
                          {s.subject.path
                            ? `${s.subject.path} › ${s.subject.name}`
                            : s.subject.name}
                        </bdi>
                      ),
                    }
                  : null
            }
            renderRow={(s) => (
              <ScheduleRowView
                schedule={s}
                onOpen={(action, schedule) => setOpen({ action, schedule })}
                showLocation={withModule.length > 1 ? nameOf(s.locationId) : undefined}
              />
            )}
            empty={
              <EmptyState icon={<ScheduleIcon />} title={<Trans>Nothing scheduled</Trans>}>
                <Trans>
                  Add a service or a check that comes round, like the boiler every year or the car
                  every 10,000 km, and Kept reminds you before it's due.
                </Trans>
              </EmptyState>
            }
          />
        </>
      )}

      <CompleteSheet
        schedule={open?.action === 'complete' ? openSchedule : null}
        onClose={close}
        onMore={(s) => setOpen({ action: 'log', schedule: s })}
      />
      <SnoozeSheet schedule={open?.action === 'snooze' ? openSchedule : null} onClose={close} />
      <ScheduleSheet
        open={open?.action === 'new' || open?.action === 'edit'}
        schedule={open?.action === 'edit' ? openSchedule : null}
        onClose={close}
      />
      <LogServiceSheet
        open={open?.action === 'log' && !!openSchedule}
        subject={
          openSchedule
            ? openSchedule.subject.type === 'thing'
              ? { thingId: openSchedule.subject.id }
              : { placeId: openSchedule.subject.id }
            : null
        }
        {...(openSchedule ? { subjectRef: openSchedule.subject } : {})}
        locationId={openSchedule?.locationId ?? ''}
        completes={openSchedule ? [openSchedule.id] : []}
        onClose={close}
      />
    </Page>
  );
}
