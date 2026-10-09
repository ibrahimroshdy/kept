/**
 * A vehicle's Fuel tab (plan T21; screens §8, the board's vehicle frames; D28, D170): the summary
 * card with Log fuel, the consumption and price trends (a lazy chunk), and the fills and charges
 * as a list (the `fuel` surface: date, unit, station, full or partial; sorted by date, amount or
 * cost), each with its odometer, station, receipt and cost, and Remove with Undo for the one who
 * logged it or an admin.
 *
 * Controls follow screens §3: Log fuel for members and above (`logs.add`), none for a viewer, who
 * still reads the litres and the consumption; money only where the response has it. With Fuel &
 * charging off in the location, the tab says so, with Turn on for admins. Offline, the list isn't
 * in the phone's copy (money, Q3): the page's own offline state covers it, and Log fuel says
 * "Needs a connection".
 *
 * Mounted by the vehicle page inside its ThingProvider. Its list filters live in the URL (the
 * list standard): the thing route's `validateSearch` must accept `f.when`, `f.unit`, `f.vendor`
 * and `f.full`.
 */
import type { FuelUnit } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { householdKeys } from '@/api/household/queries';
import { inventoryApi } from '@/api/inventory/queries';
import { useFuel, useFuelSummary, vehicleKeys, vehiclesApi } from '@/api/vehicles/queries';
import type { FuelParams, FuelRow } from '@/api/vehicles/types';
import { useFilterRegistry } from '@/components/filters/registry';
import type { FilterDef } from '@/components/filters/types';
import { useOfferUndo } from '@/components/history/undo';
import { OverflowActions } from '@/components/inbox/overflow-actions';
import { ListSurface } from '@/components/list-surface';
import { MoneyHiddenText } from '@/components/money/gated';
import { EmptyState, IconTile, Pill, Row, Skeleton, useErrorText } from '@/components/page';
import { accessOf } from '@/components/schedules/access';
import { useUnits } from '@/components/schedules/labels';
import { ModuleOff, useThingCtx } from '@/components/things/context';
import { useLocationAccountId } from '@/components/things/pickers';
import { useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { useListState } from '@/lib/url-state';
import { FuelSummaryCard } from './fuel-summary';
import { FuelIcon, useFuelAmount, useFuelUnitNames, useFuelUnitShort } from './labels';
import { LogFuelSheet, odometerOf } from './log-fuel-sheet';

const FuelTrends = lazy(() =>
  // Offline before its first load the chunk can't be fetched: like the other lazy charts
  // (components/charts/lazy.tsx), show nothing instead of crashing the route (D222).
  import('./fuel-trends').catch(() => ({ default: () => null })),
);

export { FuelSummaryCard } from './fuel-summary';
export { LogFuelSheet } from './log-fuel-sheet';

/** The `fuel` surface's filters (@kept/shared SURFACE_FILTER_KEYS.fuel). */
function useFuelFilters(accountId: string): FilterDef[] {
  const { t } = useLingui();
  const registry = useFilterRegistry();
  const names = useFuelUnitNames();
  return [
    registry.date('when', t`Date`),
    {
      key: 'unit',
      label: t`Unit`,
      kind: 'multi',
      negatable: false,
      icon: <FuelIcon />,
      values: {
        from: 'static',
        options: (['L', 'kWh', 'gal'] as const).map((u) => ({ value: u, label: names[u] })),
      },
    },
    {
      key: 'vendor',
      label: t`Station`,
      kind: 'multi',
      negatable: false,
      findLabel: t`Find a station`,
      values: {
        from: 'load',
        queryKey: ['registry', 'vendors', accountId, 'stations'],
        load: async () => {
          if (!accountId) return [];
          const page = await inventoryApi.registry('vendors', accountId, { limit: 200 });
          return page.items
            .filter((v) => v.kind === 'station')
            .map((v) => ({ value: v.id, label: v.name }));
        },
      },
    },
    {
      key: 'full',
      label: t`Fill`,
      kind: 'single',
      negatable: false,
      values: {
        from: 'static',
        options: [
          { value: '1', label: t`Full` },
          { value: '0', label: t`Partial` },
        ],
      },
    },
  ];
}

/** The Fuel tab. */
export function VehicleFuel() {
  const { t } = useLingui();
  const { thing, location, moduleOn } = useThingCtx();
  const [logging, setLogging] = useState(false);
  const accountId = useLocationAccountId(location);
  if (!moduleOn('fuel')) return <ModuleOff what={<Trans>Fuel & charging</Trans>} />;
  return (
    <div className="grid min-w-0 gap-4">
      <FuelSummaryCard onLogFuel={() => setLogging(true)} />
      <Trends thingId={thing.id} />
      <FillsList accountId={accountId} label={t`Fills and charges`} />
      <LogFuelSheet open={logging} onClose={() => setLogging(false)} />
    </div>
  );
}

function Trends({ thingId }: { thingId: string }) {
  const summary = useFuelSummary(thingId);
  if (!summary.data) return null;
  return (
    <Suspense fallback={<Skeleton className="h-44" />}>
      <FuelTrends summary={summary.data} />
    </Suspense>
  );
}

function FillsList({ accountId, label }: { accountId: string; label: string }) {
  const { t } = useLingui();
  const { thing, location } = useThingCtx();
  const money = accessOf(location).money;
  const [list] = useListState();
  const filters = useFuelFilters(accountId);
  const unitNames = useFuelUnitNames();
  const { locale, digits } = usePrefs();
  const monthName = new Intl.DateTimeFormat(formatLocale(locale, digits), {
    month: 'long',
    year: 'numeric',
  });
  const first = (k: string) => list.filters[k]?.[0];
  const many = (k: string) => list.filters[k];
  const params: FuelParams = {
    ...(first('when') ? { 'f.when': first('when') } : {}),
    ...(many('unit') ? { 'f.unit': many('unit') as FuelUnit[] } : {}),
    ...(many('vendor') ? { 'f.vendor': many('vendor') } : {}),
    ...(first('full') === '0' || first('full') === '1'
      ? { 'f.full': first('full') as '0' | '1' }
      : {}),
    ...(list.sort === 'amount' || list.sort === 'cost' || list.sort === 'takenAt'
      ? { sort: list.sort }
      : {}),
    ...(list.dir ? { dir: list.dir } : {}),
  };
  const query = useFuel(thing.id, params);
  return (
    <ListSurface<FuelRow>
      label={label}
      search={false}
      surface="fuel"
      filters={filters}
      groups={[
        { value: 'none', label: t`None` },
        { value: 'month', label: t`Month`, short: t`by month` },
        { value: 'unit', label: t`Unit`, short: t`by unit` },
      ]}
      groupOf={(f, by) => {
        if (by === 'unit') return { key: f.unit, label: unitNames[f.unit] };
        if (by !== 'month') return null;
        const key = f.takenAt.slice(0, 7);
        return { key, label: monthName.format(new Date(f.takenAt)) };
      }}
      sorts={[
        { value: 'takenAt', label: t`Date`, kind: 'date' },
        { value: 'amount', label: t`Amount` },
        ...(money ? [{ value: 'cost', label: t`Cost` }] : []),
      ]}
      query={query}
      getKey={(f) => f.id}
      renderRow={(f) => <FillRow fill={f} />}
      empty={
        <EmptyState icon={<FuelIcon />} title={<Trans>No fills yet</Trans>}>
          <Trans>
            Log fuel after a fill-up or a charge to see consumption and the cost per km.
          </Trans>
        </EmptyState>
      }
    />
  );
}

function FillRow({ fill }: { fill: FuelRow }) {
  const { t } = useLingui();
  const f = useFormat();
  const { thing, location, role, me } = useThingCtx();
  const amount = useFuelAmount();
  const short = useFuelUnitShort();
  const money = useMoney();
  const units = useUnits();
  const confirm = useConfirm();
  const offerUndo = useOfferUndo();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const online = useOnline();
  const odo = odometerOf(thing.meters);
  const admin = role === 'owner' || role === 'admin';
  const mine = fill.loggedBy.displayName === me;
  const canRemove = accessOf(location).can('logs.add') && (admin || mine);
  const what = amount(fill.amount, fill.unit);
  const day = f.day(fill.takenAt);

  const remove = async () => {
    const ok = await confirm({
      title: t`Remove the fill of ${what} on ${day}?`,
      body: t`Its odometer reading goes with it. You can undo this.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    try {
      const { auditEvents } = await vehiclesApi.deleteFuel(fill.id, fill.rowVersion);
      await Promise.all([
        qc.invalidateQueries({ queryKey: householdKeys.thing(thing.id) }),
        qc.invalidateQueries({ queryKey: vehicleKeys.all }),
      ]);
      offerUndo({ title: t`Removed the fill of ${what}` }, auditEvents);
    } catch (e) {
      toast({ title: t`Couldn't remove it`, description: errorText(e), tone: 'danger' });
    }
  };

  const parts: { key: string; text: string }[] = [{ key: 'day', text: day }];
  if (fill.vendor) parts.push({ key: 'station', text: fill.vendor.name });
  if (fill.reading) parts.push({ key: 'odometer', text: units(fill.reading.value, odo?.unit) });
  return (
    <Row
      className="flex-wrap"
      leading={
        <IconTile>
          <FuelIcon />
        </IconTile>
      }
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <bdi className="tabular-nums">{what}</bdi>
          <Pill tone={fill.isFull ? 'neutral' : 'info'}>
            {fill.isFull ? <Trans>Full</Trans> : <Trans>Partial</Trans>}
          </Pill>
        </span>
      }
      subtitle={
        <>
          {parts.map((p, i) => (
            <span key={p.key}>
              {i > 0 ? sep() : null}
              <bdi>{p.text}</bdi>
            </span>
          ))}
          {fill.missedBefore ? (
            <span className="block">
              <Trans>Missed a fill-up before this one</Trans>
            </span>
          ) : null}
          {fill.reading?.state === 'needs_review' ? (
            <span className="block text-warn">
              <Trans>The odometer reading waits for review</Trans>
            </span>
          ) : null}
        </>
      }
      trailing={
        <span className="flex flex-wrap items-center justify-end gap-2">
          <span className="grid justify-items-end text-end">
            {fill.moneyHidden ? (
              <MoneyHiddenText />
            ) : fill.cost && fill.currency ? (
              <>
                <bdi className="font-semibold tabular-nums">{money(fill.cost, fill.currency)}</bdi>
                {fill.pricePerUnit ? (
                  <bdi className="text-small text-ink-2 tabular-nums">
                    <PricePer
                      price={money(fill.pricePerUnit, fill.currency)}
                      unit={short[fill.unit]}
                    />
                  </bdi>
                ) : null}
              </>
            ) : null}
          </span>
          {fill.receipt?.thumbUrl ? (
            <img
              src={fill.receipt.thumbUrl}
              alt={t`Pump receipt`}
              className="size-10 shrink-0 rounded-lg object-cover"
            />
          ) : null}
          {canRemove ? (
            <OverflowActions
              title={what}
              isDisabled={!online}
              actions={[
                { id: 'remove', label: t`Remove`, danger: true, onAction: () => void remove() },
              ]}
            />
          ) : null}
        </span>
      }
    />
  );
}

function PricePer({ price, unit }: { price: string; unit: string }) {
  return (
    <Trans>
      {price} per {unit}
    </Trans>
  );
}

/** "Log fuel" on its own, for a page header or the action strip (the desktop frame's). */
export function LogFuelButton() {
  const { location, moduleOn } = useThingCtx();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  if (!moduleOn('fuel') || !accessOf(location).can('logs.add')) return null;
  return (
    <>
      <Button variant="secondary" isDisabled={!online} onPress={() => setOpen(true)}>
        <FuelIcon className="size-4" />
        <Trans>Log fuel</Trans>
      </Button>
      <LogFuelSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
