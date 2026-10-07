/**
 * Split (D10, §1.4): take some of a quantity off as its own row, optionally somewhere else. The
 * new row keeps the same purchase line. Hidden at quantity 1 (screens §8: actions that don't
 * apply are hidden).
 */
import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { inventoryApi } from '@/api/inventory/queries';
import type { MoveTarget } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useThingCtx } from './context';
import { parseNumber } from './form-model';
import { isChosen, WherePicker, type WhereValue } from './pickers';
import { Sheet } from './sheet';

export function currentTarget(t: {
  placeId: string | null;
  containerId: string | null;
}): MoveTarget {
  return t.containerId ? { containerId: t.containerId } : { placeId: t.placeId ?? '' };
}

export function SplitSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { thing, refresh } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const [count, setCount] = useState('1');
  const [elsewhere, setElsewhere] = useState(false);
  const [where, setWhere] = useState<WhereValue>({
    locationId: thing.locationId,
    target: currentTarget(thing),
  });
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const n = parseNumber(count);
    if (n === null || !Number.isInteger(n) || n < 1 || n >= thing.quantity) {
      setError(t`Between 1 and ${fmt.num(thing.quantity - 1)}.`);
      return;
    }
    setBusy(true);
    try {
      const r = await inventoryApi.split(thing.id, {
        quantity: n,
        id: newId(),
        ...(elsewhere && isChosen(where.target) ? { to: where.target } : {}),
      });
      await refresh();
      onClose();
      toast({
        title: t`Split ${fmt.num(n)} off`,
        tone: 'ok',
        action: {
          label: t`Open`,
          onAction: () => void navigate({ to: '/t/$id', params: { id: r.newId } }),
        },
      });
    } catch (e) {
      setError(errorText(e));
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
      title={t`Split ${thing.name ?? ''}`}
    >
      <form
        noValidate
        className="grid gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="m-0 text-small text-ink-2">
          <Trans>
            There are {fmt.num(thing.quantity)}. The ones you take off get their own row, keeping
            the same purchase.
          </Trans>
        </p>
        <TextField
          label={t`How many to take off`}
          value={count}
          onChange={(v) => {
            setCount(v);
            setError(undefined);
          }}
          autoFocus
          inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
          {...(error ? { errorMessage: error, isInvalid: true } : {})}
        />
        <Switch isSelected={elsewhere} onChange={setElsewhere}>
          <Trans>They're somewhere else</Trans>
        </Switch>
        {elsewhere ? (
          <WherePicker
            value={where}
            onChange={setWhere}
            allowOtherLocations={false}
            exclude={thing.id}
          />
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" isPending={busy}>
            <Trans>Split</Trans>
          </Button>
        </DialogFooter>
      </form>
    </Sheet>
  );
}
