/**
 * Log fuel (plan T21; the board's vehicle frames; D28, D170, D11; Q3, Q6, Q7, Q11): a fill or a
 * charge on a vehicle. In order: when (today and now by default, on Kept's own date and time
 * pickers), the unit (L · kWh · gal, remembered per vehicle as its latest fill's), the amount,
 * full or partial, "I missed a fill-up before this one" (D170: consumption skips the gap), the
 * cost and its currency (where money shows), the station (a vendor, created inline as a station,
 * D11), the odometer (optional, checked against its neighbours and refused at entry with the
 * reason, D112, with a photo-proof slot that joins the proof strip, D195), the pump receipt and a
 * note.
 *
 * Needs a connection: a fill carries money, which the phone never holds (Q3). Saving sends
 * `POST /things/:id/fuel` with an `Idempotency-Key`, then offers Undo (D150).
 */
import { type FuelUnit, newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FileTrigger } from 'react-aria-components';
import { householdKeys } from '@/api/household/queries';
import { inventoryApi } from '@/api/inventory/queries';
import type { ThingMeter } from '@/api/inventory/types';
import { useFuel, vehicleKeys, vehiclesApi } from '@/api/vehicles/queries';
import type { CreateFuelBody } from '@/api/vehicles/types';
import { useOfferUndo } from '@/components/history/undo';
import { CameraIcon } from '@/components/icons';
import { useErrorText } from '@/components/page';
import { accessOf } from '@/components/schedules/access';
import { amountOf, decimalOf, MoneyFields, useReadingRefusal } from '@/components/services/fields';
import { useThingCtx } from '@/components/things/context';
import { useLocationAccountId } from '@/components/things/pickers';
import { Sheet } from '@/components/things/sheet';
import { putFile, useUploadErrorText } from '@/components/things/upload';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { TimeField } from '@/components/ui/time-field';
import { toast } from '@/components/ui/toast';
import { useOnline } from '@/lib/online';
import { useMeterUnit } from '@/lib/units';
import { useFuelUnitNames } from './labels';

const pad = (n: number) => String(n).padStart(2, '0');
/** The phone's own day and time now: 'YYYY-MM-DD' and 'HH:MM'. */
function nowParts(d = new Date()): { day: string; time: string } {
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}
/** A local day and time as the instant the API takes. */
function instantOf(day: string, time: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [h, min] = time.split(':').map(Number) as [number, number];
  return new Date(y, m - 1, d, h, min).toISOString();
}

/** The odometer a fill reads: the thing's distance meter, else its first (a generator's hours). */
export function odometerOf(meters: readonly ThingMeter[]): ThingMeter | null {
  return meters.find((m) => m.kind === 'distance') ?? meters[0] ?? null;
}

type Upload = { key: string; name: string; fileId: string | null };

export function LogFuelSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLingui();
  return (
    <Sheet isOpen={open} onOpenChange={(o) => !o && onClose()} title={t`Log fuel`}>
      {open ? <LogFuelForm onClose={onClose} /> : null}
    </Sheet>
  );
}

/** A station: one of the account's stations, or a new name the server adds as one (D11). */
type Station = { id: string | null; text: string };

function StationField({
  accountId,
  value,
  onChange,
}: {
  accountId: string;
  value: Station;
  onChange: (v: Station) => void;
}) {
  const { t } = useLingui();
  const vendors = useQuery({
    queryKey: ['registry', 'vendors', accountId, { limit: 200 }],
    queryFn: () => inventoryApi.registry('vendors', accountId, { limit: 200 }),
    enabled: !!accountId,
  });
  const items = (vendors.data?.items ?? [])
    .filter((x) => x.kind === 'station')
    .map((x) => ({ id: x.id, label: x.name }));
  const isNew = !value.id && value.text.trim() !== '';
  return (
    <Combobox
      label={t`Station`}
      description={
        isNew
          ? t`A new station: it's added to your vendors when you save.`
          : t`Optional. Pick one, or type a new name.`
      }
      items={items}
      allowsCustomValue
      menuTrigger="focus"
      selectedKey={value.id}
      inputValue={value.text}
      onInputChange={(text) =>
        onChange({
          id: value.id && items.find((i) => i.id === value.id)?.label === text ? value.id : null,
          text,
        })
      }
      onSelectionChange={(k) => {
        if (k === null) return;
        const id = String(k);
        onChange({ id, text: items.find((i) => i.id === id)?.label ?? '' });
      }}
      placeholder={t`Search stations`}
      emptyText={t`No match: this name is added as a new station`}
    />
  );
}

/** A photo picked and uploaded to the location, for the odometer's proof or the receipt. */
function PhotoSlot({
  label,
  replaceLabel,
  value,
  onChange,
  locationId,
}: {
  label: string;
  replaceLabel: string;
  value: Upload | null;
  onChange: (u: Upload | null) => void;
  locationId: string;
}) {
  const { t } = useLingui();
  const uploadError = useUploadErrorText();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FileTrigger
        acceptedFileTypes={['image/*']}
        onSelect={(files) => {
          const file = files?.[0];
          if (!file) return;
          const key = newId();
          onChange({ key, name: file.name, fileId: null });
          void putFile({ file, locationId }).then(
            (f) => onChange({ key, name: file.name, fileId: f.id }),
            (e: unknown) => {
              onChange(null);
              toast({
                title: t`Couldn't upload ${file.name}`,
                description: uploadError(e),
                tone: 'danger',
              });
            },
          );
        }}
      >
        <Button variant="secondary" size="small">
          <CameraIcon className="size-4" />
          {value ? replaceLabel : label}
        </Button>
      </FileTrigger>
      {value ? (
        <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
          {value.fileId ? <Trans>Photo added</Trans> : <Trans>Uploading…</Trans>}
        </span>
      ) : null}
    </div>
  );
}

function LogFuelForm({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const unitOf = useMeterUnit();
  const { thing, location, refresh } = useThingCtx();
  const access = accessOf(location);
  const accountId = useLocationAccountId(location);
  const unitNames = useFuelUnitNames();
  const errorText = useErrorText();
  const refusal = useReadingRefusal();
  const offerUndo = useOfferUndo();
  const qc = useQueryClient();
  const online = useOnline();
  const latest = useFuel(thing.id, { limit: 1 }).data?.pages[0]?.items[0];
  const meter = odometerOf(thing.meters);
  const start = nowParts();

  const [day, setDay] = useState<string | null>(start.day);
  const [time, setTime] = useState(start.time);
  const [unitChoice, setUnit] = useState<FuelUnit | null>(null);
  // Remembered per vehicle: its latest fill's unit, until one is picked here.
  const unit: FuelUnit = unitChoice ?? latest?.unit ?? 'L';
  const [amount, setAmount] = useState('');
  const [full, setFull] = useState<'full' | 'partial'>('full');
  const [missed, setMissed] = useState(false);
  const [cost, setCost] = useState('');
  const [currency, setCurrency] = useState<string | null>(location.currency ?? null);
  const [station, setStation] = useState<Station>({ id: null, text: '' });
  const [odometer, setOdometer] = useState('');
  const [proof, setProof] = useState<Upload | null>(null);
  const [receipt, setReceipt] = useState<Upload | null>(null);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const clear = (key: string) => setErrors(({ [key]: _, ...rest }) => rest);
  const uploading = !!(proof && !proof.fileId) || !!(receipt && !receipt.fileId);

  const save = async () => {
    const next: Record<string, string> = {};
    if (!day) next.day = t`Pick the day.`;
    else if (day > start.day) next.day = t`Not in the future.`;
    const a = decimalOf(amount);
    if (!a || Number(a) <= 0 || !/^\d{1,7}(\.\d{1,3})?$/.test(a))
      next.amount = t`Enter how much, like 40 or 38.5.`;
    const c = access.money ? amountOf(cost) : '';
    if (c === null) next.cost = t`Enter an amount, like 1250 or 1250.50.`;
    else if (c && !currency) next.cost = t`A price needs a currency.`;
    const odo = meter ? decimalOf(odometer) : '';
    if (odo === null) next.odometer = t`Enter a number, like 52340.`;
    setErrors(next);
    if (Object.keys(next).length || !day || !a) return;
    const name = station.text.trim();
    const id = newId();
    const body: CreateFuelBody = {
      id,
      takenAt: instantOf(day, time),
      amount: a,
      unit,
      isFull: full === 'full',
      ...(missed ? { missedBefore: true } : {}),
      ...(c ? { cost: c, ...(currency ? { currency } : {}) } : {}),
      ...(station.id ? { vendor: { id: station.id } } : name ? { vendor: { name } } : {}),
      ...(odo && meter
        ? {
            reading: {
              meterId: meter.id,
              value: odo,
              ...(proof?.fileId ? { proofFileId: proof.fileId } : {}),
            },
          }
        : {}),
      ...(receipt?.fileId ? { receiptFileId: receipt.fileId } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setBusy(true);
    try {
      const { body: result, auditEvents } = await vehiclesApi.createFuel(thing.id, body, id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: householdKeys.thing(thing.id) }),
        qc.invalidateQueries({ queryKey: vehicleKeys.all }),
        ...(meter ? [qc.invalidateQueries({ queryKey: ['meters', meter.id] })] : []),
        refresh(),
      ]);
      offerUndo(
        {
          title: t`Fuel logged`,
          ...(result.reading?.state === 'needs_review'
            ? {
                description: t`The odometer reading looks off, so it waits in your Inbox for a look.`,
              }
            : {}),
        },
        auditEvents,
      );
      onClose();
    } catch (e) {
      const why = meter ? refusal(e, meter.unit) : null;
      if (why) setErrors({ odometer: why });
      else toast({ title: t`Couldn't log the fuel`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="m-0 font-semibold text-[15px] [overflow-wrap:anywhere]">
        <bdi>{thing.name}</bdi>
      </p>
      <div className="flex flex-wrap items-start gap-3">
        <DatePicker
          label={t`Date`}
          value={day}
          maxValue={start.day}
          onChange={(v) => {
            setDay(v);
            clear('day');
          }}
          {...(errors.day ? { errorMessage: errors.day } : {})}
        />
        <TimeField label={t`Time`} value={time} onChange={setTime} />
      </div>

      <Segmented<FuelUnit>
        label={t`Unit`}
        value={unit}
        onChange={setUnit}
        options={(['L', 'kWh', 'gal'] as const).map((u) => ({ id: u, label: unitNames[u] }))}
      />
      <TextField
        label={t`Amount, ${unitNames[unit]}`}
        value={amount}
        onChange={(v) => {
          setAmount(v);
          clear('amount');
        }}
        inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
        {...(errors.amount ? { errorMessage: errors.amount, isInvalid: true } : {})}
      />
      <Segmented<'full' | 'partial'>
        label={unit === 'kWh' ? t`Charge` : t`Fill`}
        value={full}
        onChange={setFull}
        options={[
          { id: 'full', label: unit === 'kWh' ? t`To full` : t`Full tank` },
          { id: 'partial', label: t`Partial` },
        ]}
        description={
          full === 'partial'
            ? t`Consumption is measured from one full fill to the next; this one counts in the next full's.`
            : undefined
        }
      />
      <div className="grid gap-1">
        <Switch isSelected={missed} onChange={setMissed}>
          <Trans>I missed a fill-up before this one</Trans>
        </Switch>
        <p className="m-0 text-small text-ink-2">
          <Trans>Consumption skips the gap, so it stays right.</Trans>
        </p>
      </div>

      {access.money ? (
        <MoneyFields
          label={t`Cost`}
          amount={cost}
          onAmount={(v) => {
            setCost(v);
            clear('cost');
          }}
          currency={currency}
          onCurrency={setCurrency}
          error={errors.cost}
        />
      ) : null}

      <StationField accountId={accountId} value={station} onChange={setStation} />

      {meter ? (
        <div className="grid gap-2">
          <TextField
            label={t`Odometer, ${unitOf(meter.unit)}`}
            description={t`Optional. Checked against the readings before and after it.`}
            value={odometer}
            onChange={(v) => {
              setOdometer(v);
              clear('odometer');
            }}
            inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
            {...(errors.odometer ? { errorMessage: errors.odometer, isInvalid: true } : {})}
          />
          <PhotoSlot
            label={t`Photo of the odometer`}
            replaceLabel={t`Replace the photo`}
            value={proof}
            onChange={setProof}
            locationId={location.id}
          />
        </div>
      ) : null}

      <PhotoSlot
        label={t`Pump receipt`}
        replaceLabel={t`Replace the receipt`}
        value={receipt}
        onChange={setReceipt}
        locationId={location.id}
      />

      <TextField label={t`Note`} value={note} onChange={setNote} inputProps={{ dir: 'auto' }} />

      {!online ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection: it has money. A reading alone can be logged offline.</Trans>
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online || uploading}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
