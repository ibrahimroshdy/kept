/**
 * The signed-in frame and its gate (lib/signed-in-gate.ts: set up yet? signed in? second factor
 * proven?). A session that ends later (a 401 on some later request) sends the person to sign in
 * from the component. Offline, the frame draws from what it has, the phone's last-known copy on a
 * cold start (offline/shell.ts).
 */
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { isApiError } from '@/api/client';
import { useNotificationCount } from '@/api/household/queries';
import { useHome } from '@/api/inventory/queries';
import { useLocations, useMe, useSetupStatus } from '@/api/queries';
import { MainShell, sidebarWidth, useHasInbox } from '@/components/app-shell';
import { AppLockGate } from '@/components/device/app-lock';
import { ErrorState, Skeleton } from '@/components/page';
import { signedInGate } from '@/lib/signed-in-gate';
import { cn } from '@/lib/utils';
import { InsecureBanner } from '@/pwa/insecure-banner';
import { PwaStoreBridge } from '@/pwa/store-bridge';

export const Route = createFileRoute('/_app')({
  beforeLoad: signedInGate,
  pendingComponent: ShellSkeleton,
  pendingMs: 150,
  component: SignedInFrame,
});

function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh bg-paper" role="status" aria-busy="true">
      <div className={cn('hidden border-e border-line bg-surface md:block', sidebarWidth)} />
      <div className="grid flex-1 content-start gap-3 p-4 md:p-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    </div>
  );
}

function SignedInFrame() {
  const setup = useSetupStatus();
  const me = useMe();
  const locations = useLocations();
  const navigate = useNavigate();
  const code = isApiError(me.error) ? me.error.code : null;
  // The Inbox badge (D198, T22): the open items of every location you can write to, from Home's
  // counts. Nobody signed in yet, or a viewer everywhere: no count.
  const inboxOn = useHasInbox();
  const home = useHome(!!me.data && !!setup.data && inboxOn);
  const inbox = home.data?.counts?.inbox ?? 0;
  // The notifications' unread count (D198, T24): the same polled query as the header's bell.
  const notifications = useNotificationCount(!!me.data && !!setup.data).data?.unread ?? 0;
  const counts = {
    ...(inbox > 0 ? { inbox } : {}),
    ...(notifications > 0 ? { notifications } : {}),
  };

  // The session ended while the app was open.
  useEffect(() => {
    if (code === 'unauthenticated') void navigate({ to: '/signin', replace: true });
    if (code === 'mfa_required') void navigate({ to: '/signin/two-factor', replace: true });
  }, [code, navigate]);

  if (code === 'unauthenticated' || code === 'mfa_required') return <ShellSkeleton />;
  // A refetch that failed keeps what the frame already has (a cold start offline starts from
  // the phone's last-known copy, lib/signed-in-gate.ts): only nothing at all is an error.
  if ((!me.data && me.error) || (!setup.data && setup.error)) {
    return (
      <div className="mx-auto grid max-w-lg p-6">
        <ErrorState
          error={me.error ?? setup.error}
          onRetry={() => {
            void setup.refetch();
            void me.refetch();
          }}
        />
      </div>
    );
  }
  if (!me.data || !setup.data) return <ShellSkeleton />;
  // The app lock (step 8, D181): when on, nothing below shows until the PIN or the passkey.
  return (
    <AppLockGate userId={me.data.user.id}>
      <MainShell locations={locations.data ?? []} counts={counts}>
        <InsecureBanner />
        <PwaStoreBridge />
        <Outlet />
      </MainShell>
    </AppLockGate>
  );
}
