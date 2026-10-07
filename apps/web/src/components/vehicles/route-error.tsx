/**
 * The error screen of `/vehicles` (step-5 plan T3). Its component chunk loads on demand from
 * assets/household/ (vite.config.ts), out of the precache: the list reads the server and isn't in
 * the phone's snapshot. Offline before its first load the chunk can't arrive, and the §3 reason
 * says so: "Needs a connection". Any other error is the usual error state.
 */
import { useLingui } from '@lingui/react/macro';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { needsConnection } from '@/components/notifications/route-error';
import { ErrorState, Notice, Page } from '@/components/page';

export function VehiclesRouteError({ error, reset }: ErrorComponentProps) {
  const { t } = useLingui();
  const offline = needsConnection(
    error,
    typeof navigator === 'undefined' || navigator.onLine !== false,
  );
  return (
    <Page title={t`Vehicles`}>
      {offline ? (
        <Notice tone="warn" title={t`Needs a connection`} />
      ) : (
        <ErrorState error={error} onRetry={reset} />
      )}
    </Page>
  );
}
