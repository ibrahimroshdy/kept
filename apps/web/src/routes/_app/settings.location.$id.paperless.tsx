/**
 * Location settings → Paperless-ngx (1.x, D248): the location's Paperless server, whose documents
 * members link to things and places. Owners and admins only (the tab is hidden for others; the
 * frame says so if they come by link).
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { LocationSettingsPage } from '@/components/location-settings';
import { SettingsRouteError } from '@/components/on-demand-route-error';
import { PaperlessSettings } from '@/components/paperless/connection-settings';

export const Route = createFileRoute('/_app/settings/location/$id/paperless')({
  component: PaperlessPage,
  errorComponent: SettingsRouteError,
});

function PaperlessPage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  return (
    <LocationSettingsPage id={id} section="paperless" title={() => t`Paperless-ngx`}>
      {() => <PaperlessSettings locationId={id} />}
    </LocationSettingsPage>
  );
}
