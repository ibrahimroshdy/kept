/**
 * The error screen of T26's routes (incidents, reports, exchange rates). Their component chunks
 * load on demand from assets/household/ (vite.config.ts), so offline before the first load the
 * page says the §3 reason, "Needs a connection", as the notification routes do; any other error
 * is the usual error state.
 */
import { useLingui } from '@lingui/react/macro';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { needsConnection } from '@/components/notifications/route-error';
import { ErrorState, Notice, Page } from '@/components/page';

function Body({ error, reset }: ErrorComponentProps) {
  const { t } = useLingui();
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  return needsConnection(error, online) ? (
    <Notice tone="warn" title={t`Needs a connection`} />
  ) : (
    <ErrorState error={error} onRetry={reset} />
  );
}

export function IncidentsRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return (
    <Page title={t`Incidents`}>
      <Body {...props} />
    </Page>
  );
}

export function ReportRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return (
    <Page title={t`Report`}>
      <Body {...props} />
    </Page>
  );
}

/** Inside the Account frame, which has its own page. */
export const TabRouteError = Body;
