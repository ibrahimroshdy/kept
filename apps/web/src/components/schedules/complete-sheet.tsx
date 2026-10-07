/**
 * Complete (plan T21; D29, screens §5): one sheet from the Schedules list, the thing page and the
 * notification centre (step-4 Q32). Completing records a service that completes the schedule and
 * restarts its count: the date (today by default, never in the future), a reading when the
 * schedule counts on a meter (checked against its neighbours, D112), the vendor, the total with
 * its currency (only where money shows), and notes. "Add line items or an invoice" hands over to
 * Log a service with the schedule ticked.
 *
 * Undoable: the Undo toast deletes the record (and its reading) and the schedule's count falls
 * back (T11). Needs a connection: it may carry money (screens §4).
 *
 *   <CompleteSheet schedule={s} onClose={() => setOpen(null)} onMore={(s) => openLogService(s)} />
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { householdApi } from '@/api/household/queries';
import type { CompleteScheduleBody, Schedule } from '@/api/household/types';
import { useOfferUndo } from '@/components/history/undo';
import { useErrorText } from '@/components/page';
import { amountOf, decimalOf, MoneyFields, useReadingRefusal } from '@/components/services/fields';
import { emptyVendor, VendorField, vendorInput } from '@/components/services/vendor-field';
import { useLocationAccountId } from '@/components/things/pickers';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useMeterUnit } from '@/lib/units';
import { useInvalidateHousehold, useLocationAccess } from './access';
import { useUnits } from './labels';

export function CompleteSheet({
  schedule,
  onClose,
  onMore,
}: {
  /** The schedule to complete; null keeps the sheet closed. */
  schedule: Schedule | null;
  onClose: () => void;
  /** Opens Log a service for the schedule's subject with it ticked. */
  onMore?: (schedule: Schedule) => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={!!schedule}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={schedule ? t`Complete ${schedule.name}` : ''}
    >
      {schedule ? (
        <CompleteForm
          key={schedule.id}
          schedule={schedule}
          onClose={onClose}
          {...(onMore ? { onMore } : {})}
        />
      ) : null}
    </Sheet>
  );
}

function CompleteForm({
  schedule: s,
  onClose,
  onMore,
}: {
  schedule: Schedule;
  onClose: () => void;
  onMore?: (schedule: Schedule) => void;
}) {
  const { t } = useLingui();
  const access = useLocationAccess()(s.locationId);
  const accountId = useLocationAccountId(access.location);
  const errorText = useErrorText();
  const refusal = useReadingRefusal();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateHousehold();
  const units = useUnits();
  const unitOf = useMeterUnit();
  const online = useOnline();
  const [servicedOn, setServicedOn] = useState<string | null>(access.today);
  const [reading, setReading] = useState('');
  const [vendor, setVendor] = useState(emptyVendor);
  const [total, setTotal] = useState('');
  const [currency, setCurrency] = useState<string | null>(access.location?.currency ?? null);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<{ reading?: string; total?: string; date?: string }>({});
  const [busy, setBusy] = useState(false);
  const meter = s.meter;
  const dueAt = meter && s.next.dueValue ? units(s.next.dueValue, meter.unit) : null;

  const save = async () => {
    const next: typeof errors = {};
    if (!servicedOn) next.date = t`Pick the day it was done.`;
    else if (servicedOn > access.today) next.date = t`Not in the future.`;
    const value = meter ? decimalOf(reading) : '';
    if (value === null) next.reading = t`Enter a number, like 60250.`;
    const amount = access.money ? amountOf(total) : '';
    if (amount === null) next.total = t`Enter an amount, like 1250 or 1250.50.`;
    else if (amount && !currency) next.total = t`A price needs a currency.`;
    setErrors(next);
    if (Object.keys(next).length) return;
    const body: CompleteScheduleBody = {
      ...(servicedOn ? { servicedOn } : {}),
      ...(value ? { reading: { value } } : {}),
      ...(vendorInput(vendor) ? { vendor: vendorInput(vendor) } : {}),
      ...(amount && currency ? { total: amount, currency } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    setBusy(true);
    try {
      const { auditEvents } = await householdApi.completeSchedule(s.id, body, s.rowVersion);
      const thingId = s.subject.type === 'thing' ? s.subject.id : undefined;
      offerUndo({ title: t`Done: ${s.name}` }, auditEvents, thingId ? { thingId } : {});
      await invalidate();
      onClose();
    } catch (e) {
      const why = meter ? refusal(e, meter.unit) : null;
      if (why) setErrors({ reading: why });
      else toast({ title: t`Couldn't complete it`, description: errorText(e), tone: 'danger' });
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
      <p className="m-0 text-small text-ink-2 [overflow-wrap:anywhere]">
        <bdi>{s.subject.name}</bdi>
        {s.subject.path ? (
          <>
            {sep()}
            <bdi>{s.subject.path}</bdi>
          </>
        ) : null}
      </p>
      <DatePicker
        label={t`Done on`}
        value={servicedOn}
        onChange={(v) => {
          setServicedOn(v);
          setErrors((x) => ({ ...x, date: undefined }));
        }}
        maxValue={access.today}
        {...(errors.date ? { errorMessage: errors.date } : {})}
      />
      {meter ? (
        <TextField
          label={t`${meter.label}, ${unitOf(meter.unit)}`}
          description={dueAt ? t`Optional. It was due at ${dueAt}.` : t`Optional.`}
          value={reading}
          onChange={(v) => {
            setReading(v);
            setErrors((x) => ({ ...x, reading: undefined }));
          }}
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
          {...(errors.reading ? { errorMessage: errors.reading, isInvalid: true } : {})}
        />
      ) : null}
      <VendorField accountId={accountId} value={vendor} onChange={setVendor} />
      {access.money ? (
        <MoneyFields
          label={t`Total`}
          amount={total}
          onAmount={(v) => {
            setTotal(v);
            setErrors((x) => ({ ...x, total: undefined }));
          }}
          currency={currency}
          onCurrency={setCurrency}
          error={errors.total}
        />
      ) : null}
      <TextField label={t`Notes`} value={notes} onChange={setNotes} inputProps={{ dir: 'auto' }} />
      {onMore ? (
        <Button
          variant="ghost"
          size="small"
          className="justify-self-start"
          onPress={() => {
            onClose();
            onMore(s);
          }}
        >
          <Trans>Add line items or an invoice</Trans>
        </Button>
      ) : null}
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
          <Trans context="schedule action">Complete</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
