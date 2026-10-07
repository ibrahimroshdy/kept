/**
 * The calendar feed (plan T25; D142, D181; step-4 Q23): a private iCal link of what's due and
 * what runs out, a month back and 13 months ahead, titles and dates only, never money. Create a
 * link and it's shown **once**, with Copy; the list says when each was last fetched; Revoke ends
 * one for good. At most 3 live. Google Calendar fetches a feed from Google's servers, so there it
 * works only when Kept can be reached from the internet.
 */
import { MAX_CALENDAR_FEEDS } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { householdApi, householdKeys, useCalendarFeeds } from '@/api/household/queries';
import type { CalendarFeed } from '@/api/household/types';
import { CalendarIcon, LinkIcon } from '@/components/icons';
import {
  ErrorState,
  IconTile,
  List,
  LoadingRows,
  Notice,
  Pill,
  useErrorText,
} from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { CopyButton } from '@/components/ui/copy-button';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';

export function CalendarFeeds() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const feeds = useCalendarFeeds();
  const errorText = useErrorText();
  const online = useOnline();
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = feeds.data?.items ?? [];
  const live = items.filter((f) => !f.revokedAt);
  const full = live.length >= MAX_CALENDAR_FEEDS;

  const create = async () => {
    setBusy(true);
    try {
      const r = await householdApi.createCalendarFeed();
      setCreated(r.url);
      await qc.invalidateQueries({ queryKey: householdKeys.calendarFeeds });
    } catch (e) {
      toast({ title: t`Couldn't create a link`, description: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <p className="m-0 text-small text-ink-2 [text-wrap:pretty]">
        <Trans>
          A private link your calendar app subscribes to: what's due and what runs out, as all-day
          events, from a month back to 13 months ahead. Titles and dates only, never money.
        </Trans>
      </p>
      {created ? (
        <Notice tone="warn" title={<Trans>Copy the link now</Trans>}>
          <div className="grid gap-2">
            <Trans>
              Kept shows it only this once. Anyone with it can read the titles and dates.
            </Trans>
            <code className="ltr block rounded-lg border border-line bg-surface p-2.5 text-start font-mono text-[13px] text-ink break-all">
              {created}
            </code>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={created} label={t`Copy the link`} size="small" />
              <Button size="small" variant="secondary" onPress={() => setCreated(null)}>
                <Trans>Done</Trans>
              </Button>
            </div>
          </div>
        </Notice>
      ) : null}
      {feeds.isPending ? (
        <LoadingRows rows={1} />
      ) : feeds.error ? (
        <ErrorState error={feeds.error} onRetry={() => void feeds.refetch()} />
      ) : items.length > 0 ? (
        <List aria-label={t`Calendar links`}>
          {items.map((f) => (
            <FeedRow key={f.id} feed={f} />
          ))}
        </List>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="small"
          variant={items.length ? 'secondary' : 'primary'}
          isPending={busy}
          isDisabled={!online || full}
          onPress={() => void create()}
        >
          <LinkIcon />
          <Trans>Create a link</Trans>
        </Button>
        {full ? (
          <span className="text-small text-ink-2">
            <Plural
              value={MAX_CALENDAR_FEEDS}
              one="# link is the most. Revoke one to make another."
              other="# links are the most. Revoke one to make another."
            />
          </span>
        ) : null}
      </div>
      <p className="m-0 text-small text-ink-3 [text-wrap:pretty]">
        <Trans>
          Locations that require two-factor are left out of the feed. Google Calendar fetches the
          link from Google's servers, so it works there only when Kept can be reached from the
          internet.
        </Trans>
      </p>
    </div>
  );
}

function FeedRow({ feed }: { feed: CalendarFeed }) {
  const { t } = useLingui();
  const f = useFormat();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const online = useOnline();
  const made = f.day(feed.createdAt);
  const fetched = feed.lastFetchedAt ? f.relative(feed.lastFetchedAt) : null;

  const revoke = async () => {
    const ok = await confirm({
      title: t`Revoke this calendar link?`,
      body: t`Calendars subscribed to it stop updating. A new link can be made any time.`,
      confirmLabel: t`Revoke`,
      destructive: true,
    });
    if (!ok) return;
    try {
      await householdApi.revokeCalendarFeed(feed.id);
      await qc.invalidateQueries({ queryKey: householdKeys.calendarFeeds });
    } catch (e) {
      toast({ title: t`Couldn't revoke it`, description: errorText(e), tone: 'danger' });
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-3 px-3.5 py-3">
      <IconTile>
        <CalendarIcon />
      </IconTile>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="font-semibold text-[15px]">
          <Trans>Link made {made}</Trans>
        </div>
        <div className="text-small text-ink-2">
          {feed.revokedAt ? (
            <Pill>
              <Trans>Revoked</Trans>
            </Pill>
          ) : fetched ? (
            <Trans>Last fetched {fetched}</Trans>
          ) : (
            <Trans>Not fetched yet</Trans>
          )}
        </div>
      </div>
      {feed.revokedAt ? null : (
        <Button
          size="small"
          variant="danger"
          isDisabled={!online}
          aria-label={t`Revoke the link made ${made}`}
          onPress={() => void revoke()}
        >
          <Trans>Revoke</Trans>
        </Button>
      )}
    </li>
  );
}
