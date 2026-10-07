/**
 * The error screens of step 7's server-only routes (plan T3): Export and Consumables. Their
 * component chunks load on demand from assets/household/ (vite.config.ts), out of the precache;
 * offline before the first load the chunk can't arrive, and the §3 reason says so: "Needs a
 * connection". Any other error is the usual error state.
 */
import { useLingui } from '@lingui/react/macro';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { needsConnection } from '@/components/notifications/route-error';
import { ErrorState, Notice, Page } from '@/components/page';

function RouteError({ title, error, reset }: ErrorComponentProps & { title: string }) {
  const { t } = useLingui();
  const offline = needsConnection(
    error,
    typeof navigator === 'undefined' || navigator.onLine !== false,
  );
  return (
    <Page title={title}>
      {offline ? (
        <Notice tone="warn" title={t`Needs a connection`} />
      ) : (
        <ErrorState error={error} onRetry={reset} />
      )}
    </Page>
  );
}

export function ExportRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <RouteError {...props} title={t`Export`} />;
}

export function ConsumablesRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <RouteError {...props} title={t`Consumables`} />;
}
