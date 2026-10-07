/**
 * Value on the thing page (screens §5, D158): the current value (the latest valuation) with its
 * date and source, what it was bought for, and the valuations with their sheet. The whole section
 * sits behind the money gate: where money is hidden from you it says "Hidden in this location"
 * and nothing else (T20). Deleting a valuation is undoable (plan Q25); a new one isn't (§7.7).
 */
import { AmountError, parseAmount, VALUATION_SOURCES, type ValuationSource } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { householdApi, useValuations } from '@/api/household/queries';
import type { Valuation } from '@/api/household/types';
import { useOfferUndo } from '@/components/history/undo';
import {
  EmptyState,
  ErrorState,
  List,
  LoadingRows,
  Row,
  Section,
  useErrorText,
} from '@/components/page';
import { useThingCtx } from '@/components/things/context';
import { todayIn, useBlocked, useHouseholdDone } from '@/components/things/household';
import { CurrencyPicker } from '@/components/things/pickers';
import { Sheet } from '@/components/things/sheet';
import { Bidi, useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { useConfirm } from '@/components/ui/confirm';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep, useFormat } from '@/lib/format';
import { GatedAmount, isMoneyHidden, MoneyHiddenText } from './gated';

export function useValuationSourceLabels(): Record<ValuationSource, string> {
  const { t } = useLingui();
  return {
    purchase: t`Purchase price`,
    appraisal: t`Appraisal`,
    estimate: t`Estimate`,
    insurer: t`Insurer's value`,
  };
}

export function ValueSection() {
  const { thing, can } = useThingCtx();
  const { t } = useLingui();
  const blocked = useBlocked();
  const hidden = isMoneyHidden(thing.currentValue) || !can('money.view');
  const q = useValuations(hidden ? '' : thing.id);
  const [open, setOpen] = useState<Valuation | 'new' | null>(null);
  const mayEdit = can('things.edit') && can('money.view');
  if (hidden)
    return (
      <Section title={<Trans>Value</Trans>}>
        <p className="m-0 rounded-[10px] border border-line bg-surface px-3.5 py-3 text-[15px]">
          <MoneyHiddenText />
        </p>
      </Section>
    );
  return (
    <Section
      title={<Trans>Value</Trans>}
      action={
        mayEdit ? (
          <Button
            size="small"
            variant="secondary"
            isDisabled={!!blocked}
            onPress={() => setOpen('new')}
          >
            <Trans>Add a valuation</Trans>
          </Button>
        ) : null
      }
    >
      {blocked && mayEdit ? <p className="m-0 text-small text-ink-3">{blocked}</p> : null}
      {q.isPending ? (
        <LoadingRows rows={2} label={t`Loading the value`} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <CurrentValueCard current={q.data.current} count={q.data.items.length} />
          {q.data.items.length ? (
            <List aria-label={t`Valuations`}>
              {q.data.items.map((v) => (
                <li key={v.id}>
                  <ValuationRow
                    valuation={v}
                    {...(mayEdit && !blocked ? { onEdit: () => setOpen(v) } : {})}
                  />
                </li>
              ))}
            </List>
          ) : null}
        </>
      )}
      {mayEdit ? (
        <ValuationSheet
          key={open === null ? 'closed' : open === 'new' ? 'new' : open.id}
          valuation={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </Section>
  );
}

function CurrentValueCard({ current, count }: { current: Valuation | null; count: number }) {
  const { thing } = useThingCtx();
  const fmt = useFormat();
  const money = useMoney();
  const sources = useValuationSourceLabels();
  const p = thing.purchase;
  const bought =
    p?.purchasedOn && p.unitPrice && p.currency && !p.moneyHidden
      ? { on: fmt.day(p.purchasedOn), price: money(p.unitPrice, p.currency), from: p.vendor?.name }
      : null;
  if (!current)
    return (
      <EmptyState title={<Trans>No value recorded</Trans>}>
        <Trans>
          An estimate, an appraisal or the insurer's figure: the latest one is its value.
        </Trans>
        {bought ? (
          <>
            {' '}
            <Trans>
              Bought {bought.on} for {bought.price}
            </Trans>
          </>
        ) : null}
      </EmptyState>
    );
  const source = sources[current.source];
  const by = current.createdBy.displayName;
  const on = fmt.day(current.valuedOn);
  const latestOf = plural(count, { one: 'the only valuation', other: 'latest of # valuations' });
  return (
    <div className="grid gap-1 rounded-[10px] border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-semibold text-[22px] text-ink">
          <GatedAmount value={current.value} />
        </span>
        <span className="text-small text-ink-3">
          <Trans>current</Trans>
        </span>
      </div>
      <p className="m-0 text-small text-ink-2">
        <Trans>
          {source} by <bdi>{by}</bdi> · {on} · {latestOf}
        </Trans>
      </p>
      {bought ? (
        <p className="m-0 text-small text-ink-2">
          {bought.from ? (
            <Trans>
              Bought {bought.on} for {bought.price}, <Bidi>{bought.from}</Bidi>
            </Trans>
          ) : (
            <Trans>
              Bought {bought.on} for {bought.price}
            </Trans>
          )}
        </p>
      ) : null}
    </div>
  );
}

function ValuationRow({ valuation: v, onEdit }: { valuation: Valuation; onEdit?: () => void }) {
  const fmt = useFormat();
  const sources = useValuationSourceLabels();
  return (
    <Row
      title={<GatedAmount value={v.value} />}
      subtitle={
        <>
          {sources[v.source]}
          {sep()}
          {fmt.day(v.valuedOn)}
          {sep()}
          <bdi>{v.createdBy.displayName}</bdi>
          {v.notes ? (
            <>
              {sep()}
              <Bidi>{v.notes}</Bidi>
            </>
          ) : null}
        </>
      }
      trailing={
        onEdit ? (
          <Button size="small" variant="secondary" onPress={onEdit}>
            <Trans>Edit</Trans>
          </Button>
        ) : null
      }
    />
  );
}

function ValuationSheet({
  valuation,
  onClose,
}: {
  valuation: Valuation | 'new' | null;
  onClose: () => void;
}) {
  const { thing, location } = useThingCtx();
  const { t } = useLingui();
  const sources = useValuationSourceLabels();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const confirm = useConfirm();
  const done = useHouseholdDone();
  const editing = valuation && valuation !== 'new' ? valuation : null;
  const shown = editing && !isMoneyHidden(editing.value) ? editing.value : null;
  const today = todayIn(location.timezone);
  const [amount, setAmount] = useState(shown?.amount ?? '');
  const [currency, setCurrency] = useState<string | null>(shown?.currency ?? location.currency);
  const [on, setOn] = useState<string | null>(editing?.valuedOn ?? today);
  const [source, setSource] = useState<ValuationSource>(editing?.source ?? 'estimate');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    let value: string;
    try {
      value = parseAmount(amount);
    } catch (e) {
      if (!(e instanceof AmountError)) throw e;
      setError(t`Enter an amount, like 1250 or 1250.50.`);
      return;
    }
    if (!currency || !on) {
      setError(!currency ? t`A value needs a currency.` : t`A value needs a date.`);
      return;
    }
    setBusy(true);
    try {
      const body = {
        value,
        currency,
        valuedOn: on,
        source,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      if (editing) {
        const { auditEvents } = await householdApi.updateValuation(
          editing.id,
          body,
          editing.rowVersion,
        );
        offerUndo({ title: t`Valuation saved` }, auditEvents, { thingId: thing.id });
      } else {
        await householdApi.createValuation(thing.id, body);
        toast({ title: t`Valuation added`, tone: 'ok' });
      }
      await done();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    const ok = await confirm({
      title: t`Remove this valuation?`,
      body: t`The value falls back to the one before it. You can undo this for 7 days.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    try {
      const { auditEvents } = await householdApi.deleteValuation(editing.id, editing.rowVersion);
      offerUndo({ title: t`Valuation removed` }, auditEvents, { thingId: thing.id });
      await done();
      onClose();
    } catch (e) {
      toast({ title: t`Couldn't remove it`, description: errorText(e), tone: 'danger' });
    }
  };

  return (
    <Sheet
      isOpen={valuation !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={editing ? t`Edit the valuation` : t`Add a valuation`}
    >
      <form
        noValidate
        className="grid gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-3.5 md:grid-cols-[1fr_10rem]">
          <TextField
            label={t`Value`}
            value={amount}
            onChange={(v) => {
              setAmount(v);
              setError(undefined);
            }}
            autoFocus
            inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
            {...(error ? { errorMessage: error, isInvalid: true } : {})}
          />
          <CurrencyPicker label={t`Currency`} value={currency} onChange={setCurrency} />
        </div>
        <DatePicker label={t`Valued on`} value={on} onChange={setOn} maxValue={today} />
        <Combobox
          label={t`Source`}
          items={VALUATION_SOURCES.map((s) => ({ id: s, label: sources[s] }))}
          selectedKey={source}
          onSelectionChange={(k) => {
            if (k) setSource(String(k) as ValuationSource);
          }}
        />
        <TextField
          label={t`Notes`}
          value={notes}
          onChange={setNotes}
          inputProps={{ dir: 'auto' }}
        />
        <DialogFooter>
          {editing ? (
            <Button variant="ghost" className="me-auto text-danger" onPress={() => void remove()}>
              <Trans>Remove</Trans>
            </Button>
          ) : null}
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
