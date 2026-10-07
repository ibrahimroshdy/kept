import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SIGNUP_OPEN_KEY } from '../accounts/sign-up.js';
import { SSRF_ALLOW_PRIVATE_KEY } from '../ai/runtime.js';
import { audited } from '../audit/audited.js';
import { requireScope } from '../auth/http.js';
import { oidcStatus } from '../auth/oidc.js';
import { AdminOpsStatusShape, readOpsStatus } from '../backup/status.js';
import type { Pools } from '../db/pools.js';
import { type Tx, withScope, withSystem } from '../db/scope.js';
import { EmbeddingsStatusSchema, embeddingsStatus } from '../embeddings/status.js';
import type { AppEnv, KeptApp } from '../http/app.js';
import { decodeCursor, encodeCursor, paginationQuery } from '../http/conventions.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../http/errors.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import type { JobAdmin } from '../jobs/failed.js';
import {
  FORMER_HOSTNAMES_KEY,
  FormerHostnames,
  forgetFormerHostnames,
} from '../labels/former-hosts.js';
import type { AdminAction, Mailer } from '../mail/mailer.js';
import { connectorsStatus } from '../oauth/plugin.js';
import { readScanStatus } from '../reminders/status.js';
import { BARCODE_CONTACT_KEY, BARCODE_LOOKUP_KEY, barcodeSettingsFrom } from '../scan/barcode.js';
import {
  acknowledgeRecoveryKit,
  recoveryKitAcknowledgedAt,
  recoveryKitStatus,
} from '../setup/recovery-kit.js';
import { UPDATE_CHECK_ENABLED_KEY, updateCheckSwitch } from '../updates/check.js';
import {
  type AuthUserRow,
  disableUser,
  enableUser,
  findAuthUser,
  mailableAddress,
  resetTwoFactor,
  signOutEverywhere,
} from './account-ops.js';

// Instance administration (task 23; D164, D165, D180, D190, §7.11, §7.14).
//
// Every route here runs on kept_app like any other request, behind kept.is_instance_admin()
// (§7.14): a preHandler refuses anyone else with 403, and the instance-scope policies refuse them
// again underneath. What lives in schema auth (sessions, the ban flag, two-factor) is changed on
// kept_auth, inside the kept_app transaction that audits it, so a refused audit changes nothing.
// Every action on another person's account is mailed to them after commit (D180); the actor's
// own account is not mailed about what they did themselves.

export type AdminDeps = {
  pools: Pools;
  mailer: Mailer;
  env: AppEnv;
  /** The running version, for the status page. */
  version: string;
  /** Whether mail goes out (KEPT_SMTP_URL); the status page says so when it doesn't. */
  mailConfigured: boolean;
  /** Whether a backup target is set (T31c); the status page says loudly when it isn't. */
  backupConfigured?: boolean;
  /** Failed-job administration (jobs/failed.ts); null where no pg-boss runs (bare tests). */
  jobs?: JobAdmin | null;
};

const UserId = z.object({ id: z.uuid() });

const FailedJob = z.object({
  id: z.uuid(),
  name: z.string(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  createdAt: z.string(),
  failedAt: z.string(),
});

const RoleCounts = z.object({
  owner: z.number().int(),
  admin: z.number().int(),
  member: z.number().int(),
  viewer: z.number().int(),
});

const AdminUser = z.object({
  id: z.uuid(),
  displayName: z.string(),
  /** Null for a managed account (its address is synthetic, D47). */
  email: z.string().nullable(),
  username: z.string().nullable(),
  managed: z.boolean(),
  instanceAdmin: z.boolean(),
  disabled: z.boolean(),
  twoFactorEnabled: z.boolean(),
  createdAt: z.string(),
  /** Live memberships by role, across every location. */
  roles: RoleCounts,
});

const AdminAlert = z.object({
  id: z.uuid(),
  kind: z.string(),
  firstAt: z.string(),
  lastAt: z.string(),
  count: z.number().int(),
  resolvedAt: z.string().nullable(),
  /** The latest figures (counts, dates); never tenant content. */
  payload: z.record(z.string(), z.unknown()),
});

const AdminStatus = z.object({
  version: z.string(),
  dbOk: z.boolean(),
  /** Open alerts. */
  alerts: z.number().int(),
  recoveryKitAcknowledged: z.boolean(),
  mail: z.object({ configured: z.boolean() }),
  /** Step 8 (T10, AdminOpsStatus): the release, backups, the recovery kit, disks, the update
   * check, failed jobs and https (backup/status.ts). Absent when the database can't answer. */
  release: AdminOpsStatusShape.release.optional(),
  backup: AdminOpsStatusShape.backup.optional(),
  recoveryKit: AdminOpsStatusShape.recoveryKit.optional(),
  disk: AdminOpsStatusShape.disk.optional(),
  updates: AdminOpsStatusShape.updates.optional(),
  jobs: AdminOpsStatusShape.jobs.optional(),
  https: AdminOpsStatusShape.https.optional(),
  /** Step 6 (T22, D125): the MCP URL, and whether OAuth connectors can be offered (https). */
  connectors: z.object({ mcpUrl: z.string(), oauth: z.enum(['available', 'needs_https']) }),
  /** Step 4 (T14): the reminder scan's last pass (reminders/status.ts); null before the first. */
  reminders: z
    .object({
      lastRunAt: z.string().nullable(),
      lastOkAt: z.string().nullable(),
      occurrences: z.number().int(),
      durationMs: z.number().int(),
    })
    .nullable(),
  /** Step 6 (T16): generic OIDC sign-in, as boot left it (auth/oidc.ts oidcStatus): the button's
   * name, the issuer, the callback URL to register at the IdP, and why discovery failed. */
  oidc: z
    .object({
      configured: z.boolean(),
      name: z.string().nullable(),
      issuer: z.string().nullable(),
      callbackUrl: z.string().nullable(),
      error: z.string().nullable(),
    })
    .optional(),
  /** Step 6 (T14, D207): semantic search's index and its source (embeddings/status.ts). */
  embeddings: EmbeddingsStatusSchema.optional(),
});

const Locked = <T extends z.ZodType>(value: T) => z.object({ value, locked: z.boolean() });
// Step 3 (T16, T17): barcode lookup (D104, D126; locked by KEPT_BARCODE_LOOKUP /
// KEPT_BARCODE_CONTACT) and the former hostnames that redirect to the public URL (D120, Q32).
// `ssrfAllowPrivate` (Q9, D83): whether a typed AI base URL (and every other user-supplied URL
// through net/ssrf.ts) may reach private addresses; off by default, for self-hosts only. No
// environment variable sets it, so it is never locked.
const Settings = z.object({
  signupOpen: Locked(z.boolean()),
  barcodeLookup: Locked(z.boolean()),
  barcodeContact: Locked(z.string().nullable()),
  formerHostnames: z.array(z.string()),
  ssrfAllowPrivate: z.boolean(),
  /** Step 8 (T11, D65): "Check for new versions", off by default; KEPT_UPDATE_CHECK locks it. */
  updateCheck: Locked(z.boolean()),
});
const SettingsBody = z
  .object({
    signupOpen: z.boolean().optional(),
    barcodeLookup: z.boolean().optional(),
    barcodeContact: z.email().max(254).nullable().optional(),
    formerHostnames: FormerHostnames.optional(),
    ssrfAllowPrivate: z.boolean().optional(),
    updateCheck: z.boolean().optional(),
  })
  .strict();

type Summary = {
  user_id: string;
  display_name: string | null;
  managed: boolean;
  instance_admin: boolean;
  owner_of: number;
  admin_of: number;
  member_of: number;
  viewer_of: number;
};

async function isInstanceAdmin(pools: Pick<Pools, 'app'>, req: FastifyRequest) {
  const scope = requireScope(req);
  return withScope(pools.app, scope, async (_tx, client) => {
    const { rows } = await client.query<{ admin: boolean }>(
      'SELECT kept.is_instance_admin() AS admin',
    );
    return rows[0]?.admin === true;
  });
}

/** An instance-level audit event by the admin (0006: kept_app writes these only as an admin). */
function auditInstance(
  tx: Tx,
  req: FastifyRequest,
  action: string,
  entity: { type: string; id?: string | null },
  change: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {},
) {
  return audited(tx, {
    locationId: null,
    ownerAccountId: null,
    actor: { type: 'user', id: requireScope(req).userId },
    action,
    entity,
    ...change,
    requestId: req.id,
  });
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function adminRoutes(app: KeptApp, deps: AdminDeps): Promise<void> {
  const { pools, mailer, env } = deps;

  /** D180: tells the person, after commit, unless they did it to themselves. */
  const tell = (req: FastifyRequest, target: AuthUserRow, action: AdminAction) => async () => {
    const to = mailableAddress(target);
    if (!to || target.id === requireScope(req).userId) return;
    await mailer.send({ kind: 'admin-action', to, action });
  };

  async function readSettings(tx: Tx) {
    const { rows } = await tx.execute<{ value: unknown }>(
      sql`SELECT value FROM public.instance_settings WHERE key = ${SIGNUP_OPEN_KEY}`,
    );
    const stored = rows[0]?.value === true;
    const locked = env.KEPT_SIGNUP_OPEN !== undefined;
    const more = await tx.execute<{ key: string; value: unknown }>(
      sql`SELECT key, value FROM public.instance_settings
           WHERE key IN (${BARCODE_LOOKUP_KEY}, ${BARCODE_CONTACT_KEY}, ${FORMER_HOSTNAMES_KEY},
                         ${SSRF_ALLOW_PRIVATE_KEY}, ${UPDATE_CHECK_ENABLED_KEY})`,
    );
    const extra = new Map(more.rows.map((r) => [r.key, r.value]));
    const barcode = barcodeSettingsFrom(extra, env);
    const hosts = FormerHostnames.safeParse(extra.get(FORMER_HOSTNAMES_KEY) ?? []);
    return {
      signupOpen: { value: locked ? env.KEPT_SIGNUP_OPEN === true : stored, locked },
      barcodeLookup: barcode.lookup,
      barcodeContact: barcode.contact,
      formerHostnames: hosts.success ? hosts.data : [],
      // As ai/runtime.ts reads it: only a stored `true` allows.
      ssrfAllowPrivate: extra.get(SSRF_ALLOW_PRIVATE_KEY) === true,
      updateCheck: updateCheckSwitch(env, extra.get(UPDATE_CHECK_ENABLED_KEY) === true),
    };
  }

  await app.register(async (scope) => {
    const admin = scope.withTypeProvider<ZodTypeProvider>();
    admin.addHook('preHandler', async (req) => {
      if (!(await isInstanceAdmin(pools, req))) {
        throw forbidden('Only instance admins can do this.');
      }
    });

    // Users, oldest first, with what they hold. `q` matches email, username or name.
    admin.get(
      '/api/v1/admin/users',
      {
        schema: {
          querystring: paginationQuery.extend({ q: z.string().trim().max(254).optional() }),
          response: {
            200: z.object({ users: z.array(AdminUser), nextCursor: z.string().nullable() }),
          },
        },
      },
      async (req) => {
        const { limit, cursor, q } = req.query;
        const after = cursor ? decodeCursor<[string, string]>(cursor) : null;
        const { rows } = await pools.auth.query<AuthUserRow>(
          `SELECT id, email, username, name, coalesce(banned, false) AS banned,
                  coalesce(two_factor_enabled, false) AS "twoFactorEnabled",
                  created_at AS "createdAt"
             FROM auth."user"
            WHERE ($1::text IS NULL OR email ILIKE $1 OR username ILIKE $1 OR name ILIKE $1)
              AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
            ORDER BY created_at, id
            LIMIT $4`,
          [q ? `%${escapeLike(q)}%` : null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const summaries = await scopedRead(pools, req, async (_tx, client) => {
          const res = await client.query<Summary>(
            'SELECT * FROM kept.admin_user_summaries($1::uuid[])',
            [page.map((u) => u.id)],
          );
          return new Map(res.rows.map((r) => [r.user_id, r]));
        });
        const last = page.at(-1);
        return {
          users: page.map((u) => {
            const s = summaries.get(u.id);
            return {
              id: u.id,
              displayName: s?.display_name ?? u.name,
              email: mailableAddress(u),
              username: u.username,
              managed: s?.managed ?? false,
              instanceAdmin: s?.instance_admin ?? false,
              disabled: u.banned,
              twoFactorEnabled: u.twoFactorEnabled,
              createdAt: u.createdAt.toISOString(),
              roles: {
                owner: s?.owner_of ?? 0,
                admin: s?.admin_of ?? 0,
                member: s?.member_of ?? 0,
                viewer: s?.viewer_of ?? 0,
              },
            };
          }),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor([last.createdAt.toISOString(), last.id])
              : null,
        };
      },
    );

    // Accounts, for the AI instance cap's per-account override picker (step-3 carry-over, T19):
    // an account's id, its owner's name and how many locations it owns (owner memberships, the
    // count Users shows), names only (D33: nothing about what is in them). `q` matches the owner's
    // name. owner_accounts is readable to kept_app only as one's own (0006), so the list is read
    // on kept_system, behind this block's instance-admin gate.
    admin.get(
      '/api/v1/admin/accounts',
      {
        schema: {
          querystring: z.object({
            q: z.string().trim().max(100).optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          }),
          response: {
            200: z.object({
              items: z.array(
                z.object({ id: z.uuid(), ownerName: z.string(), locations: z.number().int() }),
              ),
            }),
          },
        },
      },
      async (req) => {
        const { q, limit } = req.query;
        const items = await withSystem(pools.system, async (_tx, client) => {
          const { rows } = await client.query<{
            id: string;
            owner_name: string;
            locations: number;
          }>(
            `SELECT oa.id, coalesce(p.display_name, '') AS owner_name,
                    (SELECT count(*) FROM public.memberships m
                      WHERE m.user_id = oa.user_id AND m.role = 'owner'
                        AND (m.expires_at IS NULL OR m.expires_at > now()))::int AS locations
               FROM public.owner_accounts oa
               LEFT JOIN public.user_profiles p ON p.user_id = oa.user_id
              WHERE $1::text IS NULL OR p.display_name ILIKE $1
              ORDER BY lower(coalesce(p.display_name, '')), oa.id
              LIMIT $2`,
            [q ? `%${escapeLike(q)}%` : null, limit],
          );
          return rows;
        });
        return {
          items: items.map((r) => ({ id: r.id, ownerName: r.owner_name, locations: r.locations })),
        };
      },
    );

    /** One action on one account: audited in the admin's transaction, done on kept_auth inside
     * it, mailed to the person after commit. */
    const userAction = (
      path: string,
      action: AdminAction,
      auditAction: string,
      work: (userId: string) => Promise<void>,
      guard?: (req: FastifyRequest, target: AuthUserRow) => void,
    ) =>
      admin.post(
        `/api/v1/admin/users/:id/${path}`,
        { schema: { params: UserId } },
        async (req, reply) => {
          const target = await findAuthUser(pools.auth, req.params.id);
          if (!target) throw notFound();
          guard?.(req, target);
          return scopedWrite(pools, req, reply, async (tx) => {
            await auditInstance(tx, req, auditAction, { type: 'user', id: target.id });
            await work(target.id);
            return { status: 204, body: undefined, afterCommit: tell(req, target, action) };
          });
        },
      );

    userAction(
      'disable',
      'disabled',
      'admin.user_disable',
      (id) => disableUser(pools.auth, id),
      (req, target) => {
        if (target.id === requireScope(req).userId) {
          throw conflict("You can't disable your own account.");
        }
      },
    );
    userAction('enable', 'enabled', 'admin.user_enable', (id) => enableUser(pools.auth, id));
    userAction('reset-2fa', 'two-factor-reset', 'admin.user_reset_2fa', (id) =>
      resetTwoFactor(pools.auth, id),
    );
    userAction(
      'sign-out-everywhere',
      'signed-out-everywhere',
      'admin.user_sign_out_everywhere',
      (id) => signOutEverywhere(pools.auth, id),
    );

    // Instance settings. The environment wins (§7.11): a value it sets comes back locked.
    admin.get('/api/v1/admin/settings', { schema: { response: { 200: Settings } } }, async (req) =>
      scopedRead(pools, req, (tx) => readSettings(tx)),
    );

    admin.put(
      '/api/v1/admin/settings',
      { schema: { body: SettingsBody, response: { 200: Settings } } },
      async (req, reply) =>
        scopedWrite(pools, req, reply, async (tx) => {
          const before = await readSettings(tx);
          const {
            signupOpen,
            barcodeLookup,
            barcodeContact,
            formerHostnames,
            ssrfAllowPrivate,
            updateCheck,
          } = req.body;
          const put = (key: string, value: unknown) =>
            tx.execute(
              sql`INSERT INTO public.instance_settings (key, value)
                  VALUES (${key}, ${JSON.stringify(value)}::jsonb)
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            );
          if (signupOpen !== undefined) {
            if (before.signupOpen.locked) {
              throw conflict('Sign-up is set by KEPT_SIGNUP_OPEN in the server environment.');
            }
            await put(SIGNUP_OPEN_KEY, signupOpen);
          }
          if (barcodeLookup !== undefined) {
            if (before.barcodeLookup.locked) {
              throw conflict(
                'Barcode lookup is set by KEPT_BARCODE_LOOKUP in the server environment.',
              );
            }
            await put(BARCODE_LOOKUP_KEY, barcodeLookup);
          }
          if (barcodeContact !== undefined) {
            if (before.barcodeContact.locked) {
              throw conflict(
                'The contact is set by KEPT_BARCODE_CONTACT in the server environment.',
              );
            }
            await put(BARCODE_CONTACT_KEY, barcodeContact);
          }
          if (formerHostnames !== undefined) {
            const own = new URL(env.KEPT_PUBLIC_URL).hostname.toLowerCase();
            if (formerHostnames.includes(own)) {
              throw invalid("formerHostnames: the public URL's own host can't be a former one.");
            }
            await put(FORMER_HOSTNAMES_KEY, [...new Set(formerHostnames)]);
          }
          if (ssrfAllowPrivate !== undefined) await put(SSRF_ALLOW_PRIVATE_KEY, ssrfAllowPrivate);
          if (updateCheck !== undefined) {
            if (before.updateCheck.locked) {
              throw conflict(
                'Checking for new versions is set by KEPT_UPDATE_CHECK in the server environment.',
              );
            }
            await put(UPDATE_CHECK_ENABLED_KEY, updateCheck);
          }
          const after = await readSettings(tx);
          const changes: [string, unknown, unknown][] = [
            ['signup_open', before.signupOpen.value, after.signupOpen.value],
            ['barcode_lookup', before.barcodeLookup.value, after.barcodeLookup.value],
            ['barcode_contact', before.barcodeContact.value, after.barcodeContact.value],
            ['former_hostnames', before.formerHostnames, after.formerHostnames],
            ['ssrf_allow_private', before.ssrfAllowPrivate, after.ssrfAllowPrivate],
            ['update_check', before.updateCheck.value, after.updateCheck.value],
          ];
          const changed = changes.filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b));
          if (changed.length > 0) {
            await auditInstance(
              tx,
              req,
              'instance.settings_update',
              { type: 'instance_settings', id: null },
              {
                before: Object.fromEntries(changed.map(([k, a]) => [k, a])),
                after: Object.fromEntries(changed.map(([k, , b]) => [k, b])),
              },
            );
          }
          if (formerHostnames !== undefined) forgetFormerHostnames();
          return { status: 200, body: after };
        }),
    );

    // Instance admins. The last one can't be removed.
    admin.post(
      '/api/v1/admin/instance-admins',
      {
        schema: {
          body: z.object({ userId: z.uuid() }),
          response: { 201: z.object({ userId: z.uuid(), grantedAt: z.string() }) },
        },
      },
      async (req, reply) => {
        const target = await findAuthUser(pools.auth, req.body.userId);
        if (!target) throw notFound();
        if (!mailableAddress(target)) {
          throw conflict('A managed account cannot be an instance admin.');
        }
        if (target.banned) throw conflict('Enable the account first.');
        return scopedWrite(pools, req, reply, async (tx, client) => {
          const { rows } = await client.query<{ granted_at: Date }>(
            `INSERT INTO public.instance_admins (user_id, granted_by) VALUES ($1, $2)
             ON CONFLICT (user_id) DO NOTHING RETURNING granted_at`,
            [target.id, requireScope(req).userId],
          );
          const granted = rows[0];
          if (!granted) throw conflict('They are already an instance admin.');
          await auditInstance(tx, req, 'admin.instance_admin_grant', {
            type: 'user',
            id: target.id,
          });
          return {
            status: 201,
            body: { userId: target.id, grantedAt: granted.granted_at.toISOString() },
            afterCommit: tell(req, target, 'instance-admin-granted'),
          };
        });
      },
    );

    admin.delete(
      '/api/v1/admin/instance-admins/:id',
      { schema: { params: UserId } },
      async (req, reply) => {
        const target = await findAuthUser(pools.auth, req.params.id);
        if (!target) throw notFound();
        return scopedWrite(pools, req, reply, async (tx, client) => {
          // Serialises removals, so two admins removing each other can't leave none.
          await client.query("SELECT pg_advisory_xact_lock(hashtext('kept.instance_admins'))");
          const { rows } = await client.query<{ n: number; there: boolean }>(
            `SELECT count(*)::int AS n, bool_or(user_id = $1) AS there
               FROM public.instance_admins`,
            [target.id],
          );
          if (!rows[0]?.there) throw notFound();
          if ((rows[0]?.n ?? 0) <= 1) throw conflict('Kept needs at least one instance admin.');
          await client.query('DELETE FROM public.instance_admins WHERE user_id = $1', [target.id]);
          await auditInstance(tx, req, 'admin.instance_admin_revoke', {
            type: 'user',
            id: target.id,
          });
          return {
            status: 204,
            body: undefined,
            afterCommit: tell(req, target, 'instance-admin-revoked'),
          };
        });
      },
    );

    // Failed jobs (D166): what exhausted its retries, newest first, with retry and discard.
    const jobAdmin = () => {
      if (!deps.jobs) throw new AppError('internal', 503, 'Jobs are not running in this process.');
      return deps.jobs;
    };
    admin.get(
      '/api/v1/admin/jobs/failed',
      {
        schema: {
          querystring: paginationQuery,
          response: {
            200: z.object({ jobs: z.array(FailedJob), nextCursor: z.string().nullable() }),
          },
        },
      },
      async (req) => {
        const { limit, cursor } = req.query;
        const after = cursor ? decodeCursor<[string, string]>(cursor) : null;
        const page = await jobAdmin().listFailed({ limit, after });
        return {
          jobs: page.jobs.map((j) => ({
            ...j,
            createdAt: j.createdAt.toISOString(),
            failedAt: j.failedAt.toISOString(),
          })),
          nextCursor: page.next ? encodeCursor(page.next) : null,
        };
      },
    );

    /** Retry or discard one failed job: audited in the admin's transaction, done by pg-boss on
     * kept_system inside it, so a refused audit leaves the job as it was. */
    const jobAction = (path: 'retry' | 'discard', auditAction: string) =>
      admin.post(
        `/api/v1/admin/jobs/failed/:id/${path}`,
        { schema: { params: UserId } },
        async (req, reply) => {
          const jobs = jobAdmin();
          const job = await jobs.findFailed(req.params.id);
          if (!job) throw notFound();
          return scopedWrite(pools, req, reply, async (tx) => {
            await auditInstance(
              tx,
              req,
              auditAction,
              { type: 'job', id: job.id },
              {
                before: { name: job.name, attempts: job.attempts },
              },
            );
            const done = path === 'retry' ? await jobs.retry(job.id) : await jobs.discard(job.id);
            if (!done) throw notFound();
            return { status: 204, body: undefined };
          });
        },
      );
    jobAction('retry', 'admin.job_retry');
    jobAction('discard', 'admin.job_discard');

    // Admin alerts (D166, task 25): open ones by default, newest activity first.
    admin.get(
      '/api/v1/admin/alerts',
      {
        schema: {
          querystring: paginationQuery.extend({ state: z.enum(['open', 'all']).default('open') }),
          response: {
            200: z.object({ alerts: z.array(AdminAlert), nextCursor: z.string().nullable() }),
          },
        },
      },
      async (req) => {
        const { limit, cursor, state } = req.query;
        const after = cursor ? decodeCursor<[string, string]>(cursor) : null;
        const rows = await scopedRead(pools, req, async (_tx, client) => {
          const res = await client.query<{
            id: string;
            kind: string;
            first_at: Date;
            last_at: Date;
            count: number;
            resolved_at: Date | null;
            payload: Record<string, unknown>;
          }>(
            `SELECT id, kind, first_at, last_at, count, resolved_at, payload
               FROM public.admin_alerts
              WHERE ($1 = 'all' OR resolved_at IS NULL)
                AND ($2::timestamptz IS NULL OR (last_at, id) < ($2::timestamptz, $3::uuid))
              ORDER BY last_at DESC, id DESC
              LIMIT $4`,
            [state, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
          );
          return res.rows;
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          alerts: page.map((a) => ({
            id: a.id,
            kind: a.kind,
            firstAt: a.first_at.toISOString(),
            lastAt: a.last_at.toISOString(),
            count: a.count,
            resolvedAt: a.resolved_at?.toISOString() ?? null,
            payload: a.payload,
          })),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor([last.last_at.toISOString(), last.id])
              : null,
        };
      },
    );

    // The status page's summary (task 25): version, database, open alerts, the recovery kit
    // (D193) and whether mail goes out at all.
    admin.get(
      '/api/v1/admin/status',
      { schema: { response: { 200: AdminStatus } } },
      async (req) => {
        const base = {
          version: deps.version,
          mail: { configured: deps.mailConfigured },
          oidc: oidcStatus(),
          connectors: connectorsStatus(env.KEPT_PUBLIC_URL),
        };
        try {
          const failedLastDay =
            (await deps.jobs?.countFailedSince?.(new Date(Date.now() - 86_400_000))) ?? 0;
          return await scopedRead(pools, req, async (_tx, client) => {
            const { rows } = await client.query<{ open: number }>(
              'SELECT count(*)::int AS open FROM public.admin_alerts WHERE resolved_at IS NULL',
            );
            const ops = await readOpsStatus(client, {
              version: deps.version,
              sourceUrl: env.KEPT_SOURCE_URL ?? null,
              publicUrl: env.KEPT_PUBLIC_URL,
              raw: process.env,
              updateEnv: env,
              failedLastDay,
            });
            const scan = await readScanStatus(client);
            return {
              ...base,
              dbOk: true,
              alerts: rows[0]?.open ?? 0,
              recoveryKitAcknowledged: (await recoveryKitAcknowledgedAt(client)) !== null,
              embeddings: await embeddingsStatus(client, pools),
              ...ops,
              reminders: scan
                ? {
                    lastRunAt: scan.lastRunAt,
                    lastOkAt: scan.lastOkAt,
                    occurrences: scan.occurrences,
                    durationMs: Math.round(scan.durationMs),
                  }
                : null,
            };
          });
        } catch (err) {
          req.log.error({ err }, 'status: database check failed');
          return {
            ...base,
            dbOk: false,
            alerts: 0,
            recoveryKitAcknowledged: false,
            reminders: null,
          };
        }
      },
    );

    // The recovery-kit acknowledgement (D193): asked for by the status page until given. With
    // step 8 (T9) the state also says when the kit was last downloaded, and whether something it
    // holds changed since (`stale`); the download is admin/recovery-kit-routes.ts.
    const Kit = z.object({
      acknowledgedAt: z.string().nullable(),
      downloadedAt: z.string().nullable(),
      stale: z.boolean(),
    });
    const Acknowledged = z.object({ acknowledgedAt: z.string().nullable() });
    admin.get('/api/v1/admin/recovery-kit', { schema: { response: { 200: Kit } } }, async (req) =>
      scopedRead(pools, req, async (_tx, client) => recoveryKitStatus(client)),
    );
    admin.post(
      '/api/v1/admin/recovery-kit/acknowledge',
      { schema: { response: { 200: Acknowledged } } },
      async (req, reply) =>
        scopedWrite(pools, req, reply, async (tx, client) => {
          const { acknowledgedAt, first } = await acknowledgeRecoveryKit(client);
          if (first) {
            await auditInstance(tx, req, 'instance.recovery_kit_acknowledge', {
              type: 'instance_settings',
              id: null,
            });
          }
          return { status: 200, body: { acknowledgedAt: acknowledgedAt.toISOString() } };
        }),
    );
  });
}
