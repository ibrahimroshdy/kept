/**
 * Capture (screens §5; plan T25). The session itself is components/capture/capture-screen.tsx;
 * this route gives it the signed-in person's offline store and sync engine (T24), and the ways
 * in:
 *
 * - `?into=<thing id>`: capture into that box ("Capture into Box 3" from a scan);
 * - `?place=<place id>`: "Capture here" from a place;
 * - `?label=<thing id>`: LABEL mode on that thing (step 5: "read its registration card" from a
 *   vehicle's Documents tab); `captureLabelSearch()` in components/capture/links.ts builds it;
 * - `?shared=<id>` / `?share=<problem>`: a share into Kept (D140, plan T23, Q26), shown as the
 *   "Shared into Kept" sheet, whose Keep runs through the capture queue.
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useMe } from '@/api/queries';
import { appDetect } from '@/camera/scanner';
import { CaptureScreen, type OpenTarget } from '@/components/capture/capture-screen';
import { ShareArrival, type ShareProblem } from '@/components/capture/share-arrival';
import { describeUserAgent } from '@/lib/user-agent';
import { offlineSupported } from '@/offline/open';
import { useOffline } from '@/offline/provider';
import { pageStore } from '@/pwa/page-store';

type CaptureSearch = {
  shared?: string;
  share?: ShareProblem;
  into?: string;
  place?: string;
  label?: string;
};

const PROBLEMS: readonly ShareProblem[] = ['unavailable', 'failed', 'empty'];
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

export const Route = createFileRoute('/_app/capture')({
  validateSearch: (s: Record<string, unknown>): CaptureSearch => {
    const shared = str(s.shared);
    const into = str(s.into);
    const place = str(s.place);
    const label = str(s.label);
    return {
      ...(shared ? { shared } : {}),
      ...(PROBLEMS.includes(s.share as ShareProblem) ? { share: s.share as ShareProblem } : {}),
      ...(into ? { into } : {}),
      ...(place ? { place } : {}),
      ...(label ? { label } : {}),
    };
  },
  component: CapturePage,
});

function CapturePage() {
  const { t } = useLingui();
  const { shared, share, into, place, label } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const me = useMe();
  const offline = useOffline();
  // The person's own store; memory only where this browser has no IndexedDB.
  const store = offline?.store ?? (offlineSupported() ? null : pageStore());
  const iphone = useMemo(() => {
    const os = describeUserAgent(typeof navigator === 'undefined' ? null : navigator.userAgent).os;
    return os === 'iPhone' || os === 'iPad';
  }, []);

  const exit = useCallback(() => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: '/' });
  }, [router, navigate]);
  const open = useCallback(
    (to: OpenTarget) => {
      if (to.kind === 'code') void navigate({ to: '/l/$code', params: { code: to.code } });
      else if (to.kind === 'place') void navigate({ to: '/p/$id', params: { id: to.id } });
      else void navigate({ to: '/t/$id', params: { id: to.id } });
    },
    [navigate],
  );
  const engine = offline?.engine;
  const subscribe = useMemo(
    () => (engine ? (fn: () => void) => engine.subscribe(() => fn()) : undefined),
    [engine],
  );

  if (!store || !me.data)
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t`Opening the camera`}
        className="fixed inset-0 z-40 bg-[#0F0E0D] md:relative md:inset-auto md:z-auto md:mx-auto md:my-4 md:min-h-[calc(100dvh-2rem)] md:max-w-[480px] md:rounded-2xl"
      />
    );
  return (
    <CaptureScreen
      store={store}
      personalLocationId={me.data.personalLocationId}
      {...(into ? { into } : {})}
      {...(place ? { placeId: place } : {})}
      {...(label ? { labelFor: label } : {})}
      onExit={exit}
      onOpen={open}
      // One decoder for capture and Scan (T26): native where it reads QR, else the lazy wasm.
      detect={appDetect()}
      {...(engine ? { onQueued: () => engine.kick() } : {})}
      {...(subscribe ? { subscribe } : {})}
      iphone={iphone}
      renderShare={
        shared || share
          ? (onKeep) => (
              <div className="px-3 pt-2">
                <ShareArrival
                  store={store}
                  sharedId={shared}
                  problem={share}
                  onKeep={onKeep}
                  onDone={() =>
                    void navigate({
                      to: '/capture',
                      search: {
                        ...(into ? { into } : {}),
                        ...(place ? { place } : {}),
                        ...(label ? { label } : {}),
                      },
                      replace: true,
                    })
                  }
                />
              </div>
            )
          : undefined
      }
    />
  );
}
