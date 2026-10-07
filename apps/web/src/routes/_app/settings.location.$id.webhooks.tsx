/**
 * Location settings → Webhooks (step-6 plan T23; D63, D110, D180, engineering spec §2.6): signed,
 * value-free notices to another server when things change here, with their deliveries and a test
 * ping. Owners and admins only (the tab is hidden for others; the frame says so if they come by
 * link). Its chunk loads on demand from assets/household/ (vite.config.ts); its error screen stays
 * precached, so offline it says "Needs a connection".
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute, type ErrorComponentProps } from '@tanstack/react-router';
import { LocationSettingsPage } from '@/components/location-settings';
import { HouseholdRouteError } from '@/components/notifications/route-error';
import { WEBHOOK_FILTERS, WebhooksList } from '@/components/webhooks/list';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/settings/location/$id/webhooks')({
  validateSearch: listSearch(WEBHOOK_FILTERS),
  component: WebhooksPage,
  errorComponent: RouteError,
});

function WebhooksPage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  return (
    <LocationSettingsPage id={id} section="webhooks" title={() => t`Webhooks`}>
      {() => <WebhooksList locationId={id} />}
    </LocationSettingsPage>
  );
}

/** Offline before the page's first load: "Needs a connection", in the page's frame. */
function RouteError(props: ErrorComponentProps) {
  const { t } = useLingui();
  return <HouseholdRouteError {...props} title={t`Webhooks`} />;
}
