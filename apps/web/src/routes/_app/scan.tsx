/**
 * Scan (plan T26; D137, D175; screens §5, §6): the scanner with its six outcomes, "Type the code",
 * and the carrying tray (`?tray=1`, "Scan destination"). The screen is
 * components/scan/scan-screen.tsx; this route gives it the person's offline store and navigates
 * to what a scan opens. A box opened by its label leads with its photo grid (D195).
 *
 * `validateSearch` stays in the entry chunk (D80), so it is written out by hand.
 */
import { useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';
import { openSearch, type ScanTarget } from '@/components/scan/resolve';
import { ScanScreen } from '@/components/scan/scan-screen';
import { useKick, useScanStore } from '@/components/scan/use-scan-store';

export const Route = createFileRoute('/_app/scan')({
  validateSearch: (s: Record<string, unknown>): { tray?: 1 } =>
    s.tray === 1 || s.tray === '1' ? { tray: 1 } : {},
  component: ScanPage,
});

function ScanPage() {
  const { t } = useLingui();
  const { tray } = Route.useSearch();
  const store = useScanStore();
  const kick = useKick();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const router = useRouter();
  const exit = useCallback(() => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: '/' });
  }, [router, navigate]);
  const open = useCallback(
    (target: ScanTarget) => {
      // Returned, so the scan screen can close up when the navigation commits rather than
      // before it starts (scan-screen.tsx: a sheet's history entry must not pop mid-resolve).
      if (target.kind === 'place') return navigate({ to: '/p/$id', params: { id: target.id } });
      return openSearch(target, store, qc).then((search) =>
        navigate({ to: '/t/$id', params: { id: target.id }, search }),
      );
    },
    [navigate, store, qc],
  );
  if (!store)
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t`Opening the camera`}
        className="fixed inset-0 z-40 bg-[#0F0E0D] md:relative md:inset-auto md:z-auto md:mx-auto md:my-4 md:min-h-[calc(100dvh-2rem)] md:max-w-[480px] md:rounded-2xl"
      />
    );
  return (
    <ScanScreen
      key={tray ? 'tray' : 'scan'}
      store={store}
      tray={tray === 1}
      onExit={exit}
      onOpen={open}
      onQueued={kick}
    />
  );
}
