/**
 * A location's share links (1.5, D233; screens §5 Share links): owners and admins only. On the
 * list standard: search by name, filters for state and for what was shared, grouped by state,
 * with "Load more" (`GET /locations/:id/share-links` answers the whole list; the paging is done
 * here). Each row: what it shares (a box or place links to it), its state and dates, how often it
 * was opened, who made it, and Preview as recipient and Revoke (an in-app confirm). Links are made
 * from a box's or a place's page, or from Search.
 */
import {
  SHARE_LINK_SCOPES,
  SHARE_LINK_STATES,
  type ShareLinkScope,
  type ShareLinkState,
} from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { Page } from '@/api/inventory/types';
import {
  sharelinkApi,
  sharelinkKeys,
  useSharedPage,
  useShareLinks,
} from '@/api/sharelinks/queries';
import type { ShareLinkRow } from '@/api/sharelinks/types';
import { ShareIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, ErrorState, LoadingRows, Pill, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { firstOf, useListState } from '@/lib/url-state';
import { SharedHeader, SharedPlainList } from './shared-view';
import { useScopeWords, useStateWords, WhatTheySee } from './words';

/** The URL filter keys this list owns (the route's `listSearch`). */
export const SHARE_LINK_FILTERS = ['state', 'scope'] as const;
const PAGE = 20;

/** The whole list as the list surface's pages, `PAGE` at a time. */
function usePaged(
  query: ReturnType<typeof useShareLinks>,
  items: ShareLinkRow[],
): UseInfiniteQueryResult<InfiniteData<Page<ShareLinkRow>>> {
  const [pages, setPages] = useState(1);
  const shown = items.slice(0, pages * PAGE);
  return {
    ...query,
    data: query.data
      ? {
          pages: [{ items: shown, next_cursor: shown.length < items.length ? 'more' : null }],
          pageParams: [undefined],
        }
      : undefined,
    hasNextPage: shown.length < items.length,
    isFetchingNextPage: false,
    fetchNextPage: async () => {
      setPages((n) => n + 1);
      return undefined as never;
    },
  } as unknown as UseInfiniteQueryResult<InfiniteData<Page<ShareLinkRow>>>;
}

/** What a link shares, in words: the box's or place's name, or the list's. */
function useNameOf() {
  const { t } = useLingui();
  return (l: ShareLinkRow) =>
    l.scope === 'view'
      ? (l.title ?? t`List`)
      : l.subject?.isUnplaced
        ? t`Unplaced`
        : (l.subject?.name ?? t`No longer here`);
}

export function ShareLinksList({ locationId }: { locationId: string }) {
  const { t } = useLingui();
  const [list] = useListState();
  const query = useShareLinks(locationId);
  const states = useStateWords();
  const scopes = useScopeWords();
  const nameOf = useNameOf();
  const [preview, setPreview] = useState<ShareLinkRow | null>(null);
  const q = list.q.trim().toLocaleLowerCase();
  const state = firstOf(list, 'state') as ShareLinkState | undefined;
  const scope = firstOf(list, 'scope') as ShareLinkScope | undefined;
  const items = (query.data?.items ?? [])
    .filter((l) => !q || nameOf(l).toLocaleLowerCase().includes(q))
    .filter((l) => !state || l.state === state)
    .filter((l) => !scope || l.scope === scope);
  const by = list.group ?? 'none';
  const sorted =
    by === 'state'
      ? [...items].sort(
          (a, b) => SHARE_LINK_STATES.indexOf(a.state) - SHARE_LINK_STATES.indexOf(b.state),
        )
      : items;
  const paged = usePaged(query, sorted);
  return (
    <div className="grid gap-3">
      <p className="m-0 text-ink-2">
        <Trans>
          Read-only links to a box, a place or a list, for someone without an account. Make one from
          a box's or a place's page, or from Search.
        </Trans>{' '}
        <WhatTheySee />
      </p>
      <ListSurface<ShareLinkRow>
        label={t`Share links`}
        search={{ label: t`Search share links`, placeholder: t`Search by name` }}
        filters={[
          {
            key: 'state',
            label: t`State`,
            kind: 'single',
            values: {
              from: 'static',
              options: SHARE_LINK_STATES.map((s) => ({ value: s, label: states[s] })),
            },
          },
          {
            key: 'scope',
            label: t`Shared`,
            kind: 'single',
            values: {
              from: 'static',
              options: SHARE_LINK_SCOPES.map((s) => ({ value: s, label: scopes[s] })),
            },
          },
        ]}
        groups={[
          { value: 'none', label: t`None` },
          { value: 'state', label: t`State`, short: t`by state` },
        ]}
        groupOf={(l, g) => (g === 'state' ? { key: l.state, label: states[l.state] } : null)}
        query={paged}
        getKey={(l) => l.id}
        renderRow={(l) => <ShareLinkRowView link={l} onPreview={() => setPreview(l)} />}
        empty={
          <EmptyState icon={<ShareIcon />} title={<Trans>No share links here</Trans>}>
            <Trans>
              Open a box or a place and choose Share a read-only link, or share a search's list from
              Search.
            </Trans>
          </EmptyState>
        }
      />
      <PreviewSheet link={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

function ShareLinkRowView({ link: l, onPreview }: { link: ShareLinkRow; onPreview: () => void }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const online = useOnline();
  const errorText = useErrorText();
  const states = useStateWords();
  const scopes = useScopeWords();
  const nameOf = useNameOf();
  const revoke = useMutation({
    mutationFn: () => sharelinkApi.revoke(l.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: sharelinkKeys.links(l.locationId) });
      toast({ title: t`Link revoked`, tone: 'ok' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });
  const tone: Record<ShareLinkState, 'ok' | 'warn' | undefined> = {
    active: 'ok',
    expired: undefined,
    revoked: undefined,
    stopped: 'warn',
  };
  const until = f.day(l.expiresAt);
  const revokedOn = l.revokedAt ? f.day(l.revokedAt) : '';
  const opened = l.lastViewedAt ? f.relative(l.lastViewedAt) : '';
  const name = nameOf(l);
  const subjectLink =
    l.subject && l.state !== 'revoked'
      ? l.scope === 'thing'
        ? ({ to: '/t/$id', params: { id: l.subject.id } } as const)
        : ({ to: '/p/$id', params: { id: l.subject.id } } as const)
      : null;
  return (
    <div className="grid gap-2 px-3.5 py-3">
      <div className="grid min-w-0 gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {subjectLink ? (
            <Link
              {...subjectLink}
              className="break-words font-semibold text-ink underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-info"
            >
              {name}
            </Link>
          ) : (
            <span className="break-words font-semibold text-ink">{name}</span>
          )}
          <span className="text-small text-ink-2">{scopes[l.scope]}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-2">
          <Pill {...(tone[l.state] ? { tone: tone[l.state] } : {})}>{states[l.state]}</Pill>
          {l.state === 'revoked' ? (
            <span>
              <Trans>Revoked {revokedOn}</Trans>
            </span>
          ) : l.state === 'expired' ? (
            <span>
              <Trans>Expired {until}</Trans>
            </span>
          ) : (
            <span>
              <Trans>Until {until}</Trans>
            </span>
          )}
          <span>
            {plural(l.views, { 0: 'Not opened yet', one: 'Opened once', other: 'Opened # times' })}
          </span>
          {opened ? (
            <span>
              <Trans>Last opened {opened}</Trans>
            </span>
          ) : null}
        </span>
        {l.state === 'stopped' ? (
          <span className="text-small text-ink-2">
            <Trans>
              It stopped because <bdi>{l.createdBy.displayName}</bdi> no longer runs this location.
            </Trans>
          </span>
        ) : null}
        <span className="text-small text-ink-3">
          <Trans>
            Shared by <bdi>{l.createdBy.displayName}</bdi>
          </Trans>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="small" variant="secondary" isDisabled={!online} onPress={onPreview}>
          <Trans>Preview as recipient</Trans>
        </Button>
        {l.state === 'revoked' ? null : (
          <Button
            size="small"
            variant="ghost"
            isDisabled={!online}
            isPending={revoke.isPending}
            onPress={async () => {
              const ok = await confirm({
                title: t`Revoke this link?`,
                body: t`Anyone who opens it sees "This link has expired" from now on. It can't be turned back on.`,
                confirmLabel: t`Revoke`,
                destructive: true,
              });
              if (ok) revoke.mutate();
            }}
          >
            <Trans>Revoke</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}

/** "Preview as recipient": the page as it shows now, rows only (screens §5). */
function PreviewSheet({ link, onClose }: { link: ShareLinkRow | null; onClose: () => void }) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={!!link}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t`Preview as recipient`}
      wide
    >
      {link ? <PreviewBody id={link.id} onClose={onClose} /> : null}
    </Sheet>
  );
}

function PreviewBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useLingui();
  const query = useSharedPage({ id });
  const first = query.data?.pages[0];
  return (
    <div className="grid gap-4">
      {query.isPending ? (
        <LoadingRows rows={3} label={t`Loading`} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : first ? (
        <>
          <SharedHeader page={first} />
          <SharedPlainList query={query} />
        </>
      ) : null}
      <DialogFooter>
        <Button onPress={onClose}>
          <Trans>Done</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
