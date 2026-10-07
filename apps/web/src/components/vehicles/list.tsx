/**
 * The Vehicles list (plan T17; screens §1, §8; D52, D188, D205, D211, D212): every car,
 * motorbike and generator in the locations with Vehicles on, each with its odometer and how old
 * the reading is, what's due next, a document coming due and, with Fuel & charging on, its
 * consumption.
 *
 * The list standard on the `vehicles` surface: search, location, type, state (in use by default,
 * Q24), reading (fresh, stale, unknown, none) and due (overdue, soon), with saved views; the
 * Display button sorts by name, last reading, next due or location and groups by location or type.
 * The server filters and sorts (`GET /vehicles`), so the URL's state goes to it as it is.
 *
 * Offline: the list isn't in the phone's snapshot, so it says "Needs a connection" (screens §4).
 */
import { ADVICE_DAYS, LIFECYCLES, UNKNOWN_DAYS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { inventoryApi } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { useVehicles } from '@/api/vehicles/queries';
import type { VehicleRow, VehiclesParams } from '@/api/vehicles/types';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import {
  ActivityIcon,
  AlertIcon,
  BoxIcon,
  CalendarIcon,
  CarIcon,
  ClockIcon,
  DocumentIcon,
} from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice, Pill } from '@/components/page';
import { PathText, Tile } from '@/components/places/rows';
import { accessOf, useLocationAccess } from '@/components/schedules/access';
import { CreateThingSheet } from '@/components/things/create-sheet';
import { useLifecycleLabels } from '@/components/things/labels';
import { TypeIcon } from '@/components/type-icon';
import { Button } from '@/components/ui/button';
import { addressOf } from '@/lib/address';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import type { ListState } from '@/lib/url-state';
import { useListState } from '@/lib/url-state';
import { useConsumption } from './consumption';
import { isVehicleType } from './is-vehicle';
import { AdvicePill, DocumentDueText, Line, NextDueText, ReadAgo, useReadingText } from './words';

/** The URL's list state as `GET /vehicles` reads it: the filters go as they are (`f.*`, `not`). */
export function vehiclesParams(list: ListState): VehiclesParams {
  const many = (key: string) => list.filters[key] ?? [];
  const not = list.not.filter((k): k is NonNullable<VehiclesParams['not']>[number] =>
    ['location', 'type', 'state', 'reading', 'due'].includes(k),
  );
  const sort =
    list.sort === 'lastReading' || list.sort === 'nextDue' || list.sort === 'location'
      ? list.sort
      : undefined;
  return {
    ...(list.q ? { q: list.q } : {}),
    ...(many('location').length ? { 'f.location': many('location') } : {}),
    ...(many('type').length ? { 'f.type': many('type') } : {}),
    ...(many('state').length ? { 'f.state': many('state') } : {}),
    ...(many('reading').length
      ? { 'f.reading': many('reading') as NonNullable<VehiclesParams['f.reading']> }
      : {}),
    ...(many('due').length ? { 'f.due': many('due') as NonNullable<VehiclesParams['f.due']> } : {}),
    ...(not.length ? { not } : {}),
    ...(sort ? { sort } : {}),
    ...(list.dir ? { dir: list.dir } : {}),
  };
}

export function VehiclesList() {
  const listFmt = useFormat();
  const staleDays = listFmt.num(ADVICE_DAYS);
  const unknownDays = listFmt.num(UNKNOWN_DAYS);
  const { t } = useLingui();
  const [list] = useListState();
  const f = useFilterRegistry();
  const lifecycle = useLifecycleLabels();
  const locations = useLocations();
  const locationName = useLocationName();
  const online = useOnline();
  const [adding, setAdding] = useState(false);

  const withModule = (locations.data ?? []).filter((l) => accessOf(l).moduleOn('vehicles'));
  const names = new Map(withModule.map((l) => [l.id, locationName(l)]));
  const accountIds = [...new Set(withModule.map((l) => l.ownerAccountId))];
  // Add a vehicle: in the first location with Vehicles on where you can add things.
  const addTo = withModule.find((l) => accessOf(l).can('things.edit'));

  const query = useVehicles(vehiclesParams(list));
  const group = list.group === 'location' || list.group === 'type' ? list.group : 'none';

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
      ...f.type(),
      values: {
        from: 'load',
        queryKey: ['filters', 'vehicle-types', accountIds],
        load: async () => {
          const lists = await Promise.all(accountIds.map((id) => inventoryApi.types(id)));
          const seen = new Set<string>();
          return lists
            .flatMap((r) =>
              r.types.filter(
                (ty) => !ty.isFieldGroup && !ty.archivedAt && isVehicleType(ty.id, r.types),
              ),
            )
            .filter((ty) => !seen.has(ty.id) && seen.add(ty.id))
            .map((ty) => ({
              value: ty.id,
              label: ty.name ?? builtinName(ty.builtinKey),
              icon: <TypeIcon icon={ty.icon} />,
            }))
            .filter((o) => o.label)
            .sort((a, b) => a.label.localeCompare(b.label));
        },
      },
    },
    {
      key: 'state',
      label: t`State`,
      icon: <ActivityIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: LIFECYCLES.map((l) => ({ value: l, label: lifecycle[l] })),
      },
    },
    {
      key: 'reading',
      label: t`Reading`,
      icon: <ClockIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: [
          { value: 'fresh', label: t`Read lately` },
          { value: 'stale', label: t`Over ${staleDays} days old` },
          { value: 'unknown', label: t`Over ${unknownDays} days old` },
          { value: 'none', label: t`No reading` },
        ],
      },
    },
    {
      key: 'due',
      label: t`Due`,
      icon: <CalendarIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: [
          { value: 'overdue', label: t`Overdue` },
          { value: 'soon', label: t`Due soon` },
        ],
      },
    },
  ];
  // Built-in names come translated from the shared library through the registry's type filter;
  // this list only needs them for its own vehicle types.
  const builtinName = useBuiltinVehicleNames();

  return (
    <>
      {!online ? (
        <Notice tone="warn" title={t`Needs a connection`}>
          <Trans>The vehicles list comes from the server. Log a reading still works offline.</Trans>
        </Notice>
      ) : null}
      <ListSurface<VehicleRow>
        label={t`Vehicles`}
        search={{ label: t`Search vehicles`, placeholder: t`Search by name` }}
        filters={filters}
        surface="vehicles"
        sorts={[
          { value: 'name', label: t`Name` },
          { value: 'lastReading', label: t`Last reading`, kind: 'date' },
          { value: 'nextDue', label: t`Next due`, kind: 'due' },
          { value: 'location', label: t`Location` },
        ]}
        groups={[
          { value: 'none', label: t`None` },
          { value: 'location', label: t`Location`, short: t`by location` },
          { value: 'type', label: t`Type`, short: t`by type` },
        ]}
        query={query}
        getKey={(v) => v.thing.id}
        groupOf={(v, by) =>
          by === 'location'
            ? { key: v.thing.locationId, label: <bdi>{names.get(v.thing.locationId) ?? ''}</bdi> }
            : by === 'type'
              ? {
                  key: v.thing.type?.id ?? '',
                  label: <bdi>{v.thing.type?.name ?? builtinName(v.thing.type?.builtinKey)}</bdi>,
                }
              : null
        }
        defaultGroup={group === 'none' ? undefined : group}
        renderRow={(v) => <VehicleRowView vehicle={v} />}
        empty={
          <EmptyState
            icon={<CarIcon />}
            title={<Trans>No vehicles yet</Trans>}
            action={
              addTo ? (
                <div className="grid justify-items-center gap-2">
                  <Button onPress={() => setAdding(true)} isDisabled={!online}>
                    <Trans>Add a vehicle</Trans>
                  </Button>
                  <Link
                    to="/capture"
                    className="text-small text-ink-2 underline underline-offset-2"
                  >
                    <Trans>or read its registration card in LABEL mode</Trans>
                  </Link>
                </div>
              ) : null
            }
          >
            <Trans>
              A car, a motorbike or a generator: Kept keeps its odometer, what's due, fuel and
              running costs.
            </Trans>
          </EmptyState>
        }
      />
      {adding && addTo ? (
        <CreateThingSheet
          isOpen
          locationId={addTo.id}
          title={t`Add a vehicle`}
          presetType="car"
          onClose={() => setAdding(false)}
        />
      ) : null}
    </>
  );
}

/** The names of the built-in vehicle types, for a row or a filter whose type has no own name. */
function useBuiltinVehicleNames() {
  const { t } = useLingui();
  const names = useMemo<Record<string, string>>(
    () => ({
      vehicle: t`Vehicle`,
      car: t`Car`,
      motorbike: t`Motorbike`,
      bicycle: t`Bicycle`,
      generator: t`Generator`,
    }),
    [t],
  );
  return (key: string | null | undefined) => (key ? (names[key] ?? key) : '');
}

/** One vehicle in the list. Everything wraps at 375 px; nothing is cut short. */
export function VehicleRowView({ vehicle }: { vehicle: VehicleRow }) {
  const { t } = useLingui();
  const access = useLocationAccess()(vehicle.thing.locationId);
  const reading = useReadingText();
  const consumption = useConsumption();
  const lifecycle = useLifecycleLabels();
  const fmt = useFormat();
  const { thing, meter, nextDue, documentsDue, fuel } = vehicle;
  const name = thing.name ?? t`Untitled`;
  const latest = meter?.latest;
  return (
    <article
      aria-label={name}
      data-vehicle={thing.id}
      className="flex min-w-0 items-start gap-3 px-3.5 py-3"
    >
      <Tile>
        {thing.thumbUrl ? (
          <img src={thing.thumbUrl} alt="" className="size-full object-cover" />
        ) : (
          <TypeIcon icon={thing.type?.icon} />
        )}
      </Tile>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to="/t/$id"
            params={{ id: addressOf(thing) }}
            className="font-semibold text-[15px] leading-snug text-ink underline-offset-2 [overflow-wrap:anywhere] hover:underline"
          >
            <bdi>{name}</bdi>
          </Link>
          <IdChip code={thing.shortCode} />
          {thing.lifecycle !== 'in_use' ? <Pill>{lifecycle[thing.lifecycle]}</Pill> : null}
        </div>
        {thing.path.length ? <PathText path={thing.path} /> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {meter ? (
            latest ? (
              <Line>
                <span className="font-medium text-ink tabular-nums">
                  {reading(latest.value, meter.unit)}
                </span>
                {fmt.sep}
                <ReadAgo ageDays={meter.estimate.ageDays} />
              </Line>
            ) : (
              <Line>
                <Trans>No reading yet</Trans>
              </Line>
            )
          ) : null}
          <AdvicePill estimate={meter?.estimate} />
        </div>
        {nextDue ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Line icon={<CalendarIcon />}>
              <NextDueText next={nextDue} unit={meter?.unit} advice={meter?.estimate.advice} />
            </Line>
            {nextDue.state === 'overdue' ? (
              <Pill tone="danger" icon={<AlertIcon />}>
                <Trans>Overdue</Trans>
              </Pill>
            ) : null}
          </div>
        ) : null}
        {documentsDue.map((d) => (
          <Line key={d.id} icon={<DocumentIcon />}>
            <DocumentDueText kind={d.kind} expiresOn={d.expiresOn} today={access.today} />
          </Line>
        ))}
        {fuel ? (
          <Line icon={<BoxIcon />}>
            {consumption(fuel.perHundred, fuel.unit, fuel.distanceUnit)}
          </Line>
        ) : null}
      </div>
    </article>
  );
}
