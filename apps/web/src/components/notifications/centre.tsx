/**
 * The notification centre's body (plan T24; D39, screens §5 "Notification centre", frame "7 ·
 * Notification centre · phone · light"): everything Kept told you, grouped by kind (due and coming
 * up, lending, expiring, then members, AI and downloads), newest first in each group, each with
 * its next step inline (./notification-row.tsx). Mark all read; the unread count beside it.
 *
 * Under the list standard (D205, surface `notifications`): kind, location and unread on the filter
 * strip with saved views, and the Display button's grouping (by kind, or none: newest first). All
 * in the URL. It reads the server, so it loads on demand into assets/household/ (vite.config.ts)
 * and never costs the precache; pull to refresh refetches it (D212).
 *
 * Complete, Snooze and Renew open the same sheets the Schedules and Expiring screens use; their
 * writes refresh the centre with every other list (`useInvalidateHousehold`).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { householdApi, householdKeys, useNotifications } from '@/api/household/queries';
import type { Notification, NotificationsParams, Schedule } from '@/api/household/types';
import { useLocations } from '@/api/queries';
import { RenewSheet, type RenewTarget } from '@/components/documents/document-sheets';
import type { FilterDef } from '@/components/filters/types';
import { ActivityIcon, BellIcon, CheckIcon, HomeIcon } from '@/components/icons';
import { ListSurface } from '@/components/list-surface';
import { EmptyState, Notice, useErrorText } from '@/components/page';
import { CompleteSheet } from '@/components/schedules/complete-sheet';
import { oneValue, passes, useOrderedQuery } from '@/components/schedules/list-query';
import { SnoozeSheet } from '@/components/schedules/snooze-sheet';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { useListState } from '@/lib/url-state';
import {
  groupOf,
  groupRank,
  NOTIFICATION_GROUPS,
  type NotificationGroup,
  serverKindOf,
} from './groups';
import { NotificationRow, type RowActions } from './notification-row';
import { SourceGone, useReminderSources } from './sources';

function useGroupLabels(): Record<NotificationGroup, string> {
  const { t } = useLingui();
  return {
    due: t`Due and coming up`,
    lending: t`Lending`,
    expiring: t`Expiring`,
    members: t`Members`,
    ai: t`AI`,
    downloads: t`Downloads`,
  };
}

export function NotificationCentre() {
  const { t } = useLingui();
  const f = useFormat();
  const [list] = useListState();
  const qc = useQueryClient();
  const locations = useLocations();
  const nameOf = useLocationName();
  const labels = useGroupLabels();
  const sources = useReminderSources();
  const errorText = useErrorText();
  const online = useOnline();
  const [completing, setCompleting] = useState<Schedule | null>(null);
  const [snoozing, setSnoozing] = useState<Schedule | null>(null);
  const [renewing, setRenewing] = useState<RenewTarget | null>(null);
  const all = locations.data ?? [];

  const location = oneValue(list, 'location');
  const kind = list.not.includes('kind') ? undefined : serverKindOf(list.filters.kind);
  const unreadOnly = (list.filters.unread ?? []).includes('1');
  const params: NotificationsParams = {
    ...(unreadOnly ? { unread: true } : {}),
    ...(kind ? { kind } : {}),
    ...(location ? { locationId: location } : {}),
  };
  const query = useNotifications(params);
  const unread = query.data?.pages[0]?.unread ?? 0;
  const unreadText = f.num(unread);

  const keep = useCallback(
    (n: Notification) =>
      passes(list, 'kind', groupOf(n)) &&
      passes(list, 'location', n.locationId) &&
      (!unreadOnly || !n.readAt),
    [list, unreadOnly],
  );
  const grouped = (list.group || 'kind') === 'kind';
  // Newest first within each group (the server's order); the groups in the frame's order.
  const compare = useMemo(
    () =>
      grouped
        ? (a: Notification, b: Notification) => groupRank(groupOf(a)) - groupRank(groupOf(b))
        : null,
    [grouped],
  );
  const ordered = useOrderedQuery(query, keep, compare);

  // Counts beside each kind, from what's loaded (the frame's "Due · 2").
  const loaded = query.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = new Map<NotificationGroup, number>();
  for (const n of loaded) counts.set(groupOf(n), (counts.get(groupOf(n)) ?? 0) + 1);

  const filters: FilterDef[] = [
    {
      key: 'kind',
      label: t`Kind`,
      icon: <BellIcon />,
      kind: 'multi',
      values: {
        from: 'static',
        options: NOTIFICATION_GROUPS.map((g) => ({
          value: g,
          label: labels[g],
          count: counts.get(g) ?? 0,
        })),
      },
      hideZero: true,
    },
    ...(all.length > 1
      ? [
          {
            key: 'location',
            label: t`Location`,
            icon: <HomeIcon />,
            kind: 'single' as const,
            values: {
              from: 'static' as const,
              options: all.map((l) => ({ value: l.id, label: nameOf(l) })),
            },
          },
        ]
      : []),
    {
      key: 'unread',
      label: t`Unread`,
      icon: <ActivityIcon />,
      kind: 'boolean',
      values: { from: 'static', options: [{ value: '1', label: t`Unread` }] },
    },
  ];

  const refresh = () => qc.invalidateQueries({ queryKey: householdKeys.notifications.all });
  const markRead = async (body: { ids: string[] } | { all: true }) => {
    try {
      await householdApi.readNotifications(body);
    } catch (e) {
      toast({ title: t`Couldn't mark it read`, description: errorText(e), tone: 'danger' });
    }
    await refresh();
  };

  const openSchedule = async (n: Notification, then: (s: Schedule) => void) => {
    if (!n.reminder) return;
    try {
      then(await sources.schedule(n.reminder));
    } catch (e) {
      toast({
        title: t`Couldn't open it`,
        description: e instanceof SourceGone ? t`It's no longer there.` : errorText(e),
        tone: 'danger',
      });
    }
  };

  const actions: RowActions = {
    onComplete: (n) => void openSchedule(n, setCompleting),
    onSnooze: (n) => void openSchedule(n, setSnoozing),
    onRenew: (n, name) => {
      if (n.reminder && n.locationId)
        setRenewing({ id: n.reminder.sourceId, locationId: n.locationId, name });
    },
    onRead: (n) => void markRead({ ids: [n.id] }),
  };

  return (
    <>
      {online ? null : (
        <Notice tone="warn">
          <Trans>
            Needs a connection: completing, snoozing, returning and marking read wait until you're
            back online.
          </Trans>
        </Notice>
      )}
      {unread > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-small text-ink-2">
            <Trans>{unreadText} unread</Trans>
          </p>
          <Button
            size="small"
            variant="secondary"
            isDisabled={!online}
            onPress={() => void markRead({ all: true })}
          >
            <CheckIcon />
            <Trans>Mark all read</Trans>
          </Button>
        </div>
      ) : null}
      <ListSurface<Notification>
        label={t`Notifications`}
        search={false}
        filters={filters}
        surface="notifications"
        groups={[
          { value: 'kind', label: t`Kind`, short: t`by kind` },
          { value: 'none', label: t`None` },
        ]}
        query={ordered}
        getKey={(n) => n.id}
        renderRow={(n) => <NotificationRow n={n} actions={actions} />}
        groupOf={(n, by) => (by === 'kind' ? { key: groupOf(n), label: labels[groupOf(n)] } : null)}
        empty={
          <EmptyState icon={<BellIcon />} title={<Trans>Nothing new</Trans>}>
            <Trans>
              Reminders that are due, loans that are overdue, and news about your locations, with
              the next step one tap away.
            </Trans>
          </EmptyState>
        }
      />
      <CompleteSheet schedule={completing} onClose={() => setCompleting(null)} />
      <SnoozeSheet schedule={snoozing} onClose={() => setSnoozing(null)} />
      <RenewSheet target={renewing} onClose={() => setRenewing(null)} />
    </>
  );
}
