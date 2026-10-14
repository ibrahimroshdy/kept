/**
 * Location settings → Email-in (1.4, D231): the location's mailbox, which Kept checks for
 * receipts. Owners and admins only (the tab is hidden for others; the frame says so if they come
 * by link).
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { LocationSettingsPage } from '@/components/location-settings';
import { MailboxSettings } from '@/components/mailin/mailbox-settings';
import { SettingsRouteError } from '@/components/on-demand-route-error';

export const Route = createFileRoute('/_app/settings/location/$id/email-in')({
  component: EmailInPage,
  errorComponent: SettingsRouteError,
});

function EmailInPage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  return (
    <LocationSettingsPage id={id} section="email-in" title={() => t`Email-in`}>
      {() => <MailboxSettings locationId={id} />}
    </LocationSettingsPage>
  );
}
