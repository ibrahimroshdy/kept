import {
  ACCOUNT_LEVEL_KINDS,
  defaultPreference,
  NOTIFY_KINDS,
  type NotifyKind,
  PREFERENCE_CHANNELS,
  type PreferenceChannel,
  type Role,
  resolvePreference,
} from '@kept/shared';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import type { Tx } from '../db/scope.js';
import { invalid, notFound } from '../http/errors.js';

// Who wants which kind on which channel (D29; plan Q8, Q10, Q35; D239), and the digest time and
// quiet hours (D122). A preference row exists only where a person chose; no row is the default
// below, so a change to the defaults reaches everyone who never chose. Setting a value equal to
// what the cell would otherwise be deletes the row.
//
// Two layers (1.5.x, D239): a row with no location is the person's choice for all their
// locations; a row with one, their choice for that location. A location reads its own row, else
// the all-locations row, else Kept's default for the person's role there (@kept/shared
// resolvePreference()). The all-locations layer is measured against what Kept gives in a location
// a person runs (the owner default), so it stores only offs (and a webhook's on); a member who
// wants more in a friend's home turns it on there. The AI monthly summary has only that layer.
//
// The reminder engine's recipients (T14), the notices (notify/notices.ts wants()), the AI cap
// notices and the calendar feed read the same rule.

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

/** The all-locations layer's baseline (D239): Kept's default where the person runs the place. */
export const accountDefault = (kind: NotifyKind, channel: PreferenceChannel): boolean =>
  preferenceDefault({ role: 'owner', kind, channel });

export const isAccountLevel = (kind: NotifyKind) =>
  (ACCOUNT_LEVEL_KINDS as readonly string[]).includes(kind);

/**
 * One kind's values on every channel. `set`: the channels chosen at this layer (for a location,
 * the cells that differ from all locations). `isDefault`: no choice at either layer.
 */
export type KindPreference = Record<PreferenceChannel, boolean> & {
  isDefault: boolean;
  set: PreferenceChannel[];
};

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

/** The key of a stored choice; `locationId` null is the all-locations layer. */
export const prefKey = (locationId: string | null, kind: string, channel: string) =>
  `${locationId ?? ''}|${kind}|${channel}`;

/**
 * The value that decides `kind` on `channel` in `locationId` for a person with `role` there, from
 * their stored choices (D239: location, then all locations, then the default).
 */
export function effectivePreference(
  stored: ReadonlyMap<string, boolean>,
  p: {
    locationId: string;
    role: Role;
    kind: NotifyKind;
    channel: PreferenceChannel;
    recordedByMe?: boolean;
  },
): boolean {
  const { locationId, ...rest } = p;
  return resolvePreference({
    location: stored.get(prefKey(locationId, p.kind, p.channel)),
    account: stored.get(prefKey(null, p.kind, p.channel)),
    fallback: preferenceDefault(rest),
  });
}

/** What a location's cell would be without its own row: all locations, else the default. */
function inherited(
  stored: ReadonlyMap<string, boolean>,
  role: Role,
  kind: NotifyKind,
  channel: PreferenceChannel,
): boolean {
  return stored.get(prefKey(null, kind, channel)) ?? preferenceDefault({ role, kind, channel });
}

/** A location's table (viewers see only Membership, Q8), each value as it is decided there. */
export function kindsFor(
  role: Role,
  locationId: string,
  stored: ReadonlyMap<string, boolean>,
): Partial<Record<NotifyKind, KindPreference>> {
  const shown: readonly NotifyKind[] = role === 'viewer' ? ['membership'] : LOCATION_KINDS;
  const out: Partial<Record<NotifyKind, KindPreference>> = {};
  for (const kind of shown) {
    const pref = { isDefault: true, set: [] } as unknown as KindPreference;
    for (const channel of PREFERENCE_CHANNELS) {
      const here = stored.get(prefKey(locationId, kind, channel));
      if (here !== undefined) pref.set.push(channel);
      if (here !== undefined || stored.has(prefKey(null, kind, channel))) pref.isDefault = false;
      pref[channel] = here ?? inherited(stored, role, kind, channel);
    }
    out[kind] = pref;
  }
  return out;
}

/** The all-locations table (D239): every kind, each value chosen or the owner default. */
export function accountKinds(
  stored: ReadonlyMap<string, boolean>,
): Record<NotifyKind, KindPreference> {
  const out = {} as Record<NotifyKind, KindPreference>;
  for (const kind of NOTIFY_KINDS) {
    const pref = { isDefault: true, set: [] } as unknown as KindPreference;
    for (const channel of PREFERENCE_CHANNELS) {
      const chosen = stored.get(prefKey(null, kind, channel));
      if (chosen !== undefined) {
        pref.set.push(channel);
        pref.isDefault = false;
      }
      pref[channel] = chosen ?? accountDefault(kind, channel);
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
  return stored.get(prefKey(null, 'ai_summary', 'email')) ?? accountDefault('ai_summary', 'email');
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

type Change = Omit<PreferenceItem, 'enabled'> & { enabled: boolean | null };

/** Stores `next` for the caller's cell, or deletes its row when `next` is undefined. */
async function writeCell(
  client: pg.ClientBase,
  cell: Omit<PreferenceItem, 'enabled'>,
  next: boolean | undefined,
): Promise<void> {
  if (next === undefined) {
    await client.query(
      `DELETE FROM public.notification_preferences
        WHERE user_id = kept.current_user_id() AND location_id IS NOT DISTINCT FROM $1::uuid
          AND kind = $2 AND channel = $3`,
      [cell.locationId, cell.kind, cell.channel],
    );
    return;
  }
  await client.query(
    `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
     VALUES (kept.current_user_id(), $1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT notification_preferences_uq
     DO UPDATE SET enabled = EXCLUDED.enabled`,
    [cell.locationId, cell.kind, cell.channel, next],
  );
}

/**
 * PUT /api/v1/me/notification-preferences: each item stored, or its row deleted when it equals
 * what the cell would otherwise be (D239: for a location, the all-locations value or the default;
 * for all locations, the owner default). `locationId` null is the all-locations layer, for any
 * kind; `ai_summary` takes only that. A change for all locations also drops a location's row that
 * now says the same, so only what differs stays stored at each layer. A location the caller
 * isn't an active member of is 404 (as if it didn't exist). One audit event for the whole change.
 */
export async function putPreferences(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  items: readonly PreferenceItem[],
  requestId: string,
): Promise<void> {
  const mine = await myLocations(client);
  const roles = new Map(mine.map((l) => [l.locationId, l.role]));
  const stored = storedMap(await myPreferences(client));
  const before: Change[] = [];
  const after: Change[] = [];
  const apply = async (cell: Omit<PreferenceItem, 'enabled'>, next: boolean | undefined) => {
    const key = prefKey(cell.locationId, cell.kind, cell.channel);
    const was = stored.get(key);
    if (was === next) return;
    await writeCell(client, cell, next);
    if (next === undefined) stored.delete(key);
    else stored.set(key, next);
    before.push({ ...cell, enabled: was ?? null });
    after.push({ ...cell, enabled: next ?? null });
  };
  for (const item of items) {
    if (item.locationId !== null && isAccountLevel(item.kind)) {
      throw invalid(`${item.kind} belongs to your account: send it with locationId null.`);
    }
    const cell = { locationId: item.locationId, kind: item.kind, channel: item.channel };
    if (item.locationId === null) {
      const fallback = accountDefault(item.kind, item.channel);
      await apply(cell, item.enabled === fallback ? undefined : item.enabled);
      // Each location's own row that now matches what it inherits goes.
      for (const loc of mine) {
        const here = stored.get(prefKey(loc.locationId, item.kind, item.channel));
        if (here === undefined) continue;
        if (here === inherited(stored, loc.role, item.kind, item.channel)) {
          await apply({ ...cell, locationId: loc.locationId }, undefined);
        }
      }
      continue;
    }
    const role = roles.get(item.locationId);
    if (!role) throw notFound();
    const fallback = inherited(stored, role, item.kind, item.channel);
    await apply(cell, item.enabled === fallback ? undefined : item.enabled);
  }
  await auditPreferences(tx, userId, before, after, requestId);
}

/**
 * DELETE /api/v1/me/notification-preferences/:locationId (D239): the location's own choices go,
 * so it follows all locations again. A location the caller isn't an active member of is 404.
 */
export async function resetLocationPreferences(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  locationId: string,
  requestId: string,
): Promise<void> {
  if (!(await myLocations(client)).some((l) => l.locationId === locationId)) throw notFound();
  const { rows } = await client.query<{
    kind: NotifyKind;
    channel: PreferenceChannel;
    enabled: boolean;
  }>(
    `DELETE FROM public.notification_preferences
      WHERE user_id = kept.current_user_id() AND location_id = $1
      RETURNING kind, channel, enabled`,
    [locationId],
  );
  const sorted = rows.sort((a, b) =>
    `${a.kind}|${a.channel}`.localeCompare(`${b.kind}|${b.channel}`),
  );
  await auditPreferences(
    tx,
    userId,
    sorted.map((r) => ({ locationId, kind: r.kind, channel: r.channel, enabled: r.enabled })),
    sorted.map((r) => ({ locationId, kind: r.kind, channel: r.channel, enabled: null })),
    requestId,
  );
}

async function auditPreferences(
  tx: Tx,
  userId: string,
  before: Change[],
  after: Change[],
  requestId: string,
): Promise<void> {
  if (after.length === 0) return;
  await auditMine(tx, userId, {
    action: 'me.notification_preferences',
    entity: { type: 'user', id: userId },
    before: { preferences: before },
    after: { preferences: after },
    requestId,
  });
}
