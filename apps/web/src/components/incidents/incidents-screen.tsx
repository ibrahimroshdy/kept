/**
 * Incidents (D158, plan T26, screens §5): the burglaries, fires, floods and losses recorded in
 * your locations, newest first, each with how many things and claims it has.
 *
 * The list standard on the filter strip (D205, surface `incidents`): search, location, kind and
 * date (`when`), with saved views; the Display button sorts by when or by kind and groups by
 * location. `GET /incidents` takes one location and one kind, so a single value goes to the
 * server and the rest is applied to the loaded rows (components/schedules/list-query.ts).
 *
 * New incident is for owners and admins (`incidents.manage`); most incidents start from a
 * location's list instead: select the things, then Add to incident.
 */
import { INCIDENT_KINDS, type IncidentKind } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { useIncidents } from '@/api/household/queries';
import type { IncidentRow, IncidentsParams } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { dateBounds } from '@/components/filters/params';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { AlertIcon, ChevronEndIcon, PlusIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice, Page } from '@/components/page';
import { rowLink, Tile } from '@/components/places/rows';
import { oneValue, passes, useOrderedQuery } from '@/components/schedules/list-query';
import { Button } from '@/components/ui/button';
import { sep } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { useListState } from '@/lib/url-state';
import { NewIncidentSheet, useManagedLocations } from './incident-sheet';
import { useIncidentKindLabels, useIncidentName } from './labels';

/** A `YYYY-MM-DD` day as the local midnight the date filter's bounds are measured in. */
const localDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toISOString();
};

function IncidentRowView({ incident }: { incident: IncidentRow }) {
  const nameOf = useIncidentName();
  const locationName = useLocationName();
  const location = useLocations().data?.find((l) => l.id === incident.locationId);
  const name = nameOf(incident);
  const refs = [
    incident.policeReference ? { key: 'police', value: incident.policeReference } : null,
    incident.insurerReference ? { key: 'insurer', value: incident.insurerReference } : null,
  ].filter((r) => r !== null);
  return (
    <article aria-label={name}>
      <Link to="/incidents/$id" params={{ id: incident.id }} className={rowLink}>
        <Tile>
          <AlertIcon />
        </Tile>
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
            {name}
          </span>
          <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
            {location ? (
              <>
                <bdi>{locationName(location)}</bdi>
                {sep()}
              </>
            ) : null}
            <Plural value={incident.thingCount} one="# thing" other="# things" />
            {sep()}
            <Plural value={incident.claimCount} one="# claim" other="# claims" />
          </span>
          {refs.map((r) =>
            r.key === 'police' ? (
              <span key={r.key} className="text-small text-ink-2 [overflow-wrap:anywhere]">
                <Trans>
                  Police: <bdi dir="auto">{r.value}</bdi>
                </Trans>
              </span>
            ) : (
              <span key={r.key} className="text-small text-ink-2 [overflow-wrap:anywhere]">
                <Trans>
                  Insurer: <bdi dir="auto">{r.value}</bdi>
                </Trans>
              </span>
            ),
          )}
        </span>
        <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
      </Link>
    </article>
  );
}

export function IncidentsScreen() {
  const { t } = useLingui();
  const [list] = useListState();
  const f = useFilterRegistry();
  const kinds = useIncidentKindLabels();
  const locations = useLocations();
  const locationName = useLocationName();
  const managed = useManagedLocations();
  const online = useOnline();
  const [creating, setCreating] = useState(false);
  const all = locations.data ?? [];
  const names = new Map(all.map((l) => [l.id, locationName(l)]));

  const location = oneValue(list, 'location');
  const kind = oneValue(list, 'kind');
  const params: IncidentsParams = {
    ...(location ? { locationId: location } : {}),
    ...(kind && (INCIDENT_KINDS as readonly string[]).includes(kind)
      ? { kind: kind as IncidentKind }
      : {}),
  };
  const query = useIncidents(params);

  const sort = list.sort === 'kind' ? 'kind' : 'when';
  const dir = list.dir || (sort === 'when' ? 'desc' : 'asc');
  const group = list.group === 'location' ? 'location' : 'none';
  const bounds = dateBounds(list.filters.when?.[0]);
  const q = list.q.trim().toLocaleLowerCase();
  const nameOf = useIncidentName();
  const keep = useCallback(
    (i: IncidentRow) => {
      if (!passes(list, 'location', i.locationId) || !passes(list, 'kind', i.kind)) return false;
      const day = localDay(i.occurredOn);
      if (bounds.from && day < bounds.from) return false;
      if (bounds.to && day >= bounds.to) return false;
      if (!q) return true;
      return [nameOf(i), i.policeReference ?? '', i.insurerReference ?? '']
        .join(' ')
        .toLocaleLowerCase()
        .includes(q);
    },
    [list, bounds.from, bounds.to, q, nameOf],
  );
  const compare = useCallback(
    (a: IncidentRow, b: IncidentRow) => {
      if (group === 'location') {
        const g = (names.get(a.locationId) ?? '').localeCompare(names.get(b.locationId) ?? '');
        if (g) return g;
      }
      const by =
        sort === 'kind'
          ? kinds[a.kind].localeCompare(kinds[b.kind]) || a.occurredOn.localeCompare(b.occurredOn)
          : a.occurredOn.localeCompare(b.occurredOn);
      return dir === 'desc' ? -by : by;
    },
    [group, names, sort, kinds, dir],
  );
  const ordered = useOrderedQuery(query, keep, compare);

  const filters: FilterDef[] = [
    {
      key: 'kind',
      label: t`Kind`,
      icon: <AlertIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: INCIDENT_KINDS.map((k) => ({ value: k, label: kinds[k] })),
      },
    },
    ...(all.length > 1
      ? [
          {
            ...f.location(),
            values: {
              from: 'static' as const,
              options: all.map((l) => ({ value: l.id, label: locationName(l) })),
            },
          },
        ]
      : []),
    f.date('when', t`When`),
  ];

  return (
    <Page
      title={t`Incidents`}
      wide
      actions={
        managed.length ? (
          <Button size="small" isDisabled={!online} onPress={() => setCreating(true)}>
            <PlusIcon className="size-4" />
            <Trans>New incident</Trans>
          </Button>
        ) : null
      }
    >
      {!online && managed.length ? (
        <Notice tone="warn">
          <Trans>Needs a connection: recording an incident waits until you're back online.</Trans>
        </Notice>
      ) : null}
      <ListSurface<IncidentRow>
        label={t`Incidents`}
        search={{ label: t`Search incidents`, placeholder: t`Kind or reference` }}
        filters={filters}
        surface="incidents"
        sorts={[
          { value: 'when', label: t`When`, kind: 'date' },
          { value: 'kind', label: t`Kind` },
        ]}
        groups={[
          { value: 'none', label: t`None` },
          ...(all.length > 1
            ? [{ value: 'location', label: t`Location`, short: t`by location` }]
            : []),
        ]}
        query={ordered}
        getKey={(i) => i.id}
        groupOf={(i, by) =>
          by === 'location'
            ? { key: i.locationId, label: <bdi>{names.get(i.locationId) ?? ''}</bdi> }
            : null
        }
        renderRow={(i) => <IncidentRowView incident={i} />}
        empty={
          <EmptyState icon={<AlertIcon />} title={<Trans>No incidents</Trans>}>
            {managed.length ? (
              <Trans>
                If something is stolen, burnt, flooded or lost, record it here, or select the things
                in a location's list and choose Add to incident.
              </Trans>
            ) : (
              <Trans>An owner or admin records a burglary, fire, flood or loss here.</Trans>
            )}
          </EmptyState>
        }
      />
      <NewIncidentSheet isOpen={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}
