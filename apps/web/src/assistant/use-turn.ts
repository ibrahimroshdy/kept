/**
 * A conversation with the assistant (D22, D23; step-6 plan Q2): the thread as the server holds
 * it, plus the turn in flight, polled every second (no token streaming) until it ends, when the
 * thread is read again. Asking without a thread starts one, with the page's context, and shows it
 * (./store.ts). One turn at a time per thread (409 `turn_running`).
 */
import { isLiveTurn } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { assistantApi, assistantKeys, useThread, useTurn } from '@/api/assistant/queries';
import type { AskBody, Proposal, ThreadMessage, TurnView } from '@/api/assistant/types';
import { showThread } from './store';

export type AskInput = { text: string; context: NonNullable<AskBody['context']> };

function mergeById<T extends { id: string }>(a: readonly T[], b: readonly T[]): T[] {
  const seen = new Set(a.map((x) => x.id));
  return [...a, ...b.filter((x) => !seen.has(x.id))];
}

export function useConversation(threadId: string | null) {
  const qc = useQueryClient();
  const { i18n } = useLingui();
  const thread = useThread(threadId);
  const [turnId, setTurnId] = useState<string | null>(null);
  /** The thread this hook just created: switching to it keeps the turn being followed. */
  const created = useRef<string | null>(null);

  useEffect(() => {
    if (threadId !== created.current) setTurnId(null);
    created.current = null;
  }, [threadId]);

  const activeTurnId = turnId ?? thread.data?.liveTurn?.id ?? null;
  const turn = useTurn(activeTurnId);
  const status = turn.data?.status;
  const live = status ? isLiveTurn(status) : !!thread.data?.liveTurn;

  // The turn ended: read the thread again, and the list (its title and order changed).
  useEffect(() => {
    if (!status || isLiveTurn(status) || !threadId) return;
    void qc.invalidateQueries({ queryKey: assistantKeys.thread(threadId) });
    void qc.invalidateQueries({ queryKey: ['assistant', 'threads'] });
  }, [status, threadId, qc]);

  const ask = useMutation({
    mutationFn: async ({ text, context }: AskInput) => {
      let id = threadId;
      if (!id) {
        const t = await assistantApi.createThread({ context });
        id = t.id;
        created.current = id;
        showThread(id);
      }
      const r = await assistantApi.ask(id, { text, context, locale: i18n.locale });
      return { threadId: id, turnId: r.turnId };
    },
    onSuccess: async (r) => {
      setTurnId(r.turnId);
      await qc.invalidateQueries({ queryKey: ['assistant', 'threads'] });
    },
  });

  const cancel = useMutation({
    mutationFn: () => assistantApi.cancelTurn(activeTurnId as string),
    onSuccess: (view: TurnView) => {
      if (activeTurnId) qc.setQueryData(assistantKeys.turn(activeTurnId), view);
    },
  });

  const messages: ThreadMessage[] = useMemo(
    () => mergeById(thread.data?.messages ?? [], turn.data?.messages ?? []),
    [thread.data?.messages, turn.data?.messages],
  );
  const proposals: Proposal[] = useMemo(
    () => mergeById(thread.data?.proposals ?? [], turn.data?.proposals ?? []),
    [thread.data?.proposals, turn.data?.proposals],
  );

  /** The question a turn asked, to ask it again (an expired or changed card). */
  const questionOf = (id: string): string | null => {
    const m = messages.find((x) => x.turnId === id && x.role === 'user');
    const part = m?.parts.find((p) => p.type === 'text');
    return part?.type === 'text' ? part.text : null;
  };

  return {
    thread,
    messages,
    proposals,
    turn: turn.data ? { id: activeTurnId as string, ...turn.data } : null,
    live,
    ask,
    cancel,
    questionOf,
  };
}

export type Conversation = ReturnType<typeof useConversation>;
