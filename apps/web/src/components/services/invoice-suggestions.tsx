/**
 * The invoice, read by AI, on Log a service (plan T20; screens §5 "Log a service", the board's
 * frame 65; D19, D131, D189; Q12). A draft service record's suggestions (the server's
 * `ServiceRecordV5.suggestions`): its lines, total, currency, vendor and date, shown violet and
 * dashed, never applied until the person says so: **Confirm all** takes them into the form, and
 * each line's **Edit** takes that one line into the typed lines to change it.
 *
 * Above them, the read's state: "Reading the invoice…" while the extraction runs, "Read by AI: 3
 * lines, total matches" when it's done, or why there's nothing (it failed, AI is paused here).
 * A bare `$` (`currency_unclear`) suggests no currency: the form asks "US dollars or Canadian
 * dollars?" with neither chosen (D189).
 */
import { SERVICE_LINE_KINDS, type ServiceLineKind } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useId } from 'react';
import type { ServiceRecordV5, SuggestedLine } from '@/api/vehicles/types';
import { SuggestedMark } from '@/components/inbox/suggested-field';
import { useMoney } from '@/components/things/values';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { useServiceLineLabels } from './labels';

/** What a draft's read suggests, picked out of `suggestions`. */
export type InvoiceRead = {
  state: 'none' | 'reading' | 'read' | 'failed' | 'paused';
  lines: SuggestedLine[];
  total: string | null;
  currency: string | null;
  vendor: string | null;
  servicedOn: string | null;
  totalMismatch: boolean;
  currencyUnclear: boolean;
};

const READING = new Set(['queued', 'running']);
const PAUSED = new Set(['paused_budget', 'waiting_provider']);

const isKind = (k: unknown): k is ServiceLineKind =>
  typeof k === 'string' && (SERVICE_LINE_KINDS as readonly string[]).includes(k);

/** The read of a draft, or `none` for a record without one. */
export function invoiceReadOf(rec: ServiceRecordV5 | null | undefined): InvoiceRead {
  const out: InvoiceRead = {
    state: 'none',
    lines: [],
    total: null,
    currency: null,
    vendor: null,
    servicedOn: null,
    totalMismatch: !!rec?.flags.includes('total_mismatch'),
    currencyUnclear: !!rec?.flags.includes('currency_unclear'),
  };
  const ex = rec?.extraction;
  if (rec?.reviewState !== 'draft' || !ex) return out;
  if (READING.has(ex.status)) return { ...out, state: 'reading' };
  if (PAUSED.has(ex.status)) return { ...out, state: 'paused' };
  if (ex.status === 'failed') return { ...out, state: 'failed' };
  if (ex.status !== 'succeeded') return out;
  out.state = 'read';
  for (const s of rec.suggestions ?? []) {
    const v = s.value;
    if (s.field === 'line' && v && typeof v === 'object') {
      const l = v as Record<string, unknown>;
      if (typeof l.description !== 'string' || !l.description.trim()) continue;
      out.lines.push({
        description: l.description,
        ...(isKind(l.kind) ? { kind: l.kind } : {}),
        ...(typeof l.quantity === 'string' ? { quantity: l.quantity } : {}),
        ...(typeof l.unitCost === 'string' ? { unitCost: l.unitCost } : {}),
      });
    } else if (s.field === 'total' && typeof v === 'string') out.total = v;
    else if (s.field === 'currency' && typeof v === 'string') out.currency = v;
    else if (s.field === 'servicedOn' && typeof v === 'string') out.servicedOn = v;
    else if (s.field === 'vendor') {
      const name = typeof v === 'string' ? v : (v as { name?: unknown } | null)?.name;
      if (typeof name === 'string' && name.trim()) out.vendor = name;
    }
  }
  return out;
}

/** The read's state line, above the suggestions. */
export function InvoiceReadStatus({ read }: { read: InvoiceRead }) {
  const count = read.lines.length;
  if (read.state === 'none') return null;
  return (
    <p role="status" className="m-0 text-small text-ink-2">
      {read.state === 'reading' ? (
        <Trans>Reading the invoice…</Trans>
      ) : read.state === 'failed' ? (
        <Trans>Kept couldn't read the invoice. Type the lines.</Trans>
      ) : read.state === 'paused' ? (
        <Trans>
          AI is paused here, so the invoice waits to be read. Type the lines, or come back later.
        </Trans>
      ) : count === 0 ? (
        <Trans>Read by AI: no lines found. Type them.</Trans>
      ) : read.totalMismatch ? (
        <Trans>
          Read by AI: {plural(count, { one: '# line', other: '# lines' })}, and they don't add up to
          the total
        </Trans>
      ) : (
        <Trans>
          Read by AI: {plural(count, { one: '# line', other: '# lines' })}, total matches
        </Trans>
      )}
    </p>
  );
}

/**
 * The suggested lines and total, violet and dashed (D131), with Confirm all and each line's Edit.
 * `pending` are the indexes of `read.lines` not yet taken into the form.
 */
export function InvoiceSuggestions({
  read,
  pending,
  showMoney,
  onConfirmAll,
  onEditLine,
}: {
  read: InvoiceRead;
  pending: readonly number[];
  showMoney: boolean;
  onConfirmAll: () => void;
  onEditLine: (index: number) => void;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const money = useMoney();
  const kinds = useServiceLineLabels();
  if (read.state !== 'read' || pending.length === 0) return null;
  const amount = (a: string) => (read.currency ? money(a, read.currency) : fmt.num(Number(a)));
  const lineAmount = (l: SuggestedLine) =>
    l.unitCost ? String(Number(l.unitCost) * Number(l.quantity || '1')) : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of suggestions and their choices
    <div
      role="group"
      aria-label={t`Suggested line items from the invoice`}
      className="grid gap-2 rounded-[10px] border border-dashed border-violet bg-violet-soft/60 px-3 py-2.5"
    >
      <span className="inline-flex items-center gap-1 font-semibold text-[12.5px] text-violet">
        <SuggestedMark className="size-3.5" />
        <Trans>Suggested line items from the invoice</Trans>
      </span>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {pending.map((i) => {
          const l = read.lines[i];
          if (!l) return null;
          const a = showMoney ? lineAmount(l) : null;
          return (
            <li key={i} className="grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-0.5">
              <span className="font-medium text-ink [overflow-wrap:anywhere]">
                <bdi dir="auto">{l.description}</bdi>
                {l.quantity && l.quantity !== '1' ? (
                  <span className="text-ink-2 tabular-nums">
                    {' '}
                    <Trans>× {fmt.num(Number(l.quantity))}</Trans>
                  </span>
                ) : null}
              </span>
              <span className="text-end tabular-nums">{a ? amount(a) : null}</span>
              <span className="text-small text-ink-2">{l.kind ? kinds[l.kind] : null}</span>
              <Button
                size="small"
                variant="ghost"
                className="justify-self-end"
                aria-label={t`Edit ${l.description}`}
                onPress={() => onEditLine(i)}
              >
                <Trans>Edit</Trans>
              </Button>
            </li>
          );
        })}
      </ul>
      {showMoney && read.total ? (
        <div className="flex justify-between gap-3 border-line border-t pt-1.5 font-semibold">
          <span>
            <Trans>Total</Trans>
          </span>
          <span className="tabular-nums">{amount(read.total)}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="small" onPress={onConfirmAll}>
          <Trans>Confirm all</Trans>
        </Button>
      </div>
    </div>
  );
}

/** A bare `$` on the invoice (D189): which dollars, with neither chosen. */
export function DollarQuestion({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (code: 'USD' | 'CAD') => void;
}) {
  const id = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: two choices under one question
    <div role="group" aria-labelledby={id} className="grid gap-1.5">
      <p id={id} className="m-0 text-small text-warn">
        <Trans>The invoice shows $. Is it US dollars or Canadian dollars?</Trans>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="small"
          variant={value === 'USD' ? 'primary' : 'secondary'}
          aria-pressed={value === 'USD'}
          onPress={() => onPick('USD')}
        >
          <Trans>US dollars (USD)</Trans>
        </Button>
        <Button
          size="small"
          variant={value === 'CAD' ? 'primary' : 'secondary'}
          aria-pressed={value === 'CAD'}
          onPress={() => onPick('CAD')}
        >
          <Trans>Canadian dollars (CAD)</Trans>
        </Button>
      </div>
    </div>
  );
}
