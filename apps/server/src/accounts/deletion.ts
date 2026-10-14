import { z } from 'zod';
import type { Auth } from '../auth/auth.js';
import { isUndeliverableEmail } from '../auth/emails.js';
import { requireScope } from '../auth/http.js';
import { requireReauthentication } from '../auth/reauth.js';
import type { Pools } from '../db/pools.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, forbidden } from '../http/errors.js';
import { Iso } from '../locations/views.js';
import type { Mailer } from '../mail/mailer.js';
import { auditMine } from '../notify/prefs.js';

// Deleting your own account (1.2, D225; D49 with D114 and D149's grace).
//   GET    /api/v1/me/deletion  → {purgeAfter, blockers}: when it goes (null: not asked), and what
//                                 stops it: locations it owns besides its Personal one, being the
//                                 instance's last admin, being a managed account.
//   POST   /api/v1/me/deletion {password?} → 202 {purgeAfter}: re-authentication (D176), then 30
//                                 days' grace. Every other session is signed out and the address
//                                 is mailed. 409 `account_deletion_blocked` with `blockers`.
//   DELETE /api/v1/me/deletion  → {purgeAfter: null}: keep the account.
// A signed-in person only (a token gets 403). While the account waits, the session gate answers
// 403 `account_deletion_pending` everywhere but /me and these routes (auth/http.ts); its tokens,
// connectors, calendar feed and reminders are paused by the database (the migration that made
// auth.user_deletion), and the daily purge deletes it when the date passes (trash/jobs.ts).

export const ACCOUNT_DELETION_DAYS = 30;

const Blockers = z.object({
  locations: z.array(z.object({ id: z.uuid(), name: z.string() })),
  lastInstanceAdmin: z.boolean(),
  managed: z.boolean(),
});
export type DeletionBlockers = z.infer<typeof Blockers>;

const State = z.object({ purgeAfter: Iso.nullable(), blockers: Blockers });

const blocked = (b: DeletionBlockers) => b.locations.length > 0 || b.lastInstanceAdmin || b.managed;

export type AccountDeletionOptions = {
  auth: Auth;
  pools: Pick<Pools, 'app' | 'auth'>;
  mailer: Mailer;
  trustedProxies: readonly string[];
  /** A mail that could not be sent (the request itself still succeeds). */
  onMailError?: (err: unknown) => void;
};

export async function accountDeletionRoutes(
  app: KeptApp,
  opts: AccountDeletionOptions,
): Promise<void> {
  const { auth, pools, mailer, trustedProxies } = opts;

  /** A cookie session only: tokens never delete or keep an account. */
  const person = (req: Parameters<typeof requireScope>[0]) => {
    const scope = requireScope(req);
    if (!req.authSession || req.token) throw forbidden('Only you, signed in, can do this.');
    return scope;
  };

  const purgeAfterOf = async (userId: string): Promise<string | null> => {
    const { rows } = await pools.auth.query<{ purge_after: Date }>(
      'SELECT purge_after FROM auth.user_deletion WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.purge_after.toISOString() ?? null;
  };

  app.get(
    '/api/v1/me/deletion',
    { config: { allowDeletionPending: true }, schema: { response: { 200: State } } },
    async (req) => {
      const scope = person(req);
      const blockers = await withScope(pools.app, scope, async (_tx, client) => {
        const { rows } = await client.query<{ b: DeletionBlockers }>(
          'SELECT kept.account_deletion_blockers() AS b',
        );
        return rows[0]?.b as DeletionBlockers;
      });
      return { purgeAfter: await purgeAfterOf(scope.userId), blockers };
    },
  );

  app.post(
    '/api/v1/me/deletion',
    {
      schema: {
        body: z.object({ password: z.string().max(128).optional() }).strict(),
        response: { 202: z.object({ purgeAfter: Iso }) },
      },
    },
    async (req, reply) => {
      const scope = person(req);
      // What stops it is said before the password is asked for.
      const before = await withScope(pools.app, scope, async (_tx, client) => {
        const { rows } = await client.query<{ b: DeletionBlockers }>(
          'SELECT kept.account_deletion_blockers() AS b',
        );
        return rows[0]?.b as DeletionBlockers;
      });
      if (blocked(before)) {
        throw new AppError('account_deletion_blocked', 409, undefined, { blockers: before });
      }
      const { email } = await requireReauthentication(req, reply, {
        auth,
        pools,
        trustedProxies,
        password: req.body.password,
        hints: { stale: 'Sign in again, then delete your account.' },
      });

      let profile: { timezone: string } | undefined;
      let purgeAfter: string;
      try {
        ({ purgeAfter, profile } = await withScope(pools.app, scope, async (tx, client) => {
          const { rows } = await client.query<{ due: Date }>(
            'SELECT kept.request_account_deletion() AS due',
          );
          const due = (rows[0] as { due: Date }).due.toISOString();
          const p = await client.query<{ timezone: string }>(
            'SELECT timezone FROM public.user_profiles WHERE user_id = kept.current_user_id()',
          );
          await auditMine(tx, scope.userId, {
            action: 'account.deletion_request',
            entity: { type: 'user', id: scope.userId },
            after: { purgeAfter: due },
            requestId: req.id,
          });
          return { purgeAfter: due, profile: p.rows[0] };
        }));
      } catch (err) {
        if ((err as { constraint?: string }).constraint === 'account_deletion_blocked') {
          throw new AppError('account_deletion_blocked', 409);
        }
        throw err;
      }

      // Every other session ends now (D225); this one stays to show the date and keep it.
      await pools.auth.query('DELETE FROM auth.session WHERE user_id = $1 AND id <> $2', [
        scope.userId,
        req.authSession?.sessionId,
      ]);
      if (!isUndeliverableEmail(email)) {
        mailer
          .send({
            kind: 'account-deletion',
            to: email,
            purgeAfter,
            timezone: profile?.timezone ?? 'UTC',
          })
          .catch((err: unknown) => opts.onMailError?.(err));
      }
      return reply.code(202).send({ purgeAfter });
    },
  );

  app.delete(
    '/api/v1/me/deletion',
    {
      config: { allowDeletionPending: true },
      schema: { response: { 200: z.object({ purgeAfter: z.null() }) } },
    },
    async (req) => {
      const scope = person(req);
      await withScope(pools.app, scope, async (tx, client) => {
        const { rows } = await client.query<{ kept: boolean }>(
          'SELECT kept.cancel_account_deletion() AS kept',
        );
        if (rows[0]?.kept) {
          await auditMine(tx, scope.userId, {
            action: 'account.deletion_cancel',
            entity: { type: 'user', id: scope.userId },
            requestId: req.id,
          });
        }
      });
      return { purgeAfter: null };
    },
  );
}
