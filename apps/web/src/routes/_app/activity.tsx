/**
 * The activity feed (screens §5 Other screens, frame 04 · 8, D174): every change in every location
 * you belong to, newest first and grouped by day, under the list standard (filters and cursor
 * pagination in the URL). Filters: location, person, kind and date. Each entry links to what it's
 * about and carries its location. Rows are the server's rendered events, so money and secrets
 * are redacted for your role in that location before they arrive (D110).
 *
 * The search box matches the summary, what it's about and who did it (`q`, T27 decision). The
 * filters are the filter strip (D205): person (everyone who has acted in your locations,
 * `/locations/:id/actors`), kind, date and location, each "is any of" or "is none of", with saved
 * views. An entry you may undo carries Undo (D150).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { useActivity } from '@/api/inventory/queries';
import type { ActivityParams, HistoryEvent } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { dateBounds, filterParams } from '@/components/filters/params';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { DayHeading, EventRow, useDayHeadings } from '@/components/history/timeline';
import { ActivityIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { ActivityRouteError } from '@/components/on-demand-route-error';
import { EmptyState, Page } from '@/components/page';
import { useLocationName } from '@/lib/labels';
import { firstOf, isNot, listSearch, useListState } from '@/lib/url-state';

export const Route = createFileRoute('/_app/activity')({
  validateSearch: listSearch(['location', 'actor', 'kind', 'when']),
  component: ActivityPage,
  errorComponent: ActivityRouteError,
});

function ActivityPage() {
  const { t } = useLingui();
  const [list] = useListState();
  const locations = useLocations();
  const nameOf = useLocationName();
  const f = useFilterRegistry();
  const all = locations.data ?? [];
  const q = list.q.trim();
  const params: ActivityParams = {
    ...(q ? { q } : {}),
    ...filterParams(list, { location: 'locationId', actor: 'actorId', kind: 'entityType' }),
    ...dateBounds(firstOf(list, 'when')),
  };
  const query = useActivity(params);
  const events = query.data?.pages.flatMap((pg) => pg.items) ?? [];
  const dayOf = useDayHeadings(events);

  // The person filter offers everyone who has acted in the chosen locations, or in all of yours.
  const chosen = list.filters.location ?? [];
  const oneLocation = chosen.length === 1 && !isNot(list, 'location');
  const actorLocations = isNot(list, 'location')
    ? all.filter((l) => !chosen.includes(l.id)).map((l) => l.id)
    : chosen;
  const filters: FilterDef[] = [
    f.actor(actorLocations),
    f.kind(true),
    f.date(),
    ...(all.length > 1 ? [f.location()] : []),
  ];

  const locationName = (id: string | null) => {
    const l = all.find((x) => x.id === id);
    return l ? nameOf(l) : null;
  };

  return (
    <Page title={t`Activity`} wide>
      <ListSurface<HistoryEvent>
        label={t`Activity`}
        search={{ label: t`Search activity`, placeholder: t`Search activity` }}
        filters={filters}
        surface="activity"
        query={query}
        getKey={(e) => e.id}
        renderRow={(e: HistoryEvent) => (
          <>
            {dayOf.get(e.id) ? <DayHeading>{dayOf.get(e.id)}</DayHeading> : null}
            <EventRow
              event={e}
              linkEntity
              locationName={oneLocation || all.length < 2 ? null : locationName(e.location_id)}
            />
          </>
        )}
        empty={
          <EmptyState icon={<ActivityIcon />} title={<Trans>Nothing has happened yet</Trans>}>
            <Trans>
              Every addition, move and edit in the locations you belong to shows here, newest first.
            </Trans>
          </EmptyState>
        }
        noMatch={
          <EmptyState icon={<ActivityIcon />} title={<Trans>No activity matches</Trans>}>
            <Trans>Try other words, another person, kind or date, or clear a filter.</Trans>
          </EmptyState>
        }
      />
    </Page>
  );
}
