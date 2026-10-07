/**
 * A location's place tree: the flattening the move picker searches, and the "All places" outline
 * on the Location page, a way to jump to any depth in one tap (screens §1's locations tree).
 */
import { Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { PlaceNode } from '@/api/inventory/types';
import { ChevronDownIcon } from '@/components/icons';
import { TypeIcon } from '@/components/type-icon';
import { addressOf } from '@/lib/address';
import { childrenOf } from './api';
import { placeIcon, usePlaceName } from './labels';

export type TreeRow = { place: PlaceNode; depth: number };

/**
 * Depth-first, in the server's order, with the Unplaced area first. `exclude` drops a place and
 * its whole subtree (a place can't move into itself).
 */
export function flattenTree(
  places: PlaceNode[],
  { exclude, includeUnplaced = true }: { exclude?: Set<string>; includeUnplaced?: boolean } = {},
): TreeRow[] {
  const kids = childrenOf(places);
  const ids = new Set(places.map((p) => p.id));
  const out: TreeRow[] = [];
  const walk = (pl: PlaceNode, depth: number) => {
    if (exclude?.has(pl.id)) return;
    if (pl.isUnplaced && !includeUnplaced) return;
    out.push({ place: pl, depth });
    for (const c of kids.get(pl.id) ?? []) walk(c, depth + 1);
  };
  // Roots: no parent, or a parent the list doesn't have.
  const roots = places
    .filter((p) => p.parentId === null || !ids.has(p.parentId))
    .sort(
      (a, b) =>
        Number(b.isUnplaced) - Number(a.isUnplaced) ||
        a.sort - b.sort ||
        a.name.localeCompare(b.name),
    );
  for (const r of roots) walk(r, 0);
  return out;
}

/** The indent for a tree row, in logical padding so it mirrors in Arabic. */
export const indentStyle = (depth: number) => ({
  paddingInlineStart: `${0.875 + depth * 1.25}rem`,
});

export function PlaceTree({ places, currentId }: { places: PlaceNode[]; currentId?: string }) {
  const nameOf = usePlaceName();
  const rows = flattenTree(places);
  if (rows.length <= 1) return null;
  return (
    <details className="group rounded-[10px] border border-line bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3.5 text-[14px] font-semibold text-ink outline-none focus-visible:outline-2 focus-visible:outline-info [&::-webkit-details-marker]:hidden">
        <ChevronDownIcon className="size-4 -rotate-90 text-ink-3 transition-transform group-open:rotate-0 rtl:rotate-90 rtl:group-open:rotate-0" />
        <Trans>All places</Trans>
      </summary>
      <ul className="m-0 grid list-none border-t border-line p-0 py-1">
        {rows.map(({ place, depth }) => (
          <li key={place.id}>
            <Link
              to="/p/$id"
              params={{ id: addressOf(place) }}
              aria-current={place.id === currentId ? 'page' : undefined}
              style={indentStyle(depth)}
              className="flex min-h-10 items-center gap-2 pe-3.5 text-[14px] text-ink-2 outline-none hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info aria-[current=page]:font-semibold aria-[current=page]:text-ink"
            >
              <TypeIcon icon={placeIcon(place)} className="size-4 text-ink-3" />
              <bdi className="[overflow-wrap:anywhere]">{nameOf(place)}</bdi>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
