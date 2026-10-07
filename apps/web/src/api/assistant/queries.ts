/**
 * Assistant fetchers, query keys and hooks over ./types.ts and ./paths.ts. The thread list follows
 * the list standard (L88): `useInfiniteQuery` over `next_cursor`. A live turn is polled every
 * second (Q2: no token streaming); the screens (T19, T20) wrap the writes in `useMutation`.
 */
import { isLiveTurn } from '@kept/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../client';
import { qs } from '../inventory/paths';
import { nextCursor } from '../inventory/queries';
import { assistantPaths as p } from './paths';
import type {
  AskBody,
  AskResult,
  CancelProposalsBody,
  ConfirmBody,
  ConfirmResult,
  CreateThreadBody,
  Thread,
  ThreadDetail,
  ThreadsPage,
  ThreadsParams,
  TurnView,
} from './types';

export const assistantKeys = {
  all: ['assistant'] as const,
  threads: (params: ThreadsParams = {}) => ['assistant', 'threads', params] as const,
  thread: (id: string) => ['assistant', 'thread', id] as const,
  turn: (id: string) => ['assistant', 'turn', id] as const,
};

export const assistantApi = {
  threads: (params: ThreadsParams = {}) => api.get<ThreadsPage>(p.threads + qs(params)),
  createThread: (body: CreateThreadBody = {}) => api.post<Thread>(p.threads, body),
  thread: (id: string) => api.get<ThreadDetail>(p.thread(id)),
  deleteThread: (id: string) => api.del(p.thread(id)),
  ask: (threadId: string, body: AskBody) => api.post<AskResult>(p.threadTurns(threadId), body),
  turn: (id: string) => api.get<TurnView>(p.turn(id)),
  cancelTurn: (id: string) => api.post<TurnView>(p.turnCancel(id)),
  /** `locale`: the card's language, which the result's fixed words are written in (the
   * server reads Accept-Language here, T13). */
  confirm: (body: ConfirmBody, locale?: string) =>
    api.post<ConfirmResult>(
      p.proposalsConfirm,
      body,
      locale ? { 'accept-language': locale } : undefined,
    ),
  cancelProposals: (body: CancelProposalsBody) => api.post<void>(p.proposalsCancel, body),
};

/** How often a live turn is polled (Q2). */
export const TURN_POLL_MS = 1000;

/** The caller's threads: `q` and the list standard's filters (./types.ts ThreadsParams). */
export function useThreads(params: Omit<ThreadsParams, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: assistantKeys.threads(params),
    queryFn: ({ pageParam }) =>
      assistantApi.threads({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
}

export function useThread(id: string | null) {
  return useQuery({
    queryKey: assistantKeys.thread(id ?? ''),
    queryFn: () => assistantApi.thread(id as string),
    enabled: !!id,
  });
}

/** A turn, polled every second while it's live, then left alone. */
export function useTurn(id: string | null) {
  return useQuery({
    queryKey: assistantKeys.turn(id ?? ''),
    queryFn: () => assistantApi.turn(id as string),
    enabled: !!id,
    refetchInterval: (query) =>
      query.state.data && !isLiveTurn(query.state.data.status) ? false : TURN_POLL_MS,
  });
}
