import {
  defaultPreference,
  type NotificationKind,
  type NotifyKind,
  type PreferenceChannel,
  type Role,
} from '@kept/shared';
import type pg from 'pg';

// The in-app side of the notices steps 1–3 could only mail (plan T16, Q30; D39, D46, D180, D206):
// a new member and an ended membership for the location's owner, an AI cap at 80% or 100% for
// each person its mail goes to, and the AI monthly summary's opt-out (Q35). Each is a
// `notifications` row written by kept_system (0055's system_insert) in the transaction of the job
// that mails it, so the centre and the mail agree. `payload` holds ids and codes only, never
// money, secrets or contact details; the one exception is a member's display name, kept so an
// ended membership still names who left (their profile is no longer the owner's to read).

type Notice = {
  userId: string;
  locationId: string | null;
  kind: Exclude<NotificationKind, 'reminder'>;
  payload: Record<string, unknown>;
};

/** Inserts one notice. */
export async function insertNotice(client: pg.ClientBase, n: Notice): Promise<void> {
  await client.query(
    `INSERT INTO public.notifications (user_id, location_id, kind, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [n.userId, n.locationId, n.kind, JSON.stringify(n.payload)],
  );
}

/**
 * Whether `userId` wants `kind` on `channel`: their choice (notification_preferences), else the
 * default for their role there (@kept/shared defaultPreference(); Q8, Q10). Read as kept_system.
 * An account-level kind (`ai_summary`) has no location (Q35).
 */
export async function wants(
  client: pg.ClientBase,
  p: {
    userId: string;
    locationId: string | null;
    kind: NotifyKind;
    channel: PreferenceChannel;
    role: Role;
  },
): Promise<boolean> {
  const { rows } = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM public.notification_preferences
      WHERE user_id = $1 AND location_id IS NOT DISTINCT FROM $2 AND kind = $3 AND channel = $4`,
    [p.userId, p.locationId, p.kind, p.channel],
  );
  const chosen = rows[0]?.enabled;
  if (chosen !== undefined) return chosen;
  if (p.channel === 'webhook') return false;
  return defaultPreference({ role: p.role, kind: p.kind });
}

/**
 * The owner hears of a new member or an ended membership in the centre (D46, D180; Q30), unless
 * they turned the Membership kind off in-app there. Returns whether a notice was written.
 */
export async function noticeOwnerOfMember(
  client: pg.ClientBase,
  n: {
    locationId: string;
    kind: 'membership_added' | 'membership_ended';
    member: { userId: string; name: string; role: string; managed?: boolean };
  },
): Promise<boolean> {
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT user_id FROM public.memberships WHERE location_id = $1 AND role = 'owner'`,
    [n.locationId],
  );
  const owner = rows[0]?.user_id;
  if (!owner || owner === n.member.userId) return false;
  const on = await wants(client, {
    userId: owner,
    locationId: n.locationId,
    kind: 'membership',
    channel: 'inapp',
    role: 'owner',
  });
  if (!on) return false;
  await insertNotice(client, {
    userId: owner,
    locationId: n.locationId,
    kind: n.kind,
    payload: {
      userId: n.member.userId,
      userName: n.member.name,
      role: n.member.role,
      ...(n.member.managed !== undefined ? { managed: n.member.managed } : {}),
    },
  });
  return true;
}

/**
 * An AI cap crossed 80% or 100% (D206): one notice per person its mail goes to, once per cap,
 * level and month however often the `ai-notice` job runs (it retries a failed mail).
 */
export async function noticeAiCap(
  client: pg.ClientBase,
  n: { budgetId: string; level: 80 | 100; month: string; scope: string; userIds: string[] },
): Promise<number> {
  if (n.userIds.length === 0) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO public.notifications (user_id, kind, payload)
     SELECT u, 'ai_cap', jsonb_build_object('budgetId', $2::text, 'level', $3::int,
                                            'month', $4::text, 'scope', $5::text)
       FROM unnest($1::uuid[]) AS u
      WHERE NOT EXISTS (
        SELECT 1 FROM public.notifications x
         WHERE x.user_id = u AND x.kind = 'ai_cap' AND x.payload ->> 'budgetId' = $2::text
           AND x.payload ->> 'level' = $3::text AND x.payload ->> 'month' = $4::text)`,
    [[...new Set(n.userIds)], n.budgetId, n.level, n.month, n.scope],
  );
  return rowCount ?? 0;
}

/**
 * The AI monthly summary's channels for `userId` (Q35): account-level, on by default, off in
 * Settings → Me → Notifications. `inapp` off silences it entirely (Q10); the summary's sender
 * mails only when `email` is on, and writes its `ai_summary` notice only when `inapp` is.
 */
export async function aiSummaryChannels(
  client: pg.ClientBase,
  userId: string,
): Promise<{ inapp: boolean; email: boolean }> {
  const base = { userId, locationId: null, kind: 'ai_summary' as const, role: 'owner' as const };
  const inapp = await wants(client, { ...base, channel: 'inapp' });
  const email = inapp && (await wants(client, { ...base, channel: 'email' }));
  return { inapp, email };
}
