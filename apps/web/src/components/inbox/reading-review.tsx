/**
 * A reading that doesn't fit (D52, D112, engineering spec §5): "52,340 km is lower than 53,100 on
 * 12 Oct", checked against its neighbours and sent here rather than rejected. Keep it (`a`), Edit
 * (`e`) the value, Discard (`d`), or record that the meter was replaced, with the old meter's last
 * reading as the offset, so the later readings are valid.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { captureApi } from '@/api/capture/queries';
import type { InboxReadingBody } from '@/api/capture/types';
import { Pill } from '@/components/page';
import { PathText } from '@/components/places/rows';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';
import { cn } from '@/lib/utils';
import { useInboxRun } from './actions';
import type { ItemProps } from './item-card';
import { OverflowActions } from './overflow-actions';
import { BlockedReason, ItemShell, useItemKeys } from './shell';

const DECIMAL = /^\d+(\.\d+)?$/;

export function ReadingReview({ item, current, blocked }: ItemProps) {
  const { t } = useLingui();
  const fmt = useFormat();
  const unitOf = useMeterUnit();
  const { run, busy } = useInboxRun();
  const [mode, setMode] = useState<'view' | 'edit' | 'replaced'>('view');
  const [value, setValue] = useState(item.reading?.value ?? '');
  const [offset, setOffset] = useState('');
  const r = item.reading;

  const send = (body: InboxReadingBody, done: string) =>
    void run(() => captureApi.inboxReading(item.id, body, item.rowVersion), { done }).then(
      (res) => {
        if (res) setMode('view');
      },
    );
  const keep = () => !blocked && send({ action: 'keep' }, t`Kept the reading`);
  const discard = () => !blocked && send({ action: 'discard' }, t`Discarded the reading`);
  useItemKeys(item.id, {
    accept: keep,
    edit: () => !blocked && setMode('edit'),
    drop: discard,
  });
  if (!r) return null;

  const unit = unitOf(r.meter.unit);
  const num = (v: string) => fmt.num(Number(v));
  const thingName = item.thing?.name ?? r.meter.label ?? t`Meter`;
  const meterName = r.meter.label ?? t`reading`;
  const before = r.neighbours.before;
  const after = r.neighbours.after;
  const summary =
    r.reason === 'lower_than_previous' && before
      ? t`${num(r.value)} ${unit} is lower than ${num(before.value)} on ${fmt.day(before.takenAt)}`
      : r.reason === 'higher_than_next' && after
        ? t`${num(r.value)} ${unit} is higher than ${num(after.value)} on ${fmt.day(after.takenAt)}`
        : t`${num(r.value)} ${unit} doesn't fit the readings around it`;
  const valid = DECIMAL.test(value.trim());
  const offsetValid = DECIMAL.test(offset.trim());

  return (
    <ItemShell
      item={item}
      label={t`${thingName} · ${meterName}`}
      current={current}
      photo={r.proofThumbUrl ? { fileId: '', thumbUrl: r.proofThumbUrl } : undefined}
      title={
        <Trans>
          <bdi>{thingName}</bdi> · {meterName}
        </Trans>
      }
      meta={
        <>
          {item.thing?.path.length ? <PathText path={item.thing.path} /> : null}
          <Pill tone="warn">
            <Trans>Reading doesn't fit</Trans>
          </Pill>
        </>
      }
      actions={
        mode === 'view' ? (
          <>
            <Button size="small" isDisabled={!!blocked} isPending={busy} onPress={keep}>
              <Trans>Keep it</Trans>
            </Button>
            <Button
              size="small"
              variant="secondary"
              isDisabled={!!blocked}
              onPress={() => setMode('edit')}
            >
              <Trans>Fix the reading</Trans>
            </Button>
            <OverflowActions
              title={t`${thingName} · ${meterName}`}
              isDisabled={!!blocked}
              actions={[
                { id: 'replaced', label: t`Meter replaced`, onAction: () => setMode('replaced') },
                { id: 'discard', label: t`Discard`, keys: 'D', danger: true, onAction: discard },
              ]}
            />
            <BlockedReason reason={blocked} />
          </>
        ) : null
      }
    >
      <p className="m-0 text-[15px] text-ink">{summary}</p>
      <ol aria-label={t`Readings around it`} className="m-0 grid list-none grid-cols-3 gap-2 p-0">
        {[
          before ? { ...before, bad: false } : null,
          { value: r.value, takenAt: r.takenAt, bad: true },
          after ? { ...after, bad: false } : null,
        ]
          .filter((x): x is { value: string; takenAt: string; bad: boolean } => !!x)
          .map((x) => (
            <li
              key={`${x.takenAt}-${x.value}`}
              className={cn(
                'grid gap-0.5 rounded-lg border px-2.5 py-2 text-small',
                x.bad ? 'border-warn text-ink' : 'border-line text-ink-2',
              )}
            >
              <span>{fmt.day(x.takenAt)}</span>
              <b className="font-semibold text-[15px] tabular-nums">
                {num(x.value)} {unit}
              </b>
              {x.bad ? (
                <span className="sr-only">
                  <Trans>(this one)</Trans>
                </span>
              ) : null}
            </li>
          ))}
      </ol>
      {mode === 'edit' ? (
        <form
          className="grid gap-3 rounded-[10px] border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) send({ action: 'edit', value: value.trim() }, t`Fixed the reading`);
          }}
        >
          <TextField
            label={t`Reading (${unit})`}
            value={value}
            onChange={setValue}
            inputMode="decimal"
            autoFocus
            {...(valid ? {} : { errorMessage: t`A number, like 52340.` })}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="small" isPending={busy} isDisabled={!valid}>
              <Trans>Save</Trans>
            </Button>
            <Button size="small" variant="secondary" onPress={() => setMode('view')}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : null}
      {mode === 'replaced' ? (
        <form
          className="grid gap-3 rounded-[10px] border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (offsetValid)
              send(
                { action: 'meter_replaced', offset: offset.trim(), takenAt: r.takenAt },
                t`Recorded the new meter`,
              );
          }}
        >
          <TextField
            label={t`The old meter's last reading (${unit})`}
            description={t`Later readings count on from it, so this one fits.`}
            value={offset}
            onChange={setOffset}
            inputMode="decimal"
            autoFocus
            {...(offset && !offsetValid ? { errorMessage: t`A number, like 53100.` } : {})}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="small" isPending={busy} isDisabled={!offsetValid}>
              <Trans>Record the new meter</Trans>
            </Button>
            <Button size="small" variant="secondary" onPress={() => setMode('view')}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : null}
    </ItemShell>
  );
}
