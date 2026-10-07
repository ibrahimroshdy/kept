/**
 * The error screens of the settings, admin and history routes that load on demand (vite.config.ts,
 * assets/household/): Instance admin, Account, AI, Personal AI key, Import, Locations and a
 * location's settings, two-factor, Activity and Trash. They all need the server (screens §4:
 * "settings, admin", "imports"), so their chunks stay out of the precache and are cached by the
 * service worker once used. Offline before that first load the chunk can't arrive, and the §3
 * reason says so: "Needs a connection". Any other error is the usual error state.
 *
 * A layout's error screen also catches its children's (TanStack renders no boundary for a route
 * without an errorComponent), so /admin covers every admin tab, /settings/account every account
 * tab and /settings/ai its usage page.
 */
import { useLingui } from '@lingui/react/macro';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { needsConnection } from '@/components/notifications/route-error';
import { ErrorState, Notice, Page } from '@/components/page';

function OnDemandError({ title, error, reset }: ErrorComponentProps & { title: string }) {
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

export function AdminRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <OnDemandError {...props} title={t`Instance admin`} />;
}

export function AccountRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <OnDemandError {...props} title={t`Account`} />;
}

export function AiRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <OnDemandError {...props} title={t`AI`} />;
}

export function PersonalAiRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <OnDemandError {...props} title={t`Personal AI key`} />;
}

export function ImportRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <OnDemandError {...props} title={t`Import`} />;
}

/** Settings → Locations and a location's settings pages (whose title is the location's name). */
export function SettingsRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <OnDemandError {...props} title={t`Settings`} />;
}

export function TwoFactorRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <OnDemandError {...props} title={t`Turn on two-factor`} />;
}

export function ActivityRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <OnDemandError {...props} title={t`Activity`} />;
}

export function TrashRouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <OnDemandError {...props} title={t`Trash`} />;
}
