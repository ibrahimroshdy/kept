/**
 * A location on Home (screens §5 Home; D240, the approved Home design): a map preview, the name
 * with its kind, who is there, then what it holds and what is flagged there.
 *
 * - **Stats:** things (live, trash left out), places (Unplaced left out, from `/home/overview`),
 *   and its value where Money is on and shows to you (per currency, never converted, D76). Where
 *   money is hidden from you there is no value at all, not a placeholder.
 * - **Flags:** how many things wait in its Unplaced area ("2 things need a place", which the
 *   location page leads with), then overdue, due, expiring, lent out, uncertain and low stock,
 *   each only when it has a count. The map preview pins one dot per kind of flag.
 * - **Layout:** a compact card with the preview beside the text on a phone; on a wider Home the
 *   preview sits on top and two cards share a row (the `home` container, routes/_app/index.tsx).
 *
 * The cover photo (D195) waits for the contract to carry one.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeOverview } from '@/api/inventory/types';
import type { LocationSummary } from '@/api/types';
import { PeopleCount, ThingCount } from '@/components/counts';
import { BoxIcon, ChevronEndIcon, LockIcon } from '@/components/icons';
import { KindIcon } from '@/components/kind-icon';
import { useMoney } from '@/components/things/values';
import { locationAddress } from '@/lib/address';
import { sep, useFormat } from '@/lib/format';
import { useKindLabels, useLocationName, useRoleLabels } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { LocationMapPreview, type MapPreviewTone } from './map-preview';

export type LocationCounts = { unplacedCount: number };
export type LocationOverview = HomeOverview['locations'][number];

type FlagKey = keyof LocationOverview['flags'];

/** The flags in the order the card lists them, with the colour of their dot and pin. */
export const FLAG_TONES: readonly (readonly [FlagKey, MapPreviewTone])[] = [
  ['overdue', 'danger'],
  ['due', 'amber'],
  ['expiring', 'warn'],
  ['lentOut', 'info'],
  ['uncertain', 'violet'],
  ['lowStock', 'warn'],
];

export const DOT: Record<MapPreviewTone, string> = {
  danger: 'bg-danger',
  amber: 'bg-amber',
  warn: 'bg-warn',
  info: 'bg-info',
  violet: 'bg-violet',
};

function useFlagText(): Record<FlagKey, (count: string) => string> {
  const { t } = useLingui();
  return {
    overdue: (count) => t`${count} overdue`,
    due: (count) => t`${count} due`,
    expiring: (count) => t`${count} expiring`,
    lentOut: (count) => t`${count} lent out`,
    uncertain: (count) => t`${count} uncertain`,
    lowStock: (count) => t`${count} low`,
  };
}

function FlagPill({ tone, children }: { tone: MapPreviewTone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper py-0.5 ps-[7px] pe-[9px] text-[12.5px] leading-[1.45] text-ink-2">
      <span aria-hidden="true" className={cn('size-[7px] shrink-0 rounded-full', DOT[tone])} />
      {children}
    </span>
  );
}

export function LocationCard({
  location,
  counts,
  overview,
}: {
  location: LocationSummary;
  /** From `/home`: the Unplaced count. */
  counts?: LocationCounts;
  /** From `/home/overview`: places, flags and value. */
  overview?: LocationOverview;
}) {
  const kinds = useKindLabels();
  const roles = useRoleLabels();
  const nameOf = useLocationName();
  const f = useFormat();
  const money = useMoney();
  const flagText = useFlagText();
  const personal = location.kind === 'personal';
  const things = location.thingCount;
  const unplaced = counts?.unplacedCount ?? 0;
  const places = overview?.places ?? 0;
  const flags = FLAG_TONES.filter(([k]) => (overview?.flags[k] ?? 0) > 0);
  const value = (overview?.value?.byCurrency ?? [])
    .map((a) => money(a.amount, a.currency))
    .join(f.sep);
  return (
    <Link
      to="/loc/$id"
      params={{ id: locationAddress(location) }}
      className={cn(
        'grid grid-cols-[104px_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface text-start text-ink outline-none hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-info',
        '@min-[600px]/home:grid-cols-[minmax(0,1fr)]',
      )}
    >
      <span
        className={cn(
          'relative grid min-h-[104px] place-items-center border-e border-line bg-paper p-1.5',
          '@min-[600px]/home:h-[124px] @min-[600px]/home:border-e-0 @min-[600px]/home:border-b',
        )}
      >
        {overview ? (
          <span
            aria-hidden="true"
            className="absolute start-1.5 top-1.5 rounded-[4px] border border-line bg-surface px-1 py-[3px] font-mono font-semibold text-[10px] text-ink-3 uppercase leading-none tracking-[0.06em]"
          >
            {places > 0 ? <Trans>Map</Trans> : <Trans>No rooms</Trans>}
          </span>
        ) : null}
        <LocationMapPreview
          kind={location.kind}
          places={places}
          things={things}
          pins={[...new Set(flags.map(([, tone]) => tone))]}
        />
      </span>
      <span className="grid min-w-0 content-start gap-2 px-3 pt-3 pb-[13px]">
        <span className="flex items-center gap-2 font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
          <KindIcon kind={location.kind} className="size-[18px] shrink-0 text-ink-2" />
          <span className="min-w-0">{nameOf(location)}</span>
          {location.require2fa ? <LockIcon className="size-4 shrink-0 text-ink-3" /> : null}
          <ChevronEndIcon className="ms-auto size-[18px] shrink-0 text-ink-3" />
        </span>
        <span className="-mt-1 text-[13px] text-ink-2">
          {personal ? (
            things === 0 ? (
              <Trans>Only you · nothing yet · captures with no location land here</Trans>
            ) : (
              <Trans>Only you</Trans>
            )
          ) : (
            <>
              {kinds[location.kind]}
              {sep()}
              <PeopleCount n={location.memberCount} />
              {location.role !== 'owner' ? (
                <>
                  {sep()}
                  {roles.one[location.role]}
                </>
              ) : null}
            </>
          )}
        </span>
        {personal && things === 0 ? null : (
          <span className="flex flex-wrap gap-x-3.5 gap-y-0.5 text-[13px] text-ink-2 tabular-nums">
            <span>
              <ThingCount n={things} />
            </span>
            {places > 0 ? (
              <span>
                <Plural value={places} one="# place" other="# places" />
              </span>
            ) : null}
            {value ? (
              <span>
                <Trans>
                  <bdi className="font-semibold text-ink">{value}</bdi> value
                </Trans>
              </span>
            ) : null}
          </span>
        )}
        {unplaced > 0 || flags.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {unplaced > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--warn)_40%,var(--line))] bg-[color-mix(in_srgb,var(--warn)_7%,var(--surface))] py-0.5 ps-[7px] pe-[9px] text-[12.5px] text-warn leading-[1.45] [&_svg]:size-3.5">
                <BoxIcon />
                <Plural
                  value={unplaced}
                  one="# thing needs a place"
                  other="# things need a place"
                />
              </span>
            ) : null}
            {flags.map(([k, tone]) => (
              <FlagPill key={k} tone={tone}>
                {flagText[k](f.num(overview?.flags[k] ?? 0))}
              </FlagPill>
            ))}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
