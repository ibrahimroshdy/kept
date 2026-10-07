/**
 * The signed-in frame's last-known state, for a cold start offline (step-3 DoD; D17, D101, D181,
 * D210). The frame needs `/api/v1/me`, `/api/v1/setup` and `/api/v1/locations` before it draws
 * (lib/signed-in-gate.ts, routes/_app.tsx). An authenticated response never goes in the Cache API
 * (D181), so the frame keeps its own minimal copy in the person's own database (the `shell` meta
 * row, written by offline/provider.tsx each time those queries answer online). A reload or a cold
 * start with no connection draws the frame from it, and everything says "as of last sync".
 *
 * **Only what the shell reads.** The person's id, name, roles and profile display settings, and
 * each location's name, role, kind and modules: no secret, no money and no contact detail (the
 * email is left out). Online, the server stays the truth: the queries refetch and overwrite it.
 *
 * **It goes with the cache.** A 401 clears the database's meta (wipe.ts `clearCache`, D210) and a
 * sign-out deletes the database, so the copy never outlives the session that wrote it. A locked
 * database (`lockedAt`) never opens the frame.
 *
 * Plain data only: no Dexie here (the entry chunk imports this module through the gate).
 */
import type { LocationDetail, Me } from '@/api/types';

export type OfflineShell = {
  /** When the server last answered (ms since the epoch): the queries' `dataUpdatedAt`. */
  savedAt: number;
  me: Me;
  locations: LocationDetail[];
};

/** `/me` without the contact detail: the shell never shows it offline. */
export function shellMe(me: Me): Me {
  return {
    user: {
      id: me.user.id,
      displayName: me.user.displayName,
      email: null,
      username: me.user.username,
      twoFactorEnabled: me.user.twoFactorEnabled,
      managed: me.user.managed,
      instanceAdmin: me.user.instanceAdmin,
    },
    mfa: me.mfa,
    personalLocationId: me.personalLocationId,
    profile: {
      timezone: me.profile.timezone,
      locale: me.profile.locale,
      units: me.profile.units,
      theme: me.profile.theme,
      digits: me.profile.digits,
    },
    memberships: me.memberships.map((m) => ({
      locationId: m.locationId,
      name: m.name,
      kind: m.kind,
      role: m.role,
      expiresAt: m.expiresAt,
    })),
    instance: { recoveryKitAcknowledged: me.instance.recoveryKitAcknowledged },
  };
}

/** A location as the shell and Home read it: no version, successor or money settings. */
export function shellLocation(l: LocationDetail): LocationDetail {
  return {
    id: l.id,
    name: l.name,
    kind: l.kind,
    ownerAccountId: l.ownerAccountId,
    role: l.role,
    membershipExpiresAt: l.membershipExpiresAt,
    preset: l.preset,
    timezone: l.timezone,
    currency: l.currency,
    memberCount: l.memberCount,
    thingCount: l.thingCount,
    pendingInviteCount: l.pendingInviteCount,
    require2fa: l.require2fa,
    modules: [...l.modules],
    providerResolved: l.providerResolved,
    ...(l.effectiveModules ? { effectiveModules: [...l.effectiveModules] } : {}),
    ...(l.languages ? { languages: [...l.languages] } : {}),
  };
}

export function shellOf(me: Me, locations: readonly LocationDetail[], savedAt: number) {
  return {
    savedAt,
    me: shellMe(me),
    locations: locations.map(shellLocation),
  } satisfies OfflineShell;
}

/**
 * The stored row, when it is one and belongs to `userId`; null for anything else (a row from an
 * older build, another person's, a locked database).
 */
export function readShell(
  value: unknown,
  userId: string,
  lockedAt: unknown = undefined,
): OfflineShell | null {
  if (lockedAt !== undefined && lockedAt !== null) return null;
  const s = value as Partial<OfflineShell> | null | undefined;
  if (!s || typeof s !== 'object') return null;
  if (typeof s.savedAt !== 'number' || !Array.isArray(s.locations)) return null;
  if (!s.me || typeof s.me !== 'object' || s.me.user?.id !== userId) return null;
  return s as OfflineShell;
}
