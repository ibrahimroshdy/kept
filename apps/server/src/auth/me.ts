import { z } from 'zod';
import { auditAccountEvent } from '../accounts/account-audit.js';
import type { Pools } from '../db/pools.js';
import type { KeptApp } from '../http/app.js';
import { notFound } from '../http/errors.js';
import { requireScope } from './http.js';

// The signed-in user's devices (task 17): every live session, and revoking one. Sessions are
// Better Auth's rows in schema auth, so these read and write through kept_auth; the audit event
// goes through kept_app like any other.

const SessionView = z.object({
  id: z.uuid(),
  userAgent: z.string().nullable(),
  /** The client address the session was created from (the user's own sessions only). */
  ipAddress: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /** When the session was last renewed: at most a day stale over HTTPS (D181). */
  lastActiveAt: z.iso.datetime({ offset: true }),
  /** The session making this request. */
  current: z.boolean(),
  /** A second factor was proven in this session (TOTP, backup code, passkey with UV). */
  secondFactor: z.boolean(),
});

type SessionRow = {
  id: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: Date;
  updated_at: Date;
  second_factor: boolean;
};

export async function meSessionRoutes(
  app: KeptApp,
  opts: { pools: Pick<Pools, 'app' | 'auth'> },
): Promise<void> {
  const { pools } = opts;

  app.get(
    '/api/v1/me/sessions',
    { schema: { response: { 200: z.object({ sessions: z.array(SessionView) }) } } },
    async (req) => {
      const scope = requireScope(req);
      const { rows } = await pools.auth.query<SessionRow>(
        `SELECT s.id, s.user_agent, s.ip_address, s.created_at, s.updated_at,
                (m.session_id IS NOT NULL) AS second_factor
           FROM auth.session s LEFT JOIN auth.session_mfa m ON m.session_id = s.id
          WHERE s.user_id = $1 AND s.expires_at > now()
          ORDER BY s.updated_at DESC, s.id`,
        [scope.userId],
      );
      return {
        sessions: rows.map((r) => ({
          id: r.id,
          userAgent: r.user_agent,
          ipAddress: r.ip_address,
          createdAt: r.created_at.toISOString(),
          lastActiveAt: r.updated_at.toISOString(),
          current: r.id === req.authSession?.sessionId,
          secondFactor: r.second_factor,
        })),
      };
    },
  );

  app.delete(
    '/api/v1/me/sessions/:id',
    { schema: { params: z.object({ id: z.uuid() }) } },
    async (req, reply) => {
      const scope = requireScope(req);
      const { rowCount } = await pools.auth.query(
        'DELETE FROM auth.session WHERE id = $1 AND user_id = $2',
        [req.params.id, scope.userId],
      );
      // Someone else's session is as absent as one that never existed (§7.7).
      if (!rowCount) throw notFound();
      await auditAccountEvent(pools.app, scope.userId, {
        action: 'session.revoke',
        entity: { type: 'session', id: req.params.id },
        requestId: req.id,
      });
      return reply.code(204).send();
    },
  );
}
