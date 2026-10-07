/**
 * Recent activity on Home (screens §5 Home, §8): the newest 3 entries on the phone, 5 on
 * desktop, then "All activity". Rows are the Activity feed's (`EventRow`, compact: who, what,
 * when and where, without the field changes). Nothing yet, or the feed failed: no section; the
 * Activity page says why.
 */
import { Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { useActivity } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import { EventRow } from '@/components/history/timeline';
import { Section } from '@/components/page';
import { useLocationName } from '@/lib/labels';
import { useMediaQuery, WIDE } from '@/lib/media';
import { cn } from '@/lib/utils';

/** Screens §8: 3 on the phone, 5 on desktop. */
export const RECENT_PHONE = 3;
export const RECENT_DESKTOP = 5;

export function RecentActivity({ className }: { className?: string }) {
  const wide = useMediaQuery(WIDE);
  const query = useActivity({ limit: RECENT_DESKTOP });
  const locations = useLocations().data ?? [];
  const nameOf = useLocationName();
  const events = (query.data?.pages[0]?.items ?? []).slice(0, wide ? RECENT_DESKTOP : RECENT_PHONE);
  if (events.length === 0) return null;
  // Name the location only when there's more than one to tell apart.
  const shared = locations.length > 1;
  const locationName = (id: string | null) => {
    const l = locations.find((x) => x.id === id);
    return shared && l ? nameOf(l) : null;
  };
  return (
    <Section
      title={<Trans>Recent activity</Trans>}
      action={
        <Link
          to="/activity"
          className="inline-flex min-h-11 items-center text-[13px] font-semibold text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info"
        >
          <Trans>All activity</Trans>
        </Link>
      }
      className={className}
    >
      <ul
        className={cn(
          'm-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0',
          '[&>li+li]:border-t [&>li+li]:border-line',
        )}
      >
        {events.map((e) => (
          <li key={e.id}>
            <EventRow event={e} linkEntity compact locationName={locationName(e.location_id)} />
          </li>
        ))}
      </ul>
    </Section>
  );
}
