import { newId } from '@kept/shared';
import { z } from 'zod';
import { NewAccount, SignUpAnswer, type SignUpDeps, signUpPerson } from '../accounts/sign-up.js';
import { audited } from '../audit/audited.js';
import { isUndeliverableEmail } from '../auth/emails.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { assertClientId } from '../http/conventions.js';
import { conflict, invalid, notFound, unauthenticated } from '../http/errors.js';
import { scopedWrite } from '../http/write.js';
import { outlasts, requireCan, requireMembership } from '../locations/access.js';
import { GrantableRole, Iso, LocationKind, locationViews } from '../locations/views.js';
import { acceptInviteInTx, inviteInvalid } from './accept.js';
import {
  hashInviteToken,
  INVITE_TTL_DAYS,
  inviteQrSvg,
  inviteUrl,
  isInviteTokenShape,
  newInviteToken,
} from './token.js';

// Invites (task 20; D33, D46, D48, D180, D181, D193; screens §5 Invite, Accept invite).

/** Pending (unaccepted, unexpired) invites a location may have at once (review M9). */
export const MAX_PENDING_INVITES = 50;
//
// Two kinds, both single-use and valid 7 days:
// - a link invite: the response carries the link and its QR code (D193), for the inviter to
//   copy, share or show;
// - an email invite: the link is mailed to that address and is *not* in the response. That is
//   what lets holding the token prove the mailbox: accepting marks the address verified, and
//   kept.accept_invite() then binds the invite to it (§7.10). The mail is a job enqueued in the
//   create transaction, and the job makes the token (invites/mail-job.ts).
// Previews and acceptance never say why an invite doesn't work: unknown, used, expired, revoked,
// or its creator no longer an admin are all 404 `invite_invalid` (a 410 would confirm that a
// token once existed).

const Params = z.object({ id: z.uuid() });
const InviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() });
const TokenParams = z.object({ token: z.string().min(1).max(128) });

const CreateBody = z.object({
  id: z.uuid().optional(),
  role: GrantableRole,
  /** The membership's end date (D46), no later than the inviter's own (D180). */
  membershipExpiresAt: Iso.nullable().optional(),
  /** Mail the link to this address instead of showing it. */
  email: z.email().max(254).optional(),
});

const Created = z.object({
  id: z.uuid(),
  role: GrantableRole,
  /** The link (`/invite#<token>`): for a link invite only, and not on an idempotent replay. */
  url: z.string().nullable(),
  /** The link as an SVG QR code, alongside `url`. */
  qrSvg: z.string().nullable(),
  /** When the link stops working. */
  expiresAt: Iso,
  membershipExpiresAt: Iso.nullable(),
  email: z.string().nullable(),
  /** The link went to `email` (not shown here). */
  emailed: z.boolean(),
});

const Preview = z.object({
  location: z.object({ name: z.string(), kind: LocationKind }),
  inviterName: z.string(),
  role: GrantableRole,
  membershipExpiresAt: Iso.nullable(),
  expiresAt: Iso,
  require2fa: z.boolean(),
  /** The invite is for one email address; signing up or accepting needs that address. */
  emailBound: z.boolean(),
  /** Signed in and already a member: the location to open instead of joining. */
  alreadyMemberLocationId: z.uuid().nullable(),
});

const AcceptBody = z.object({ newAccount: NewAccount.optional() });
const Accepted = z.object({ locationId: z.uuid(), alreadyMember: z.boolean() });

type PreviewRow = {
  location_name: string;
  location_kind: z.infer<typeof LocationKind>;
  role: z.infer<typeof GrantableRole>;
  inviter_name: string | null;
  expires_at: Date;
  membership_expires_at: Date | null;
  require_2fa: boolean;
  email_bound: boolean;
  member_location_id: string | null;
};

export type InviteRoutesOptions = SignUpDeps & { publicUrl: string };

export async function inviteRoutes(app: KeptApp, opts: InviteRoutesOptions): Promise<void> {
  const { pools, publicUrl, jobs } = opts;

  app.post(
    '/api/v1/locations/:id/invites',
    { schema: { params: Params, body: CreateBody, response: { 201: Created } } },
    (req, reply) =>
      scopedWrite(
        pools,
        req,
        reply,
        async (tx, client, scope) => {
          const locationId = req.params.id;
          const body = req.body;
          const me = await requireMembership(client, locationId);
          requireCan(me.role, 'members.manage');
          if (body.role === 'admin') {
            requireCan(me.role, 'admins.manage', 'Only the owner invites admins.');
          }
          const [location] = await locationViews(client, locationId);
          if (!location) throw notFound();
          if (location.kind === 'personal') {
            throw conflict('A Personal location has no members but its owner.');
          }
          const until = body.membershipExpiresAt ? new Date(body.membershipExpiresAt) : null;
          if (until && until.getTime() <= Date.now()) {
            throw invalid('The end date must be in the future.');
          }
          if (outlasts(until, me.expiresAt)) {
            throw invalid("The end date can't be later than your own (D180).");
          }
          const email = body.email?.trim().toLowerCase() ?? null;
          if (email && isUndeliverableEmail(email)) {
            throw invalid('That email address cannot receive mail.');
          }

          // Abuse limit (review M9): 50 pending invites per location. The lock makes two
          // concurrent creates count one after the other.
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
            'kept.invites',
            locationId,
          ]);
          const { rows: pending } = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM public.invites
              WHERE location_id = $1 AND accepted_at IS NULL AND expires_at > now()`,
            [locationId],
          );
          if ((pending[0]?.n ?? 0) >= MAX_PENDING_INVITES) {
            throw conflict(
              `A location can have ${MAX_PENDING_INVITES} pending invites; revoke some first.`,
            );
          }

          const id = body.id ? assertClientId(body.id) : newId();
          // An email invite's real token is made by the mail job (invites/mail-job.ts), which
          // replaces this hash: the one made here is never shown or mailed.
          const { token, hash } = newInviteToken();
          const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
          await client.query(
            `INSERT INTO public.invites
               (id, location_id, role, membership_expires_at, email, token_hash, expires_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, locationId, body.role, until, email, hash, expiresAt, scope.userId],
          );
          await audited(tx, {
            locationId,
            actor: { type: 'user', id: scope.userId },
            action: 'invite.create',
            entity: { type: 'invite', id },
            after: {
              role: body.role,
              membership_expires_at: until,
              email,
              expires_at: expiresAt,
            },
            requestId: req.id,
          });
          if (email) {
            if (jobs) await jobs.send(client, 'send-invite-mail', { inviteId: id });
            else req.log.warn({ inviteId: id }, 'no job queue: the invite was not mailed');
          }
          const url = email ? null : inviteUrl(publicUrl, token);
          return {
            status: 201,
            body: {
              id,
              role: body.role,
              url,
              qrSvg: url ? inviteQrSvg(url) : null,
              expiresAt: expiresAt.toISOString(),
              membershipExpiresAt: until?.toISOString() ?? null,
              email,
              emailed: email !== null,
            },
          };
        },
        // A replay says the invite exists without handing out its link again.
        { redact: (body) => ({ ...(body as object), url: null, qrSvg: null }) },
      ),
  );

  app.delete(
    '/api/v1/locations/:id/invites/:inviteId',
    { schema: { params: InviteParams } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const { id: locationId, inviteId } = req.params;
        const me = await requireMembership(client, locationId);
        requireCan(me.role, 'members.manage');
        const { rows } = await client.query<{
          role: string;
          email: string | null;
          expires_at: Date;
        }>(
          `SELECT role, email, expires_at FROM public.invites
            WHERE id = $1 AND location_id = $2 AND accepted_at IS NULL`,
          [inviteId, locationId],
        );
        const invite = rows[0];
        if (!invite) throw notFound();
        if (invite.role === 'admin') requireCan(me.role, 'admins.manage');
        await client.query('DELETE FROM public.invites WHERE id = $1', [inviteId]);
        await audited(tx, {
          locationId,
          actor: { type: 'user', id: scope.userId },
          action: 'invite.revoke',
          entity: { type: 'invite', id: inviteId },
          before: invite,
          requestId: req.id,
        });
        return { status: 204, body: null };
      }),
  );

  // The public preview: holding the token is the permission (0006, 0008). With a session, it
  // also says whether the caller already belongs.
  app.get(
    '/api/v1/invites/:token',
    { config: { auth: 'optional' }, schema: { params: TokenParams, response: { 200: Preview } } },
    async (req) => {
      const { token } = req.params;
      if (!isInviteTokenShape(token)) throw inviteInvalid();
      const sql = 'SELECT * FROM kept.invite_preview($1)';
      const hash = hashInviteToken(token);
      const rows = req.scope
        ? await withScope(
            pools.app,
            req.scope,
            async (_tx, c) => (await c.query<PreviewRow>(sql, [hash])).rows,
          )
        : (await pools.app.query<PreviewRow>(sql, [hash])).rows;
      const row = rows[0];
      if (!row) throw inviteInvalid();
      return {
        location: { name: row.location_name, kind: row.location_kind },
        inviterName: row.inviter_name ?? '',
        role: row.role,
        membershipExpiresAt: row.membership_expires_at?.toISOString() ?? null,
        expiresAt: row.expires_at.toISOString(),
        require2fa: row.require_2fa,
        emailBound: row.email_bound,
        alreadyMemberLocationId: row.member_location_id,
      };
    },
  );

  // Joining. Signed in: the invite is consumed for the caller (200). Not signed in: `newAccount`
  // signs up with the invite (sign-up is closed otherwise, D33, D127), which holds the invite for
  // that address (accounts/sign-up.ts), answering 202 `{next: 'sign-in'}` like POST
  // /api/v1/auth/sign-up, so it can't be used to learn which addresses have accounts; the person
  // then signs in and accepts again, which joins them.
  app.post(
    '/api/v1/invites/:token/accept',
    {
      config: { auth: 'optional' },
      bodyLimit: 4096,
      schema: {
        params: TokenParams,
        body: AcceptBody.optional(),
        response: { 200: Accepted, 202: SignUpAnswer },
      },
    },
    async (req, reply) => {
      const { token } = req.params;
      const newAccount = req.body?.newAccount;
      if (!req.scope) {
        if (!newAccount) throw unauthenticated();
        const answer = await signUpPerson(opts, req, reply, newAccount, token);
        return reply.code(202).send(answer);
      }
      if (newAccount) throw invalid('You are signed in: accept without newAccount.');
      if (!isInviteTokenShape(token)) throw inviteInvalid();
      const hash = hashInviteToken(token);
      return scopedWrite(pools, req, reply, async (_tx, client, scope) => ({
        status: 200,
        body: await acceptInviteInTx(opts, client, scope, hash, req.id),
      }));
    },
  );
}
