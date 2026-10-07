/**
 * The notification centre's groups (plan T24; frame "7 · Notification centre · phone · light"):
 * what's due and coming up (schedules and warranty-registration deadlines), Lending (overdue
 * loans), Expiring (warranties, documents, things that expire), then the notices: your
 * locations' members, AI, and downloads that are ready. They are the `kind` filter's values on
 * the filter strip (surface `notifications`) and the Display button's grouping.
 *
 * The server's `kind` is the notification's own (`reminder`, `membership_added`, …), so a group
 * reaches the server only when it is exactly one of those (Downloads); the rest are narrowed from
 * the rows loaded, as the other step-4 lists do (components/schedules/list-query.ts).
 */
import type { NotificationKind } from '@kept/shared';
import type { Notification } from '@/api/household/types';

export const NOTIFICATION_GROUPS = [
  'due',
  'lending',
  'expiring',
  'members',
  'ai',
  'downloads',
] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

export function groupOf(n: Notification): NotificationGroup {
  switch (n.kind) {
    case 'reminder': {
      const source = n.reminder?.sourceType;
      if (source === 'loan') return 'lending';
      if (source === 'schedule' || source === 'registration') return 'due';
      return 'expiring';
    }
    case 'membership_added':
    case 'membership_ended':
      return 'members';
    case 'ai_cap':
    case 'ai_summary':
      return 'ai';
    case 'export_ready':
      return 'downloads';
  }
}

/** The server's `kind` for the chosen groups, when they come down to exactly one. */
export function serverKindOf(groups: readonly string[] | undefined): NotificationKind | undefined {
  if (!groups?.length) return undefined;
  const kinds = new Set<NotificationKind>();
  for (const g of groups) {
    if (g === 'due' || g === 'lending' || g === 'expiring') kinds.add('reminder');
    else if (g === 'members') {
      kinds.add('membership_added');
      kinds.add('membership_ended');
    } else if (g === 'ai') {
      kinds.add('ai_cap');
      kinds.add('ai_summary');
    } else if (g === 'downloads') kinds.add('export_ready');
  }
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/** The order groups are shown in: the frame's, then the notices. */
export const groupRank = (g: NotificationGroup): number => NOTIFICATION_GROUPS.indexOf(g);
