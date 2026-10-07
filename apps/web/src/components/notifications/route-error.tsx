/**
 * The error screen of the notification routes (plan T24, T25), and of step 4's lists (T29). Their component chunks are loaded
 * on demand from assets/household/ (vite.config.ts): out of the precache, cached by the service
 * worker once used. Offline before that first load the chunk can't arrive, and the §3 reason says
 * so: "Needs a connection". Any other error is the usual error state.
 */
import { useLingui } from '@lingui/react/macro';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { ErrorState, Notice, Page } from '@/components/page';

const CHUNK_FAILED =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported/i;

/** Whether the route can't show because its chunk can't be fetched: offline, or the load failed. */
export function needsConnection(error: unknown, online: boolean): boolean {
  return !online || (error instanceof Error && CHUNK_FAILED.test(error.message));
}

/** A route loaded on demand, in its page's frame: `title` names the page. */
export function HouseholdRouteError({
  title,
  error,
  reset,
}: ErrorComponentProps & { title: string }) {
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

export function NotificationsRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <HouseholdRouteError {...props} title={t`Notifications`} />;
}

/** Step 4's lists (Schedules, Lending, Paperwork, Expiring), loaded on demand too. */
export function StepFourRouteError(
  props: ErrorComponentProps & { page: 'schedules' | 'lending' | 'paperwork' | 'expiring' },
) {
  const { t } = useLingui();
  const titles = {
    schedules: t`Schedules`,
    lending: t`Lending`,
    paperwork: t`Paperwork`,
    expiring: t`Expiring`,
  };
  return <HouseholdRouteError {...props} title={titles[props.page]} />;
}
