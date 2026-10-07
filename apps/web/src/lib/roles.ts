import type { Role } from '@kept/shared';

/** Roles `me` may grant in a location: admin only for the owner (D48). */
export function grantableRoles(me: Role): Role[] {
  if (me === 'owner') return ['admin', 'member', 'viewer'];
  if (me === 'admin') return ['member', 'viewer'];
  return [];
}
