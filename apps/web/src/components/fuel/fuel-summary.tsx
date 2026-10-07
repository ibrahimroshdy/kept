/**
 * The fuel summary card (plan T21; the board's vehicle frames 67 and 68; D28, Q6, Q7, Q22): the
 * consumption over the last full fills in the reader's units ("7.3 L/100 km · last 5 full fills"),
 * the fuel cost per distance ("EGP 1.75/km · fuel only"), the monthly average ("≈ EGP 3,300 · a
 * month") and the latest fill ("40.0 L · 27 Sep · EGP 960"). Money is per currency, never added
 * across currencies (Q22), and only when the response has it: a viewer without money sees the
 * litres and the consumption, and "Hidden in this location" for the rest. With no consumption,
 * the reason is said in words (`whyNone`).
 *
 * Mounted by the vehicle page inside its ThingProvider (on the Overview and at the top of the
 * Fuel tab); it reads the thing and the caller's role from the context.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { useFuel, useFuelSummary } from '@/api/vehicles/queries';
import type { FuelSummary } from '@/api/vehicles/types';
import { MoneyHiddenText } from '@/components/money/gated';
import { ErrorState, Skeleton } from '@/components/page';
import { accessOf } from '@/components/schedules/access';
import { useUnits } from '@/components/schedules/labels';
import { useThingCtx } from '@/components/things/context';
import { useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { FuelIcon, useConsumptionText, useFuelAmount, useWhyNoneText } from './labels';

/** One figure and what it covers, as the board's quad draws it. */
function Fact({ value, caption }: { value: ReactNode; caption: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <span className="font-semibold text-[17px] text-ink tabular-nums [overflow-wrap:anywhere]">
        {value}
      </span>
      <span className="text-small text-ink-2 [overflow-wrap:anywhere]">{caption}</span>
    </div>
  );
}

/** The summary's figures as facts: consumption per unit, then the money per currency. */
export function SummaryFacts({ summary, extra }: { summary: FuelSummary; extra?: ReactNode }) {
  const consumptionText = useConsumptionText();
  const whyNone = useWhyNoneText();
  const money = useMoney();
  const facts: ReactNode[] = [];
  for (const u of summary.byUnit) {
    if (u.consumption)
      facts.push(
        <Fact
          key={`c-${u.unit}`}
          value={
            <bdi>
              {consumptionText(u.consumption.perHundred, u.unit, u.consumption.distanceUnit)}
            </bdi>
          }
          caption={
            <Plural
              value={u.consumption.fills}
              one="the last full fill"
              other="the last # full fills"
            />
          }
        />,
      );
  }
  if (!summary.moneyHidden) {
    for (const d of summary.perDistance ?? []) {
      const amount = money(d.amount, d.currency);
      const unit = d.distanceUnit;
      facts.push(
        <Fact
          key={`d-${d.currency}`}
          value={
            <bdi>
              <Trans>
                {amount}/{unit}
              </Trans>
            </bdi>
          }
          caption={<Trans>fuel only</Trans>}
        />,
      );
    }
    for (const m of summary.monthlyAverage ?? []) {
      const amount = money(m.amount, m.currency);
      facts.push(
        <Fact
          key={`m-${m.currency}`}
          value={
            <bdi>
              <Trans>≈ {amount}</Trans>
            </bdi>
          }
          caption={
            <Plural
              value={m.months}
              one="a month, over the last month"
              other="a month, over the last # months"
            />
          }
        />,
      );
    }
  }
  const missing = summary.byUnit.filter((u) => !u.consumption);
  return (
    <div className="grid gap-3">
      {facts.length || extra ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          {facts}
          {extra}
        </div>
      ) : null}
      {summary.byUnit.length === 0 ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>No fills yet. Log one to start the consumption and the cost per km.</Trans>
        </p>
      ) : null}
      {missing.map((u) => (
        <p key={u.unit} className="m-0 text-small text-ink-2">
          {whyNone(u.whyNone)}
        </p>
      ))}
      {summary.moneyHidden ? (
        <p className="m-0 text-small">
          <Trans>Costs:</Trans> <MoneyHiddenText />
        </p>
      ) : null}
    </div>
  );
}

/** The latest fill as a fact: "40.0 L", "27 Sep · EGP 960 · 52,020 km". */
function LatestFill({ thingId }: { thingId: string }) {
  const fills = useFuel(thingId, { limit: 1 });
  const f = useFormat();
  const amount = useFuelAmount();
  const money = useMoney();
  const units = useUnits();
  const { thing } = useThingCtx();
  const last = fills.data?.pages[0]?.items[0];
  if (!last) return null;
  const odo = thing.meters[0]?.unit;
  const parts = [
    f.day(last.takenAt),
    ...(last.cost && last.currency ? [money(last.cost, last.currency)] : []),
    ...(last.reading ? [units(last.reading.value, odo)] : []),
  ];
  return (
    <Fact
      value={<bdi>{amount(last.amount, last.unit)}</bdi>}
      caption={
        <>
          <Trans>Latest:</Trans>{' '}
          {parts.map((p, i) => (
            <span key={p}>
              {i > 0 ? sep() : null}
              <bdi>{p}</bdi>
            </span>
          ))}
        </>
      }
    />
  );
}

/**
 * The card: the facts, the latest fill and Log fuel. `onLogFuel` opens the sheet (the vehicle
 * page owns it); without it the button is left out.
 */
export function FuelSummaryCard({
  onLogFuel,
  allFills,
}: {
  onLogFuel?: () => void;
  /** "All fills": a link or button to the Fuel tab, when the card sits on the Overview. */
  allFills?: ReactNode;
}) {
  const { t } = useLingui();
  const { thing, location, moduleOn } = useThingCtx();
  const online = useOnline();
  const summary = useFuelSummary(thing.id);
  const canLog = accessOf(location).can('logs.add');
  if (!moduleOn('fuel')) return null;
  return (
    <section
      // A landmark on the Fuel tab only: on a phone the Overview and the Fuel tab are one page,
      // and two regions named "Fuel" fail axe's landmark-unique.
      aria-label={allFills ? undefined : t`Fuel`}
      className="grid gap-3 rounded-[12px] border border-line bg-surface p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 flex items-center gap-2 font-semibold text-[15px]">
          <FuelIcon className="size-[18px] text-ink-2" />
          <Trans>Fuel</Trans>
        </h3>
        {allFills}
      </div>
      {summary.isPending ? (
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : summary.data ? (
        <SummaryFacts summary={summary.data} extra={<LatestFill thingId={thing.id} />} />
      ) : null}
      {canLog && onLogFuel ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="small" isDisabled={!online} onPress={onLogFuel}>
            <FuelIcon className="size-4" />
            <Trans>Log fuel</Trans>
          </Button>
          {online ? null : (
            <span className="text-small text-ink-2">
              <Trans>Needs a connection: it has money.</Trans>
            </span>
          )}
        </div>
      ) : null}
    </section>
  );
}
