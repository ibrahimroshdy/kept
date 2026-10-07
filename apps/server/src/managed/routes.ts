import { randomBytes } from 'node:crypto';
import { isAPIError } from 'better-auth/api';
import { z } from 'zod';
import { ensureAccountAsSystem } from '../accounts/ensure-account.js';
import { audited } from '../audit/audited.js';
import type { Auth } from '../auth/auth.js';
import { requestClientIp } from '../auth/client-ip.js';
import { authHeaders } from '../auth/http.js';
import {
  createManagedUser,
  issueResetCode,
  ManagedAccountError,
  RESET_CODE_TTL_SECONDS,
  redeemResetCode,
  revokeUserSessions,
} from '../auth/managed.js';
import { clearSignInFailures, limiterKey, reserveSignInAttempt } from '../auth/sign-in-limiter.js';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../http/errors.js';
import { scopedWrite } from '../http/write.js';
import type { JobQueue } from '../jobs/queue.js';
import { outlasts, requireCan, requireMembership } from '../locations/access.js';
import { GrantableRole, Iso, locationViews } from '../locations/views.js';

// Managed accounts (task 21; D47, D114, D127, D164, D180, D197; spike S3).
// - An owner or admin creates one in a location: a username and a display name, no email. The
//   password is random and never shown; the response carries a one-time reset code (D164) the
//   person uses to set their own. So nobody but the person ever knows the password. That
//   location is the account's home (user_profiles.created_in_location_id). A location holds at
//   most 20 managed accounts (security review M9). A taken username answers 409: only owners and
//   admins can ask, so telling them is accepted (review M9).
// - D197: only the home location's owner, or the account's creator while still an unexpired
//   owner or admin there, can issue a new code (kept.managed_reset_location()). It signs the
//   account out everywhere once the audited transaction commits (D164).
// - Redeeming a code needs no session: POST /api/v1/auth/reset-code, limited per account + IP
//   (redeemResetCode) and per IP alone (carry-over: one address trying many usernames), and
//   audited in the home location (review M3).
// - A managed account can't own a location other than its Personal one (locations/routes.ts,
//   and the locations INSERT policy since 0010).

/** Managed accounts one location may hold (review M9). */
export const MAX_MANAGED_PER_LOCATION = 20;

const Params = z.object({ id: z.uuid() });
const UserParams = z.object({ userId: z.uuid() });

const CreateBody = z.object({
  displayName: z.string().trim().min(1).max(100),
  /** Better Auth's username plugin validates it (3–30 characters, letters, digits, _ and .) and
   * keeps it unique per instance, case-insensitively (§7.10). */
  username: z.string().trim().min(1).max(64),
  role: GrantableRole,
  expiresAt: Iso.nullable().optional(),
});

const Created = z.object({
  userId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  membershipId: z.uuid(),
  role: GrantableRole,
  expiresAt: Iso.nullable(),
  /** The one-time code the person sets their password with (D164). Not on an idempotent replay:
   * issue a new one with the reset-code route. */
  code: z.string().nullable(),
  codeExpiresAt: Iso,
});

const ResetCode = z.object({ code: z.string().nullable(), expiresAt: Iso });

const RedeemBody = z.object({
  username: z.string().trim().min(1).max(64),
  code: z.string().min(1).max(32),
  newPassword: z.string().min(1).max(256),
});

export type ManagedRoutesOptions = {
  auth: Auth;
  pools: Pick<Pools, 'app' | 'auth' | 'system'>;
  jobs: JobQueue | null;
  trustedProxies: readonly string[];
};

function fromAuthError(err: unknown): never {
  if (isAPIError(err)) {
    const code = String(err.body?.code ?? '');
    if (/TAKEN|ALREADY/.test(code)) throw conflict('That username is taken.');
    throw invalid(err.body?.message ?? 'Check body.username.');
  }
  throw err;
}

const codeExpiry = () => new Date(Date.now() + RESET_CODE_TTL_SECONDS * 1000).toISOString();

/** `managed_account.password_set` in the account's home location (or its Personal location when
 * the home is gone), actor the person themselves. */
async function auditPasswordSet(
  pools: Pick<Pools, 'system'>,
  userId: string,
  requestId: string,
): Promise<void> {
  await withSystem(pools.system, async (tx, client) => {
    const { rows } = await client.query<{ location_id: string | null; owner_account_id: string }>(
      `SELECT loc.location_id,
              (SELECT oa.id FROM public.memberships o
                 JOIN public.owner_accounts oa ON oa.user_id = o.user_id
                WHERE o.location_id = loc.location_id AND o.role = 'owner') AS owner_account_id
         FROM (SELECT coalesce(
                 p.created_in_location_id,
                 (SELECT m.location_id FROM public.memberships m
                    JOIN public.owner_accounts oa ON oa.user_id = m.user_id
                   WHERE m.user_id = p.user_id AND m.role = 'owner'
                   ORDER BY m.created_at LIMIT 1)) AS location_id
                 FROM public.user_profiles p WHERE p.user_id = $1) loc`,
      [userId],
    );
    const row = rows[0];
    if (!row?.location_id) return;
    await audited(tx, {
      locationId: row.location_id,
      ownerAccountId: row.owner_account_id,
      actor: { type: 'user', id: userId },
      action: 'managed_account.password_set',
      entity: { type: 'user', id: userId },
      requestId,
    });
  });
}

export async function managedRoutes(app: KeptApp, opts: ManagedRoutesOptions): Promise<void> {
  const { auth, pools, jobs } = opts;

  app.post(
    '/api/v1/locations/:id/managed-accounts',
    { schema: { params: Params, body: CreateBody, response: { 201: Created } } },
    async (req, reply) => {
      // The Better Auth user is made on its own login, before this transaction commits; if the
      // rest fails, it is deleted again, so no half-made account is left for the repair job to
      // turn into an ordinary one.
      let createdUserId: string | null = null;
      try {
        return await scopedWrite(
          pools,
          req,
          reply,
          async (tx, client, scope) => {
            const locationId = req.params.id;
            const body = req.body;
            const me = await requireMembership(client, locationId);
            requireCan(me.role, 'members.manage');
            if (body.role === 'admin') {
              requireCan(me.role, 'admins.manage', 'Only the owner makes admins.');
            }
            const [location] = await locationViews(client, locationId);
            if (!location) throw notFound();
            if (location.kind === 'personal') {
              throw conflict('A Personal location has no members but its owner.');
            }
            const until = body.expiresAt ? new Date(body.expiresAt) : null;
            if (until && until.getTime() <= Date.now()) {
              throw invalid('The end date must be in the future.');
            }
            if (outlasts(until, me.expiresAt)) {
              throw invalid("The end date can't be later than your own (D180).");
            }

            // Counted under a per-location lock, so two concurrent creates can't both fit.
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
              'kept.managed',
              locationId,
            ]);
            const { rows: count } = await client.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM public.memberships m
                 JOIN public.user_profiles p ON p.user_id = m.user_id
                WHERE m.location_id = $1 AND p.managed`,
              [locationId],
            );
            if ((count[0]?.n ?? 0) >= MAX_MANAGED_PER_LOCATION) {
              throw conflict(
                `A location can have ${MAX_MANAGED_PER_LOCATION} managed accounts; remove one first.`,
              );
            }

            const user = await createManagedUser(auth, {
              username: body.username,
              displayName: body.displayName,
              // Never shown to anyone: the person sets their own with the code below.
              password: randomBytes(32).toString('base64url'),
            }).catch(fromAuthError);
            createdUserId = user.userId;

            await client.query('SELECT kept.create_managed_profile($1, $2)', [
              user.userId,
              body.displayName,
            ]);
            const { rows } = await client.query<{ id: string }>(
              'SELECT kept.add_managed_member($1, $2, $3, $4) AS id',
              [locationId, user.userId, body.role, until],
            );
            const membershipId = rows[0]?.id as string;
            await audited(tx, {
              locationId,
              actor: { type: 'user', id: scope.userId },
              action: 'managed_account.create',
              entity: { type: 'membership', id: membershipId },
              after: {
                user_id: user.userId,
                username: user.username,
                display_name: body.displayName,
                role: body.role,
                expires_at: until,
              },
              requestId: req.id,
            });
            if (jobs) {
              await jobs.send(client, 'notify-owner-new-member', {
                locationId,
                userId: user.userId,
              });
            } else {
              req.log.warn({ locationId }, 'no job queue: the owner was not notified');
            }
            // A brand-new user has no sessions to sign out.
            const code = await issueResetCode(auth, user.userId, { revokeSessions: false });
            return {
              status: 201,
              body: {
                userId: user.userId,
                username: user.username,
                displayName: body.displayName,
                membershipId,
                role: body.role,
                expiresAt: until?.toISOString() ?? null,
                code,
                codeExpiresAt: codeExpiry(),
              },
              // D114: the account and Personal location every user has, made as the system
              // for the new user (nobody holds their scope yet). The repair job would do it
              // within the hour if this failed.
              afterCommit: async () => {
                await ensureAccountAsSystem(pools, user.userId);
              },
            };
          },
          { redact: (body) => ({ ...(body as object), code: null }) },
        );
      } catch (err) {
        if (createdUserId) {
          const ctx = await auth.$context;
          await ctx.internalAdapter.deleteUser(createdUserId).catch((cleanupErr: unknown) => {
            req.log.error({ err: cleanupErr }, 'could not remove a half-made managed account');
          });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/v1/managed-accounts/:userId/reset-code',
    { schema: { params: UserParams, response: { 200: ResetCode } } },
    (req, reply) =>
      scopedWrite(
        pools,
        req,
        reply,
        async (tx, client, scope) => {
          const { userId } = req.params;
          // Under the caller's policies: a profile they can't see (no shared location) is a 404.
          const { rows } = await client.query<{ managed: boolean; reset_location: string | null }>(
            `SELECT p.managed, kept.managed_reset_location(p.user_id) AS reset_location
               FROM public.user_profiles p
              WHERE p.user_id = $1 AND p.user_id <> kept.current_user_id()`,
            [userId],
          );
          const target = rows[0];
          if (!target?.managed) throw notFound();
          // D197: the home location's owner, or the creator while an owner or admin there.
          const locationId = target.reset_location;
          if (!locationId) {
            throw forbidden(
              "Only the owner of the account's home location, or whoever created it while still an admin there, can reset it.",
            );
          }
          await audited(tx, {
            locationId,
            actor: { type: 'user', id: scope.userId },
            action: 'managed_account.reset_code',
            entity: { type: 'user', id: userId },
            after: { sessions_revoked: true },
            requestId: req.id,
          });
          // Replaces any earlier code. Signing the account out everywhere (D164) waits for the
          // commit, so a rolled-back request signs nobody out (review M3).
          let code: string;
          try {
            code = await issueResetCode(auth, userId, { revokeSessions: false });
          } catch (err) {
            if (err instanceof ManagedAccountError && err.code === 'not_managed') throw notFound();
            throw err;
          }
          return {
            status: 200,
            body: { code, expiresAt: codeExpiry() },
            afterCommit: () => revokeUserSessions(auth, userId),
          };
        },
        { redact: (body) => ({ ...(body as object), code: null }) },
      ),
  );

  // The person redeems the code and chooses their password; they then sign in with their
  // username. No session needed; limited per IP here and per username + IP inside.
  app.post(
    '/api/v1/auth/reset-code',
    { config: { auth: 'none' }, bodyLimit: 4096, schema: { body: RedeemBody } },
    async (req, reply) => {
      const ip = requestClientIp(authHeaders(req, opts.trustedProxies));
      if (!ip) throw invalid('The client address could not be determined.');
      const ipKey = limiterKey('reset-code-ip', ip);
      const decision = await reserveSignInAttempt(pools.auth, ipKey);
      if (!decision.allowed) {
        reply.header('retry-after', String(decision.retryAfter));
        throw new AppError('rate_limited', 429, undefined, { retryAfter: decision.retryAfter });
      }
      let redeemed: { userId: string };
      try {
        redeemed = await redeemResetCode(auth, pools.auth, { ...req.body, ip });
      } catch (err) {
        if (err instanceof ManagedAccountError) {
          if (err.code === 'code_delayed') {
            const retryAfter = err.retryAfter ?? 60;
            reply.header('retry-after', String(retryAfter));
            throw new AppError('rate_limited', 429, undefined, { retryAfter });
          }
          if (err.code === 'invalid_password') throw invalid(err.message);
          throw new AppError('token_invalid', 400, 'Check the code, or ask for a new one.');
        }
        throw err;
      }
      await clearSignInFailures(pools.auth, ipKey);
      // Audited in the account's home location, as the person (review M3). There is no session,
      // so the system writes it; the password is already set, so a failure here is logged.
      await auditPasswordSet(pools, redeemed.userId, req.id).catch((err: unknown) => {
        req.log.error({ err }, 'reset-code redemption not audited');
      });
      return reply.code(204).send();
    },
  );
}
