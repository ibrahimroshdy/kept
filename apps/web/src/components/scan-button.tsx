/**
 * Scan in the page header, on Home and Search only (screens §1: "Scan (on Home and Search)"). It
 * opens the scanner (plan T26). The page header (components/page.tsx) places it before the
 * page's own actions, so every screen gets it from the route, not by passing it in.
 *
 * The same slot carries "Carrying 3" on every page while the carrying tray holds something
 * (D175), so the tray is one tap away wherever the person walks with it. Only the tray's light
 * state module is imported here: the header is on every page.
 */
import { useLingui } from '@lingui/react/macro';
import { Link, useRouterState } from '@tanstack/react-router';
import { QrIcon } from '@/components/icons';
import { useScanStore } from '@/components/scan/use-scan-store';
import { TrayChip } from '@/components/tray/tray-footer';
import { useTray } from '@/components/tray/use-tray';

/** The paths whose header carries Scan. */
const SCAN_PATHS: ReadonlySet<string> = new Set(['/', '/search']);

export function ScanButton() {
  const { t } = useLingui();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const store = useScanStore();
  const carried = useTray(store).ids?.length ?? 0;
  return (
    <>
      {carried > 0 ? <TrayChip count={carried} /> : null}
      {SCAN_PATHS.has(pathname) ? (
        <Link
          to="/scan"
          aria-label={t`Scan`}
          className="grid size-11 shrink-0 place-items-center rounded-[10px] text-ink-2 outline-none hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-[22px]"
        >
          <QrIcon />
        </Link>
      ) : null}
    </>
  );
}
