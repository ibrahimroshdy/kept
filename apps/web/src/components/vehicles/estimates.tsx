/**
 * Estimated due dates on a vehicle's schedules (plan T18, T7; D52, D188): the meter series'
 * thresholds carry each unit schedule's `estimatedOn` (`kept.meter_eta`), so the Overview and the
 * Schedules tab show "estimated ~14 Nov" without a second implementation of the estimate. A meter
 * whose latest reading is 60 days old or more (`unknown`) gives no estimated dates.
 */
import { Trans } from '@lingui/react/macro';
import { useMemo } from 'react';
import type { ThingMeter } from '@/api/inventory/types';
import { useMeterSeries } from '@/api/vehicles/queries';
import type { ThingMeterV5 } from '@/api/vehicles/types';
import { ClockIcon } from '@/components/icons';
import { Pill } from '@/components/page';
import { useThingCtx } from '@/components/things/context';
import { useFormat } from '@/lib/format';
import { mainMeterOf } from './is-vehicle';

/** The vehicle's odometer, with its estimate when the server sent one (step 5's GET /things/:id). */
export function useMainMeter():
  | (ThingMeter & Partial<Pick<ThingMeterV5, 'estimate' | 'nudgeDays'>>)
  | null {
  const { thing } = useThingCtx();
  return mainMeterOf(thing.meters) as
    | (ThingMeter & Partial<Pick<ThingMeterV5, 'estimate' | 'nudgeDays'>>)
    | null;
}

/** Schedule id → its estimated date, from the meter's series; empty when it's `unknown`. */
export function useEstimatedDates(): Map<string, string> {
  const meter = useMainMeter();
  const series = useMeterSeries(meter?.id ?? '');
  const unknown = meter?.estimate?.advice === 'unknown';
  return useMemo(() => {
    const out = new Map<string, string>();
    if (unknown) return out;
    for (const th of series.data?.thresholds ?? [])
      if (th.estimatedOn) out.set(th.scheduleId, th.estimatedOn);
    return out;
  }, [series.data, unknown]);
}

/** "estimated ~14 Nov" (D52: a distance due point is always labelled estimated). */
export function EstimatedPill({ on }: { on: string }) {
  const fmt = useFormat();
  const day = fmt.day(on);
  return (
    <Pill tone="info" icon={<ClockIcon />}>
      <Trans>estimated ~{day}</Trans>
    </Pill>
  );
}
