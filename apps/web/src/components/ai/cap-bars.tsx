/**
 * "This month" (D206, screens §5 AI settings §5 and AI usage totals): a bar per cap, "so far"
 * (never compared with full months, D188): "USD 1.12 of USD 5.00 · 22%", the tokens, and "3 calls
 * with unknown cost" under a money cap, which can't count them (§8a).
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { AiCap } from '@/api/capture/types';
import { Pill } from '@/components/page';
import { sep, useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMoney, useTokens } from './labels';

/**
 * Whose cap it is, as the subject of a sentence: the target's label, or "This server" for the
 * instance's own caps, whose label the server leaves empty (T9).
 */
export function useCapWho(): (cap: Pick<AiCap, 'scope' | 'target'>) => string {
  const { t } = useLingui();
  return (c) =>
    c.target.label ||
    (c.scope === 'instance' || c.scope === 'instance_account' ? t`This server` : '');
}

/** Whose cap it is, in words: "Home", "Ibrahim's account", "Bruce in the account". */
export function useCapName(): (cap: AiCap) => string {
  const { t } = useLingui();
  return (c) => {
    const who = c.target.label;
    switch (c.scope) {
      case 'instance':
        return t`This server, overall`;
      case 'instance_account':
        // An instance cap's label is '' (T9): an account's own override names no one.
        return c.target.id
          ? who
            ? t`${who} on this server's key`
            : t`An account on this server's key`
          : t`Each account on this server's key`;
      case 'account':
        return who ? t`${who}'s account` : t`The account`;
      case 'member':
        return t`${who} in the account`;
      case 'user':
        return t`Your personal key`;
      default:
        return who;
    }
  };
}

export function CapBar({ cap }: { cap: AiCap }) {
  const fmt = useFormat();
  const money = useMoney();
  const tokens = useTokens();
  const name = useCapName();
  const percent = cap.percent ?? 0;
  const currency = cap.monthlyCap?.currency;
  const used = cap.used.cost.find((c) => c.currency === currency)?.amount ?? '0';
  const warned = cap.state === 'warned' || percent >= 80;
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="font-semibold text-[14px] text-ink">
          <bdi>{name(cap)}</bdi>
          {cap.task ? (
            <span className="font-normal text-ink-2">
              {sep()}
              {cap.task === 'extraction' ? (
                <Trans>photos and receipts</Trans>
              ) : cap.task === 'assistant' ? (
                <Trans>assistant</Trans>
              ) : (
                <Trans>search</Trans>
              )}
            </span>
          ) : null}
        </span>
        <span className="text-small text-ink-2 tabular-nums">
          {cap.monthlyCap ? (
            <Trans>
              {money(used, cap.monthlyCap.currency)} of{' '}
              {money(cap.monthlyCap.amount, cap.monthlyCap.currency)} · {fmt.num(percent)}% so far
            </Trans>
          ) : cap.tokensPerMonth ? (
            <Trans>
              {tokens(cap.used.tokens)} of {tokens(cap.tokensPerMonth)} tokens · {fmt.num(percent)}%
              so far
            </Trans>
          ) : (
            <Trans>{tokens(cap.used.tokens)} tokens so far</Trans>
          )}
        </span>
      </div>
      {cap.monthlyCap || cap.tokensPerMonth ? (
        // biome-ignore lint/a11y/useSemanticElements: a styled bar; <meter> can't take the warn fill
        <div
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, percent)}
          aria-label={name(cap)}
          className="h-2 overflow-hidden rounded-full bg-sunken"
        >
          <div
            className={cn('h-full rounded-full', warned ? 'bg-warn' : 'bg-ink')}
            style={{ inlineSize: `${Math.min(100, percent)}%` }}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-small text-ink-2">
        {cap.state === 'paused' ? (
          <Pill tone="warn">
            <Trans>Paused</Trans>
          </Pill>
        ) : warned ? (
          <Pill tone="warn">
            <Trans>{fmt.num(percent)}% used</Trans>
          </Pill>
        ) : null}
        {cap.monthlyCap && cap.tokensPerMonth ? (
          <span>
            <Trans>
              and {tokens(cap.used.tokens)} of {tokens(cap.tokensPerMonth)} tokens
            </Trans>
          </span>
        ) : null}
        {cap.monthlyCap && cap.used.unknownCostCalls > 0 ? (
          <span>
            <Plural
              value={cap.used.unknownCostCalls}
              one="# call this month has no price and isn't counted. Add prices, or set a token cap too."
              other="# calls this month have no price and aren't counted. Add prices, or set a token cap too."
            />
          </span>
        ) : null}
        {cap.cappedByAccount ? (
          <span>
            <Trans>The account's lower cap applies first.</Trans>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function CapBars({ caps }: { caps: AiCap[] }) {
  const monthly = caps.filter((c) => !c.tokensPerMinute && !c.tokensPerDay);
  if (monthly.length === 0) return null;
  return (
    <div className="grid gap-3.5 rounded-[10px] border border-line bg-surface p-3.5">
      {monthly.map((c) => (
        <CapBar key={c.id} cap={c} />
      ))}
    </div>
  );
}
