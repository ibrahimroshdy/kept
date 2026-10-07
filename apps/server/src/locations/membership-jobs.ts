import type pg from 'pg';
import { audited } from '../audit/audited.js';
import { isUndeliverableEmail } from '../auth/emails.js';
import type { Pools } from '../db/pools.js';
import { type Tx, withSystem } from '../db/scope.js';
import type { Mailer } from '../mail/mailer.js';
import { noticeOwnerOfMember, wants } from '../notify/notices.js';

// The membership jobs (task 19; D46, D180). Both run as kept_system, whose system_all policy on
// memberships (0006) lets them see every location's; neither takes its scope from job data.

type Log = { info: (obj: object, msg: string) => void };

/** The location's owner account, found through its owner membership (kept_system has no policy
 * on locations; the two always agree, 0005 §3). */
async function ownerAccountOf(client: pg.ClientBase, locationId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT oa.id FROM public.memberships m
       JOIN public.owner_accounts oa ON oa.user_id = m.user_id
      WHERE m.location_id = $1 AND m.role = 'owner'`,
    [locationId],
  );
  return rows[0]?.id ?? null;
}

/** An expired membership's audit event (the system acted), for the location's history. */
async function auditSystem(
  tx: Tx,
  client: pg.ClientBase,
  locationId: string,
  action: string,
  membershipId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await audited(tx, {
    locationId,
    ownerAccountId: await ownerAccountOf(client, locationId),
    actor: { type: 'system', id: null },
    action,
    entity: { type: 'membership', id: membershipId },
    before: detail,
  });
}

export type ExpiredMembership = {
  id: string;
  locationId: string;
  userId: string;
  role: string;
  expiresAt: Date;
};

/**
 * `expire-memberships` (every 15 minutes, D46): deletes every membership whose end date has
 * passed, with an audit event for each, in one transaction. An expired membership already stops
 * working the moment it ends (kept.visible_location_ids() ignores it); this removes the row and
 * records it. The owner hears of it in the notification centre (step 4, Q30: a
 * `membership_ended` notice in the same transaction, unless they turned Membership off there),
 * and, given `mail`, by email (D46; T15's `membership-ended` mail) after the transaction commits,
 * when their Membership email preference is on (the default) and their address is verified and
 * deliverable. A failed send is logged, never retried: the expiry stands either way. The
 * member's tokens are revoked in the same transaction by the memberships trigger (0070,
 * kept.membership_access_ended()).
 */
export async function expireMemberships(
  pools: Pick<Pools, 'system'>,
  log?: Log & { error?: (obj: object, msg: string) => void },
  mail?: { mailer: Mailer; auth: pg.Pool },
): Promise<ExpiredMembership[]> {
  const toMail: {
    ownerId: string;
    locale: string | null;
    locationName: string;
    memberName: string;
    role: 'admin' | 'member' | 'viewer';
    endedOn: string;
  }[] = [];
  const expired = await withSystem(pools.system, async (tx, client) => {
    const { rows } = await client.query<{
      id: string;
      location_id: string;
      user_id: string;
      role: string;
      expires_at: Date;
    }>(
      `DELETE FROM public.memberships
        WHERE expires_at <= now() AND role <> 'owner'
        RETURNING id, location_id, user_id, role, expires_at`,
    );
    for (const r of rows) {
      await auditSystem(tx, client, r.location_id, 'member.expire', r.id, {
        user_id: r.user_id,
        role: r.role,
        expires_at: r.expires_at,
      });
      const { rows: profile } = await client.query<{ display_name: string }>(
        'SELECT display_name FROM public.user_profiles WHERE user_id = $1',
        [r.user_id],
      );
      const memberName = profile[0]?.display_name ?? '';
      await noticeOwnerOfMember(client, {
        locationId: r.location_id,
        kind: 'membership_ended',
        member: { userId: r.user_id, name: memberName, role: r.role },
      });
      if (!mail) continue;
      const { rows: owner } = await client.query<{
        user_id: string;
        locale: string | null;
        location_name: string;
      }>(
        `SELECT m.user_id, p.locale, l.name AS location_name
           FROM public.memberships m
           JOIN public.locations l ON l.id = m.location_id
           LEFT JOIN public.user_profiles p ON p.user_id = m.user_id
          WHERE m.location_id = $1 AND m.role = 'owner'`,
        [r.location_id],
      );
      const o = owner[0];
      if (!o || o.user_id === r.user_id) continue;
      const pref = { userId: o.user_id, locationId: r.location_id, kind: 'membership' as const };
      // In-app off silences the kind entirely (Q10); email follows its own choice.
      const on =
        (await wants(client, { ...pref, channel: 'inapp', role: 'owner' })) &&
        (await wants(client, { ...pref, channel: 'email', role: 'owner' }));
      if (!on) continue;
      toMail.push({
        ownerId: o.user_id,
        locale: o.locale,
        locationName: o.location_name,
        memberName,
        role: r.role as 'admin' | 'member' | 'viewer',
        endedOn: r.expires_at.toISOString().slice(0, 10),
      });
    }
    return rows.map((r) => ({
      id: r.id,
      locationId: r.location_id,
      userId: r.user_id,
      role: r.role,
      expiresAt: r.expires_at,
    }));
  });
  for (const m of expired) {
    log?.info({ locationId: m.locationId, membershipId: m.id }, 'membership expired');
  }
  if (mail && toMail.length > 0) {
    const { rows: users } = await mail.auth.query<{
      id: string;
      email: string;
      email_verified: boolean;
      banned: boolean | null;
    }>('SELECT id, email, email_verified, banned FROM auth."user" WHERE id = ANY($1::uuid[])', [
      [...new Set(toMail.map((m) => m.ownerId))],
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const m of toMail) {
      const u = byId.get(m.ownerId);
      if (!u?.email_verified || u.banned || isUndeliverableEmail(u.email)) continue;
      await mail.mailer
        .send({
          kind: 'membership-ended',
          to: u.email,
          locale: m.locale,
          locationName: m.locationName,
          memberName: m.memberName,
          role: m.role,
          endedOn: m.endedOn,
        })
        .catch((err: unknown) => log?.error?.({ err }, 'membership-ended mail failed'));
    }
  }
  return expired;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/**
 * `notify-owner-new-member` (D180): the owner hears of every new member and managed account.
 * The job names a location and a user (`{locationId, userId}`); everything else is read from the
 * database as it is now. A membership gone by the time the job runs (removed, expired) needs no
 * notice. The owner is mailed (kept.new_member_notice(), migration 0011) inside the job's
 * transaction, so a failed send rolls the audit event back and the retry starts clean. The
 * in-app notice (step 4, Q30: `membership_added`) is written in the same transaction, so it too
 * exists once, with the mail.
 */
export async function notifyOwnerNewMember(
  pools: Pick<Pools, 'system'>,
  data: unknown,
  log?: Log,
  mailer?: Mailer,
): Promise<boolean> {
  const { locationId, userId } = (data ?? {}) as { locationId?: unknown; userId?: unknown };
  if (!isUuid(locationId) || !isUuid(userId)) return false;
  return withSystem(pools.system, async (tx, client) => {
    const { rows } = await client.query<{
      id: string;
      location_id: string;
      user_id: string;
      role: string;
      invited_by: string | null;
      owner_id: string | null;
    }>(
      `SELECT m.id, m.location_id, m.user_id, m.role, m.invited_by,
              (SELECT o.user_id FROM public.memberships o
                WHERE o.location_id = m.location_id AND o.role = 'owner') AS owner_id
         FROM public.memberships m
        WHERE m.location_id = $1 AND m.user_id = $2 AND m.role <> 'owner'`,
      [locationId, userId],
    );
    const m = rows[0];
    if (!m) return false;
    const membershipId = m.id;
    await audited(tx, {
      locationId: m.location_id,
      ownerAccountId: await ownerAccountOf(client, m.location_id),
      actor: { type: 'system', id: null },
      action: 'member.owner_notified',
      entity: { type: 'membership', id: membershipId },
      after: { user_id: m.user_id, role: m.role, invited_by: m.invited_by, owner_id: m.owner_id },
    });
    const notice = await client.query<{
      owner_email: string;
      owner_locale: string | null;
      location_name: string;
      member_name: string;
      role: 'admin' | 'member' | 'viewer';
      managed: boolean;
    }>('SELECT * FROM kept.new_member_notice($1, $2)', [m.location_id, m.user_id]);
    const n = notice.rows[0];
    if (n) {
      await noticeOwnerOfMember(client, {
        locationId: m.location_id,
        kind: 'membership_added',
        member: { userId: m.user_id, name: n.member_name, role: n.role, managed: n.managed },
      });
    }
    if (mailer && n && !isUndeliverableEmail(n.owner_email)) {
      await mailer.send({
        kind: 'owner-new-member',
        to: n.owner_email,
        locale: n.owner_locale,
        locationName: n.location_name,
        memberName: n.member_name,
        role: n.role,
        managed: n.managed,
      });
    }
    log?.info(
      { locationId: m.location_id, membershipId, ownerId: m.owner_id },
      'owner notified of a new member',
    );
    return true;
  });
}
