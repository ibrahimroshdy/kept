/**
 * Your threads (D23; screens §5 "Assistant": "a threads list opens from the sheet's menu"): your
 * own only, private even from admins, newest first, searchable over your questions and the
 * answers, each deletable at once (an in-app confirm, never `window.confirm`). "Deleted after 90
 * days" without a new question. The full list, under the list standard, is the `/assistant` page;
 * this is the sheet's quick one.
 */
import { THREAD_RETENTION_DAYS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Input, SearchField } from 'react-aria-components';
import { assistantApi, assistantKeys, useThreads } from '@/api/assistant/queries';
import type { ThreadSummary } from '@/api/assistant/types';
import { useLocations } from '@/api/queries';
import { SearchIcon, TrashIcon } from '@/components/icons';
import { EmptyState, ErrorState, LoadingRows, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { isolate } from '@/lib/bidi';
import { sep, useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { assistantStore, showThread } from './store';

/** Delete a thread, asked first. */
export function useDeleteThread(onDeleted?: (id: string) => void) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const remove = useMutation({
    mutationFn: (id: string) => assistantApi.deleteThread(id),
    onSuccess: async (_r, id) => {
      qc.removeQueries({ queryKey: assistantKeys.thread(id) });
      await qc.invalidateQueries({ queryKey: ['assistant', 'threads'] });
      toast({ title: t`Thread deleted`, tone: 'ok' });
      onDeleted?.(id);
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  return async (thread: ThreadSummary) => {
    const title = thread.title ?? t`New thread`;
    const ok = await confirm({
      title: t`Delete “${isolate(title)}”?`,
      body: t`It's deleted now, for good. Nothing else changes.`,
      confirmLabel: t`Delete`,
      destructive: true,
    });
    if (ok) remove.mutate(thread.id);
  };
}

/** Where a thread was asked from, and when it was last used. */
export function useThreadMeta() {
  const f = useFormat();
  const locations = useLocations();
  const locationName = useLocationName();
  return (thread: ThreadSummary): string => {
    const l = thread.context.locationId
      ? locations.data?.find((x) => x.id === thread.context.locationId)
      : undefined;
    return [l ? isolate(locationName(l)) : null, f.relative(thread.updatedAt)]
      .filter(Boolean)
      .join(sep());
  };
}

export function ThreadRow({
  thread,
  onOpen,
  current = false,
}: {
  thread: ThreadSummary;
  /** Open in the sheet; without it the row links to `/assistant/<thread>`. */
  onOpen?: (id: string) => void;
  current?: boolean;
}) {
  const { t } = useLingui();
  const online = useOnline();
  const meta = useThreadMeta();
  // Deleting the thread on screen leaves a new one in its place.
  const askDelete = useDeleteThread((id) => {
    if (assistantStore.get().threadId === id) showThread(null);
  });
  const title = thread.title ?? t`New thread`;
  const body = (
    <span className="grid min-w-0 flex-1 gap-0.5 text-start">
      <bdi className="font-semibold text-[15px] text-ink leading-snug [overflow-wrap:anywhere]">
        {title}
      </bdi>
      <span className="text-small text-ink-2">{meta(thread)}</span>
    </span>
  );
  const cls =
    'flex min-h-14 min-w-0 flex-1 cursor-pointer items-center gap-3 px-3.5 py-2.5 outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info';
  return (
    <div className="flex items-stretch" aria-current={current ? 'true' : undefined}>
      {onOpen ? (
        <button type="button" className={cls} onClick={() => onOpen(thread.id)}>
          {body}
        </button>
      ) : (
        <Link to="/assistant/$threadId" params={{ threadId: thread.id }} className={cls}>
          {body}
        </Link>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label={t`Delete “${isolate(title)}”`}
        isDisabled={!online}
        onPress={() => void askDelete(thread)}
        className="my-auto me-1.5 shrink-0 [&_svg]:size-5"
      >
        <TrashIcon />
      </Button>
    </div>
  );
}

export function RetentionNote() {
  const f = useFormat();
  const days = f.num(THREAD_RETENTION_DAYS);
  return (
    <p className="m-0 text-small text-ink-3">
      <Trans>Private to you. Deleted after {days} days without a new question.</Trans>
    </p>
  );
}

export function ThreadsList({
  currentId,
  onOpen,
  onNavigate,
}: {
  currentId: string | null;
  onOpen: (id: string) => void;
  onNavigate?: () => void;
}) {
  const { t } = useLingui();
  const [q, setQ] = useState('');
  const query = useThreads(q.trim() ? { q: q.trim() } : {});
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr_auto]">
      <div className="px-4 pt-1 pb-3">
        <SearchField
          aria-label={t`Search your threads`}
          value={q}
          onChange={setQ}
          className="flex min-h-11 items-center gap-2 rounded-[10px] border border-line bg-paper px-3 focus-within:border-ink [&_svg]:size-[18px]"
        >
          <SearchIcon className="shrink-0 text-ink-3" />
          <Input
            placeholder={t`Search your threads`}
            className="min-h-10 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden"
          />
        </SearchField>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-3">
        {query.isPending ? (
          <LoadingRows rows={3} label={t`Loading your threads`} />
        ) : query.isError && !items.length ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !items.length ? (
          q.trim() ? (
            <p className="m-0 rounded-[10px] border border-dashed border-line px-4 py-6 text-center text-ink-2">
              <Trans>Nothing matches. Try fewer words.</Trans>
            </p>
          ) : (
            <EmptyState title={<Trans>No threads yet</Trans>}>
              <Trans>Your questions and their answers are kept here, private to you.</Trans>
            </EmptyState>
          )
        ) : (
          <ul
            aria-label={t`Your threads`}
            className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0"
          >
            {items.map((thread) => (
              <li key={thread.id} className="border-line not-first:border-t">
                <ThreadRow thread={thread} onOpen={onOpen} current={thread.id === currentId} />
              </li>
            ))}
          </ul>
        )}
        {query.hasNextPage ? (
          <div className="grid justify-items-center pt-3">
            <Button
              variant="secondary"
              isPending={query.isFetchingNextPage}
              onPress={() => void query.fetchNextPage()}
            >
              <Trans>Load more</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-line border-t px-4 pt-2.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))] md:pb-3.5">
        <RetentionNote />
        <Link
          to="/assistant"
          onClick={onNavigate}
          className="font-semibold text-small text-ink underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
        >
          <Trans>All threads</Trans>
        </Link>
      </div>
    </div>
  );
}
