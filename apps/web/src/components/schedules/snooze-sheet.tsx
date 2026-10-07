/**
 * Snooze (plan T21; screens §8, step-4 Q28): move a schedule's due point to a date, or, when it
 * counts on a meter, to a reading, which defaults to the due reading plus 10% of the interval
 * (1,000 km on a 10,000 km schedule). A snooze replaces the due point until the schedule is
 * completed; Unsnooze (the row's action) takes it back. Undoable.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { householdApi } from '@/api/household/queries';
import type { Schedule, SnoozeBody } from '@/api/household/types';
import { useOfferUndo } from '@/components/history/undo';
import { useErrorText } from '@/components/page';
import { decimalOf } from '@/components/services/fields';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useMeterUnit } from '@/lib/units';
import { addDays, useInvalidateHousehold, useLocationAccess } from './access';
import { useUnits } from './labels';

/** The reading a snooze to a value starts at: the due reading plus 10% of the interval. */
export function defaultSnoozeValue(s: Schedule): string | null {
  const base = Number(s.next.dueValue ?? s.snoozedUntilValue ?? s.anchorValue ?? Number.NaN);
  const every = Number(s.everyUnits ?? Number.NaN);
  if (!Number.isFinite(base) || !Number.isFinite(every)) return null;
  const v = base + every / 10;
  return String(Math.round(v * 100) / 100);
}

/** The day a snooze to a date starts at: a week after the later of today and the due day. */
export function defaultSnoozeDate(s: Schedule, today: string): string {
  const from = s.next.dueOn && s.next.dueOn > today ? s.next.dueOn : today;
  return addDays(from, 7);
}

export function SnoozeSheet({
  schedule,
  onClose,
}: {
  schedule: Schedule | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={!!schedule}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={schedule ? t`Snooze ${schedule.name}` : ''}
    >
      {schedule ? <SnoozeForm key={schedule.id} schedule={schedule} onClose={onClose} /> : null}
    </Sheet>
  );
}

function SnoozeForm({ schedule: s, onClose }: { schedule: Schedule; onClose: () => void }) {
  const { t } = useLingui();
  const f = useFormat();
  const units = useUnits();
  const unitOf = useMeterUnit();
  const access = useLocationAccess()(s.locationId);
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateHousehold();
  const errorText = useErrorText();
  const online = useOnline();
  const byUnits = !!s.meter && s.everyUnits != null;
  const [mode, setMode] = useState<'date' | 'value'>(
    byUnits && s.next.dueOn == null ? 'value' : 'date',
  );
  const tomorrow = addDays(access.today, 1);
  const [until, setUntil] = useState<string | null>(defaultSnoozeDate(s, access.today));
  const [value, setValue] = useState(defaultSnoozeValue(s) ?? '');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    let body: SnoozeBody;
    if (mode === 'date') {
      if (!until || until < tomorrow) {
        setError(t`Pick a day after today.`);
        return;
      }
      body = { untilDate: until };
    } else {
      const v = decimalOf(value);
      if (!v) {
        setError(t`Enter a number, like 60250.`);
        return;
      }
      body = { untilValue: v };
    }
    setBusy(true);
    try {
      const { auditEvents } = await householdApi.snoozeSchedule(s.id, body, s.rowVersion);
      const said =
        'untilDate' in body ? f.day(body.untilDate) : units(body.untilValue, s.meter?.unit);
      const thingId = s.subject.type === 'thing' ? s.subject.id : undefined;
      offerUndo({ title: t`Snoozed until ${said}` }, auditEvents, thingId ? { thingId } : {});
      await invalidate();
      onClose();
    } catch (e) {
      toast({ title: t`Couldn't snooze it`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      className="grid gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {byUnits ? (
        <Segmented
          label={t`Until`}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(undefined);
          }}
          options={[
            { id: 'date', label: t`A date` },
            { id: 'value', label: t`A reading` },
          ]}
        />
      ) : null}
      {mode === 'date' ? (
        <DatePicker
          label={t`Snooze until`}
          value={until}
          onChange={(v) => {
            setUntil(v);
            setError(undefined);
          }}
          minValue={tomorrow}
          {...(error ? { errorMessage: error } : {})}
        />
      ) : (
        <TextField
          label={t`Snooze until, ${unitOf(s.meter?.unit)}`}
          description={t`10% of the interval past the due reading, unless you change it.`}
          value={value}
          onChange={(v) => {
            setValue(v);
            setError(undefined);
          }}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
          {...(error ? { errorMessage: error, isInvalid: true } : {})}
        />
      )}
      {!online ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online}>
          <Trans>Snooze</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
