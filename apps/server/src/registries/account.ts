import { type Action, can, type Role } from '@kept/shared';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import type { FieldClass } from '../audit/classes.js';
import type { Tx } from '../db/scope.js';
import type { ChangedBy } from '../http/conventions.js';
import { forbidden, notFound } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { enqueueReindex } from '../search/jobs.js';

// Who the caller is in an owner account (T11; D11, D123, plan Q21). An account's registries
// (types, place kinds, brands, vendors, people, tags) are reached through the locations of it the
// caller can see; their role in the account is their highest role across those. An account they
// can see nothing of is a 404, like any row they can't see (§7.7); a visible account their role
// can't change is a 403 from can() (product design §7.1): managing needs owner or admin
// somewhere in the account (`registries-types.manage`), inline creation of people, vendors and
// tags a member (`people-vendors.create-inline`, `tags.create`).

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export type AccountAccess = { accountId: string; role: Role; isOwn: boolean };

/** The caller's role in `accountId`, or null when they can see no location of it. */
export async function accountAccess(
  client: pg.ClientBase,
  accountId: string,
): Promise<AccountAccess | null> {
  const { rows } = await client.query<{ role: Role; is_own: boolean }>(
    `SELECT m.role, l.owner_account_id = kept.current_owner_account_id() AS is_own
       FROM public.memberships m JOIN public.locations l ON l.id = m.location_id
      WHERE l.owner_account_id = $1 AND m.user_id = kept.current_user_id()
        AND m.location_id IN (SELECT kept.visible_location_ids())`,
    [accountId],
  );
  if (rows.length === 0) return null;
  const role = rows.map((r) => r.role).reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  return { accountId, role, isOwn: rows[0]?.is_own === true };
}

/** 404 unless the caller sees the account; 403 unless their role there may do `action`. */
export async function requireAccount(
  client: pg.ClientBase,
  accountId: string,
  action?: Action,
  hint?: string,
): Promise<AccountAccess> {
  const access = await accountAccess(client, accountId);
  if (!access) throw notFound();
  if (action && !can(access.role, action)) throw forbidden(hint);
  return access;
}

/** What a registry write needs from its request. */
export type WriteCtx = {
  tx: Tx;
  client: pg.ClientBase;
  userId: string;
  /** Set when a personal token or an OAuth grant makes the write: the audit names it (actorOf). */
  tokenId?: string | null;
  requestId: string;
  jobs: JobQueue | null;
};

export const MANAGE_HINT = 'Only owners and admins manage types and registries.';

/** The account-level audit row of a registry write (plan Q15: readable by the account's admins). */
export async function auditRegistry(
  tx: Tx,
  event: {
    accountId: string;
    userId: string;
    tokenId?: string | null;
    action: string;
    entity: { type: string; id: string };
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    fieldClasses?: Record<string, FieldClass>;
    requestId: string;
  },
): Promise<void> {
  await audited(tx, {
    locationId: null,
    ownerAccountId: event.accountId,
    actor: actorOf({ userId: event.userId, tokenId: event.tokenId ?? undefined }),
    action: event.action,
    entity: event.entity,
    before: event.before ?? null,
    after: event.after ?? null,
    ...(event.fieldClasses ? { fieldClasses: event.fieldClasses } : {}),
    requestId: event.requestId,
  });
}

/** Who made the latest audited change to an entity, for a 412's `changedBy` (D156). */
export async function lastChangedBy(
  client: pg.ClientBase,
  entityType: string,
  entityId: string,
): Promise<ChangedBy | null> {
  const { rows } = await client.query<{ display_name: string | null }>(
    `SELECT p.display_name
       FROM public.audit_events e
       LEFT JOIN public.user_profiles p ON e.actor_type = 'user' AND p.user_id = e.actor_id
      WHERE e.entity_type = $1 AND e.entity_id = $2
      ORDER BY e.at DESC, e.id DESC LIMIT 1`,
    [entityType, entityId],
  );
  const name = rows[0]?.display_name;
  return name ? { displayName: name } : null;
}

/**
 * The account's locations where a live thing uses a registry row (kept.registry_use_locations,
 * 0026). The caller must administer the account; the ids only ever go into job data.
 */
export async function locationsUsing(
  client: pg.ClientBase,
  kind: 'type' | 'brand' | 'vendor' | 'person' | 'tag',
  id: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT u AS id FROM kept.registry_use_locations($1, $2) AS u',
    [kind, id],
  );
  return rows.map((r) => r.id);
}

/** A rename leaves the search documents of the things using the row stale: reindex (T20). */
export async function reindexUses(
  jobs: JobQueue | null,
  client: pg.ClientBase,
  kind: 'type' | 'brand' | 'person' | 'tag',
  id: string,
): Promise<void> {
  for (const locationId of await locationsUsing(client, kind, id)) {
    await enqueueReindex(jobs, client, locationId);
  }
}
