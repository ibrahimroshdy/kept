import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { type AuditEventInput, audited } from '../audit/audited.js';
import { withScope } from '../db/scope.js';

/**
 * An account-level audit event (no location) by the user themselves, e.g. a session revoked or
 * the email changed. It needs the user's owner account (kept_app's audit policy pins it), which
 * ensureAccount() creates on the first signed-in request (task 18); without one there is nothing
 * to attach the event to and nothing is written. Returns whether an event was written.
 */
export async function auditAccountEvent(
  appPool: pg.Pool,
  userId: string,
  event: Pick<AuditEventInput, 'action' | 'entity' | 'before' | 'after' | 'requestId'>,
): Promise<boolean> {
  return withScope(appPool, { userId, mfa: false }, async (tx) => {
    const [row] = (
      await tx.execute<{ id: string | null }>(sql`SELECT kept.current_owner_account_id() AS id`)
    ).rows;
    if (!row?.id) return false;
    await audited(tx, {
      ...event,
      locationId: null,
      ownerAccountId: row.id,
      actor: { type: 'user', id: userId },
    });
    return true;
  });
}
