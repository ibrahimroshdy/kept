import type pg from 'pg';
import type { Auth } from '../auth/auth.js';
import type { Pools } from '../db/pools.js';
import type { Scope } from '../db/scope.js';
import { AppError, conflict, pgErrorOf } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';

// Joining a location with an invite (task 20; D33, D46, D180, §7.10). The checks live in
// kept.accept_invite() (0006, rewritten in 0010): live, unaccepted, still backed by its creator,
// the creator's own end date as a cap, the owner's alone for an admin invite, an email invite
// only for the verified address it names, never a Personal location, and not while a sign-up
// holds it for another address (kept.claim_invite(), security review I1). It also writes the
// member.join audit event, as the joiner, in this transaction (review M3). Every refusal is the
// same 404 `invite_invalid`.

export const inviteInvalid = () =>
  new AppError('invite_invalid', 404, 'Ask the person who invited you for a new link.');

export type AcceptDeps = {
  auth: Auth;
  pools: Pick<Pools, 'app' | 'auth' | 'system'>;
  jobs: JobQueue | null;
  log: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
};

export type Accepted = {
  locationId: string;
  /** The caller already belonged: nothing changed. */
  alreadyMember: boolean;
};

type Preview = { email_bound: boolean; email_matches: boolean; member_location_id: string | null };

/**
 * Accepts the invite `tokenHash` as `scope`'s user, inside the caller's kept_app transaction.
 *
 * An email invite's link is only ever mailed (task 20), so holding its token proves the mailbox:
 * when the signed-in user's address is the invite's, it is marked verified here (Better Auth's
 * own flag, through kept_auth) before kept.accept_invite() asks for a verified address. A link
 * invite never touches the flag.
 */
export async function acceptInviteInTx(
  deps: AcceptDeps,
  client: pg.ClientBase,
  scope: Scope,
  tokenHash: string,
  requestId: string | null,
): Promise<Accepted> {
  const { rows } = await client.query<Preview>(
    'SELECT email_bound, email_matches, member_location_id FROM kept.invite_preview($1)',
    [tokenHash],
  );
  const preview = rows[0];
  if (!preview) throw inviteInvalid();
  if (preview.member_location_id) {
    return { locationId: preview.member_location_id, alreadyMember: true };
  }
  if (preview.email_bound) {
    if (!preview.email_matches) throw inviteInvalid();
    const ctx = await deps.auth.$context;
    await ctx.internalAdapter.updateUser(scope.userId, { emailVerified: true });
  }

  let locationId: string;
  try {
    const accepted = await client.query<{ location_id: string }>(
      'SELECT kept.accept_invite($1, $2) AS location_id',
      [tokenHash, requestId],
    );
    locationId = accepted.rows[0]?.location_id as string;
  } catch (err) {
    const pg = pgErrorOf(err);
    // Already a member of a location this session can't see (require_2fa without a second
    // factor): the preview couldn't say so. (An expired membership of theirs is replaced.)
    if (pg?.code === '23505' && pg.constraint === 'memberships_location_user_uq') {
      throw conflict('You already belong to this location.');
    }
    throw err;
  }

  const job = { locationId, userId: scope.userId };
  if (deps.jobs) await deps.jobs.send(client, 'notify-owner-new-member', job);
  else deps.log.warn({ locationId }, 'no job queue: the owner was not notified of a new member');
  return { locationId, alreadyMember: false };
}
