import { can } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import type { Pools } from '../db/pools.js';
import type { Tx } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { checkVersion, paginationQuery, requireIfMatch } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { outlasts, requireCan, requireMembership } from './access.js';
import {
  GrantableRole,
  keysetPage,
  MemberKeySchema,
  MemberView,
  memberPage,
  memberViews,
  nextCursor,
  PendingInviteView,
  pendingInviteViews,
} from './views.js';

// Memberships (task 19; D46, D48, D180; screens §5 Members and roles).
// - Owners and admins manage members and viewers; only the owner manages admins (D48).
// - An end date an admin sets is never later than their own (D46, D180).
// - Nobody changes the owner's row; ownership moves only by transfer (a later, deliberate path).
// - Anyone but the owner can leave: DELETE their own membership (0008 app_delete_own). The owner
//   gets 409 `last_owner`.
// - Since 0010 the policies hold the same lines (security review I3), and an admin can't touch a
//   membership that outlasts their own: that one is the owner's to change.
// - D180 again (review M6): when an admin is shortened, demoted, removed or leaves, the
//   memberships they created are capped at the admin's new end (now, for removal), in the same
//   transaction, each with a `member.recap` event.
// - PATCH updates only the row version it read (If-Match), so of two racing edits one gets 412
//   (review M2).
// - GET is paginated (§7.7): `limit` and `cursor`, answering `nextCursor`. Pending invites (at
//   most 50, invites/routes.ts) come whole with every page.

const Params = z.object({ id: z.uuid() });
const MemberParams = z.object({ id: z.uuid(), membershipId: z.uuid() });

const PatchBody = z
  .object({
    role: GrantableRole,
    /** An end date in the future, or null for none. */
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .partial()
  .refine((b) => b.role !== undefined || b.expiresAt !== undefined, {
    message: 'Nothing to change.',
  });

type TargetRow = {
  id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  expires_at: Date | null;
  row_version: number;
};

async function targetMembership(
  client: pg.ClientBase,
  locationId: string,
  membershipId: string,
): Promise<TargetRow> {
  const { rows } = await client.query<TargetRow>(
    `SELECT id, user_id, role, expires_at, row_version FROM public.memberships
      WHERE id = $1 AND location_id = $2 AND (expires_at IS NULL OR expires_at > now())`,
    [membershipId, locationId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * D180 (review M6): memberships `adminUserId` created in `locationId` can't outlast `cap`, the
 * admin's own end after a change (now, when they are removed or leave). Null: no end, nothing to
 * cap. Runs as the caller, under the memberships policies.
 */
async function recapInvitees(
  tx: Tx,
  client: pg.ClientBase,
  opts: {
    locationId: string;
    adminUserId: string;
    cap: Date | null;
    actorId: string;
    requestId: string;
  },
): Promise<void> {
  if (!opts.cap) return;
  const { rows } = await client.query<{ id: string; user_id: string; before: Date | null }>(
    `WITH old AS (
       SELECT id, expires_at FROM public.memberships
        WHERE location_id = $1 AND invited_by = $2 AND user_id <> $2 AND role <> 'owner'
          AND (expires_at IS NULL OR expires_at > $3)
          FOR UPDATE)
     UPDATE public.memberships m SET expires_at = $3
       FROM old WHERE m.id = old.id
     RETURNING m.id, m.user_id, old.expires_at AS before`,
    [opts.locationId, opts.adminUserId, opts.cap],
  );
  for (const r of rows) {
    await audited(tx, {
      locationId: opts.locationId,
      actor: { type: 'user', id: opts.actorId },
      action: 'member.recap',
      entity: { type: 'membership', id: r.id },
      before: { user_id: r.user_id, expires_at: r.before },
      after: { user_id: r.user_id, expires_at: opts.cap, invited_by: opts.adminUserId },
      requestId: opts.requestId,
    });
  }
}

export async function memberRoutes(
  app: KeptApp,
  opts: { pools: Pick<Pools, 'app' | 'auth'> },
): Promise<void> {
  const { pools } = opts;

  app.get(
    '/api/v1/locations/:id/members',
    {
      schema: {
        params: Params,
        querystring: paginationQuery,
        response: {
          200: z.object({
            members: z.array(MemberView),
            invites: z.array(PendingInviteView),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client, scope) => {
        const me = await requireMembership(client, req.params.id);
        const page = await memberPage(
          client,
          pools.auth,
          req.params.id,
          { userId: scope.userId, role: me.role },
          keysetPage(req.query, MemberKeySchema),
        );
        // Pending invites are for those who manage members; the policy shows them nobody else.
        const invites = can(me.role, 'members.manage')
          ? await pendingInviteViews(client, req.params.id)
          : [];
        return { members: page.items, invites, nextCursor: nextCursor(page.next) };
      }),
  );

  app.patch(
    '/api/v1/locations/:id/members/:membershipId',
    { schema: { params: MemberParams, body: PatchBody, response: { 200: MemberView } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const { id, membershipId } = req.params;
        const expected = requireIfMatch(req);
        const me = await requireMembership(client, id);
        requireCan(me.role, 'members.manage');
        const target = await targetMembership(client, id, membershipId);
        if (target.role === 'owner') {
          throw forbidden("The owner's membership can't be changed; transfer ownership instead.");
        }
        if (target.user_id === scope.userId) {
          throw forbidden("You can't change your own role or end date.");
        }
        const body = req.body;
        // D48: promoting, demoting or changing an admin is the owner's alone.
        if (target.role === 'admin' || body.role === 'admin') {
          requireCan(me.role, 'admins.manage', 'Only the owner manages admins.');
        }
        checkVersion({ rowVersion: target.row_version }, expected, Object.keys(body));
        if (body.expiresAt === undefined && outlasts(target.expires_at, me.expiresAt)) {
          throw forbidden(
            'This membership outlasts yours, so only the owner can change it (D180).',
          );
        }
        let expiresAt = target.expires_at;
        if (body.expiresAt !== undefined) {
          expiresAt = body.expiresAt === null ? null : new Date(body.expiresAt);
          if (expiresAt && expiresAt.getTime() <= Date.now()) {
            throw invalid('The end date must be in the future.');
          }
          if (outlasts(expiresAt, me.expiresAt)) {
            throw invalid("The end date can't be later than your own (D180).");
          }
        }
        const role = body.role ?? target.role;
        // Only the version the client read: a concurrent edit makes this match nothing.
        const { rowCount } = await client.query(
          `UPDATE public.memberships SET role = $2, expires_at = $3
            WHERE id = $1 AND row_version = $4`,
          [membershipId, role, expiresAt, expected],
        );
        if (!rowCount) {
          const now = await targetMembership(client, id, membershipId);
          checkVersion({ rowVersion: now.row_version }, expected, Object.keys(body));
          throw notFound();
        }
        if (target.role === 'admin') {
          await recapInvitees(tx, client, {
            locationId: id,
            adminUserId: target.user_id,
            cap: expiresAt,
            actorId: scope.userId,
            requestId: req.id,
          });
        }
        await audited(tx, {
          locationId: id,
          actor: { type: 'user', id: scope.userId },
          action: 'member.update',
          entity: { type: 'membership', id: membershipId },
          before: { user_id: target.user_id, role: target.role, expires_at: target.expires_at },
          after: { user_id: target.user_id, role, expires_at: expiresAt },
          requestId: req.id,
        });
        const [view] = await memberViews(
          client,
          pools.auth,
          id,
          { userId: scope.userId, role: me.role },
          membershipId,
        );
        if (!view) throw notFound();
        return { status: 200, body: view };
      }),
  );

  app.delete(
    '/api/v1/locations/:id/members/:membershipId',
    { schema: { params: MemberParams } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const { id, membershipId } = req.params;
        const me = await requireMembership(client, id);
        const target = await targetMembership(client, id, membershipId);
        const leaving = target.user_id === scope.userId;
        if (leaving) {
          if (target.role === 'owner') {
            throw new AppError(
              'last_owner',
              409,
              'Transfer the location to someone else, or delete it, instead of leaving.',
            );
          }
        } else {
          requireCan(me.role, 'members.manage');
          if (target.role === 'owner') throw forbidden("The owner can't be removed.");
          if (target.role === 'admin') {
            requireCan(me.role, 'admins.manage', 'Only the owner removes admins.');
          }
        }
        // D180: whoever an admin let in can't outlast them (review M6). Before the delete, while
        // a leaving admin still administers the location.
        if (target.role === 'admin') {
          await recapInvitees(tx, client, {
            locationId: id,
            adminUserId: target.user_id,
            cap: new Date(),
            actorId: scope.userId,
            requestId: req.id,
          });
        }
        // Audited first: after leaving, the location is no longer visible to the leaver, and
        // their event would be refused.
        await audited(tx, {
          locationId: id,
          actor: { type: 'user', id: scope.userId },
          action: leaving ? 'member.leave' : 'member.remove',
          entity: { type: 'membership', id: membershipId },
          before: { user_id: target.user_id, role: target.role, expires_at: target.expires_at },
          requestId: req.id,
        });
        const { rowCount } = await client.query('DELETE FROM public.memberships WHERE id = $1', [
          membershipId,
        ]);
        if (!rowCount) throw notFound();
        return { status: 204, body: null };
      }),
  );
}
