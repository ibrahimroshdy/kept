/**
 * A thread's messages (D22, D23, D164, D179; screens §5 "Assistant", frames 04 · 4–6): the
 * person's questions, the assistant's answers (./answer.tsx), its tool steps as quiet lines
 * ("Looked in Garage"), redacted parts as "Removed", and one confirmation card per batch of
 * proposals (./confirm-card.tsx). The model's reasoning is never shown. Under the last message,
 * the turn in flight: "Thinking…", "Waiting for Groq · about 20 s", or how it ended when it
 * didn't answer (paused, failed, stopped).
 */
import type { Part } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Fragment, type ReactNode, useEffect, useMemo, useRef } from 'react';
import type { Proposal, ThreadMessage } from '@/api/assistant/types';
import { useAiStatus } from '@/api/capture/queries';
import { useProviderName } from '@/components/ai/labels';
import { usePausedUntil } from '@/components/ai/paused-banner';
import { AssistantIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { Answer, Redacted, seenThings, ToolStep } from './answer';
import { ConfirmCard } from './confirm-card';
import type { Conversation } from './use-turn';

function Who() {
  return (
    <span className="flex items-center gap-1.5 font-semibold text-[12px] text-ink-3 [&_svg]:size-3.5">
      <AssistantIcon />
      <Trans>Assistant</Trans>
    </span>
  );
}

function Question({ text }: { text: string }) {
  return (
    <div
      dir="auto"
      className="max-w-[86%] justify-self-end whitespace-pre-wrap rounded-2xl rounded-ee-[4px] bg-sunken px-3.5 py-2 text-[15px] text-ink leading-snug [overflow-wrap:anywhere]"
    >
      {text}
    </div>
  );
}

/** Seconds until an instant, never below one. */
const secondsTo = (iso: string | null): number =>
  iso ? Math.max(1, Math.round((Date.parse(iso) - Date.now()) / 1000)) : 0;

/** The turn in flight, or how the last one ended without an answer. */
function TurnLine({
  conversation,
  locationId,
}: {
  conversation: Conversation;
  locationId: string | null;
}) {
  const { t } = useLingui();
  const f = useFormat();
  const ai = useAiStatus(locationId);
  const providerName = useProviderName();
  const pausedUntil = usePausedUntil();
  const turn = conversation.turn;
  if (!turn && !conversation.live) return null;
  const status = turn?.status ?? 'running';
  let line: ReactNode = null;
  switch (status) {
    case 'queued':
    case 'running':
      line = <Trans>Thinking…</Trans>;
      break;
    case 'waiting_provider': {
      const provider = providerName(ai.data?.providerKind ?? null);
      const secs = f.num(secondsTo(turn?.pausedUntil ?? null));
      line = turn?.pausedUntil ? (
        <Trans>
          Waiting for <bdi>{provider}</bdi> · about {secs} s
        </Trans>
      ) : (
        <Trans>
          Waiting for <bdi>{provider}</bdi>
        </Trans>
      );
      break;
    }
    case 'paused_budget':
      line = turn?.pausedUntil ? pausedUntil(turn.pausedUntil) : t`AI paused`;
      break;
    case 'failed':
      line = <Trans>The assistant couldn't finish this answer. Ask again.</Trans>;
      break;
    case 'cancelled':
      line = <Trans>Stopped</Trans>;
      break;
    default:
      return null;
  }
  const live = status === 'queued' || status === 'running' || status === 'waiting_provider';
  return (
    <div className="grid gap-1.5">
      <Who />
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 flex-1 text-[14.5px] text-ink-2" role="status" aria-live="polite">
          {live ? (
            <span
              aria-hidden="true"
              className="me-1.5 inline-block size-2 animate-pulse rounded-full bg-amber"
            />
          ) : null}
          {line}
        </p>
        {live && turn ? (
          <Button
            size="small"
            variant="secondary"
            isPending={conversation.cancel.isPending}
            onPress={() => conversation.cancel.mutate()}
          >
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type Item =
  | { kind: 'question'; key: string; text: string }
  | { kind: 'answer'; key: string; text: string }
  | { kind: 'tool'; key: string; tool: string; locationIds: string[] | null }
  | { kind: 'redacted'; key: string }
  | { kind: 'card'; key: string; proposals: Proposal[] };

/** The thread as lines to draw: one card per batch, tool calls paired with their results. */
export function threadItems(messages: ThreadMessage[], proposals: Proposal[]): Item[] {
  const results = new Map<string, string[]>();
  for (const m of messages)
    for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p.locationIds);
  const batches = new Map<string, Proposal[]>();
  for (const x of proposals) batches.set(x.batchId, [...(batches.get(x.batchId) ?? []), x]);
  const shown = new Set<string>();
  const items: Item[] = [];
  /** Where each turn's lines end, for a batch no message points at. */
  const turnEnd = new Map<string, number>();
  for (const m of messages) {
    if (m.role === 'tool') {
      if (m.parts.some((p) => p.type === 'redacted'))
        items.push({ kind: 'redacted', key: `${m.id}:r` });
      continue;
    }
    m.parts.forEach((p: Part, i) => {
      const key = `${m.id}:${i}`;
      switch (p.type) {
        case 'text':
          if (p.text.trim())
            items.push(
              m.role === 'user'
                ? { kind: 'question', key, text: p.text }
                : { kind: 'answer', key, text: p.text },
            );
          break;
        case 'tool_call':
          items.push({
            kind: 'tool',
            key,
            tool: p.tool,
            locationIds: results.get(p.callId) ?? null,
          });
          break;
        case 'proposal': {
          const batch = proposals.find((x) => x.id === p.proposalId)?.batchId;
          if (batch && !shown.has(batch)) {
            shown.add(batch);
            items.push({ kind: 'card', key: batch, proposals: batches.get(batch) ?? [] });
          }
          break;
        }
        case 'redacted':
          items.push({ kind: 'redacted', key });
          break;
        // `reasoning` is the model's own, kept for the next request and never shown.
      }
    });
    if (m.turnId) turnEnd.set(m.turnId, items.length);
  }
  // A batch no `proposal` part names still gets its card, after its turn's lines.
  const late: { at: number; item: Item }[] = [];
  for (const [batch, list] of batches) {
    if (shown.has(batch)) continue;
    const turn = list[0]?.turnId ?? '';
    late.push({
      at: turnEnd.get(turn) ?? items.length,
      item: { kind: 'card', key: batch, proposals: list },
    });
  }
  // Last first, so earlier positions hold; equal positions keep their order.
  const order = late.map((x, i) => ({ ...x, i })).sort((a, b) => b.at - a.at || b.i - a.i);
  for (const { at, item } of order) items.splice(at, 0, item);
  return items;
}

export function ThreadView({
  conversation,
  locationId,
  pendingText,
  onAskAgain,
  onNavigate,
}: {
  conversation: Conversation;
  /** The context's location: whose AI status explains a wait. */
  locationId: string | null;
  /** A question sent and not yet stored. */
  pendingText: string | null;
  onAskAgain: (question: string) => void;
  onNavigate?: () => void;
}) {
  const { messages, proposals } = conversation;
  const items = useMemo(() => threadItems(messages, proposals), [messages, proposals]);
  const seen = useMemo(
    () =>
      seenThings(
        messages.flatMap((m) =>
          m.parts.flatMap((p) => (p.type === 'tool_result' ? [p.output] : [])),
        ),
      ),
    [messages],
  );
  const end = useRef<HTMLDivElement>(null);
  const count = items.length;
  // New lines scroll into view (the newest at the bottom, as a chat reads).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when lines are added
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [count, pendingText, conversation.turn?.status]);
  const nav = onNavigate ? { onNavigate } : {};
  let lastWasAnswer = false;
  return (
    <div className="grid content-start gap-3.5">
      {items.map((item) => {
        const showWho = (item.kind === 'answer' || item.kind === 'tool') && !lastWasAnswer;
        lastWasAnswer = item.kind === 'answer' || item.kind === 'tool' || item.kind === 'card';
        switch (item.kind) {
          case 'question':
            lastWasAnswer = false;
            return <Question key={item.key} text={item.text} />;
          case 'answer':
            return (
              <div key={item.key} className="grid gap-2 text-[15px] text-ink leading-normal">
                {showWho ? <Who /> : null}
                <Answer text={item.text} seen={seen} {...nav} />
              </div>
            );
          case 'tool':
            return (
              <Fragment key={item.key}>
                {showWho ? <Who /> : null}
                <ToolStep
                  tool={item.tool}
                  locationIds={item.locationIds}
                  pending={item.locationIds === null && conversation.live}
                />
              </Fragment>
            );
          case 'redacted':
            return <Redacted key={item.key} />;
          case 'card': {
            const turnId = item.proposals[0]?.turnId;
            const question = turnId ? conversation.questionOf(turnId) : null;
            return (
              <ConfirmCard
                key={item.key}
                proposals={item.proposals}
                {...(question ? { onAskAgain: () => onAskAgain(question) } : {})}
                {...nav}
              />
            );
          }
        }
        return null;
      })}
      {pendingText ? <Question text={pendingText} /> : null}
      <TurnLine conversation={conversation} locationId={locationId} />
      <div ref={end} />
    </div>
  );
}
