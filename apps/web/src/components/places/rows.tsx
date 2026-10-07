/**
 * The two rows of a browse list (screens §5, frames 02 · 1–2): a place ("Tool wall · 9 things ·
 * 2 places", with a chevron) and a thing (icon or photo, name, the ID chip, "× 3", its derived
 * states, and where it is when the list spans depths). Both are links by id. Names are user text
 * and bidi-isolated; nothing is cut off with an ellipsis (phones never trim).
 */
import { Plural, Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { PathStep, PlaceNode, ThingRow } from '@/api/inventory/types';
import { ChevronEndIcon } from '@/components/icons';
import { IdChip } from '@/components/id-chip';
import { StatusPill } from '@/components/status-pill';
import { TypeIcon } from '@/components/type-icon';
import { addressOf } from '@/lib/address';
import { sep, useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { placeIcon, usePlaceName } from './labels';

export const rowLink =
  'flex min-h-[60px] min-w-0 flex-1 items-center gap-3 px-3.5 py-2 text-ink outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info';

export function Tile({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-sunken text-ink-3 [&_svg]:size-5',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** "9 things · 2 places", in the reader's digits (D143, through Lingui's `#`). */
export function PlaceCounts({ place }: { place: Pick<PlaceNode, 'thingCount' | 'childCount'> }) {
  const things = place.thingCount;
  const places = place.childCount;
  if (things === 0 && places === 0) return <Trans>Empty</Trans>;
  return (
    <>
      {things > 0 ? <Plural value={things} one="# thing" other="# things" /> : null}
      {things > 0 && places > 0 ? sep() : null}
      {places > 0 ? <Plural value={places} one="# place" other="# places" /> : null}
    </>
  );
}

export function PlaceRowView({ place, trailing }: { place: PlaceNode; trailing?: ReactNode }) {
  const nameOf = usePlaceName();
  return (
    <div className="flex items-center">
      <Link to="/p/$id" params={{ id: addressOf(place) }} className={rowLink}>
        <Tile>
          <TypeIcon icon={placeIcon(place)} />
        </Tile>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
            <bdi>{nameOf(place)}</bdi>
          </span>
          <span className="text-small text-ink-2">
            <PlaceCounts place={place} />
          </span>
        </span>
        <ChevronEndIcon className="size-5 shrink-0 text-ink-3" />
      </Link>
      {trailing}
    </div>
  );
}

/** "Office › Desk drawer › Cable box". */
export function PathText({ path }: { path: PathStep[] }) {
  const placeName = usePlaceName();
  return (
    <span className="text-small text-ink-2 [overflow-wrap:anywhere]">
      {path.map((s, i) => (
        <span key={s.id}>
          {i > 0 ? <span aria-hidden="true"> › </span> : null}
          <bdi>{placeName(s)}</bdi>
        </span>
      ))}
    </span>
  );
}

export function ThingRowView({
  thing,
  showPath = false,
  leading,
}: {
  thing: ThingRow;
  /** The list spans depths (a location's things): say where each one is. */
  showPath?: boolean;
  /** A selection checkbox, before the link. */
  leading?: ReactNode;
}) {
  const f = useFormat();
  return (
    <div className="flex items-center">
      {leading}
      <Link to="/t/$id" params={{ id: addressOf(thing) }} className={rowLink}>
        <Tile>
          {thing.thumbUrl ? (
            <img src={thing.thumbUrl} alt="" className="size-full object-cover" />
          ) : (
            <TypeIcon icon={thing.type?.icon} />
          )}
        </Tile>
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="font-semibold text-[15px] leading-snug [overflow-wrap:anywhere]">
            {thing.name ? <bdi>{thing.name}</bdi> : <Trans>Untitled draft</Trans>}
            {thing.quantity > 1 ? (
              <span className="ms-1.5 font-normal text-ink-2 text-small">
                <span aria-hidden="true">× </span>
                <span className="sr-only">
                  <Trans>quantity</Trans>{' '}
                </span>
                {f.num(thing.quantity)}
              </span>
            ) : null}
          </span>
          {thing.shortCode || thing.derivedState.length || showPath ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <IdChip code={thing.shortCode} />
              {thing.derivedState.map((s) => (
                <StatusPill key={s} state={s} />
              ))}
              {showPath && thing.path.length ? <PathText path={thing.path} /> : null}
            </span>
          ) : null}
        </span>
      </Link>
    </div>
  );
}

/** A container's thumbnail grid (D195): photos first, the type icon where there is none. */
export function PhotoTile({ thing }: { thing: ThingRow }) {
  return (
    <Link
      to="/t/$id"
      params={{ id: addressOf(thing) }}
      className="grid content-start gap-1.5 rounded-[10px] p-1 text-ink outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-info"
    >
      <span
        aria-hidden="true"
        className="grid aspect-square w-full place-items-center overflow-hidden rounded-lg bg-sunken text-ink-3 [&_svg]:size-8"
      >
        {thing.thumbUrl ? (
          <img src={thing.thumbUrl} alt="" className="size-full object-cover" />
        ) : (
          <TypeIcon icon={thing.type?.icon} />
        )}
      </span>
      <span className="text-small font-medium leading-snug [overflow-wrap:anywhere]">
        {thing.name ? <bdi>{thing.name}</bdi> : <Trans>Untitled draft</Trans>}
      </span>
      {thing.shortCode ? <IdChip code={thing.shortCode} /> : null}
    </Link>
  );
}
