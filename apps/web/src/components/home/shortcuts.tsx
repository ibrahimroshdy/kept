/**
 * Home's shortcuts (D240, the approved Home design): Capture, Scan a label, Log a reading and Add
 * a thing together. Log a reading shows only when something has a meter you can log on (screens
 * §6 Quick log, T19), so a first day has three.
 *
 * A phone shows them as one row of tiles, icon over the words; a wide Home's side column shows
 * them two by two, icon beside the words, with Capture across the row when there are three.
 */
import { can } from '@kept/shared';
import { Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type { LocationSummary } from '@/api/types';
import { CameraIcon, PlusIcon, QrIcon } from '@/components/icons';
import { CreateThingSheet } from '@/components/things/create-sheet';
import { useOnline } from '@/lib/online';
import { cn } from '@/lib/utils';
import { GaugeIcon, QuickLog, useQuickLogTargets } from './quick-log';
import { HomeSection } from './section';

const TILE =
  'flex min-h-[78px] min-w-0 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border px-1 py-2.5 text-center font-semibold text-[13px] leading-[1.25] [overflow-wrap:anywhere] outline-none [&_svg]:size-[22px] [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-info data-focus-visible:outline-2 data-focus-visible:outline-info ' +
  '@min-[860px]/home:min-h-[52px] @min-[860px]/home:flex-row @min-[860px]/home:justify-start @min-[860px]/home:gap-2.5 @min-[860px]/home:px-3 @min-[860px]/home:py-2 @min-[860px]/home:text-start @min-[860px]/home:[&_svg]:size-5';
const PLAIN = 'border-line bg-surface text-ink hover:border-ink-3 data-hovered:border-ink-3';
const PRIMARY = 'border-amber bg-amber text-amber-ink';

/** Where "Add a thing" starts: a shared location you can add to, else your Personal one (D114). */
export function addTargetOf(locations: readonly LocationSummary[]): string | undefined {
  return (
    locations.find((l) => l.kind !== 'personal' && can(l.role, 'things.edit'))?.id ??
    locations.find((l) => l.kind === 'personal')?.id
  );
}

export function Shortcuts({
  locations,
  meteredThings,
  className,
}: {
  locations: readonly LocationSummary[];
  /** `/home`'s count of metered things you can log on (T13). */
  meteredThings: number | undefined;
  className?: string;
}) {
  const [adding, setAdding] = useState(false);
  const addTo = addTargetOf(locations);
  // The same rule as QuickLog's: online, Home's count; offline, the phone's snapshot.
  const online = useOnline();
  const offline = useQuickLogTargets(!online && meteredThings === undefined);
  const reading = online
    ? (meteredThings ?? 0) > 0
    : (meteredThings ?? 0) > 0 || (offline.data?.length ?? 0) > 0;
  const three = !reading;
  const tile = (icon: ReactNode, label: ReactNode) => (
    <>
      {icon}
      <span>{label}</span>
    </>
  );
  return (
    <HomeSection title={<Trans>Shortcuts</Trans>} className={className}>
      <div
        className={cn(
          'grid gap-2 @min-[860px]/home:grid-cols-2',
          three ? 'grid-cols-3' : 'grid-cols-4',
        )}
      >
        <Link to="/capture" className={cn(TILE, PRIMARY, three && '@min-[860px]/home:col-span-2')}>
          {tile(<CameraIcon />, <Trans>Capture</Trans>)}
        </Link>
        <Link to="/scan" className={cn(TILE, PLAIN)}>
          {tile(<QrIcon />, <Trans>Scan a label</Trans>)}
        </Link>
        <QuickLog
          meteredThings={meteredThings}
          trigger={(open) => (
            <AriaButton onPress={open} className={cn(TILE, PLAIN)}>
              {tile(
                <GaugeIcon className="fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.8]" />,
                <Trans>Log a reading</Trans>,
              )}
            </AriaButton>
          )}
        />
        {addTo ? (
          <AriaButton onPress={() => setAdding(true)} className={cn(TILE, PLAIN)}>
            {tile(<PlusIcon />, <Trans>Add a thing</Trans>)}
          </AriaButton>
        ) : null}
      </div>
      {adding && addTo ? (
        <CreateThingSheet isOpen locationId={addTo} onClose={() => setAdding(false)} />
      ) : null}
    </HomeSection>
  );
}
