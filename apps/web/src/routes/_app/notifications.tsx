/**
 * Notifications (plan T24; D39, frame "7 · Notification centre · phone · light"): grouped by
 * kind, each naming the thing, place, location and local date, with Complete, Snooze and Mark
 * returned inline; Mark all read; the filter strip (surface `notifications`: kind, location,
 * unread) and pull to refresh. Its chunk loads on demand from assets/household/ (vite.config.ts).
 * The header's gear opens Me → Notifications, as the frame's settings button does.
 */
import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { GearIcon } from '@/components/icons';
import { NotificationCentre } from '@/components/notifications/centre';
import { NotificationsRouteError } from '@/components/notifications/route-error';
import { LinkButton, Page } from '@/components/page';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/notifications')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS.notifications),
  component: NotificationsPage,
  errorComponent: NotificationsRouteError,
});

function NotificationsPage() {
  const { t } = useLingui();
  return (
    <Page
      title={t`Notifications`}
      wide
      actions={
        <LinkButton
          to="/settings/me/notifications"
          variant="ghost"
          size="icon"
          aria-label={t`Notification settings`}
        >
          <GearIcon />
        </LinkButton>
      }
    >
      <NotificationCentre />
    </Page>
  );
}
