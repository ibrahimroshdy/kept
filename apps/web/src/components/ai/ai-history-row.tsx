/**
 * An AI call in a thing's history (D206, screens §5 Thing detail): what it was for, who caused
 * it, when, and the AI line (model, tokens, ≈ cost per the gate, who paid), which opens the ledger
 * row. Nothing here can be undone: it's a record of a call, not a change.
 */
import { Trans } from '@lingui/react/macro';
import type { HistoryEvent } from '@/api/inventory/types';
import { AssistantIcon } from '@/components/icons';
import { Pill } from '@/components/page';
import { sep, useFormat } from '@/lib/format';
import { AiLine } from './ai-line';
import { useTaskLabel } from './labels';

export function AiHistoryRow({ event }: { event: HistoryEvent }) {
  const fmt = useFormat();
  const task = useTaskLabel();
  const call = event.aiCall;
  if (!call) return null;
  const who = event.actor.displayName;
  return (
    <article aria-label={task(call.task)} className="flex items-start gap-3 px-3.5 py-3">
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-sunken text-ink-2 [&_svg]:size-[18px]"
      >
        <AssistantIcon />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2 font-semibold text-[15px] text-ink leading-snug">
          {task(call.task)}
          <Pill>
            <Trans context="history kind">AI</Trans>
          </Pill>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-small text-ink-2">
          {who ? (
            <>
              <bdi>{who}</bdi>
              <span aria-hidden="true">{sep().trim()}</span>
            </>
          ) : (
            <>
              <Trans>Kept (background)</Trans>
              <span aria-hidden="true">{sep().trim()}</span>
            </>
          )}
          <time dateTime={event.at}>{fmt.dateTime(event.at)}</time>
        </div>
        <AiLine call={call} />
      </div>
    </article>
  );
}
