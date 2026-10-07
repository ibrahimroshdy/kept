import {
  ACCOUNT_LEVEL_KINDS,
  defaultPreference,
  NOTIFY_KINDS,
  type NotifyKind,
  PREFERENCE_CHANNELS,
  type PreferenceChannel,
  type Role,
} from '@kept/shared';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import type { Tx } from '../db/scope.js';
import { invalid, notFound } from '../http/errors.js';

// Who wants which kind on which channel (D29; plan Q8, Q10, Q35), and the digest time and quiet
// hours (D122). A preference row exists only where a person chose; no row is the default below,
// so a change to the defaults reaches everyone who never chose. Setting a value equal to the
// default deletes the row.
//
// The reminder engine's recipients (T14) read the same rule: preferenceDefault().

export const DEFAULT_DIGEST = '08:00';

/** The kinds a location's table shows: every kind but the account-level ones (Q35). */
export const LOCATION_KINDS: readonly NotifyKind[] = NOTIFY_KINDS.filter(
  (k) => !(ACCOUNT_LEVEL_KINDS as readonly string[]).includes(k),
);

/**
 * What a person gets on `channel` for `kind` when they haven't chosen: @kept/shared
 * defaultPreference() on the in-app centre, email and push (Q10: the same default on each), and
 * never on a webhook until they turn it on (plan T14: "webhook channels only when chosen").
 * For an account-level kind (`ai_summary`, Q35) the role doesn't matter.
 */
export function preferenceDefault(p: {
  role: Role;
  kind: NotifyKind;
  channel: PreferenceChannel;
  recordedByMe?: boolean;
}): boolean {
  if (p.channel === 'webhook') return false;
  return defaultPreference({
    role: p.role,
    kind: p.kind,
    ...(p.recordedByMe !== undefined ? { recordedByMe: p.recordedByMe } : {}),
  });
}

export const isAccountLevel = (kind: NotifyKind) =>
  (ACCOUNT_LEVEL_KINDS as readonly string[]).includes(kind);

export type KindPreference = Record<PreferenceChannel, boolean> & { isDefault: boolean };

export type StoredPreference = {
  locationId: string | null;
  kind: NotifyKind;
  channel: PreferenceChannel;
  enabled: boolean;
};

/** The caller's active memberships: the locations whose kinds they may choose. */
export async function myLocations(
  client: pg.ClientBase,
): Promise<Array<{ locationId: string; name: string; role: Role }>> {
  const { rows } = await client.query<{ id: string; name: string; role: Role }>(
    `SELECT l.id, l.name, m.role
       FROM public.memberships m JOIN public.locations l ON l.id = m.location_id
      WHERE m.user_id = kept.current_user_id() AND l.deleted_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
      ORDER BY (l.kind = 'personal') DESC, lower(l.name), l.id`,
  );
  return rows.map((r) => ({ locationId: r.id, name: r.name, role: r.role }));
}

export async function myPreferences(client: pg.ClientBase): Promise<StoredPreference[]> {
  const { rows } = await client.query<{
    location_id: string | null;
    kind: NotifyKind;
    channel: PreferenceChannel;
    enabled: boolean;
  }>(
    `SELECT location_id, kind, channel, enabled FROM public.notification_preferences
      WHERE user_id = kept.current_user_id()`,
  );
  return rows.map((r) => ({
    locationId: r.location_id,
    kind: r.kind,
    channel: r.channel,
    enabled: r.enabled,
  }));
}

const prefKey = (locationId: string | null, kind: string, channel: string) =>
  `${locationId ?? ''}|${kind}|${channel}`;

/** A location's table (viewers see only Membership, Q8), each value chosen or defaulted. */
export function kindsFor(
  role: Role,
  locationId: string,
  stored: ReadonlyMap<string, boolean>,
): Partial<Record<NotifyKind, KindPreference>> {
  const shown: readonly NotifyKind[] = role === 'viewer' ? ['membership'] : LOCATION_KINDS;
  const out: Partial<Record<NotifyKind, KindPreference>> = {};
  for (const kind of shown) {
    const pref = { isDefault: true } as KindPreference;
    for (const channel of PREFERENCE_CHANNELS) {
      const fallback = preferenceDefault({ role, kind, channel });
      const chosen = stored.get(prefKey(locationId, kind, channel));
      if (chosen !== undefined && chosen !== fallback) pref.isDefault = false;
      pref[channel] = chosen ?? fallback;
    }
    out[kind] = pref;
  }
  return out;
}

export function storedMap(prefs: readonly StoredPreference[]): Map<string, boolean> {
  return new Map(prefs.map((p) => [prefKey(p.locationId, p.kind, p.channel), p.enabled]));
}

/** The AI monthly summary by email: chosen, else on (Q35). */
export function aiSummaryEmail(stored: ReadonlyMap<string, boolean>): boolean {
  return (
    stored.get(prefKey(null, 'ai_summary', 'email')) ??
    preferenceDefault({ role: 'owner', kind: 'ai_summary', channel: 'email' })
  );
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** The caller's owner account, which an account-level audit event needs (§7.13). */
async function ownerAccountOf(tx: Tx): Promise<string | null> {
  const [row] = (
    await tx.execute<{ id: string | null }>(sql`SELECT kept.current_owner_account_id() AS id`)
  ).rows;
  return row?.id ?? null;
}

/** An audit event about the caller's own account (no location). */
export async function auditMine(
  tx: Tx,
  userId: string,
  event: {
    action: string;
    entity: { type: string; id: string | null };
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    requestId: string;
  },
): Promise<void> {
  const ownerAccountId = await ownerAccountOf(tx);
  if (!ownerAccountId) return;
  await audited(tx, {
    ...event,
    locationId: null,
    ownerAccountId,
    actor: { type: 'user', id: userId },
  });
}

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

export type Timing = {
  timezone: string;
  digestTime: string;
  quietFrom: string | null;
  quietTo: string | null;
};

export async function myTiming(client: pg.ClientBase): Promise<Timing> {
  const { rows } = await client.query<{
    timezone: string;
    digest_time: string | null;
    quiet_from: string | null;
    quiet_to: string | null;
  }>(
    `SELECT timezone, digest_time::text, quiet_from::text, quiet_to::text
       FROM public.user_profiles WHERE user_id = kept.current_user_id()`,
  );
  const r = rows[0];
  return {
    timezone: r?.timezone ?? 'UTC',
    digestTime: hhmm(r?.digest_time ?? null) ?? DEFAULT_DIGEST,
    quietFrom: hhmm(r?.quiet_from ?? null),
    quietTo: hhmm(r?.quiet_to ?? null),
  };
}

export type TimingPatch = {
  digestTime?: string | undefined;
  quietFrom?: string | null | undefined;
  quietTo?: string | null | undefined;
};

/** PUT /api/v1/me/notification-settings: the digest time and quiet hours (both ends or neither). */
export async function updateTiming(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  patch: TimingPatch,
  requestId: string,
): Promise<void> {
  const before = await myTiming(client);
  const from = patch.quietFrom === undefined ? before.quietFrom : patch.quietFrom;
  const to = patch.quietTo === undefined ? before.quietTo : patch.quietTo;
  if ((from === null) !== (to === null)) {
    throw invalid('Quiet hours need both a start and an end, or neither.');
  }
  if (from !== null && from === to)
    throw invalid('Quiet hours can’t start and end at the same time.');
  const digest = patch.digestTime ?? before.digestTime;
  await client.query(
    `UPDATE public.user_profiles SET digest_time = $1::time, quiet_from = $2::time, quiet_to = $3::time
      WHERE user_id = kept.current_user_id()`,
    [digest, from, to],
  );
  const after = { digest_time: digest, quiet_from: from, quiet_to: to };
  const was = {
    digest_time: before.digestTime,
    quiet_from: before.quietFrom,
    quiet_to: before.quietTo,
  };
  if (JSON.stringify(after) === JSON.stringify(was)) return;
  await auditMine(tx, userId, {
    action: 'me.notifications',
    entity: { type: 'user', id: userId },
    before: was,
    after,
    requestId,
  });
}

export type PreferenceItem = {
  locationId: string | null;
  kind: NotifyKind;
  channel: PreferenceChannel;
  enabled: boolean;
};

/**
 * PUT /api/v1/me/notification-preferences: each item stored, or its row deleted when it equals
 * the default. A location the caller isn't an active member of is 404 (as if it didn't exist).
 * One audit event for the whole change.
 */
export async function putPreferences(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  items: readonly PreferenceItem[],
  requestId: string,
): Promise<void> {
  const roles = new Map((await myLocations(client)).map((l) => [l.locationId, l.role]));
  const stored = storedMap(await myPreferences(client));
  const before: Array<PreferenceItem | (Omit<PreferenceItem, 'enabled'> & { enabled: null })> = [];
  const after: typeof before = [];
  for (const item of items) {
    if (isAccountLevel(item.kind) !== (item.locationId === null)) {
      throw invalid(
        isAccountLevel(item.kind)
          ? `${item.kind} belongs to your account: send it with locationId null.`
          : `${item.kind} is chosen per location: send a locationId.`,
      );
    }
    const role: Role | undefined = item.locationId ? roles.get(item.locationId) : 'owner';
    if (!role) throw notFound();
    const fallback = preferenceDefault({ role, kind: item.kind, channel: item.channel });
    const key = prefKey(item.locationId, item.kind, item.channel);
    const was = stored.get(key);
    const next = item.enabled === fallback ? undefined : item.enabled;
    if (was === next) continue;
    if (next === undefined) {
      await client.query(
        `DELETE FROM public.notification_preferences
          WHERE user_id = kept.current_user_id() AND location_id IS NOT DISTINCT FROM $1::uuid
            AND kind = $2 AND channel = $3`,
        [item.locationId, item.kind, item.channel],
      );
      stored.delete(key);
    } else {
      await client.query(
        `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
         VALUES (kept.current_user_id(), $1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT notification_preferences_uq
         DO UPDATE SET enabled = EXCLUDED.enabled`,
        [item.locationId, item.kind, item.channel, next],
      );
      stored.set(key, next);
    }
    const base = { locationId: item.locationId, kind: item.kind, channel: item.channel };
    before.push({ ...base, enabled: was ?? null });
    after.push({ ...base, enabled: next ?? null });
  }
  if (after.length === 0) return;
  await auditMine(tx, userId, {
    action: 'me.notification_preferences',
    entity: { type: 'user', id: userId },
    before: { preferences: before },
    after: { preferences: after },
    requestId,
  });
}
