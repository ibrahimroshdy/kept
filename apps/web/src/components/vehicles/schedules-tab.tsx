/**
 * A vehicle's Schedules tab (plan T18; D52, D188): step 4's schedules section for the thing, each
 * unit schedule with its estimated date ("estimated ~14 Nov", from the meter's series, T7), what
 * the estimates rest on, and, when nothing is scheduled, the starter schedules.
 */
import { useThingCtx } from '@/components/things/context';
import { ThingSchedulesSection } from '@/components/things/schedules-section';
import { useFormat } from '@/lib/format';
import { EstimatedPill, useEstimatedDates, useMainMeter } from './estimates';
import { EstimateNote } from './overview';
import { StarterSchedulesEmpty } from './starter-schedules';

export function VehicleSchedules() {
  const { thing } = useThingCtx();
  const fmt = useFormat();
  const meter = useMainMeter();
  const estimated = useEstimatedDates();
  const first = [...estimated.values()].sort()[0];
  return (
    <ThingSchedulesSection
      key={thing.id}
      note={(s) => {
        const on = estimated.get(s.id);
        return on ? <EstimatedPill on={on} /> : null;
      }}
      empty={<StarterSchedulesEmpty />}
      footer={
        meter?.estimate ? (
          <EstimateNote
            ageDays={meter.estimate.ageDays}
            advice={meter.estimate.advice}
            nudgeDays={meter.nudgeDays ?? 30}
            next={first ? fmt.day(first) : null}
            show
          />
        ) : null
      }
    />
  );
}
