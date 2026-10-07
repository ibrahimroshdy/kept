import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import type { Mailer } from '../mail/mailer.js';
import { inviteUrl, newInviteToken } from './token.js';

// `send-invite-mail` (security review M9; D33, §7.10). An email invite's link is only ever mailed
// and its token is never stored, not even in a job's data: the route stores an unusable hash and
// enqueues this job in its own transaction, so the mail is due exactly when the invite exists.
// The job makes the real token, stores its hash through kept.rekey_email_invite() (migration
// 0010; a live, unaccepted email invite only), and mails the link to the invite's own address.
// It takes nothing but the invite's id from `data` (the rule in jobs/boss.ts). A retry makes a
// new token, so only the last link mailed works.

export type InviteMailDeps = {
  pools: Pick<Pools, 'system'>;
  mailer: Mailer;
  publicUrl: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns whether a mail was sent (false for an invite that is gone, used or expired). */
export async function sendInviteMail(deps: InviteMailDeps, data: unknown): Promise<boolean> {
  const { inviteId } = (data ?? {}) as { inviteId?: unknown };
  if (typeof inviteId !== 'string' || !UUID.test(inviteId)) return false;
  const { token, hash } = newInviteToken();
  const invite = await withSystem(deps.pools.system, async (_tx, client) => {
    const { rows } = await client.query<{
      email: string;
      role: 'admin' | 'member' | 'viewer';
      location_name: string;
      inviter_name: string | null;
    }>('SELECT * FROM kept.rekey_email_invite($1, $2)', [inviteId, hash]);
    return rows[0] ?? null;
  });
  if (!invite) return false;
  await deps.mailer.send({
    kind: 'invite',
    to: invite.email,
    url: inviteUrl(deps.publicUrl, token),
    locationName: invite.location_name,
    inviterName: invite.inviter_name ?? '',
    role: invite.role,
  });
  return true;
}
