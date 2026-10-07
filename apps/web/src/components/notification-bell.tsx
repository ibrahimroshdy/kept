/**
 * The notification bell in the page header (screens §1: "the notification bell" on every screen;
 * the design board's app bar and desktop top bar). It opens the notification centre and shows the
 * unread count from `GET /api/v1/notifications/count` as a badge, the way the rail shows the
 * Inbox's (D198). Hidden on the centre itself, whose header carries its settings instead
 * (frame "7 · Notification centre").
 *
 * The page header (components/page.tsx) places it: after Scan on a phone, and between the search
 * field and Capture from 768 px, as the top bar does.
 */
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { Link, useRouterState } from '@tanstack/react-router';
import { useNotificationCount } from '@/api/household/queries';
import { BellIcon } from '@/components/icons';
import { cn } from '@/lib/utils';

export function NotificationBell({ className }: { className?: string }) {
  const { t, i18n } = useLingui();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onCentre = pathname === '/notifications';
  const count = useNotificationCount(!onCentre);
  if (onCentre) return null;
  const unread = count.data?.unread ?? 0;
  const label =
    unread > 0
      ? plural(unread, { one: '# unread notification', other: '# unread notifications' })
      : t`Notifications`;
  return (
    <Link
      to="/notifications"
      aria-label={label}
      data-slot="notification-bell"
      className={cn(
        'relative grid size-11 shrink-0 place-items-center rounded-[10px] text-ink-2 outline-none hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-info [&_svg]:size-[22px]',
        className,
      )}
    >
      <BellIcon />
      {/* The count is drawn from an attribute, not a text node: the link's name already says it,
          and a bare "4" in the header would be one more "4" on every page. */}
      {unread > 0 ? (
        <span
          aria-hidden="true"
          data-count={unread > 99 ? `${i18n.number(99)}+` : i18n.number(unread)}
          className="absolute top-1.5 end-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-amber px-1 font-semibold text-[10px] leading-none text-amber-ink ring-2 ring-paper after:content-[attr(data-count)]"
        />
      ) : null}
    </Link>
  );
}
