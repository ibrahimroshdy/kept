/**
 * "What uses AI in Kept" (D206, screens §5 AI settings §1): always first, for everyone who can open
 * the page, and before the key box in the Get-started "Connect AI" step. One row per action: how
 * many AI calls it makes, the tokens including the image, and ≈ cost from the price table, or "Add
 * a price to see cost". The basis under it ("From your last 30 days", or "Measured by Kept on
 * 26 Sept 2026 with Groq"), and the month's estimate at the recent pace, or an example.
 *
 * Money shows only when the server sent it (the gate); otherwise tokens only.
 */
import { type LedgerTask, REFERENCE_FIGURES } from '@kept/shared';
import { Plural, Trans } from '@lingui/react/macro';
import { useAiExplain } from '@/api/capture/queries';
import type { AiExplain, AiScope } from '@/api/capture/types';
import { ErrorState, LoadingRows, Section } from '@/components/page';
import { sep, useFormat } from '@/lib/format';
import { useActionLabel, useApproxCost, useTokens } from './labels';

export function WhatUsesAi({
  scope,
  locationId,
  whatIsSentId,
}: {
  scope: AiScope;
  locationId?: string;
  /** The id of the "What is sent" section, for the one-line link to it. */
  whatIsSentId?: string;
}) {
  const q = useAiExplain(scope, locationId);
  return (
    <Section title={<Trans>What uses AI in Kept</Trans>}>
      {q.isPending ? (
        <LoadingRows rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <ExplainBody explain={q.data} whatIsSentId={whatIsSentId} />
      )}
    </Section>
  );
}

/**
 * Whether an action sends a photo: the extractions do; an assistant question, a search's or a
 * thing's embedding and the connection test don't (step 6: their figures come from history once
 * there are 5 calls, step 3's rule, so "image included" must not follow them).
 */
const withImage = (task: LedgerTask) => task.startsWith('extract_');

/**
 * Its separators keep to the part before them (`sep({ keep: true })`), so a wrapped line ends on
 * "·" and never starts with one ("…image included ·" / "≈ USD 0.0030"; the phone pass).
 */

function ExplainBody({ explain, whatIsSentId }: { explain: AiExplain; whatIsSentId?: string }) {
  const fmt = useFormat();
  const action = useActionLabel();
  const approx = useApproxCost();
  const tokens = useTokens();
  const history = explain.actions.some((a) => a.basis === 'history');
  const refDate = explain.actions.find((a) => a.referenceDate)?.referenceDate;
  const p = explain.projection;
  const hasPrice = explain.actions.some((a) => a.costTypical);
  return (
    <div className="grid gap-3">
      <ul className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0 [&>li+li]:border-line [&>li+li]:border-t">
        {explain.actions.map((a) => (
          <li key={a.task} className="grid gap-0.5 px-3.5 py-2.5">
            <span className="font-semibold text-[15px] text-ink">{action(a.task)}</span>
            <span className="text-small text-ink-2">
              {a.task === 'assistant_turn' ? (
                <Trans>1 or more calls (each tool it uses adds one)</Trans>
              ) : (
                <Plural value={a.callsPerAction} one="# AI call" other="# AI calls" />
              )}
              {sep({ keep: true })}
              {a.tokensTypical > 0 && !withImage(a.task) ? (
                <Trans>~{tokens(a.tokensTypical)} tokens</Trans>
              ) : a.tokensTypical > 0 ? (
                <Trans>~{tokens(a.tokensTypical)} tokens, image included</Trans>
              ) : a.task === 'embed_query' || a.task === 'embed_thing' ? (
                <Trans>a few tokens</Trans>
              ) : (
                <Trans>tokens vary</Trans>
              )}
              {sep({ keep: true })}
              {a.costTypical ? (
                approx(a.costTypical.amount, a.costTypical.currency)
              ) : a.tokensTypical > 0 ? (
                <Trans>add a price to see cost</Trans>
              ) : (
                <Trans>from your own use once you've tried it</Trans>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-small text-ink-3">
        {history ? (
          <Trans>From your last 30 days, for actions you've used at least 5 times.</Trans>
        ) : refDate ? (
          <Trans>
            Measured by Kept on {fmt.day(`${refDate}T12:00:00Z`)} with Groq ·{' '}
            <bdi dir="ltr" className="model-id font-mono">
              {REFERENCE_FIGURES.model}
            </bdi>
          </Trans>
        ) : null}
      </p>
      <p className="m-0 text-[15px] text-ink">
        {p.calls > 0 ? (
          p.cost.length > 0 ? (
            <Trans>
              At your last 30 days' pace:{' '}
              {p.cost.map((c) => approx(c.amount, c.currency)).join(' + ')} a month (
              <Plural value={p.calls} one="# call" other="# calls" />)
            </Trans>
          ) : (
            <Trans>
              At your last 30 days' pace: ~{tokens(p.tokens)} tokens a month (
              <Plural value={p.calls} one="# call" other="# calls" />)
            </Trans>
          )
        ) : (
          <Trans>For example, 100 photos and 20 receipts a month ≈ 120 calls.</Trans>
        )}
      </p>
      {p.unknownCostCalls > 0 ? (
        <p className="m-0 text-small text-ink-2">
          <Plural
            value={p.unknownCostCalls}
            one="# call had no price, so it isn't in the estimate."
            other="# calls had no price, so they aren't in the estimate."
          />
        </p>
      ) : null}
      {!hasPrice ? (
        <p className="m-0 text-small text-ink-2">
          <Trans>Add a price to see cost. Until then Kept counts tokens only.</Trans>
        </p>
      ) : null}
      {whatIsSentId ? (
        <a
          href={`#${whatIsSentId}`}
          className="justify-self-start font-semibold text-small text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
        >
          <Trans>What is sent to the provider</Trans>
        </a>
      ) : null}
    </div>
  );
}
