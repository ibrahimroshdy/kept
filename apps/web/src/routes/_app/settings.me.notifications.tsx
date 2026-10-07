/**
 * Me → Notifications (plan T25; D29, D30, D139, D142, frame "Settings · Me · phone · light"):
 * channels (email, push on this device, webhooks), what each location tells you and how, the
 * digest time and quiet hours, the calendar feed, and the AI monthly summary. Its chunk loads on
 * demand from assets/household/ (vite.config.ts).
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { NotificationsRouteError } from '@/components/notifications/route-error';
import { NotificationSettings } from '@/components/notifications/settings/notification-settings';
import { Page } from '@/components/page';

export const Route = createFileRoute('/_app/settings/me/notifications')({
  component: NotificationSettingsPage,
  errorComponent: NotificationsRouteError,
});

function NotificationSettingsPage() {
  const { t } = useLingui();
  return (
    <Page title={t`Notifications`} back="/settings">
      <NotificationSettings />
    </Page>
  );
}
