/**
 * Consumables' sheet and the thing page's "Keep at least" (D14, D150, D172, D183; screens "Other
 * screens"; frames 08 "Consumables" and "Adjust"; step-7 plan T23). Loaded on demand (its own
 * chunk in assets/household/, vite.config.ts): both read and write the server.
 *
 * - **Adjust** (`AdjustSheet`): −, + and the count, which takes ٠–٩ and ٫ as well as 0–9 (D172)
 *   and may reach 0 (D183); and "Keep at least", emptied to remove it. Save writes what changed:
 *   the count through `POST /things/:id/adjust`, the minimum through `PUT` or `DELETE
 *   /things/:id/stock-rule`, each with its If-Match, and shows the Undo toast for every event
 *   they recorded (D150). The thing and its rule are read fresh when the sheet opens: a list row
 *   carries neither version.
 * - **Keep at least** (`KeepAtLeastSection`): on a consumable thing's page where the module is
 *   on, its minimum and whether it's low (fewer than the minimum, plan Q19), with Adjust for
 *   members and above (`things.edit`).
 *
 * Offline, Adjust is disabled with "Needs a connection" (screens §3).
 */
import { STOCK_MIN_MAX } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { inventoryKeys, useThing, useType } from '@/api/inventory/queries';
import type { ThingRow } from '@/api/inventory/types';
import { portabilityApi, portabilityKeys, useStockRule } from '@/api/portability/queries';
import { useOfferUndo } from '@/components/history/undo';
import { AlertIcon } from '@/components/icons';
import { LoadingRows, Notice, Pill, Section, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { useThingCtx } from '@/components/things/context';
import { westernNumber } from '@/components/things/form-model';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { isolate } from '@/lib/bidi';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';

/** A count or a minimum as typed: Western or Eastern digits, `.` or `٫`, at most 3 decimals. */
export function parseAmount(s: string): number | null {
  const w = westernNumber(s);
  if (!/^\d+(\.\d{1,3})?$/.test(w)) return null;
  return Number(w);
}

/** Every list and count a stock write can change. */
function useInvalidateStock() {
  const qc = useQueryClient();
  return (thingId: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: portabilityKeys.consumables.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.things.detail(thingId) }),
      qc.invalidateQueries({ queryKey: inventoryKeys.things.all }),
      qc.invalidateQueries({ queryKey: inventoryKeys.places.all }),
      // Home's "Low stock" row is /home's count.
      qc.invalidateQueries({ queryKey: inventoryKeys.home }),
    ]).then(() => undefined);
}

export type AdjustSheetProps = {
  /** The thing to adjust; null keeps the sheet closed. */
  thing: Pick<ThingRow, 'id' | 'name'> | null;
  onClose: () => void;
};

export function AdjustSheet({ thing, onClose }: AdjustSheetProps) {
  const { t } = useLingui();
  const name = thing ? (thing.name ?? t`Untitled draft`) : '';
  return (
    <Sheet
      isOpen={thing !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t`Adjust ${isolate(name)}`}
    >
      {({ close }) => (thing ? <AdjustForm thingId={thing.id} name={name} onDone={close} /> : null)}
    </Sheet>
  );
}

function AdjustForm({
  thingId,
  name,
  onDone,
}: {
  thingId: string;
  name: string;
  onDone: () => void;
}) {
  const view = useThing(thingId);
  const rule = useStockRule(thingId);
  if (view.isPending || rule.isPending) return <LoadingRows rows={3} />;
  if (view.isError || rule.isError)
    return <ErrorNotice error={view.error ?? rule.error} onDone={onDone} />;
  return (
    <AdjustFields
      thingId={thingId}
      name={name}
      quantity={view.data.quantity}
      rowVersion={view.data.rowVersion}
      rule={rule.data}
      onDone={onDone}
    />
  );
}

function ErrorNotice({ error, onDone }: { error: unknown; onDone: () => void }) {
  const errorText = useErrorText();
  return (
    <div className="grid gap-4">
      <Notice tone="danger">{errorText(error)}</Notice>
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Close</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}

function AdjustFields({
  thingId,
  name,
  quantity,
  rowVersion,
  rule,
  onDone,
}: {
  thingId: string;
  name: string;
  quantity: number;
  rowVersion: number;
  rule: { minQuantity: number; rowVersion: number } | null;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const online = useOnline();
  const errorText = useErrorText();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateStock();
  // Shown in the reader's digits; parsed from either (D172). No grouping: it's typed over.
  const show = (n: number) => fmt.num(n).replace(/[,٬\s]/g, '');
  const [count, setCount] = useState(show(quantity));
  const [min, setMin] = useState(rule ? show(rule.minQuantity) : '');
  const [errors, setErrors] = useState<{ count?: string; min?: string }>({});
  const [busy, setBusy] = useState(false);

  const parsedCount = parseAmount(count);
  const step = (by: number) => {
    const next = Math.max(0, (parsedCount ?? quantity) + by);
    setCount(show(next));
    setErrors((e) => ({ ...e, count: undefined }));
  };

  const save = async () => {
    const nextCount = parseAmount(count);
    const minText = min.trim();
    const nextMin = minText === '' ? null : parseAmount(minText);
    const next: typeof errors = {};
    if (nextCount === null) next.count = t`A number, 0 or more.`;
    if (minText !== '' && (nextMin === null || nextMin <= 0 || nextMin > STOCK_MIN_MAX))
      next.min = t`A number above 0, or empty for no minimum.`;
    setErrors(next);
    if (next.count || next.min || nextCount === null) return;

    setBusy(true);
    const events: string[] = [];
    try {
      if (nextCount !== quantity) {
        const r = await portabilityApi.adjust(thingId, { quantity: nextCount }, rowVersion);
        events.push(...r.auditEvents);
      }
      if (nextMin === null && rule) {
        const r = await portabilityApi.deleteStockRule(thingId, rule.rowVersion);
        events.push(...r.auditEvents);
      } else if (nextMin !== null && nextMin !== rule?.minQuantity) {
        const r = await portabilityApi.putStockRule(
          thingId,
          { minQuantity: nextMin },
          rule?.rowVersion,
        );
        events.push(...r.auditEvents);
      }
      await invalidate(thingId);
      if (events.length) offerUndo({ title: t`Adjusted ${isolate(name)}` }, events, { thingId });
      onDone();
    } catch (e) {
      // Whatever was written before the failure is already in; show it, and the reason.
      await invalidate(thingId);
      if (events.length) offerUndo({ title: t`Adjusted ${isolate(name)}` }, events, { thingId });
      setErrors({ count: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-end justify-center gap-3">
        <Button
          size="icon"
          variant="secondary"
          aria-label={t`One fewer`}
          isDisabled={(parsedCount ?? quantity) <= 0}
          onPress={() => step(-1)}
        >
          <span aria-hidden="true" className="text-[22px] leading-none">
            −
          </span>
        </Button>
        <TextField
          label={t`How many are left`}
          value={count}
          onChange={(v) => {
            setCount(v);
            setErrors((e) => ({ ...e, count: undefined }));
          }}
          className="w-36"
          inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
          {...(errors.count ? { errorMessage: errors.count, isInvalid: true } : {})}
        />
        <Button size="icon" variant="secondary" aria-label={t`One more`} onPress={() => step(1)}>
          <span aria-hidden="true" className="text-[22px] leading-none">
            +
          </span>
        </Button>
      </div>
      <TextField
        label={t`Keep at least`}
        description={t`Below this it's listed as low. Empty for no minimum.`}
        value={min}
        onChange={(v) => {
          setMin(v);
          setErrors((e) => ({ ...e, min: undefined }));
        }}
        inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
        {...(errors.min ? { errorMessage: errors.min, isInvalid: true } : {})}
      />
      {!online ? (
        <Notice tone="warn">
          <Trans>Needs a connection</Trans>
        </Notice>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isDisabled={!online} isPending={busy}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "12 left · keep at least 16", in the reader's digits. */
export function StockLine({ quantity, min }: { quantity: number; min: number | null }) {
  const fmt = useFormat();
  const minText = min === null ? null : fmt.num(min);
  return (
    <>
      <Plural value={quantity} one="# left" other="# left" />
      {minText ? (
        <>
          {sep()}
          <Trans>keep at least {minText}</Trans>
        </>
      ) : null}
    </>
  );
}

/**
 * The thing page's "Keep at least" (T23): only on a consumable type (inherited counts) where the
 * module is on. Members and above adjust it; others see it. Rendered only for a thing with a type
 * (./lazy.tsx), so its type can be read.
 */
export function KeepAtLeastSection() {
  const { thing, can, moduleOn } = useThingCtx();
  const typeId = thing.type?.id ?? '';
  const type = useType(typeId);
  const consumable = !!type.data?.resolvedCapabilities.includes('consumable');
  const on = moduleOn('consumables') && consumable;
  const rule = useStockRule(thing.id, on);
  const { t } = useLingui();
  const online = useOnline();
  const [adjusting, setAdjusting] = useState(false);
  if (!on || rule.isPending) return null;
  if (rule.isError) return null;
  const min = rule.data?.minQuantity ?? null;
  const low = min !== null && thing.quantity < min;
  const name = thing.name ?? t`Untitled draft`;
  return (
    <Section
      title={<Trans>Keep at least</Trans>}
      action={
        can('things.edit') ? (
          <Button
            size="small"
            variant="secondary"
            isDisabled={!online}
            aria-label={online ? t`Adjust ${name}` : t`Needs a connection`}
            onPress={() => setAdjusting(true)}
          >
            {min === null ? <Trans>Set a minimum</Trans> : <Trans>Adjust</Trans>}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-surface p-3.5 text-[15px]">
        {min === null ? (
          <span className="text-ink-2">
            <Trans>No minimum. Set one and Kept lists it as low when fewer are left.</Trans>
          </span>
        ) : (
          <>
            <span className="text-ink">
              <StockLine quantity={thing.quantity} min={min} />
            </span>
            {low ? (
              <Pill tone="warn" icon={<AlertIcon />}>
                <Trans>Low</Trans>
              </Pill>
            ) : null}
          </>
        )}
      </div>
      <AdjustSheet thing={adjusting ? thing : null} onClose={() => setAdjusting(false)} />
    </Section>
  );
}
