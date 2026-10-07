/**
 * The AI line (D206, screens §5 Inbox): on anything AI filled, what read it and what it cost, in
 * one short line: "AI · Groq · 1.6K tokens · ≈ $0.004 · paid by you". The full model id, the
 * exact tokens and cost, and who paid are in the call's detail (CallDetailSheet), which tapping
 * the line opens where the server names the ledger row (`call.id`). The cost shows "≈" with one
 * significant figure below 0.01; "cost unknown" when no price was known; nothing where the money
 * gate hid it (the server leaves `cost` out). "paid by you" when the viewer's own key or account
 * paid (`paidBy.mine`). A failed read says why instead. Used by the inbox (T27), the thing
 * header's extraction status and the capture screen (T25). It was "Read by qwen/qwen3.8-27b
 * (Groq) · 1,640 tokens · cost unknown · paid by Personal", dotted-underlined and wrapping over
 * two lines on the maintainer's iPhone.
 */
import { Trans } from '@lingui/react/macro';
import { Fragment, useState } from 'react';
import type { AiCallSummary } from '@/api/capture/types';
import { ChevronEndIcon } from '@/components/icons';
import { sep } from '@/lib/format';
import { formatLocale, usePrefs } from '@/lib/prefs';
import { cn } from '@/lib/utils';
import { CallDetailSheet } from './call-detail';
import { failedRead, useFailureReason, useProviderName } from './labels';

export { useApproxCost, useProviderName } from './labels';

/** "1.6K", "٢٫٥ ألف": the line's token count, compact. */
export function useCompactCount(): (n: number) => string {
  const { locale, digits } = usePrefs();
  return (n) =>
    new Intl.NumberFormat(formatLocale(locale, digits), {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
}

/** "≈ $0.004", "≈ EGP 0.19": the line's cost, short. One significant figure below 0.01. */
export function useShortCost(): (amount: string, currency: string) => string {
  const { locale, digits } = usePrefs();
  return (amount, currency) => {
    const n = Number(amount);
    const small = Math.abs(n) > 0 && Math.abs(n) < 0.01;
    const nf = new Intl.NumberFormat(formatLocale(locale, digits), {
      style: 'currency',
      currency,
      // "$" for US dollars; CA$, EGP and the rest keep their code, so "$" is never ambiguous.
      // Arabic takes the code: a "$" beside Arabic digits is flipped by the bidi algorithm.
      currencyDisplay: locale === 'ar' ? 'code' : currency === 'USD' ? 'narrowSymbol' : 'symbol',
      ...(small
        ? { maximumSignificantDigits: 1 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    });
    return `≈ ${nf.format(n)}`;
  };
}

export function AiLine({ call, className }: { call: AiCallSummary; className?: string }) {
  const [open, setOpen] = useState(false);
  const providerName = useProviderName();
  const count = useCompactCount();
  const short = useShortCost();
  const why = useFailureReason();
  const provider = providerName(call.providerKind);
  const tokens = count(call.tokens);
  const payer = call.paidBy.label;
  const cost = call.cost
    ? short(call.cost.amount, call.cost.currency)
    : call.costSource === 'unknown'
      ? null
      : undefined;
  // Each part stays whole and the line breaks only between parts, balanced: "AI · Groq · 1.6K
  // tokens ·" over "≈ $0.004 · paid by you", never "paid" over "by you" (the phone-pass rule).
  const part = 'whitespace-nowrap';
  const payerText = call.paidBy.mine ? (
    <Trans>paid by you</Trans>
  ) : call.paidBy.scope === 'instance' ? (
    // The instance key's label is '' (T9): it is this server's.
    <Trans>paid by this server</Trans>
  ) : (
    <Trans>
      paid by <bdi>{payer}</bdi>
    </Trans>
  );
  const parts = failedRead(call)
    ? null
    : [
        <Trans key="read">
          AI · {provider} · {tokens} tokens
        </Trans>,
        // Its own direction: "≈ US$ 0.004" stays in order inside an Arabic line.
        ...(cost ? [<bdi key="cost">{cost}</bdi>] : []),
        ...(cost === null ? [<Trans key="unknown">cost unknown</Trans>] : []),
        payerText,
      ];
  const chevron = call.id ? (
    <ChevronEndIcon aria-hidden="true" className="ms-0.5 inline size-3.5 align-[-2px]" />
  ) : null;
  // The separator (lib/format's `sep`): "· " leads a part, or in Arabic "،" ends the one before,
  // so it never starts a line either way.
  const mark = sep();
  const lead = mark.startsWith(' ') ? mark.trimStart() : null;
  const trail = lead ? null : mark.trimEnd();
  const text = parts ? (
    parts.map((p, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed short list
      <Fragment key={i}>
        {/* The space between parts is the only place the line may break. */}
        {i > 0 ? ' ' : null}
        <span className={part}>
          {i > 0 ? lead : null}
          {p}
          {i < parts.length - 1 ? trail : null}
          {i === parts.length - 1 ? chevron : null}
        </span>
      </Fragment>
    ))
  ) : (
    // A failed read says why in words (§8a): "Couldn't read this photo · the provider timed out".
    <>
      <Trans>Couldn't read this photo · {why(call.outcome, call.errorCode)}</Trans>
      {chevron}
    </>
  );
  const base = cn('m-0 text-small text-ink-3 [text-wrap:balance]', className);
  // Tapping the line opens its ledger row (D206), where the server named it.
  if (!call.id) return <p className={base}>{text}</p>;
  return (
    <>
      <p className={base}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          className="cursor-pointer text-start text-ink-2 outline-none [text-wrap:balance] hover:text-ink hover:underline hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-info"
        >
          {text}
        </button>
      </p>
      <CallDetailSheet callId={open ? call.id : null} onClose={() => setOpen(false)} />
    </>
  );
}
