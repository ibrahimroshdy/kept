/**
 * Settings → Account → Exchange rates (D76, D136; plan T26, Q21–Q22): the rates entered for one
 * owner account, per pair of currencies and the day each applies from, newest first within a
 * pair. Totals in several currencies (the insurance report, the AI caps) are converted only with
 * these, directly or through the inverse pair, never through a third currency and never
 * estimated; the page says so.
 *
 * Owners and admins of the account add, change and delete a rate; each write shows Undo for 10
 * seconds (`fx_rate.set` brings the previous rate back, or removes a new one; `fx_rate.delete`
 * puts it back). The pair and the day are the rate's key, so changing either is a new rate.
 * Members read the list. Online only: offline the buttons are off with "Needs a connection".
 *
 * Not on the filter strip: a handful of pairs, and no list surface for rates (shared LIST_SURFACES).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { householdApi, householdKeys, useFxRates } from '@/api/household/queries';
import type { FxRate } from '@/api/household/types';
import { useOfferUndo } from '@/components/history/undo';
import { ChartIcon, PencilIcon, PlusIcon, TrashIcon } from '@/components/icons';
import { EmptyState, ErrorState, List, LoadingRows, Notice, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import type { AccountScope } from '@/components/registries/api';
import { dayIn } from '@/components/schedules/access';
import { CurrencyPicker } from '@/components/things/pickers';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { usePrefs } from '@/lib/prefs';

/** `fx_rates.rate` is numeric(18,8): up to 10 whole digits and 8 decimals, above 0. */
const RATE = /^(\d{1,10})(?:\.(\d{1,8}))?$/;

/**
 * What a person typed as a rate, canonical ("48.6500" → "48.65"), or null. Eastern Arabic and
 * Persian digits, and `٫` or `,` as the decimal point, are read too.
 */
export function parseRate(input: string): string | null {
  const s = input
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.');
  const m = RATE.exec(s);
  if (!m) return null;
  const int = (m[1] ?? '0').replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return /[1-9]/.test(out) ? out : null;
}

/** A rate in the reader's digits, every decimal kept (Intl's default would round to 3). */
function useRateText() {
  const { locale, digits } = usePrefs();
  return (rate: string) => {
    const decimals = rate.split('.')[1]?.length ?? 0;
    try {
      return new Intl.NumberFormat(locale, {
        numberingSystem: /^ar/.test(locale) && digits === 'eastern' ? 'arab' : 'latn',
        maximumFractionDigits: decimals,
      })
        .format(rate as Intl.StringNumericLiteral)
        .replace(/[‎‏؜]/g, '');
    } catch {
      return rate;
    }
  };
}

/** "1 USD = 48.65 EGP", left to right whatever the language (D136). */
function RateText({ rate }: { rate: Pick<FxRate, 'fromCcy' | 'toCcy' | 'rate'> }) {
  const text = useRateText();
  const f = useFormat();
  return (
    <bdi dir="ltr" className="whitespace-nowrap tabular-nums">
      {f.num(1)} {rate.fromCcy} = {text(rate.rate)} {rate.toCcy}
    </bdi>
  );
}

function useInvalidateRates() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: householdKeys.fx.all });
}

// ----- the sheet ---------------------------------------------------------------------------------

type Editing = { mode: 'add' } | { mode: 'edit'; rate: FxRate };

function RateForm({
  accountId,
  editing,
  onDone,
}: {
  accountId: string;
  editing: Editing;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const online = useOnline();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateRates();
  const existing = editing.mode === 'edit' ? editing.rate : null;
  const [from, setFrom] = useState<string | null>(existing?.fromCcy ?? null);
  const [to, setTo] = useState<string | null>(existing?.toCcy ?? null);
  const [rate, setRate] = useState(existing?.rate ?? '');
  const [validFrom, setValidFrom] = useState<string | null>(
    existing?.validFrom ?? dayIn(undefined),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseRate(rate);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!from) next.from = t`Choose the currency you convert from.`;
    if (!to) next.to = t`Choose the currency you convert to.`;
    else if (to === from) next.to = t`Choose two different currencies.`;
    if (!parsed) next.rate = t`A number above 0, with at most 8 decimals, like 48.65.`;
    if (!validFrom) next.validFrom = t`Pick the day it applies from.`;
    setErrors(next);
    if (Object.keys(next).length || !from || !to || !parsed || !validFrom) return;
    setBusy(true);
    setFailed(null);
    try {
      const { auditEvents } = await householdApi.putFxRate(
        accountId,
        { fromCcy: from, toCcy: to, rate: parsed, validFrom },
        existing?.rowVersion,
      );
      await invalidate();
      offerUndo({ title: existing ? t`Rate changed` : t`Rate added` }, auditEvents);
      onDone();
    } catch (err) {
      setFailed(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
      {existing ? (
        <p className="m-0 text-ink-2">
          <Trans>
            From {existing.fromCcy} to {existing.toCcy}. To change the pair or the day, add a new
            rate.
          </Trans>
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1">
            <CurrencyPicker label={t`From`} value={from} onChange={setFrom} />
            {errors.from ? <p className="m-0 text-small text-danger">{errors.from}</p> : null}
          </div>
          <div className="grid gap-1">
            <CurrencyPicker label={t`To`} value={to} onChange={setTo} />
            {errors.to ? <p className="m-0 text-small text-danger">{errors.to}</p> : null}
          </div>
        </div>
      )}
      <TextField
        label={from ? t`1 ${from} is worth` : t`Rate`}
        description={to && parsed && from ? undefined : t`How much one unit is worth in the other.`}
        value={rate}
        onChange={(v) => {
          setRate(v);
          setErrors(({ rate: _, ...rest }) => rest);
        }}
        inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
        {...(errors.rate ? { errorMessage: errors.rate, isInvalid: true } : {})}
      />
      {from && to && parsed && from !== to ? (
        <p className="m-0 text-small text-ink-2">
          <RateText rate={{ fromCcy: from, toCcy: to, rate: parsed }} />
        </p>
      ) : null}
      {existing ? null : (
        <DatePicker
          label={t`Applies from`}
          description={t`Until a newer rate for the same pair.`}
          value={validFrom}
          onChange={(v) => {
            setValidFrom(v);
            setErrors(({ validFrom: _, ...rest }) => rest);
          }}
          {...(errors.validFrom ? { errorMessage: errors.validFrom } : {})}
        />
      )}
      {failed ? <Notice tone="danger">{errorText(failed)}</Notice> : null}
      {online ? null : (
        <p className="m-0 text-small text-ink-2">
          <Trans>Needs a connection</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}

// ----- the tab -----------------------------------------------------------------------------------

export function ExchangeRatesTab({ scope }: { scope: AccountScope }) {
  const { t } = useLingui();
  const f = useFormat();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const online = useOnline();
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateRates();
  const query = useFxRates(scope.accountId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const manage = scope.canManage;
  const rates = query.data?.items ?? [];
  // One group per pair, the newest rate first (the one that applies today, unless dated ahead).
  const pairs = new Map<string, FxRate[]>();
  for (const r of rates) {
    const key = `${r.fromCcy}→${r.toCcy}`;
    pairs.set(key, [...(pairs.get(key) ?? []), r]);
  }
  for (const list of pairs.values()) list.sort((a, b) => b.validFrom.localeCompare(a.validFrom));

  const remove = async (r: FxRate) => {
    const pair = `${r.fromCcy} → ${r.toCcy}`;
    const day = f.day(r.validFrom);
    const ok = await confirm({
      title: t`Delete the ${pair} rate from ${day}?`,
      body: t`Totals from that day use the rate before it, or show per currency.`,
      confirmLabel: t`Delete`,
      destructive: true,
    });
    if (!ok) return;
    const key = `${r.fromCcy}/${r.toCcy}/${r.validFrom}`;
    setDeleting(key);
    try {
      const { auditEvents } = await householdApi.deleteFxRate(scope.accountId, r);
      await invalidate();
      offerUndo({ title: t`Rate deleted` }, auditEvents);
    } catch (err) {
      toast({ title: errorText(err), tone: 'danger' });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="grid gap-4">
      <Notice tone="info">
        <Trans>
          Kept converts totals only with a rate you entered here, for that pair or its inverse. It
          never estimates one, and never goes through a third currency: without a rate, totals stay
          per currency.
        </Trans>
      </Notice>
      {manage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="small" isDisabled={!online} onPress={() => setEditing({ mode: 'add' })}>
            <PlusIcon className="size-4" />
            <Trans>Add a rate</Trans>
          </Button>
          {online ? null : (
            <span className="text-small text-ink-3">
              <Trans>Needs a connection</Trans>
            </span>
          )}
        </div>
      ) : (
        <p className="m-0 text-small text-ink-2">
          <Trans>Only an owner or admin of this account changes its rates.</Trans>
        </p>
      )}
      {query.isPending ? (
        <LoadingRows rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rates.length === 0 ? (
        <EmptyState icon={<ChartIcon />} title={<Trans>No exchange rates yet</Trans>}>
          <Trans>
            Add one when you want totals in several currencies turned into one, like USD to EGP.
          </Trans>
        </EmptyState>
      ) : (
        [...pairs.entries()].map(([pair, list]) => (
          <section key={pair} aria-label={pair} className="grid gap-1.5">
            <h2 dir="ltr" className="eyebrow m-0 text-start">
              {pair}
            </h2>
            <List>
              {list.map((r) => {
                const key = `${r.fromCcy}/${r.toCcy}/${r.validFrom}`;
                const day = f.day(r.validFrom);
                const who = r.updatedBy.displayName;
                return (
                  <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-3">
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="font-medium">
                        <RateText rate={r} />
                      </span>
                      <span className="text-small text-ink-2">
                        <Trans>
                          From {day} · by <bdi>{who}</bdi>
                        </Trans>
                      </span>
                    </span>
                    {manage ? (
                      <span className="flex gap-1">
                        <Button
                          size="small"
                          variant="ghost"
                          isDisabled={!online}
                          aria-label={t`Change the rate from ${day}`}
                          onPress={() => setEditing({ mode: 'edit', rate: r })}
                        >
                          <PencilIcon className="size-4" />
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          isDisabled={!online}
                          isPending={deleting === key}
                          aria-label={t`Delete the rate from ${day}`}
                          onPress={() => void remove(r)}
                        >
                          <TrashIcon className="size-4" />
                        </Button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </List>
          </section>
        ))
      )}
      <Sheet
        isOpen={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.mode === 'edit' ? t`Change the rate` : t`Add a rate`}
      >
        {({ close }) =>
          editing ? <RateForm accountId={scope.accountId} editing={editing} onDone={close} /> : null
        }
      </Sheet>
    </div>
  );
}
