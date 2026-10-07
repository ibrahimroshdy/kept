/**
 * Where something is: the location, then each place and container down to it (screens §5). Every
 * step is a link by id, so a move never breaks it; the current page is the last step, not a
 * link. A place step links to its short address when the location's place tree has it (D208;
 * PathStep carries no short ID); a container step keeps its id, which the thing page replaces.
 * Names are user text, so each is bidi-isolated; the separator mirrors in Arabic.
 */
import { useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { Fragment, useMemo } from 'react';
import type { PathStep } from '@/api/inventory/types';
import { ChevronEndIcon } from '@/components/icons';
import { addressOf } from '@/lib/address';
import { usePlaceTree } from './api';
import { usePlaceName } from './labels';

const link =
  'rounded-sm text-ink-2 underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-info';

export function Breadcrumb({
  location,
  path,
  current,
}: {
  location: { id: string; name: string };
  /** The places and containers above the current page, outermost first. */
  path: PathStep[];
  /** The current page's name; left out when the path ends at it already. */
  current?: string;
}) {
  const { t } = useLingui();
  const placeName = usePlaceName();
  const tree = usePlaceTree(location.id);
  const codes = useMemo(
    () => new Map((tree.data?.places ?? []).map((p) => [p.id, p.shortCode])),
    [tree.data],
  );
  return (
    <nav aria-label={t`Path`}>
      <ol className="m-0 flex list-none flex-wrap items-center gap-x-1 gap-y-0.5 p-0 text-[13px] font-medium leading-snug">
        <li>
          <Link to="/loc/$id" params={{ id: location.id }} className={link}>
            <bdi>{location.name}</bdi>
          </Link>
        </li>
        {path.map((step) => (
          <Fragment key={step.id}>
            <Separator />
            <li>
              {step.kind === 'container' ? (
                <Link to="/t/$id" params={{ id: step.id }} className={link}>
                  <bdi>{placeName(step)}</bdi>
                </Link>
              ) : (
                <Link
                  to="/p/$id"
                  params={{ id: addressOf({ id: step.id, shortCode: codes.get(step.id) }) }}
                  className={link}
                >
                  <bdi>{placeName(step)}</bdi>
                </Link>
              )}
            </li>
          </Fragment>
        ))}
        {current !== undefined ? (
          <>
            <Separator />
            <li aria-current="page" className="font-semibold text-ink">
              <bdi>{current}</bdi>
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}

function Separator() {
  return (
    <li aria-hidden="true" className="flex text-ink-3">
      <ChevronEndIcon className="size-3.5" />
    </li>
  );
}
