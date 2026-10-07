/**
 * The usage page's totals (D206, screens §5 AI usage §2 and §4): calls (and how many Kept held
 * back), tokens, images, cost per currency (never converted, D76), "N calls with unknown cost",
 * the caps' progress, and the outcome counts, each of which filters the call list below.
 */
import type { LedgerOutcome } from '@kept/shared';
import { LEDGER_OUTCOMES } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type { AiUsage } from '@/api/capture/types';
import { useFormat } from '@/lib/format';
import { useListState } from '@/lib/url-state';
import { cn } from '@/lib/utils';
import { CapBars } from './cap-bars';
import { useApproxCost, useOutcomeLabel, useTokens } from './labels';

function Kpi({ label, value, note }: { label: ReactNode; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="grid content-start gap-1 rounded-[10px] border border-line bg-surface p-3.5">
      <span className="text-small text-ink-3">{label}</span>
      <span className="font-semibold text-[20px] text-ink tabular-nums leading-tight [overflow-wrap:anywhere]">
        {value}
      </span>
      {note ? <span className="text-small text-ink-2">{note}</span> : null}
    </div>
  );
}

export function UsageTotals({ usage }: { usage: AiUsage }) {
  const fmt = useFormat();
  const tokens = useTokens();
  const approx = useApproxCost();
  const totals = usage.totals;
  const held = totals.calls - totals.sentCalls;
  const allTokens = totals.tokens.input + totals.tokens.output;
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Kpi
          label={usage.soFar ? <Trans>Calls so far</Trans> : <Trans>Calls</Trans>}
          value={fmt.num(totals.calls)}
          note={
            held > 0 ? (
              <Plural value={held} one="# held back by Kept" other="# held back by Kept" />
            ) : undefined
          }
        />
        <Kpi
          label={<Trans>Tokens</Trans>}
          value={tokens(allTokens)}
          note={
            <Trans>
              {tokens(totals.tokens.input)} in · {tokens(totals.tokens.output)} out
            </Trans>
          }
        />
        <Kpi label={<Trans>Images</Trans>} value={fmt.num(totals.images)} />
        <Kpi
          label={<Trans>Cost</Trans>}
          value={
            totals.cost.length ? (
              <span className="grid gap-0.5">
                {totals.cost.map((c) => (
                  <span key={c.currency}>{approx(c.amount, c.currency)}</span>
                ))}
              </span>
            ) : (
              <Trans>None known</Trans>
            )
          }
          note={
            totals.unknownCostCalls > 0 ? (
              <Plural
                value={totals.unknownCostCalls}
                one="# call with unknown cost"
                other="# calls with unknown cost"
              />
            ) : undefined
          }
        />
      </div>
      {usage.caps.length ? <CapBars caps={usage.caps} /> : null}
    </div>
  );
}

/** Outcome counts; each one filters the list (`f.outcome`). */
export function OutcomeCounts({ outcomes }: { outcomes: AiUsage['totals']['outcomes'] }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const label = useOutcomeLabel();
  const [list, setList] = useListState();
  const chosen = list.filters.outcome ?? [];
  const shown = LEDGER_OUTCOMES.filter((o) => (outcomes[o] ?? 0) > 0);
  if (shown.length === 0) return null;
  const toggle = (o: LedgerOutcome) => {
    const next = chosen.includes(o) ? chosen.filter((x) => x !== o) : [o];
    setList({
      filters: { ...list.filters, outcome: next },
      not: list.not.filter((n) => n !== 'outcome'),
    });
  };
  return (
    <section aria-label={t`Outcomes`} className="flex flex-wrap gap-2">
      {shown.map((o) => {
        const on = chosen.includes(o) && !list.not.includes('outcome');
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(o)}
            className={cn(
              'inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium outline-none focus-visible:outline-2 focus-visible:outline-info',
              on
                ? 'border-ink bg-ink text-paper'
                : 'border-line bg-surface text-ink-2 hover:text-ink',
            )}
          >
            {label(o)}
            <span className="tabular-nums">{fmt.num(outcomes[o] ?? 0)}</span>
          </button>
        );
      })}
    </section>
  );
}
