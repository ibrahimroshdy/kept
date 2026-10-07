/**
 * The carrying tray's own footer (screens §8: a focused task replaces the tab bar with its own
 * footer; board frame 7b): "Carrying 3" opens the tray, "Choose a place" skips the scan. Shown on
 * the scanner while it is looking for a destination, and as a chip in page headers (the Scan
 * button's slot) whenever something is being carried.
 */
import { plural } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import { Button } from 'react-aria-components';
import { TrayIcon } from './tray-icon';

const dark =
  'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-[10px] px-3.5 font-semibold text-[14px] outline-none data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-[#F2EFE9] [&_svg]:size-5';

export function TrayFooter({
  count,
  onOpenTray,
  onChoosePlace,
}: {
  count: number;
  onOpenTray: () => void;
  onChoosePlace: () => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      <Button onPress={onOpenTray} className={`${dark} border border-[#4A463F]`}>
        <TrayIcon />
        {plural(count, { one: 'Carrying #', other: 'Carrying #' })}
      </Button>
      <Button onPress={onChoosePlace} className={`${dark} bg-amber text-amber-ink`}>
        <Trans>Choose a place</Trans>
      </Button>
    </div>
  );
}

/** "Carrying 3" in a page header: back to the tray from anywhere. */
export function TrayChip({ count }: { count: number }) {
  return (
    <Link
      to="/scan"
      search={{ tray: 1 }}
      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 font-semibold text-[13px] text-ink outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-[18px]"
    >
      <TrayIcon />
      <span dir="auto">{plural(count, { one: 'Carrying #', other: 'Carrying #' })}</span>
    </Link>
  );
}
