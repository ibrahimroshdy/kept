/**
 * Meters and readings (D113, core since D185; task 16). Each meter shows its latest reading and
 * its readings list (the list standard). Online, a reading lower than the one before it or
 * higher than the one after is refused (409 with the neighbour, D26): the sheet says which value
 * it collides with and to check it, or record the meter's replacement first (D52). An
 * implausible jump is kept as "Needs review" with Keep, Edit or Discard (D112). The inbox item
 * for it is step 3.
 */
import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { isApiError } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import { thingApi, useInvalidateThing, useReadings } from '@/api/inventory/thing-api';
import type { Reading, ReadingConflictDetails, ThingMeter } from '@/api/inventory/types';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Row, Section, useErrorText } from '@/components/page';
import { LogReadingSheet } from '@/components/readings/log-reading-sheet';
import { PendingReadings } from '@/components/readings/pending';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';
import { useThingCtx } from './context';
import { parseNumber } from './form-model';
import { useReviewReasonLabels } from './labels';
import { Sheet } from './sheet';

export function useMeterName() {
  const { t } = useLingui();
  return (m: Pick<ThingMeter, 'kind' | 'label'>) =>
    m.label ?? (m.kind === 'distance' ? t`Odometer` : m.kind === 'hours' ? t`Hours` : m.kind);
}

export function MetersSection() {
  const { thing } = useThingCtx();
  if (thing.meters.length === 0) return null;
  return (
    <div className="grid gap-5">
      {thing.meters.map((m) => (
        <MeterCard key={m.id} meter={m} />
      ))}
    </div>
  );
}

function MeterCard({ meter }: { meter: ThingMeter }) {
  const { can, thing } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const unitOf = useMeterUnit();
  const name = useMeterName();
  const readings = useReadings(meter.id);
  const [logging, setLogging] = useState(false);
  const [editing, setEditing] = useState<Reading | null>(null);
  return (
    <Section
      title={name(meter)}
      action={
        can('logs.add') ? (
          <Button size="small" onPress={() => setLogging(true)}>
            <Trans>Log a reading</Trans>
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[10px] border border-line bg-surface p-3.5">
        {meter.latest ? (
          <>
            <span className="font-semibold text-[22px] text-ink tabular-nums">
              {fmt.num(Number(meter.latest.value))} {meter.unit}
            </span>
            <span className="text-small text-ink-2">
              <Trans>latest, {fmt.day(meter.latest.takenAt)}</Trans>
            </span>
          </>
        ) : (
          <span className="text-ink-2">
            <Trans>No readings yet</Trans>
          </span>
        )}
        {meter.needsReview > 0 ? (
          <StatusPill
            state="needs_review"
            label={t`${fmt.num(meter.needsReview)} to review`}
            className="ms-auto"
          />
        ) : null}
      </div>
      <PendingReadings meterId={meter.id} unit={meter.unit} />
      <ListSurface<Reading>
        label={t`Readings of ${name(meter)}`}
        search={false}
        query={readings}
        getKey={(r) => r.id}
        renderRow={(r) => (
          <ReadingRow reading={r} unit={unitOf(meter.unit)} onEdit={() => setEditing(r)} />
        )}
        empty={
          <EmptyState title={<Trans>No readings yet</Trans>}>
            <Trans>Log the first one to start its history.</Trans>
          </EmptyState>
        }
      />
      <LogReadingSheet
        target={
          logging
            ? {
                thingId: thing.id,
                thingName: thing.name ?? '',
                locationId: thing.locationId,
                meter,
              }
            : null
        }
        onClose={() => setLogging(false)}
      />
      <ReadingSheet
        meter={meter}
        isOpen={editing !== null}
        reading={editing}
        onClose={() => setEditing(null)}
      />
    </Section>
  );
}

function ReadingRow({
  reading,
  unit,
  onEdit,
}: {
  reading: Reading;
  unit: string;
  onEdit: () => void;
}) {
  const { can, me, thing } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const reasons = useReviewReasonLabels();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const invalidate = useInvalidateThing();
  const mine = reading.loggedBy.displayName === me;
  const mayChange = mine ? can('logs.edit-own') : can('logs.edit-delete-others');
  const review = reading.state === 'needs_review';
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast({ title: done, tone: 'ok' });
      await invalidate(thing.id);
    } catch (e) {
      toast({ title: t`Couldn't change the reading`, description: errorText(e), tone: 'danger' });
    }
  };
  return (
    <Row
      title={
        <span className="tabular-nums">
          {fmt.num(Number(reading.value))} {unit}
        </span>
      }
      subtitle={
        <>
          {fmt.dateTime(reading.takenAt)}
          {sep()}
          <bdi>{reading.loggedBy.displayName}</bdi>
          {reading.note ? (
            <>
              {sep()}
              <bdi dir="auto">{reading.note}</bdi>
            </>
          ) : null}
        </>
      }
      trailing={review ? <StatusPill state="needs_review" /> : undefined}
    >
      {review ? (
        <div className="grid gap-2 pt-1">
          {reading.reviewReason ? (
            <span className="text-small text-warn">{reasons[reading.reviewReason]}</span>
          ) : null}
          {mayChange ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="small"
                onPress={() =>
                  void run(() => thingApi.acceptReading(reading.id), t`Kept the reading`)
                }
              >
                <Trans>Keep</Trans>
              </Button>
              <Button size="small" variant="secondary" onPress={onEdit}>
                <Trans>Edit</Trans>
              </Button>
              <Button
                size="small"
                variant="secondary"
                onPress={async () => {
                  if (
                    await confirm({
                      title: t`Discard this reading?`,
                      body: t`It is removed from the meter's history.`,
                      confirmLabel: t`Discard`,
                      destructive: true,
                    })
                  )
                    await run(() => thingApi.deleteReading(reading.id), t`Reading discarded`);
                }}
              >
                <Trans>Discard</Trans>
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Row>
  );
}

function nowLocalIso() {
  return new Date().toISOString();
}

function ReadingSheet({
  meter,
  isOpen,
  reading,
  onClose,
}: {
  meter: ThingMeter;
  isOpen: boolean;
  reading: Reading | null;
  onClose: () => void;
}) {
  const { thing } = useThingCtx();
  const { t } = useLingui();
  const errorText = useErrorText();
  const fmt = useFormat();
  const unitOf = useMeterUnit();
  const reasons = useReviewReasonLabels();
  const invalidate = useInvalidateThing();
  const name = useMeterName();
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);
  const key = reading?.id ?? 'new';
  if (isOpen && seeded !== key) {
    setSeeded(key);
    setValue(reading?.value ?? '');
    setNote(reading?.note ?? '');
    setError(undefined);
  }
  if (!isOpen && seeded !== null) setSeeded(null);

  const save = async () => {
    const n = parseNumber(value);
    if (n === null || Number.isNaN(n) || n < 0) {
      setError(t`Enter a number, 0 or more.`);
      return;
    }
    setBusy(true);
    try {
      if (reading) {
        await thingApi.updateReading(
          reading.id,
          { value: String(n), note: note || null },
          reading.rowVersion,
        );
        toast({ title: t`Reading updated`, tone: 'ok' });
      } else {
        const r = await inventoryApi.logReading(meter.id, {
          id: newId(),
          value: String(n),
          takenAt: nowLocalIso(),
          ...(note ? { note } : {}),
        });
        toast(
          r.state === 'needs_review'
            ? {
                title: t`Saved for review`,
                description: r.reason ? reasons[r.reason] : undefined,
              }
            : { title: t`Reading logged`, tone: 'ok' },
        );
      }
      await invalidate(thing.id);
      onClose();
    } catch (e) {
      setError(backwardsText(e) ?? errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** A refused backwards reading, said with the neighbour it collides with (T16's 409). */
  function backwardsText(e: unknown): string | null {
    if (!isApiError(e) || e.status !== 409) return null;
    const d = e.details as ReadingConflictDetails;
    const unit = unitOf(meter.unit);
    if (d.reason === 'lower_than_previous' && d.previous) {
      const before = fmt.num(Number(d.previous.value));
      return t`Lower than the reading before it (${before} ${unit}). Check the value, or record that the meter was replaced first.`;
    }
    if (d.reason === 'higher_than_next' && d.next) {
      const after = fmt.num(Number(d.next.value));
      return t`Higher than the reading after it (${after} ${unit}). Check the value and the date it was taken.`;
    }
    return null;
  }

  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={reading ? t`Edit the reading` : t`Log a reading · ${name(meter)}`}
    >
      <form
        noValidate
        className="grid gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label={t`Reading (${unitOf(meter.unit)})`}
          value={value}
          onChange={setValue}
          autoFocus
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
          {...(error ? { errorMessage: error, isInvalid: true } : {})}
        />
        <TextField
          label={t`Note (optional)`}
          value={note}
          onChange={setNote}
          inputProps={{ dir: 'auto' }}
        />
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" isPending={busy}>
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </form>
    </Sheet>
  );
}
