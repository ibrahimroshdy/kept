/**
 * Log a reading (plan T19; screens §6 Quick log, §7 "Reading"; the board's frame 70; D26, D27,
 * D52, D112, D195; Q9, Q18, Q23). One sheet, opened from every door: a meter card, the vehicle's
 * Overview and Readings tabs, Home's quick log, and the first-reading step after creating a thing.
 *
 * In order: the meter (in the header), the value (either digits) with the check against the
 * latest reading under it (./reading-field.tsx), when it was taken (now by default, on Kept's own
 * date and time pickers), an optional proof photo, and a note.
 *
 * - **Online:** `POST /meters/:id/readings`, with the photo as `proofFileId` (it joins the
 *   odometer proof strip, D195). A reading that runs backwards is refused (409) with the
 *   neighbour, and **Meter replaced** (step 2's `POST /meters/:id/replaced`, `meters.manage`)
 *   records the new meter's offset and sends the reading again. A jump over the daily limit asks
 *   "Is it right?" first: **It's right** sends `confirmJump: true` (Q9); a jump the server still
 *   holds (a custom limit the client can't see) is saved for review and said so.
 * - **Offline:** a `log_reading` op in the phone's queue (./enqueue-reading.ts), the photo as its
 *   blob. "Saved on this phone. Kept checks it against your other readings when it syncs; if it
 *   doesn't fit, it waits in your Inbox."
 *
 * Opened for a viewer it never is: every door checks `logs.add` first (`useCanLogReading`).
 */
import { newId, can as roleCan } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { FileTrigger } from 'react-aria-components';
import { api, isApiError } from '@/api/client';
import { householdKeys } from '@/api/household/queries';
import { inventoryPaths } from '@/api/inventory/paths';
import type { MeterReplacedBody, ReadingConflictDetails } from '@/api/inventory/types';
import { useLocations } from '@/api/queries';
import { vehicleKeys, vehiclesApi } from '@/api/vehicles/queries';
import { useOfferUndo } from '@/components/history/undo';
import { CameraIcon, XIcon } from '@/components/icons';
import { useErrorText } from '@/components/page';
import { useReadingRefusal } from '@/components/services/fields';
import { useReviewReasonLabels } from '@/components/things/labels';
import { useMeterName } from '@/components/things/meters-section';
import { Sheet } from '@/components/things/sheet';
import { putFile, sha256Hex, useUploadErrorText } from '@/components/things/upload';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { TimeField } from '@/components/ui/time-field';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useMeterUnit, useTypedNumber } from '@/lib/units';
import { offlineSupported } from '@/offline/open';
import { useOffline } from '@/offline/provider';
import type { OfflineStore } from '@/offline/store';
import { pageStore } from '@/pwa/page-store';
import { enqueueReading } from './enqueue-reading';
import {
  CheckLine,
  checkReading,
  checkTone,
  defaultDailyLimit,
  type LatestReading,
  ReadingField,
  readingValueOf,
  useReadingCheckText,
} from './reading-field';

/** The meter a reading is of, as every door knows it (a thing's meter, a snapshot's meter). */
export type ReadingSheetMeter = {
  id: string;
  kind: string;
  unit: string;
  label: string | null;
  latest?: LatestReading | null;
};

/** What the sheet logs on: the thing (for its name and location) and one of its meters. */
export type ReadingSheetTarget = {
  thingId: string;
  thingName: string;
  locationId: string;
  meter: ReadingSheetMeter;
};

/** The phone's queue: the signed-in person's Dexie store, or the page's memory store where this
 * browser has no IndexedDB (tests, locked-down browsers). Null while Dexie opens. */
export function useReadingStore(): OfflineStore | null {
  const offline = useOffline();
  return offline?.store ?? (offlineSupported() ? null : pageStore());
}

/** Whether the caller may log a reading in a location (`logs.add`: not a viewer). */
export function useCanLogReading() {
  const locations = useLocations();
  return (locationId: string) => {
    const role = locations.data?.find((l) => l.id === locationId)?.role;
    return !!role && roleCan(role, 'logs.add');
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The day and time chosen, as an instant on this device's clock, never after now. */
function takenAtOf(day: string, time: string, now = new Date()): Date {
  const at = new Date(`${day}T${time}:00`);
  return Number.isNaN(at.getTime()) || at > now ? now : at;
}

export function LogReadingSheet({
  target,
  onClose,
  onLogged,
}: {
  /** Null: closed. */
  target: ReadingSheetTarget | null;
  onClose: () => void;
  /** After a reading is saved (online) or queued (offline). */
  onLogged?: () => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={target !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Log a reading`}
    >
      {target ? (
        <LogReadingForm
          key={`${target.thingId}:${target.meter.id}`}
          target={target}
          onClose={onClose}
          {...(onLogged ? { onLogged } : {})}
        />
      ) : null}
    </Sheet>
  );
}

type Proof = { key: string; file: File; fileId: string | null };

/** The form inside the sheet: also the create sheet's "Add the first reading" step. */
export function LogReadingForm({
  target,
  onClose,
  onLogged,
  cancelLabel,
}: {
  target: ReadingSheetTarget;
  onClose: () => void;
  onLogged?: () => void;
  /** "Skip" in the first-reading step; "Cancel" by default. */
  cancelLabel?: string;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const online = useOnline();
  const store = useReadingStore();
  const offline = useOffline();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const uploadError = useUploadErrorText();
  const refusal = useReadingRefusal();
  const reasons = useReviewReasonLabels();
  const offerUndo = useOfferUndo();
  const meterName = useMeterName();
  const checkText = useReadingCheckText();
  const unitOf = useMeterUnit();
  const typed = useTypedNumber();
  const locations = useLocations();
  const role = locations.data?.find((l) => l.id === target.locationId)?.role;
  const mayReplace = !!role && roleCan(role, 'meters.manage');
  const { meter } = target;
  const unit = unitOf(meter.unit);

  const [now] = useState(() => new Date());
  const [value, setValue] = useState('');
  const [day, setDay] = useState<string | null>(localDay(now));
  const [time, setTime] = useState(localTime(now));
  const [note, setNote] = useState('');
  const [proof, setProof] = useState<Proof | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [refused, setRefused] = useState<LatestReading | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [offset, setOffset] = useState('');
  const [offsetError, setOffsetError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLDivElement>(null);

  const parsed = readingValueOf(value);
  const takenAt = takenAtOf(day ?? localDay(now), time);
  const check = parsed
    ? checkReading(parsed, takenAt, meter.latest, defaultDailyLimit(meter))
    : ({ kind: 'none' } as const);
  const hint = parsed ? checkText(check, unit, parsed) : null;

  // Online, the photo goes up as soon as it's picked; offline it waits in the queue as a blob.
  useEffect(() => {
    if (!proof || proof.fileId || !online) return;
    let live = true;
    putFile({ file: proof.file, locationId: target.locationId })
      .then((f) => {
        if (live) setProof((p) => (p?.key === proof.key ? { ...p, fileId: f.id } : p));
      })
      .catch((e: unknown) => {
        if (!live) return;
        setProof(null);
        toast({ title: t`Couldn't upload the photo`, description: uploadError(e), tone: 'danger' });
      });
    return () => {
      live = false;
    };
  }, [proof, online, target.locationId, t, uploadError]);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['things'] }),
      qc.invalidateQueries({ queryKey: ['meters'] }),
      qc.invalidateQueries({ queryKey: ['home'] }),
      qc.invalidateQueries({ queryKey: householdKeys.thing(target.thingId) }),
      qc.invalidateQueries({ queryKey: vehicleKeys.all }),
      qc.invalidateQueries({ queryKey: ['reading-pending', meter.id] }),
    ]);
  };

  const validValue = (): string | null => {
    if (parsed === null || parsed === '') {
      setError(t`Enter the reading, like 53000 or 53000.5.`);
      return null;
    }
    if (!day) {
      setError(undefined);
      return null;
    }
    return parsed;
  };

  const saveOffline = async (v: string) => {
    if (!store) {
      setError(t`This phone isn't ready to save offline yet. Try again in a moment.`);
      return;
    }
    const blob = proof
      ? {
          id: newId(),
          kind: 'original' as const,
          blob: proof.file,
          sha256: await sha256Hex(proof.file),
        }
      : null;
    await enqueueReading(store, {
      locationId: target.locationId,
      meterId: meter.id,
      value: v,
      takenAt: takenAt.toISOString(),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(blob ? { proof: blob } : {}),
    });
    offline?.engine?.kick();
    toast({
      title: t`Saved on this phone`,
      description: t`Kept checks it against your other readings when it syncs; if it doesn't fit, it waits in your Inbox.`,
      tone: 'ok',
    });
    await qc.invalidateQueries({ queryKey: ['reading-pending', meter.id] });
    onLogged?.();
    onClose();
  };

  const saveOnline = async (v: string, confirmJump: boolean) => {
    const res = await vehiclesApi.createReading(meter.id, {
      id: newId(),
      value: v,
      takenAt: takenAt.toISOString(),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(proof?.fileId ? { proofFileId: proof.fileId } : {}),
      ...(confirmJump ? { confirmJump: true as const } : {}),
    });
    const r = res.body;
    await refresh();
    if (r.state === 'needs_review') {
      toast({
        title: t`Saved for review`,
        ...(r.reason ? { description: reasons[r.reason] } : {}),
      });
    } else {
      offerUndo(
        { title: t`Reading logged`, description: `${fmt.num(Number(v))} ${unit}` },
        res.auditEvents,
        { thingId: target.thingId },
      );
    }
    onLogged?.();
    onClose();
  };

  const save = async (confirmJump = false) => {
    const v = validValue();
    if (v === null) return;
    setBusy(true);
    setError(undefined);
    setRefused(null);
    try {
      if (!online) await saveOffline(v);
      else await saveOnline(v, confirmJump);
    } catch (e) {
      if (isApiError(e) && e.code === 'offline') {
        // The connection went between the check and the request: keep it on the phone.
        await saveOffline(v).catch(() => setError(errorText(e)));
        return;
      }
      const why = refusal(e, unit);
      if (why) {
        setError(why);
        const d = isApiError(e) ? (e.details as ReadingConflictDetails) : null;
        if (d?.reason === 'lower_than_previous' && d.previous) {
          setRefused({ value: d.previous.value, takenAt: d.previous.takenAt });
          setOffset(typed(d.previous.value));
        }
      } else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** The meter was replaced: record where the new one carries on from, then send it again. */
  const replaceAndSave = async () => {
    const o = readingValueOf(offset);
    if (o === null || o === '') {
      setOffsetError(t`Enter the reading it carries on from, like 51220.`);
      return;
    }
    setBusy(true);
    try {
      const body: MeterReplacedBody = { at: takenAt.toISOString(), offset: o };
      await api.post(inventoryPaths.meterReplaced(meter.id), body);
      setReplacing(false);
      setRefused(null);
    } catch (e) {
      setBusy(false);
      setOffsetError(errorText(e));
      return;
    }
    setBusy(false);
    await save();
  };

  const focusValue = () => field.current?.querySelector('input')?.focus();
  const name = meterName(meter);
  const latest = meter.latest;

  return (
    <form
      noValidate
      className="grid gap-3.5"
      aria-label={t`Log a reading`}
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <p className="m-0 text-small text-ink-2 [overflow-wrap:anywhere]">
        <bdi className="font-medium text-ink">{target.thingName}</bdi>
        {sep()}
        <bdi>{name}</bdi>
        {sep()}
        <bdi dir="ltr">{unit}</bdi>
      </p>
      {latest ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Last reading{' '}
            <span className="tabular-nums">
              {fmt.num(Number(latest.value))} {unit}
            </span>
            , {fmt.day(latest.takenAt)}
          </Trans>
        </p>
      ) : null}

      <div ref={field} className="grid gap-2">
        <ReadingField
          unit={unit}
          value={value}
          onChange={(v) => {
            setValue(v);
            setError(undefined);
            setRefused(null);
            setReplacing(false);
          }}
          error={error}
          autoFocus
        />
        {hint && !error ? <CheckLine tone={checkTone(check)}>{hint}</CheckLine> : null}
        {check.kind === 'jump' && !error && online ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              variant="secondary"
              isPending={busy}
              onPress={() => void save(true)}
            >
              <Trans>It's right</Trans>
            </Button>
            <Button size="small" variant="secondary" onPress={focusValue}>
              <Trans>Edit</Trans>
            </Button>
          </div>
        ) : null}
        {(refused || (check.kind === 'lower' && !error)) && mayReplace && online && !replacing ? (
          <div className="flex flex-wrap gap-2">
            <Button size="small" variant="secondary" onPress={focusValue}>
              <Trans>Edit</Trans>
            </Button>
            <Button
              size="small"
              variant="secondary"
              onPress={() => {
                setOffset((o) => o || typed(refused?.value ?? latest?.value ?? ''));
                setReplacing(true);
              }}
            >
              <Trans>Meter replaced</Trans>
            </Button>
          </div>
        ) : null}
        {replacing ? (
          <fieldset className="m-0 grid gap-2 rounded-[10px] border border-line p-3">
            <legend className="px-1 font-semibold text-small text-ink-2">
              <Trans>Meter replaced</Trans>
            </legend>
            <p className="m-0 text-small text-ink-2">
              <Trans>
                A new meter starts again from 0. Kept adds what the old one had reached, so the
                history keeps going up.
              </Trans>
            </p>
            <TextField
              label={t`The old meter had reached (${unit})`}
              value={offset}
              onChange={(v) => {
                setOffset(v);
                setOffsetError(undefined);
              }}
              inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
              {...(offsetError ? { errorMessage: offsetError, isInvalid: true } : {})}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="small" isPending={busy} onPress={() => void replaceAndSave()}>
                <Trans>Record and save the reading</Trans>
              </Button>
              <Button size="small" variant="secondary" onPress={() => setReplacing(false)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </fieldset>
        ) : null}
      </div>

      <div className="grid gap-3.5 sm:grid-cols-[1fr_auto]">
        <DatePicker
          label={t`Taken on`}
          value={day}
          onChange={(v) => setDay(v)}
          maxValue={localDay(new Date())}
          {...(!day ? { errorMessage: t`Pick the day it was read.` } : {})}
        />
        <TimeField label={t`At`} value={time} onChange={setTime} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FileTrigger
          acceptedFileTypes={['image/*']}
          onSelect={(files) => {
            const file = files?.[0];
            if (file) setProof({ key: newId(), file, fileId: null });
          }}
        >
          <Button variant="secondary" size="small">
            <CameraIcon className="size-4" />
            {proof ? <Trans>Replace the photo</Trans> : <Trans>Photo of the meter</Trans>}
          </Button>
        </FileTrigger>
        {proof ? (
          <span className="inline-flex items-center gap-1 text-small text-ink-2 [overflow-wrap:anywhere]">
            {online && !proof.fileId ? <Trans>Uploading…</Trans> : <Trans>Kept as proof</Trans>}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Remove the photo`}
              onPress={() => setProof(null)}
            >
              <XIcon />
            </Button>
          </span>
        ) : (
          <span className="text-small text-ink-3">
            <Trans>Optional. It joins the meter's proof photos.</Trans>
          </span>
        )}
      </div>

      <TextField
        label={t`Note (optional)`}
        value={note}
        onChange={setNote}
        inputProps={{ dir: 'auto', maxLength: 500 }}
      />

      {!online ? (
        <CheckLine tone="info">
          <Trans>
            No connection. The reading is saved on this phone and checked against the others when it
            syncs.
          </Trans>
        </CheckLine>
      ) : null}

      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          {cancelLabel ?? <Trans>Cancel</Trans>}
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!!(online && proof && !proof.fileId)}>
          <Trans>Save reading</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
