/**
 * Change lifecycle (D119, D158): in use, or one of the ways a thing ends, with its end details.
 * Setting it back to "In use" is "found": the end details are cleared. The price it went for is
 * money, so it only appears with the Money module on and money visible to you.
 */
import { AmountError, LIFECYCLES, parseAmount } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { inventoryApi } from '@/api/inventory/queries';
import type { Lifecycle, LifecycleBody } from '@/api/inventory/types';
import { useOfferUndo } from '@/components/history/undo';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useThingCtx } from './context';
import { useLifecycleLabels } from './labels';
import { CurrencyPicker } from './pickers';
import { Sheet } from './sheet';

const today = () => new Date().toISOString().slice(0, 10);

export function LifecycleSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { thing, location, moduleOn, can, refresh } = useThingCtx();
  const { t } = useLingui();
  const labels = useLifecycleLabels();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const [lifecycle, setLifecycle] = useState<Lifecycle>(thing.lifecycle);
  const [on, setOn] = useState<string | null>(thing.ended?.on ?? today());
  const [to, setTo] = useState(thing.ended?.to ?? '');
  const [notes, setNotes] = useState(thing.ended?.notes ?? '');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState<string | null>(location.currency);
  const [priceError, setPriceError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const ending = lifecycle !== 'in_use';
  const showMoney = moduleOn('money') && can('money.view');
  const recipient =
    lifecycle === 'sold' || lifecycle === 'given_away' || lifecycle === 'returned_to_owner';

  const save = async () => {
    const body: LifecycleBody = { lifecycle };
    if (ending) {
      if (on) body.endedOn = on;
      if (to.trim()) body.endedTo = to.trim();
      if (notes.trim()) body.endedNotes = notes.trim();
      if (showMoney && price.trim()) {
        try {
          body.endedPrice = parseAmount(price);
        } catch (e) {
          if (e instanceof AmountError) {
            setPriceError(t`Enter an amount, like 1250 or 1250.50.`);
            return;
          }
          throw e;
        }
        if (!currency) {
          setPriceError(t`A price needs a currency.`);
          return;
        }
        body.endedCurrency = currency;
      }
    }
    setBusy(true);
    try {
      const { auditEvents } = await inventoryApi.lifecycle(thing.id, body, thing.rowVersion);
      offerUndo({ title: ending ? labels[lifecycle] : t`Back in use` }, auditEvents, {
        thingId: thing.id,
      });
      await refresh();
      onClose();
    } catch (e) {
      toast({ title: t`Couldn't change it`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Change lifecycle`}
    >
      <form
        noValidate
        className="grid gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Combobox
          label={t`What happened to it`}
          items={LIFECYCLES.map((l) => ({ id: l, label: labels[l] }))}
          selectedKey={lifecycle}
          onSelectionChange={(k) => {
            if (k) setLifecycle(String(k) as Lifecycle);
          }}
        />
        {ending ? (
          <>
            <DatePicker label={t`When`} value={on} onChange={setOn} maxValue={today()} />
            {recipient ? (
              <TextField
                label={lifecycle === 'sold' ? t`Sold to` : t`Given to`}
                value={to}
                onChange={setTo}
                inputProps={{ dir: 'auto' }}
              />
            ) : null}
            {showMoney && lifecycle === 'sold' ? (
              <div className="grid gap-3.5 md:grid-cols-[1fr_10rem]">
                <TextField
                  label={t`Sold for`}
                  value={price}
                  onChange={(v) => {
                    setPrice(v);
                    setPriceError(undefined);
                  }}
                  inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
                  {...(priceError ? { errorMessage: priceError, isInvalid: true } : {})}
                />
                <CurrencyPicker label={t`Currency`} value={currency} onChange={setCurrency} />
              </div>
            ) : null}
            <TextField
              label={t`Notes`}
              value={notes}
              onChange={setNotes}
              inputProps={{ dir: 'auto' }}
            />
          </>
        ) : thing.lifecycle !== 'in_use' ? (
          <p className="m-0 text-small text-ink-2">
            <Trans>Found it, or got it back: the end details are cleared.</Trans>
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            isPending={busy}
            isDisabled={lifecycle === thing.lifecycle && !ending}
          >
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </form>
    </Sheet>
  );
}
