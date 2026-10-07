import {
  effectiveModules,
  MODULE_IDS,
  type ModuleId,
  PRESETS,
  type Preset,
  presetModules,
  ROLES,
  type Role,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { LOCATION_KINDS } from '../db/schema/index.js';
import { decodeCursor, encodeCursor } from '../http/conventions.js';
import { invalid } from '../http/errors.js';

// What the API shows of a location and its people (tasks 19–21). Field names are camelCase, as
// the web app's types (apps/web/src/api/types.ts) expect; dates are ISO 8601 strings.

export const Iso = z.iso.datetime({ offset: true });
export const LocationKind = z.enum(LOCATION_KINDS);
export const RoleSchema = z.enum(ROLES);
export const GrantableRole = z.enum(['admin', 'member', 'viewer']);
export const ModuleIdSchema = z.enum(MODULE_IDS);

export const LocationView = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: LocationKind,
  /** The owner account the location belongs to: its registries, types and place kinds (T25). */
  ownerAccountId: z.uuid(),
  /** The caller's role here. */
  role: RoleSchema,
  /** The caller's own end date here (D46), or null. */
  membershipExpiresAt: Iso.nullable(),
  preset: z.enum(PRESETS),
  timezone: z.string(),
  currency: z.string(),
  languages: z.array(z.string()),
  require2fa: z.boolean(),
  moneyVisibleToViewers: z.boolean(),
  longUnseenMonths: z.number().int(),
  /** The owner's nominated successor (D165); shown to the owner only. */
  successorUserId: z.uuid().nullable(),
  memberCount: z.number().int(),
  /** Its live things (trash left out), as the caller's policies let them count. */
  thingCount: z.number().int(),
  /** Unaccepted, unexpired invites; counted for owners and admins only (0 otherwise). */
  pendingInviteCount: z.number().int(),
  /** Modules switched on here: the preset's, then this location's own switches (D61). */
  modules: z.array(ModuleIdSchema),
  /** The modules actually on: switched on, dependencies met, AI modules with a provider. */
  effectiveModules: z.array(ModuleIdSchema),
  /** An AI provider resolves for this location (D113, D191). Step 3 wires the real check. */
  providerResolved: z.boolean(),
  /** For If-Match on PATCH (§7.7). */
  rowVersion: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type LocationView = z.infer<typeof LocationView>;

type LocationRow = {
  id: string;
  owner_account_id: string;
  name: string;
  kind: z.infer<typeof LocationKind>;
  preset: Preset;
  timezone: string;
  currency: string;
  languages: string[];
  require_2fa: boolean;
  money_visible_to_viewers: boolean;
  long_unseen_months: number;
  successor_user_id: string | null;
  provider_resolved: boolean;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  role: Role;
  membership_expires_at: Date | null;
  member_count: number;
  thing_count: number;
  pending_invite_count: number;
  sort_name: string;
};

/** A page of a keyset-sorted list (§7.7): at most `limit` rows after the row whose sort key is
 * `after` (null: from the start). */
export type KeysetPage<K> = { limit: number; after: K | null };

/** The page a request asks for (`limit` and `cursor` from paginationQuery), its cursor checked
 * against the list's key shape. */
export function keysetPage<K>(
  query: { limit: number; cursor?: string | undefined },
  schema: z.ZodType<K>,
): KeysetPage<K> {
  if (!query.cursor) return { limit: query.limit, after: null };
  const parsed = schema.safeParse(decodeCursor(query.cursor));
  if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
  return { limit: query.limit, after: parsed.data };
}

/** The next page's cursor, or null at the end. */
export const nextCursor = (key: unknown | null): string | null =>
  key === null ? null : encodeCursor(key);

/** Locations sort Personal first, then by name, then id; this is a row's key in that order. */
export type LocationKey = [personalLast: number, name: string, id: string];
export const LocationKeySchema = z.tuple([z.number().int(), z.string(), z.uuid()]);

/** The locations the caller can see (one, with `locationId`; or a page), with their role in
 * each. */
export async function locationViews(
  client: pg.ClientBase,
  locationId: string | null = null,
): Promise<LocationView[]> {
  return (await locationRows(client, locationId, null)).map((r) => r.view);
}

/** One page of the caller's locations, and the cursor for the next (null at the end). */
export async function locationPage(
  client: pg.ClientBase,
  page: KeysetPage<LocationKey>,
): Promise<{ items: LocationView[]; next: LocationKey | null }> {
  const rows = await locationRows(client, null, page);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: items.map((r) => r.view),
    next:
      rows.length > page.limit && last
        ? [last.row.kind === 'personal' ? 0 : 1, last.row.sort_name, last.row.id]
        : null,
  };
}

async function locationRows(
  client: pg.ClientBase,
  locationId: string | null,
  page: KeysetPage<LocationKey> | null,
): Promise<{ row: LocationRow; view: LocationView }[]> {
  const { rows } = await client.query<LocationRow>(
    `SELECT l.id, l.owner_account_id, l.name, l.kind, l.preset, l.timezone, l.currency, l.languages, l.require_2fa,
            l.money_visible_to_viewers, l.long_unseen_months, l.successor_user_id, l.row_version,
            l.created_at, l.updated_at, m.role, m.expires_at AS membership_expires_at,
            lower(l.name) AS sort_name,
            kept.ai_provider_resolved(l.id) AS provider_resolved,
            (SELECT count(*) FROM public.memberships mm
              WHERE mm.location_id = l.id
                AND (mm.expires_at IS NULL OR mm.expires_at > now()))::int AS member_count,
            (SELECT count(*) FROM public.things t
              WHERE t.location_id = l.id AND t.deleted_at IS NULL)::int AS thing_count,
            (SELECT count(*) FROM public.invites i
              WHERE i.location_id = l.id AND i.accepted_at IS NULL
                AND i.expires_at > now())::int AS pending_invite_count
       FROM public.locations l
       JOIN public.memberships m ON m.location_id = l.id AND m.user_id = kept.current_user_id()
      WHERE ($1::uuid IS NULL OR l.id = $1)
        AND ($2::int IS NULL
             OR (CASE WHEN l.kind = 'personal' THEN 0 ELSE 1 END, lower(l.name), l.id)
                > ($2::int, $3::text, $4::uuid))
      ORDER BY CASE WHEN l.kind = 'personal' THEN 0 ELSE 1 END, lower(l.name), l.id
      LIMIT $5`,
    [
      locationId,
      page?.after?.[0] ?? null,
      page?.after?.[1] ?? null,
      page?.after?.[2] ?? null,
      page ? page.limit + 1 : null,
    ],
  );
  if (rows.length === 0) return [];
  const switches = await client.query<{ location_id: string; module: string; enabled: boolean }>(
    'SELECT location_id, module, enabled FROM public.location_modules WHERE location_id = ANY($1)',
    [rows.map((r) => r.id)],
  );
  const byLocation = new Map<string, { module: string; enabled: boolean }[]>();
  for (const s of switches.rows) {
    const list = byLocation.get(s.location_id) ?? [];
    list.push(s);
    byLocation.set(s.location_id, list);
  }
  return rows.map((r) => {
    const enabled = switchedOn(r.preset, byLocation.get(r.id) ?? []);
    const view: LocationView = {
      id: r.id,
      name: r.name,
      kind: r.kind,
      ownerAccountId: r.owner_account_id,
      role: r.role,
      membershipExpiresAt: r.membership_expires_at?.toISOString() ?? null,
      preset: r.preset,
      timezone: r.timezone,
      currency: r.currency.trim(),
      languages: r.languages,
      require2fa: r.require_2fa,
      moneyVisibleToViewers: r.money_visible_to_viewers,
      longUnseenMonths: r.long_unseen_months,
      successorUserId: r.role === 'owner' ? r.successor_user_id : null,
      memberCount: r.member_count,
      thingCount: r.thing_count,
      pendingInviteCount: r.pending_invite_count,
      modules: [...enabled],
      effectiveModules: [
        ...effectiveModules(enabled, { providerResolved: r.provider_resolved === true }),
      ],
      // Step 3 (T9, D191): AI capture follows a provider that resolves for the caller here.
      providerResolved: r.provider_resolved === true,
      rowVersion: r.row_version,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
    return { row: r, view };
  });
}

/** A preset's modules with a location's own switches applied, in registry order. */
export function switchedOn(
  preset: Preset,
  switches: readonly { module: string; enabled: boolean }[],
): Set<ModuleId> {
  const on = presetModules(preset) as Set<string>;
  for (const s of switches) {
    if (s.enabled) on.add(s.module);
    else on.delete(s.module);
  }
  return new Set(MODULE_IDS.filter((id) => on.has(id)));
}

// ---------------------------------------------------------------------------------------------
// Members and pending invites
// ---------------------------------------------------------------------------------------------

export const MemberView = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  displayName: z.string(),
  /** Shown to owners and admins (and to the member themselves); never for managed accounts. */
  email: z.string().nullable(),
  /** A managed account's sign-in name (D47); shown to owners and admins and the member. */
  username: z.string().nullable(),
  role: RoleSchema,
  expiresAt: Iso.nullable(),
  managed: z.boolean(),
  /** For managed accounts: who created it (D47), when the caller can see that person. */
  managedByName: z.string().nullable(),
  /** Not tracked per location yet. */
  lastActiveAt: Iso.nullable(),
  /** Shown to owners and admins; false otherwise. */
  twoFactorEnabled: z.boolean(),
  isYou: z.boolean(),
  /** For If-Match on PATCH (§7.7). */
  rowVersion: z.number().int(),
});
export type MemberView = z.infer<typeof MemberView>;

export const PendingInviteView = z.object({
  id: z.uuid(),
  role: GrantableRole,
  /** When the link stops working (7 days, D33). */
  expiresAt: Iso,
  /** The membership end date the invite grants, or null. */
  membershipExpiresAt: Iso.nullable(),
  email: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: Iso,
});
export type PendingInviteView = z.infer<typeof PendingInviteView>;

type MemberRow = {
  id: string;
  user_id: string;
  role: Role;
  expires_at: Date | null;
  row_version: number;
  display_name: string | null;
  managed: boolean | null;
  created_by_name: string | null;
  rank: number;
  sort_name: string;
};

type AuthUserRow = {
  id: string;
  email: string;
  username: string | null;
  two_factor_enabled: boolean | null;
};

/** Members sort owner, admins, members, viewers, then by name, then id. */
export type MemberKey = [rank: number, name: string, id: string];
export const MemberKeySchema = z.tuple([z.number().int(), z.string(), z.uuid()]);

/**
 * The location's current members (one, with `membershipId`; or a page), as the caller may see
 * them. The
 * rows come from kept_app under the caller's policies; only then are those users' sign-in details
 * read from schema auth (kept_auth), by the ids already found, so nothing is looked up for a
 * user the caller couldn't see.
 */
export async function memberViews(
  client: pg.ClientBase,
  authPool: pg.Pool,
  locationId: string,
  caller: { userId: string; role: Role },
  membershipId: string | null = null,
): Promise<MemberView[]> {
  return (await memberRows(client, authPool, locationId, caller, membershipId, null)).map(
    (r) => r.view,
  );
}

/** One page of the location's members, and the cursor for the next (null at the end). */
export async function memberPage(
  client: pg.ClientBase,
  authPool: pg.Pool,
  locationId: string,
  caller: { userId: string; role: Role },
  page: KeysetPage<MemberKey>,
): Promise<{ items: MemberView[]; next: MemberKey | null }> {
  const rows = await memberRows(client, authPool, locationId, caller, null, page);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: items.map((r) => r.view),
    next:
      rows.length > page.limit && last ? [last.row.rank, last.row.sort_name, last.row.id] : null,
  };
}

async function memberRows(
  client: pg.ClientBase,
  authPool: pg.Pool,
  locationId: string,
  caller: { userId: string; role: Role },
  membershipId: string | null,
  page: KeysetPage<MemberKey> | null,
): Promise<{ row: MemberRow; view: MemberView }[]> {
  const { rows } = await client.query<MemberRow>(
    `SELECT m.id, m.user_id, m.role, m.expires_at, m.row_version, p.display_name, p.managed,
            cp.display_name AS created_by_name,
            CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END
              AS rank,
            lower(coalesce(p.display_name, '')) AS sort_name
       FROM public.memberships m
       LEFT JOIN public.user_profiles p ON p.user_id = m.user_id
       LEFT JOIN public.user_profiles cp ON cp.user_id = p.created_by_user_id
      WHERE m.location_id = $1 AND ($2::uuid IS NULL OR m.id = $2)
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND ($3::int IS NULL
             OR (CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
                 lower(coalesce(p.display_name, '')), m.id) > ($3::int, $4::text, $5::uuid))
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
               lower(coalesce(p.display_name, '')), m.id
      LIMIT $6`,
    [
      locationId,
      membershipId,
      page?.after?.[0] ?? null,
      page?.after?.[1] ?? null,
      page?.after?.[2] ?? null,
      page ? page.limit + 1 : null,
    ],
  );
  if (rows.length === 0) return [];
  const users = await authPool.query<AuthUserRow>(
    'SELECT id, email, username, two_factor_enabled FROM auth."user" WHERE id = ANY($1)',
    [rows.map((r) => r.user_id)],
  );
  const byId = new Map(users.rows.map((u) => [u.id, u]));
  const manages = caller.role === 'owner' || caller.role === 'admin';
  return rows.map((r) => {
    const u = byId.get(r.user_id);
    const isYou = r.user_id === caller.userId;
    const managed = r.managed === true;
    const details = manages || isYou;
    const view: MemberView = {
      membershipId: r.id,
      userId: r.user_id,
      displayName: r.display_name ?? '',
      email: details && !managed ? (u?.email ?? null) : null,
      username: details && managed ? (u?.username ?? null) : null,
      role: r.role,
      expiresAt: r.expires_at?.toISOString() ?? null,
      managed,
      managedByName: managed ? r.created_by_name : null,
      lastActiveAt: null,
      twoFactorEnabled: details ? u?.two_factor_enabled === true : false,
      isYou,
      rowVersion: r.row_version,
    };
    return { row: r, view };
  });
}

/** Unaccepted, unexpired invites. kept_app's policy shows them to owners and admins only. */
export async function pendingInviteViews(
  client: pg.ClientBase,
  locationId: string,
): Promise<PendingInviteView[]> {
  const { rows } = await client.query<{
    id: string;
    role: 'admin' | 'member' | 'viewer';
    expires_at: Date;
    membership_expires_at: Date | null;
    email: string | null;
    created_at: Date;
    created_by_name: string | null;
  }>(
    `SELECT i.id, i.role, i.expires_at, i.membership_expires_at, i.email, i.created_at,
            p.display_name AS created_by_name
       FROM public.invites i LEFT JOIN public.user_profiles p ON p.user_id = i.created_by
      WHERE i.location_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now()
      ORDER BY i.created_at DESC, i.id`,
    [locationId],
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    expiresAt: r.expires_at.toISOString(),
    membershipExpiresAt: r.membership_expires_at?.toISOString() ?? null,
    email: r.email,
    createdByName: r.created_by_name,
    createdAt: r.created_at.toISOString(),
  }));
}
