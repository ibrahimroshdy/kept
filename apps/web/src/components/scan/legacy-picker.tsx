/**
 * An old Homebox label whose asset ID is on more than one thing (D146, screens §8): Homebox numbers
 * assets per collection, and each collection became a Kept location, so `000-014` can be in two.
 * The person picks the one in their hands; each choice names its location.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from 'react-aria-components';
import { BoxIcon, ChevronEndIcon } from '@/components/icons';
import type { LegacyCandidate, ScanTarget } from './resolve';

export function LegacyPicker({
  legacy,
  candidates,
  onOpen,
}: {
  legacy: string;
  candidates: readonly LegacyCandidate[];
  /** Opens the one chosen. The server candidates carry no location id; the page finds it. */
  onOpen: (target: ScanTarget) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="grid gap-2.5">
      <h2 className="m-0 font-semibold text-[19px]">
        <Trans>Which one is it?</Trans>
      </h2>
      <p className="m-0 text-ink-2">
        <Trans>
          <bdi dir="ltr" className="font-mono">
            Asset {legacy}
          </bdi>{' '}
          is on more than one thing you brought from Homebox. Pick the one in your hands.
        </Trans>
      </p>
      <ul aria-label={t`Things with this label`} className="m-0 grid list-none gap-1.5 p-0">
        {candidates.map((c) => (
          <li key={`${c.kind}:${c.id}`}>
            <Button
              onPress={() => onOpen({ kind: c.kind, id: c.id, locationId: c.locationId ?? '' })}
              className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2 text-start outline-none data-focus-visible:outline-2 data-focus-visible:outline-info data-hovered:bg-sunken [&_svg]:size-5"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2">
                <BoxIcon />
              </span>
              <span className="grid min-w-0 flex-1">
                <bdi className="font-semibold [overflow-wrap:anywhere]">{c.name}</bdi>
                <bdi className="text-small text-ink-3 [overflow-wrap:anywhere]">
                  {c.locationName}
                </bdi>
              </span>
              <ChevronEndIcon className="shrink-0 text-ink-3" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
