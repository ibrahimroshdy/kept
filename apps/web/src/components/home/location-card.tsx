/**
 * A location on Home (screens §5 Home item 4): name, kind icon, thing count and members, and how
 * many things wait in its Unplaced area ("12 things need a place", §5), which the location page
 * leads with (Sort them). The thing count is the location's own (live, trash left out); the
 * Unplaced count comes from `/home` once it has answered. The cover photo (D195) waits for the
 * contract to carry one.
 */
import { Plural, Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { LocationSummary } from '@/api/types';
import { PeopleCount, ThingCount } from '@/components/counts';
import { BoxIcon, ChevronEndIcon, LockIcon } from '@/components/icons';
import { KindIcon } from '@/components/kind-icon';
import { IconTile, Pill } from '@/components/page';
import { sep } from '@/lib/format';
import { useKindLabels, useLocationName } from '@/lib/labels';

export type LocationCounts = { unplacedCount: number };

export function LocationCard({
  location,
  counts,
}: {
  location: LocationSummary;
  counts?: LocationCounts;
}) {
  const kinds = useKindLabels();
  const nameOf = useLocationName();
  const personal = location.kind === 'personal';
  const things = location.thingCount;
  const unplaced = counts?.unplacedCount ?? 0;
  return (
    <Link
      to="/loc/$id"
      params={{ id: location.id }}
      className="flex items-center gap-3 rounded-[10px] border border-line bg-surface p-3.5 text-ink outline-none hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-info"
    >
      <IconTile>
        <KindIcon kind={location.kind} />
      </IconTile>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
          {nameOf(location)}
        </div>
        <div className="text-small text-ink-2">
          {personal ? (
            things === 0 ? (
              <Trans>Only you · nothing yet · captures with no location land here</Trans>
            ) : (
              <>
                <Trans>Only you</Trans>
                {sep()}
                <ThingCount n={things} />
              </>
            )
          ) : (
            <>
              {kinds[location.kind]}
              {sep()}
              <ThingCount n={things} />
              {sep()}
              <PeopleCount n={location.memberCount} />
            </>
          )}
        </div>
        {unplaced > 0 ? (
          <Pill tone="warn" icon={<BoxIcon />}>
            <Plural value={unplaced} one="# thing needs a place" other="# things need a place" />
          </Pill>
        ) : null}
      </div>
      {location.require2fa ? <LockIcon className="size-4 shrink-0 text-ink-3" /> : null}
      <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
    </Link>
  );
}
