import { newId } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { allowPrivateAddresses } from '../ai/runtime.js';
import { audited } from '../audit/audited.js';
import { rateLimited, requireScope } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import type { Sealed } from '../crypto/envelope.js';
import type { SecretKeys } from '../crypto/keyring.js';
import { MAIL_OUTCOMES, MAILBOX_DISABLED_REASONS } from '../db/schema/mailboxes.js';
import { withSystem } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { requireCan, requireMembership } from '../locations/access.js';
import {
  Folder,
  IMAP_PORTS,
  IMAP_SECURITY,
  MAX_ALLOWED_SENDERS,
  type MailboxConfig,
  MailboxHost,
  openMailboxConfig,
  Sender,
  sealMailboxConfig,
} from './config.js';
import { imapSource, type MailSource, MailSourceError } from './source.js';

// A location's mailbox for email-in (1.4, D231). The web's contract is
// apps/web/src/api/mailin/{paths,types}.ts and its mock.
//
// GET    /api/v1/locations/:id/mailbox        → {mailbox: MailboxView | null, recent: [...]}
// PUT    /api/v1/locations/:id/mailbox        {host, port, security, username, password?, folder,
//                                               allowedSenders} → MailboxView
// POST   /api/v1/locations/:id/mailbox/check  → {ok, error} (the saved mailbox, now)
// DELETE /api/v1/locations/:id/mailbox        → 204
//
// `location.settings` (owner and admin), as the location's other settings; closed to tokens (no
// catalogue `tokens` entry). The password is write-only: never answered, and a PUT without one
// keeps the saved one. A PUT signs in to the mailbox first and refuses one that fails, saying
// why; a changed host, user, port or folder starts the mailbox again from now (its mark is
// cleared), and saving turns a mailbox that was turned off back on. Signing in is rate-limited
// with the check: CHECKS_PER_MINUTE a person.

export const CHECKS_PER_MINUTE = 6;
const RECENT = 20;

const Iso = z.iso.datetime({ offset: true });

const MailboxView = z.object({
  id: z.uuid(),
  host: z.string(),
  port: z.number().int(),
  security: z.enum(IMAP_SECURITY),
  username: z.string(),
  folder: z.string(),
  allowedSenders: z.array(z.string()),
  active: z.boolean(),
  disabledReason: z.enum(MAILBOX_DISABLED_REASONS).nullable(),
  lastPolledAt: Iso.nullable(),
  lastError: z.string().nullable(),
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }),
});
type MailboxView = z.infer<typeof MailboxView>;

const RecentMail = z.object({
  id: z.uuid(),
  from: z.string().nullable(),
  subject: z.string().nullable(),
  receivedAt: Iso.nullable(),
  outcome: z.enum(MAIL_OUTCOMES),
  purchaseId: z.uuid().nullable(),
  at: Iso,
});

const PutBody = z
  .object({
    host: MailboxHost,
    port: z.number().int().min(1).max(65_535).optional(),
    security: z.enum(IMAP_SECURITY),
    username: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(500).optional(),
    folder: Folder,
    allowedSenders: z.array(Sender).max(MAX_ALLOWED_SENDERS).default([]),
  })
  .strict();

const IdParams = z.object({ id: z.uuid() });

type Row = {
  id: string;
  host: string;
  username: string;
  folder: string;
  allowed_senders: string[];
  active: boolean;
  disabled_reason: MailboxView['disabledReason'];
  last_polled_at: Date | null;
  last_error: string | null;
  created_by: string;
  creator_name: string | null;
};

const SELECT_ROW = `SELECT m.id, m.host, m.username, m.folder, m.allowed_senders, m.active,
         m.disabled_reason, m.last_polled_at, m.last_error, m.created_by,
         p.display_name AS creator_name
    FROM public.mailboxes m
    LEFT JOIN public.user_profiles p ON p.user_id = m.created_by`;

/** The port and TLS mode live in the sealed connection; the job's door hands them back. */
async function sealedOf(
  pools: InventoryDeps['pools'],
  id: string,
): Promise<{ config_ciphertext: Sealed } | null> {
  return withSystem(pools.system, async (_tx, c) => {
    const { rows } = await c.query<{ config_ciphertext: Sealed }>(
      'SELECT config_ciphertext FROM kept.mailbox_config($1)',
      [id],
    );
    return rows[0] ?? null;
  });
}

function viewOf(row: Row, config: Pick<MailboxConfig, 'port' | 'security'>): MailboxView {
  return {
    id: row.id,
    host: row.host,
    port: config.port,
    security: config.security,
    username: row.username,
    folder: row.folder,
    allowedSenders: row.allowed_senders,
    active: row.active,
    disabledReason: row.disabled_reason,
    lastPolledAt: row.last_polled_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdBy: { id: row.created_by, displayName: row.creator_name ?? '' },
  };
}

async function requireSettings(client: pg.ClientBase, locationId: string): Promise<void> {
  const { role } = await requireMembership(client, locationId);
  requireCan(role, 'location.settings');
}

async function rowOf(client: pg.ClientBase, locationId: string): Promise<Row | null> {
  const { rows } = await client.query<Row>(`${SELECT_ROW} WHERE m.location_id = $1`, [locationId]);
  return rows[0] ?? null;
}

/** The words a failed sign-in gives the page (and the PUT's 400). */
const FAILURE: Record<string, string> = {
  private_address: 'That address is on a private network. An instance admin can allow it.',
  unreachable: "Kept couldn't reach that server. Check the host and port.",
  tls_failed: "The server's encryption didn't check out. Check the host and the security.",
  auth_failed: 'The mailbox refused the user name or password.',
  no_folder: "That folder doesn't exist in the mailbox.",
  timeout: 'The server took too long to answer.',
  failed: "Kept couldn't sign in to the mailbox.",
};

export async function mailboxRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const source: MailSource = deps.mailSource ?? imapSource();

  function keysOf(): SecretKeys {
    if (!deps.secretKeys) {
      throw new AppError('internal', 503, 'Secret values are not configured on this server.');
    }
    return deps.secretKeys;
  }
  async function signIn(
    userId: string,
    reply: Parameters<typeof rateLimited>[0],
    config: MailboxConfig,
  ) {
    const limit = await reserveInWindow(
      pools.auth,
      limiterKey('mailbox-check', userId),
      CHECKS_PER_MINUTE,
      60,
    );
    if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);
    try {
      const session = await source(config, {
        allowPrivate: await allowPrivateAddresses(pools),
      });
      await session.close().catch(() => {});
      return null;
    } catch (e) {
      return e instanceof MailSourceError ? e.code : 'failed';
    }
  }

  app.get(
    '/api/v1/locations/:id/mailbox',
    {
      schema: {
        params: IdParams,
        response: {
          200: z.object({ mailbox: MailboxView.nullable(), recent: z.array(RecentMail) }),
        },
      },
    },
    async (req) => {
      const found = await scopedRead(pools, req, async (_tx, client) => {
        await requireSettings(client, req.params.id);
        const row = await rowOf(client, req.params.id);
        const { rows: recent } = row
          ? await client.query<{
              id: string;
              from_address: string | null;
              subject: string | null;
              received_at: Date | null;
              outcome: (typeof MAIL_OUTCOMES)[number];
              purchase_id: string | null;
              created_at: Date;
            }>(
              `SELECT id, from_address, subject, received_at, outcome, purchase_id, created_at
                 FROM public.mailbox_messages WHERE mailbox_id = $1
                ORDER BY created_at DESC, id DESC LIMIT ${RECENT}`,
              [row.id],
            )
          : { rows: [] };
        return { row, recent };
      });
      let mailbox: MailboxView | null = null;
      if (found.row) {
        const sealed = await sealedOf(pools, found.row.id);
        const keys = deps.secretKeys?.get().keyring;
        const config =
          sealed && keys
            ? openMailboxConfig(keys, found.row.id, sealed.config_ciphertext)
            : { port: IMAP_PORTS.tls, security: 'tls' as const };
        mailbox = viewOf(found.row, config);
      }
      return {
        mailbox,
        recent: found.recent.map((r) => ({
          id: r.id,
          from: r.from_address,
          subject: r.subject,
          receivedAt: r.received_at?.toISOString() ?? null,
          outcome: r.outcome,
          purchaseId: r.purchase_id,
          at: r.created_at.toISOString(),
        })),
      };
    },
  );

  app.put(
    '/api/v1/locations/:id/mailbox',
    { schema: { params: IdParams, body: PutBody, response: { 200: MailboxView } } },
    async (req, reply) => {
      const keys = keysOf().get();
      const locationId = req.params.id;
      const body = req.body;
      const existing = await scopedRead(pools, req, async (_tx, client) => {
        await requireSettings(client, locationId);
        return rowOf(client, locationId);
      });
      let password = body.password;
      let saved: MailboxConfig | null = null;
      if (existing) {
        const sealed = await sealedOf(pools, existing.id);
        if (sealed) saved = openMailboxConfig(keys.keyring, existing.id, sealed.config_ciphertext);
        password ??= saved?.password;
      }
      if (!password) throw invalid('password: the mailbox password.');
      const config: MailboxConfig = {
        host: body.host,
        port: body.port ?? IMAP_PORTS[body.security],
        security: body.security,
        username: body.username,
        password,
        folder: body.folder,
      };
      const failed = await signIn(requireScope(req).userId, reply, config);
      if (failed) {
        throw new AppError('validation', 400, FAILURE[failed] ?? FAILURE.failed, {
          mailError: failed,
        });
      }
      const restart =
        !saved ||
        saved.host !== config.host ||
        saved.port !== config.port ||
        saved.username !== config.username ||
        saved.folder !== config.folder;
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await requireSettings(client, locationId);
        const id = existing?.id ?? newId();
        const sealed = sealMailboxConfig(keys.current, id, config);
        if (existing) {
          await client.query(
            `UPDATE public.mailboxes
                SET host = $2, username = $3, folder = $4, allowed_senders = $5,
                    config_ciphertext = $6::jsonb, key_version = $7, active = true,
                    disabled_reason = NULL, last_error = NULL,
                    uid_validity = CASE WHEN $8 THEN NULL ELSE uid_validity END,
                    last_uid = CASE WHEN $8 THEN NULL ELSE last_uid END,
                    last_polled_at = CASE WHEN $8 THEN NULL ELSE last_polled_at END
              WHERE id = $1`,
            [
              id,
              config.host,
              config.username,
              config.folder,
              body.allowedSenders,
              JSON.stringify(sealed),
              keys.current.keyVersion,
              restart,
            ],
          );
        } else {
          await client.query(
            `INSERT INTO public.mailboxes (id, location_id, host, username, folder,
                                           allowed_senders, config_ciphertext, key_version,
                                           created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, kept.current_user_id())`,
            [
              id,
              locationId,
              config.host,
              config.username,
              config.folder,
              body.allowedSenders,
              JSON.stringify(sealed),
              keys.current.keyVersion,
            ],
          );
        }
        const row = (await rowOf(client, locationId)) as Row;
        const view = viewOf(row, config);
        // Never the password: the address, the folder and the senders.
        const image = {
          host: view.host,
          port: view.port,
          security: view.security,
          username: view.username,
          folder: view.folder,
          allowed_senders: view.allowedSenders,
        };
        await audited(tx, {
          locationId,
          actor: { type: 'user', id: scope.userId },
          action: existing ? 'mailbox.update' : 'mailbox.create',
          entity: { type: 'mailbox', id },
          ...(existing && saved
            ? {
                before: {
                  host: existing.host,
                  port: saved.port,
                  security: saved.security,
                  username: existing.username,
                  folder: existing.folder,
                  allowed_senders: existing.allowed_senders,
                },
              }
            : {}),
          after: { ...image, ...(body.password && existing ? { password_changed: true } : {}) },
          requestId: req.id,
        });
        return { status: 200, body: view };
      });
    },
  );

  app.post(
    '/api/v1/locations/:id/mailbox/check',
    {
      schema: {
        params: IdParams,
        response: { 200: z.object({ ok: z.boolean(), error: z.string().nullable() }) },
      },
    },
    async (req, reply) => {
      const keys = keysOf().get();
      const row = await scopedRead(pools, req, async (_tx, client) => {
        await requireSettings(client, req.params.id);
        return rowOf(client, req.params.id);
      });
      if (!row) throw notFound();
      const sealed = await sealedOf(pools, row.id);
      if (!sealed) throw notFound();
      const config = openMailboxConfig(keys.keyring, row.id, sealed.config_ciphertext);
      const failed = await signIn(requireScope(req).userId, reply, config);
      return { ok: failed === null, error: failed };
    },
  );

  app.delete('/api/v1/locations/:id/mailbox', { schema: { params: IdParams } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await requireSettings(client, req.params.id);
      const row = await rowOf(client, req.params.id);
      if (!row) throw notFound();
      await client.query('DELETE FROM public.mailboxes WHERE id = $1', [row.id]);
      await audited(tx, {
        locationId: req.params.id,
        actor: { type: 'user', id: scope.userId },
        action: 'mailbox.delete',
        entity: { type: 'mailbox', id: row.id },
        before: { host: row.host, username: row.username, folder: row.folder },
        requestId: req.id,
      });
      return { status: 204, body: undefined };
    }),
  );
}
