/**
 * Recent activity on Home (screens §5 Home, §8; D240): the newest 3 entries on the phone, 5 on
 * desktop, then "All activity". Rows are the Activity feed's (`EventRow`, compact: who, what,
 * when and where, without the field changes).
 *
 * D240 (the approved Home design) adds:
 * - **All · Added · Moved · Checked** chips, each the feed's `kind` filter (@kept/shared
 *   ACTIVITY_KINDS), so "what did Alfred check yesterday" is one tap. A preview, not a list: the
 *   full list with its filters, search and pages is Activity.
 * - **Photos to review**, moved here from "Needs you": the newest open inbox items with their
 *   photo, everyone's, as the Inbox badge counts them (`counts.inbox`); each opens the Inbox. A
 *   reading to review that isn't an inbox item is a line under them, opening Search's filter.
 * - **An empty feed says what will show there** (day one), instead of leaving the section out.
 *   A feed that failed is still left out: the Activity page says why.
 */
import { ACTIVITY_KIND_IDS, type ActivityKind } from '@kept/shared';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Radio, RadioGroup } from 'react-aria-components';
import { useInbox } from '@/api/capture/queries';
import type { InboxItem } from '@/api/capture/types';
import { useActivity } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { EventRow } from '@/components/history/timeline';
import { BoxIcon, ChevronEndIcon } from '@/components/icons';
import { useKindLabels } from '@/components/inbox/labels';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useMediaQuery, WIDE } from '@/lib/media';
import { cn } from '@/lib/utils';
import { HomeSection, SectionLink } from './section';

/** Screens §8: 3 on the phone, 5 on desktop. */
export const RECENT_PHONE = 3;
export const RECENT_DESKTOP = 5;
/** Photos to review: one row of four. */
export const REVIEW_PHOTOS = 4;

type Chip = 'all' | ActivityKind;

const INBOX_LINK = { to: '/inbox', search: { 'f.mine': 'everyone' } } as const;

function photoOf(item: InboxItem): string | null {
  return (
    item.thing?.photos[0]?.thumbUrl ??
    item.receipt?.pages[0]?.thumbUrl ??
    item.reading?.proofThumbUrl ??
    null
  );
}

function PhotosToReview({ count, readings: n }: { count: number; readings: number }) {
  const f = useFormat();
  const kinds = useKindLabels();
  const inbox = useInbox({ mine: false, limit: REVIEW_PHOTOS }, count > 0);
  const items = (inbox.data?.pages[0]?.items ?? []).slice(0, REVIEW_PHOTOS);
  const caption = (i: InboxItem) =>
    i.thing?.name ?? i.receipt?.vendorSeen ?? i.batch?.placePath.at(-1)?.name ?? kinds[i.kind].pill;
  return (
    <div className="grid gap-2 px-3 pt-2.5 pb-3">
      {count > 0 ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-[13.5px] text-ink">
              <Trans>Photos to review</Trans>{' '}
              <span className="font-medium text-ink-3 tabular-nums">{f.num(count)}</span>
            </span>
            <Link
              {...INBOX_LINK}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 font-semibold text-[13px] text-ink-2 outline-none hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-info"
            >
              <Trans>Inbox</Trans>
              <ChevronEndIcon className="size-4" />
            </Link>
          </div>
          {items.length > 0 ? (
            <ul className="m-0 grid list-none grid-cols-4 gap-2 p-0">
              {items.map((i) => {
                const src = photoOf(i);
                return (
                  <li key={i.id} className="min-w-0">
                    <Link
                      {...INBOX_LINK}
                      className="group grid gap-[5px] text-[12px] leading-[1.35] text-ink-2 outline-none [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-info"
                    >
                      <span className="grid aspect-square place-items-center overflow-hidden rounded-lg border border-line bg-sunken text-ink-3 group-hover:border-ink-3 [&_svg]:size-6">
                        {src ? (
                          <img src={src} alt="" className="size-full object-cover" />
                        ) : (
                          <BoxIcon />
                        )}
                      </span>
                      <bdi>{caption(i)}</bdi>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}
      {n > 0 ? (
        <Link
          to="/search"
          search={{ 'f.state': 'to_review' } as never}
          className="justify-self-start rounded-sm text-[13px] text-info underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-info"
        >
          <Plural value={n} one="# reading needs a look" other="# readings need a look" />
        </Link>
      ) : null}
    </div>
  );
}

export function RecentActivity({
  inbox = 0,
  readings = 0,
  className,
}: {
  /** `/home`'s `counts.inbox`: the open inbox items, everyone's. */
  inbox?: number;
  /** Readings to review that aren't inbox items (`attention.toReview` less `counts.inbox`). */
  readings?: number;
  className?: string;
}) {
  const { t } = useLingui();
  const wide = useMediaQuery(WIDE);
  const [chip, setChip] = useState<Chip>('all');
  const query = useActivity({ limit: RECENT_DESKTOP, ...(chip === 'all' ? {} : { kind: chip }) });
  const locations = useLocations().data ?? [];
  const nameOf = useLocationName();
  const events = (query.data?.pages[0]?.items ?? []).slice(0, wide ? RECENT_DESKTOP : RECENT_PHONE);
  if (query.error && !query.data) return null;
  // Name the location only when there's more than one to tell apart.
  const shared = locations.length > 1;
  const locationName = (id: string | null) => {
    const l = locations.find((x) => x.id === id);
    return shared && l ? nameOf(l) : null;
  };
  const labels: Record<Chip, string> = {
    all: t`All`,
    added: t`Added`,
    moved: t`Moved`,
    checked: t`Checked`,
  };
  const none: Record<Chip, string> = {
    all: t`Nothing yet. What you add, move and check shows here.`,
    added: t`Nothing added yet.`,
    moved: t`Nothing moved yet.`,
    checked: t`Nothing checked yet.`,
  };
  const review = inbox > 0 || readings > 0;
  // Day one: no activity at all, so nothing to filter either.
  const empty = chip === 'all' && query.isSuccess && events.length === 0;
  return (
    <HomeSection
      title={<Trans>Recent activity</Trans>}
      action={empty ? null : <SectionLink to="/activity">{t`All activity`}</SectionLink>}
      className={className}
    >
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {review ? <PhotosToReview count={inbox} readings={readings} /> : null}
        {empty ? null : (
          <RadioGroup
            aria-label={t`Recent activity`}
            orientation="horizontal"
            value={chip}
            onChange={(v) => setChip(v as Chip)}
            className={cn(
              'flex flex-wrap gap-1.5 px-3 pt-3 pb-2.5',
              review && 'border-t border-line',
            )}
          >
            {(['all', ...ACTIVITY_KIND_IDS] as const).map((k) => (
              <Radio
                key={k}
                value={k}
                className="inline-flex min-h-8 cursor-pointer items-center rounded-full border border-line bg-surface px-3 font-medium text-[13px] text-ink-2 leading-none outline-none data-hovered:border-ink-3 data-selected:border-ink data-selected:bg-ink data-selected:text-paper data-focus-visible:outline-2 data-focus-visible:outline-info"
              >
                {labels[k]}
              </Radio>
            ))}
          </RadioGroup>
        )}
        {events.length > 0 ? (
          <ul className="m-0 grid list-none p-0 [&>li]:border-t [&>li]:border-line">
            {events.map((e) => (
              <li key={e.id}>
                <EventRow event={e} linkEntity compact locationName={locationName(e.location_id)} />
              </li>
            ))}
          </ul>
        ) : query.isSuccess ? (
          <p
            className={cn(
              'm-0 px-3.5 py-4 text-[14px] text-ink-2',
              (review || !empty) && 'border-t border-line',
            )}
          >
            {none[chip]}
          </p>
        ) : null}
      </div>
    </HomeSection>
  );
}
