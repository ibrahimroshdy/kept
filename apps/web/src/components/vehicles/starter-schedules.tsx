/**
 * Starter schedules (plan T18, T13; D52, engineering spec §3.4 "Schedules, none", Q25): a vehicle
 * with nothing scheduled is offered the usual four (oil change, tyre rotation, brake fluid, air
 * filter), each with its interval, whichever comes first. They're editable defaults, not the
 * maker's advice, and never made without asking: the sheet lists them ticked, any can be
 * unticked, and Add makes the ticked ones (`POST /things/:id/starter-schedules`), with Undo. On a
 * meter in miles, or without a distance meter, each is by months alone (no rounded conversion).
 */
import {
  STARTER_SCHEDULES,
  type StarterKey,
  type StarterSchedule,
  starterInterval,
} from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import type { Schedule } from '@/api/household/types';
import { vehiclesApi } from '@/api/vehicles/queries';
import { useOfferUndo } from '@/components/history/undo';
import { ScheduleIcon } from '@/components/icons';
import { EmptyState, useErrorText } from '@/components/page';
import { useInvalidateHousehold } from '@/components/schedules/access';
import { useScheduleText } from '@/components/schedules/labels';
import { useThingCtx } from '@/components/things/context';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { TickBox } from '@/components/ui/tick-box';
import { toast } from '@/components/ui/toast';
import { useOnline } from '@/lib/online';
import { useMainMeter } from './estimates';

export function useStarterNames(): Record<StarterKey, string> {
  const { t } = useLingui();
  return {
    oil_change: t`Oil change`,
    tyre_rotation: t`Tyre rotation`,
    brake_fluid: t`Brake fluid`,
    air_filter: t`Air filter`,
  };
}

/** The empty Schedules tab of a vehicle: what starter schedules are, and the sheet. */
export function StarterSchedulesEmpty() {
  const { can } = useThingCtx();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const manage = can('schedules-claims.manage');
  return (
    <>
      <EmptyState
        icon={<ScheduleIcon />}
        title={<Trans>Nothing scheduled</Trans>}
        action={
          manage ? (
            <Button onPress={() => setOpen(true)} isDisabled={!online}>
              <Trans>Add starter schedules</Trans>
            </Button>
          ) : null
        }
      >
        <Trans>
          Start from the usual four: oil change, tyre rotation, brake fluid and air filter. Change
          or remove any of them later.
        </Trans>
      </EmptyState>
      {manage ? <StarterSchedulesSheet isOpen={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function StarterSchedulesSheet({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Starter schedules`}
    >
      {isOpen ? <StarterForm onClose={onClose} /> : null}
    </Sheet>
  );
}

function StarterForm({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const { thing } = useThingCtx();
  const meter = useMainMeter();
  const names = useStarterNames();
  const text = useScheduleText();
  const online = useOnline();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateHousehold();
  const errorText = useErrorText();
  const [picked, setPicked] = useState<Set<StarterKey>>(
    () => new Set(STARTER_SCHEDULES.map((s) => s.key)),
  );
  const [busy, setBusy] = useState(false);
  const intervalOf = (s: StarterSchedule) => {
    const i = starterInterval(s, meter);
    return text.interval({
      everyMonths: i.everyMonths,
      everyUnits: i.everyUnits,
      meter: i.everyUnits && meter ? { id: meter.id, label: '', unit: meter.unit } : null,
      dueOn: null,
    } as Schedule);
  };
  const toggle = (k: StarterKey, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });
  const save = async () => {
    setBusy(true);
    try {
      const keys = STARTER_SCHEDULES.map((s) => s.key).filter((k) => picked.has(k));
      const { body, auditEvents } = await vehiclesApi.starterSchedules(thing.id, { keys });
      await invalidate();
      onClose();
      const n = body.schedules.length;
      if (n === 0) toast({ title: t`It has those already`, tone: 'ok' });
      else
        offerUndo(
          { title: plural(n, { one: 'Added # schedule', other: 'Added # schedules' }) },
          auditEvents,
          { thingId: thing.id },
        );
    } catch (e) {
      toast({ title: t`Couldn't add them`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-3">
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Whichever comes first. These are common defaults, not your maker's advice: check the
          handbook and edit them to match.
        </Trans>
      </p>
      <div className="grid">
        {STARTER_SCHEDULES.map((s) => (
          <TickBox
            key={s.key}
            isSelected={picked.has(s.key)}
            onChange={(on) => toggle(s.key, on)}
            description={intervalOf(s)}
          >
            {names[s.key]}
          </TickBox>
        ))}
      </div>
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          onPress={() => void save()}
          isPending={busy}
          isDisabled={picked.size === 0 || !online}
        >
          <Trans>Add</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
