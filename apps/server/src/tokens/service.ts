import {
  formatToken,
  newTokenParts,
  TOKEN_KINDS,
  TOKEN_REVOKED_REASONS,
  TOKEN_SCOPES,
  type TokenKind,
  type TokenRevokedReason,
  type TokenScope,
} from '@kept/shared';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import type { Scope, Tx } from '../db/scope.js';
import { checkVersion, decodeCursor, encodeCursor } from '../http/conventions.js';
import { AppError, forbidden, invalid, notFound } from '../http/errors.js';
import { withoutBidiControls } from '../http/untrusted.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { hashTokenSecret } from './verify.js';

// Personal tokens and connected apps, the person's own (step-6 plan T10; screens §5
// "Connections"; D15, D60, D63, D179, D180, D190; engineering spec §3.2, §7.3, §7.13).
//
// api_tokens is user-level: its policies show a person only their own rows, and never to a
// token (0070), so a token can't list, make or revoke tokens whatever the route catalogue says.
// The secret's HMAC is never read back (kept_app has no SELECT on `hash`); the secret itself is
// in the create answer only.

const Iso = z.iso.datetime({ offset: true });

export const TokenRowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(TOKEN_KINDS),
  name: z.string(),
  scope: z.enum(TOKEN_SCOPES),
  locations: z.array(z.object({ id: z.uuid(), name: z.string(), kind: z.string() })),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.enum(TOKEN_REVOKED_REASONS).nullable(),
  /** An OAuth app's name as it calls itself (untrusted, D179). */
  clientName: z.string().optional(),
  rowVersion: z.number().int(),
});
export type TokenRow = z.infer<typeof TokenRowSchema>;

export const TokensPageSchema = z.object({
  items: z.array(TokenRowSchema),
  next_cursor: z.string().nullable(),
});

export const TokensQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
  kind: z.enum(TOKEN_KINDS).optional(),
});

export const CreateTokenBody = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(TOKEN_SCOPES),
  /** One location at least (D179); the web pre-selects one. */
  locationIds: z.array(z.uuid()).min(1).max(100),
  expiresAt: Iso.optional(),
  /** Sent again after D179's warning, to make a write token across differing member lists. */
  confirmCrossLocation: z.boolean().optional(),
});
export type CreateTokenBody = z.infer<typeof CreateTokenBody>;

export const UpdateTokenBody = z.object({ name: z.string().trim().min(1).max(80) });

const ClientConfigSchema = z.object({
  url: z.string(),
  headers: z.record(z.string(), z.string()),
});

export const CreatedTokenSchema = z.object({
  token: TokenRowSchema,
  secret: z.string(),
  clientConfigs: z.object({ claudeDesktop: ClientConfigSchema, generic: ClientConfigSchema }),
});
export type CreatedToken = z.infer<typeof CreatedTokenSchema>;

export const CrossLocationWarningSchema = z.object({ warning: z.literal('cross_location_write') });

export type Ctx = { tx: Tx; client: pg.PoolClient; scope: Scope; requestId: string };

type DbRow = {
  id: string;
  kind: TokenKind;
  name: string;
  scope: TokenScope;
  oauth_client_id: string | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: TokenRevokedReason | null;
  row_version: number;
};

/** Every column kept_app may read: never `hash` (0070's column grant). */
const COLUMNS = `t.id, t.kind, t.name, t.scope, t.oauth_client_id, t.created_at, t.expires_at,
  t.last_used_at, t.revoked_at, t.revoked_reason, t.row_version`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** OAuth clients' names, read as kept_auth (auth.oauth_client is Better Auth's, D93). */
export type ClientNames = (clientIds: string[]) => Promise<Map<string, string>>;

export function clientNamesFrom(authPool: pg.Pool | null): ClientNames {
  return async (clientIds) => {
    if (!authPool || clientIds.length === 0) return new Map();
    const { rows } = await authPool.query<{ client_id: string; name: string | null }>(
      'SELECT client_id, name FROM auth.oauth_client WHERE client_id = ANY ($1::text[])',
      [clientIds],
    );
    // As the app calls itself, without bidi controls (oauth/consent.ts, D179).
    return new Map(
      rows.flatMap((r) => {
        const name = r.name ? withoutBidiControls(r.name).trim() : '';
        return name ? [[r.client_id, name] as const] : [];
      }),
    );
  };
}

async function toRows(
  client: pg.ClientBase,
  rows: readonly DbRow[],
  names: ClientNames,
): Promise<TokenRow[]> {
  if (rows.length === 0) return [];
  const { rows: locs } = await client.query<{
    token_id: string;
    id: string;
    name: string;
    kind: string;
  }>(
    `SELECT tl.token_id, l.id, l.name, l.kind FROM public.token_locations tl
       JOIN public.locations l ON l.id = tl.location_id
      WHERE tl.token_id = ANY ($1::uuid[])
      ORDER BY lower(l.name), l.id`,
    [rows.map((r) => r.id)],
  );
  const byToken = new Map<string, { id: string; name: string; kind: string }[]>();
  for (const l of locs) {
    const loc = { id: l.id, name: l.name, kind: l.kind };
    byToken.set(l.token_id, [...(byToken.get(l.token_id) ?? []), loc]);
  }
  const clientIds = [
    ...new Set(rows.flatMap((r) => (r.oauth_client_id ? [r.oauth_client_id] : []))),
  ];
  const clientNames = await names(clientIds);
  return rows.map((r) => {
    const clientName = r.oauth_client_id ? clientNames.get(r.oauth_client_id) : undefined;
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      scope: r.scope,
      locations: byToken.get(r.id) ?? [],
      createdAt: r.created_at.toISOString(),
      expiresAt: iso(r.expires_at),
      lastUsedAt: iso(r.last_used_at),
      revokedAt: iso(r.revoked_at),
      revokedReason: r.revoked_reason,
      ...(clientName !== undefined ? { clientName } : {}),
      rowVersion: r.row_version,
    };
  });
}

type Key = [string, string];

function afterKey(cursor: string | undefined): Key | null {
  if (!cursor) return null;
  const k = decodeCursor<unknown>(cursor);
  if (
    !Array.isArray(k) ||
    typeof k[0] !== 'string' ||
    Number.isNaN(Date.parse(k[0])) ||
    !z.uuid().safeParse(k[1]).success
  ) {
    throw invalid('The cursor is not valid; start again from the first page.');
  }
  return [k[0], k[1] as string];
}

/** GET /api/v1/tokens: the caller's own, personal and OAuth, newest first. */
export async function listTokens(
  client: pg.ClientBase,
  query: z.infer<typeof TokensQuery>,
  names: ClientNames,
): Promise<{ items: TokenRow[]; next_cursor: string | null }> {
  const values: unknown[] = [];
  const v = (x: unknown) => {
    values.push(x);
    return `$${values.length}`;
  };
  const where = ['t.user_id = kept.current_user_id()'];
  if (query.kind) where.push(`t.kind = ${v(query.kind)}`);
  const after = afterKey(query.cursor);
  if (after) where.push(`(t.created_at, t.id) < (${v(after[0])}::timestamptz, ${v(after[1])})`);
  const { rows } = await client.query<DbRow>(
    `SELECT ${COLUMNS} FROM public.api_tokens t WHERE ${where.join(' AND ')}
      ORDER BY t.created_at DESC, t.id DESC LIMIT ${v(query.limit + 1)}`,
    values,
  );
  const shown = rows.slice(0, query.limit);
  const last = shown.at(-1);
  return {
    items: await toRows(client, shown, names),
    next_cursor:
      rows.length > query.limit && last
        ? encodeCursor([last.created_at.toISOString(), last.id])
        : null,
  };
}

async function readRow(client: pg.ClientBase, id: string): Promise<DbRow> {
  const { rows } = await client.query<DbRow>(
    `SELECT ${COLUMNS} FROM public.api_tokens t WHERE t.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** One of the caller's tokens, as the list shows it. */
export async function tokenRow(
  client: pg.ClientBase,
  id: string,
  names: ClientNames,
): Promise<TokenRow> {
  const [row] = await toRows(client, [await readRow(client, id)], names);
  return row as TokenRow;
}

/** The person's own account, which account-level events belong to (§7.13). */
export async function ownAccount(tx: Tx): Promise<string> {
  const [row] = (
    await tx.execute<{ id: string | null }>(sql`SELECT kept.current_owner_account_id() AS id`)
  ).rows;
  if (!row?.id) {
    // ensureAccount() makes it on the first signed-in request (task 18); a token only ever
    // exists for someone who has signed in.
    throw new AppError('internal', 500);
  }
  return row.id;
}

/**
 * D179: whether the people who can see each location differ, so a write token across them
 * would let a change in one show in another to a different audience.
 */
async function memberListsDiffer(
  client: pg.ClientBase,
  locationIds: readonly string[],
): Promise<boolean> {
  const { rows } = await client.query<{ members: string }>(
    `SELECT string_agg(m.user_id::text, ',' ORDER BY m.user_id) AS members
       FROM public.memberships m
      WHERE m.location_id = ANY ($1::uuid[])
        AND (m.expires_at IS NULL OR m.expires_at > now())
      GROUP BY m.location_id`,
    [locationIds],
  );
  return new Set(rows.map((r) => r.members)).size > 1;
}

export type ClientConfigs = CreatedToken['clientConfigs'];

/**
 * Ready-made MCP client settings: `<public URL>/mcp` with the bearer header, nothing more. The
 * step-6 rule: a client's own config-file shape is added only from that
 * client's documentation (none is read here), so neither carries a `file` yet.
 */
export function clientConfigsFor(publicUrl: string, secret: string): ClientConfigs {
  const url = `${publicUrl.replace(/\/+$/, '')}/mcp`;
  const headers = { Authorization: `Bearer ${secret}` };
  return { claudeDesktop: { url, headers }, generic: { url, headers } };
}

export type CreateResult =
  | { kind: 'created'; body: CreatedToken }
  | { kind: 'warning'; body: { warning: 'cross_location_write' } };

/** POST /api/v1/tokens. */
export async function createToken(
  ctx: Ctx,
  body: CreateTokenBody,
  opts: { key: Buffer; publicUrl: string; names: ClientNames; now?: Date },
): Promise<CreateResult> {
  const { tx, client, scope } = ctx;
  const locationIds = [...new Set(body.locationIds.map((id) => id.toLowerCase()))];
  for (const id of locationIds) {
    const { role } = await requireMembership(client, id);
    requireCan(role, 'tokens.manage-own');
    // "Own, up to own role" (roles.ts QUALIFIERS): a viewer's token only reads (D63, D180).
    if (body.scope === 'write' && role === 'viewer') {
      throw forbidden('A viewer’s token can only read; choose read access.');
    }
  }
  const now = opts.now ?? new Date();
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    throw invalid('Pick an expiry date in the future.');
  }
  if (
    body.scope === 'write' &&
    locationIds.length > 1 &&
    !body.confirmCrossLocation &&
    (await memberListsDiffer(client, locationIds))
  ) {
    return { kind: 'warning', body: { warning: 'cross_location_write' } };
  }

  const parts = newTokenParts();
  const { rows } = await client.query<DbRow>(
    `INSERT INTO public.api_tokens AS t
       (user_id, kind, name, lookup, hash, scope, created_with_mfa, expires_at)
     VALUES (kept.current_user_id(), 'personal', $1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [
      body.name,
      parts.lookup,
      hashTokenSecret(opts.key, parts.secret),
      body.scope,
      scope.mfa,
      expiresAt,
    ],
  );
  const row = rows[0] as DbRow;
  await client.query(
    `INSERT INTO public.token_locations (token_id, location_id)
     SELECT $1, x FROM unnest($2::uuid[]) AS x`,
    [row.id, locationIds],
  );
  await audited(tx, {
    locationId: null,
    ownerAccountId: await ownAccount(tx),
    actor: actorOf(scope),
    action: 'token.create',
    entity: { type: 'api_token', id: row.id },
    after: {
      name: row.name,
      kind: row.kind,
      scope: row.scope,
      locationIds,
      expiresAt: iso(row.expires_at),
    },
    requestId: ctx.requestId,
  });
  const secret = formatToken(parts);
  const [token] = await toRows(client, [row], opts.names);
  return {
    kind: 'created',
    body: {
      token: token as TokenRow,
      secret,
      clientConfigs: clientConfigsFor(opts.publicUrl, secret),
    },
  };
}

/** What the idempotency row keeps of a create (http/write.ts WriteOptions.redact): never the
 * secret, nor the configs that carry it. */
export function redactCreated(body: unknown): unknown {
  const b = body as Partial<CreatedToken>;
  if (!b.token) return body;
  const blank = (c: { url: string }) => ({ url: c.url, headers: {} });
  return {
    token: b.token,
    secret: '',
    clientConfigs: {
      claudeDesktop: blank(b.clientConfigs?.claudeDesktop ?? { url: '' }),
      generic: blank(b.clientConfigs?.generic ?? { url: '' }),
    },
  };
}

/** PATCH /api/v1/tokens/:id (If-Match): renames one. */
export async function renameToken(
  ctx: Ctx,
  id: string,
  name: string,
  expected: number,
  names: ClientNames,
): Promise<TokenRow> {
  const before = await readRow(ctx.client, id);
  checkVersion({ rowVersion: before.row_version }, expected, ['name']);
  await ctx.client.query('UPDATE public.api_tokens SET name = $2 WHERE id = $1', [id, name]);
  await audited(ctx.tx, {
    locationId: null,
    ownerAccountId: await ownAccount(ctx.tx),
    actor: actorOf(ctx.scope),
    action: 'token.update',
    entity: { type: 'api_token', id },
    before: { name: before.name },
    after: { name },
    requestId: ctx.requestId,
  });
  return tokenRow(ctx.client, id, names);
}

export type Revoked = { kind: TokenKind; oauthClientId: string | null; userId: string };

/** DELETE /api/v1/tokens/:id: revoked by its person (`user`); a revoked token stays revoked, and
 * revoking it again changes nothing. */
export async function revokeToken(ctx: Ctx, id: string): Promise<Revoked> {
  const before = await readRow(ctx.client, id);
  const revoked = {
    kind: before.kind,
    oauthClientId: before.oauth_client_id,
    userId: ctx.scope.userId,
  };
  if (before.revoked_at) return revoked;
  await ctx.client.query(
    `UPDATE public.api_tokens SET revoked_at = now(), revoked_reason = 'user' WHERE id = $1`,
    [id],
  );
  await audited(ctx.tx, {
    locationId: null,
    ownerAccountId: await ownAccount(ctx.tx),
    actor: actorOf(ctx.scope),
    action: 'token.revoke',
    entity: { type: 'api_token', id },
    before: { revokedReason: null },
    after: { revokedReason: 'user' },
    requestId: ctx.requestId,
  });
  return revoked;
}

/**
 * After an OAuth grant is revoked (T12): the app's consent and any refresh or opaque access
 * tokens Better Auth stored for this person go, as kept_auth (Better Auth's tables, D93), so the
 * app must ask again. Its JWT access tokens aren't stored (spike S6.2 §3); they are refused at
 * `/mcp` because the grant row is revoked (kept.token_oauth_for, every call).
 */
export async function forgetOAuthClient(
  authPool: pg.Pool,
  userId: string,
  clientId: string,
): Promise<void> {
  await authPool.query(
    `WITH c AS (DELETE FROM auth.oauth_consent WHERE user_id = $1 AND client_id = $2),
          r AS (DELETE FROM auth.oauth_refresh_token WHERE user_id = $1 AND client_id = $2)
     DELETE FROM auth.oauth_access_token WHERE user_id = $1 AND client_id = $2`,
    [userId, clientId],
  );
}
