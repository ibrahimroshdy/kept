import { type Action, can, type Role } from '@kept/shared';
import type pg from 'pg';
import { forbidden, notFound } from '../http/errors.js';

// Who the caller is in a location (task 19). Read under the caller's own policies: a location
// they can't see (not a member, expired, deleted, or require_2fa without a second factor) has no
// membership row for them here, and is a 404 like any row they can't see (§7.7). A location they
// can see but may not change answers 403 from can() (product design §7.1).

export type CallerMembership = {
  membershipId: string;
  role: Role;
  expiresAt: Date | null;
};

export async function callerMembership(
  client: pg.ClientBase,
  locationId: string,
): Promise<CallerMembership | null> {
  const { rows } = await client.query<{ id: string; role: Role; expires_at: Date | null }>(
    `SELECT m.id, m.role, m.expires_at FROM public.memberships m
      WHERE m.location_id = $1 AND m.user_id = kept.current_user_id()
        AND (m.expires_at IS NULL OR m.expires_at > now())`,
    [locationId],
  );
  const row = rows[0];
  return row ? { membershipId: row.id, role: row.role, expiresAt: row.expires_at } : null;
}

/** The caller's membership, or 404 when they can't see the location. */
export async function requireMembership(
  client: pg.ClientBase,
  locationId: string,
): Promise<CallerMembership> {
  const found = await callerMembership(client, locationId);
  if (!found) throw notFound();
  return found;
}

/** 403 unless `role` may do `action` (§7.1). */
export function requireCan(role: Role, action: Action, hint?: string): void {
  if (!can(role, action)) throw forbidden(hint);
}

/** D46, D180: a membership an admin sets can't outlast the admin's own. `null` (no end) is later
 * than any date. */
export function outlasts(requested: Date | null, callerExpiresAt: Date | null): boolean {
  if (!callerExpiresAt) return false;
  return requested === null || requested.getTime() > callerExpiresAt.getTime();
}
