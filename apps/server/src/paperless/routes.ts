import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { can, newId, type Role } from '@kept/shared';
import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import sharp from 'sharp';
import { z } from 'zod';
import { allowPrivateAddresses } from '../ai/runtime.js';
import { audited } from '../audit/audited.js';
import { rateLimited, requireScope } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import type { Sealed } from '../crypto/envelope.js';
import type { SecretKeys } from '../crypto/keyring.js';
import { PAPERLESS_KINDS, type PaperlessKind } from '../db/schema/paperless.js';
import { type Scope, type Tx, withSystem } from '../db/scope.js';
import { createAttachment } from '../files/attachments.js';
import { ingestFile } from '../files/ingest.js';
import { receive } from '../files/upload.js';
import { isMoneyRole } from '../files/views.js';
import type { KeptApp } from '../http/app.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { gateFor } from '../serialize/gates.js';
import { ImageLimiter } from '../storage/derivatives.js';
import { contentDisposition } from '../storage/disposition.js';
import { TtlCache } from './cache.js';
import {
  type ClientOptions,
  PAGE_SIZE,
  PAPERLESS_ERRORS,
  PaperlessClient,
  type PaperlessDocument,
  PaperlessError,
} from './client.js';
import {
  openPaperlessConfig,
  type PaperlessConfig,
  paperlessRoot,
  paperlessToken,
  sealPaperlessConfig,
} from './config.js';
import { kindOf } from './kinds.js';

// Paperless-ngx (1.x, D248). The web's contract is apps/web/src/api/paperless/{paths,types}.ts
// and its mock.
//
// The connection, one per location (owners and admins: `location.settings`; never a token):
// GET    /api/v1/locations/:id/paperless          → {connection: PaperlessConnection | null}
// PUT    /api/v1/locations/:id/paperless          {url, token?} → PaperlessConnection
// POST   /api/v1/locations/:id/paperless/check    → {ok, version, error} (the saved one, now)
// DELETE /api/v1/locations/:id/paperless          → 204 (its links go with it)
//
// Using it (every member reads; members and up link, copy and unlink):
// GET    /api/v1/locations/:id/paperless/status   → {connected, reachable, version, error}
// GET    /api/v1/locations/:id/paperless/documents?q&page&thingId|placeId → a page of documents
// GET    /api/v1/locations/:id/paperless/documents/:documentId/thumb      → image/jpeg
// GET    /api/v1/paperless-links?thingId|placeId  → {connected, items: PaperlessLink[]}
// POST   /api/v1/paperless-links {thingId|placeId, documentIds} → 201 {items}
// DELETE /api/v1/paperless-links/:id              → 204
// GET    /api/v1/paperless-links/:id/thumb        → image/jpeg
// GET    /api/v1/paperless-links/:id/preview      → the document, as a download (members and up)
// POST   /api/v1/paperless-links/:id/copy         → 201 {link, attachment}
//
// - The token is write-only: never answered, logged or audited. kept_app never reads it; the
//   server opens it through kept.paperless_config() (as kept_system) after the request has passed
//   kept_app's own checks, so a link or a thing the caller can't see is a 404 before Paperless is
//   ever asked.
// - Saving or checking signs in to Paperless first, rate-limited with the check (6 a minute a
//   person); a search is 60 a minute a person.
// - Thumbnails are re-encoded to a small JPEG here (never Paperless's bytes as they came), served
//   like brand logos, and kept for THUMB_TTL_MS. A preview leaves as a download, as an original
//   does (D117, D157), to members and up only.
// - Receipts and invoices are money (security review #10): where the caller's gate hides money,
//   links of those kinds are left out, and their thumbnails, previews and copies are 404s.
// - Paperless down, or the token revoked: the link list never calls Paperless, so the cached
//   titles show; the status route says what is wrong.

export const CHECKS_PER_MINUTE = 6;
export const SEARCHES_PER_MINUTE = 60;
/** The most links one thing or place holds. */
export const MAX_LINKS_PER_SUBJECT = 50;
/** The most documents linked in one request. */
export const MAX_LINK_BATCH = 20;
export const THUMB_TTL_MS = 5 * 60_000;
export const STATUS_TTL_MS = 60_000;
/** The longest side of a thumbnail Kept serves. */
export const THUMB_SIDE = 320;

const Iso = z.iso.datetime({ offset: true });
const IdParams = z.object({ id: z.uuid() });
const DocId = z.coerce.number().int().positive().max(2_147_483_647);

const ConnectionView = z.object({
  id: z.uuid(),
  url: z.string(),
  version: z.string().nullable(),
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }),
  updatedAt: Iso,
  links: z.number().int(),
});
type ConnectionView = z.infer<typeof ConnectionView>;

const PutBody = z
  .object({ url: z.string().trim().min(1).max(500), token: z.string().min(1).max(600).optional() })
  .strict();

const Check = z.object({
  ok: z.boolean(),
  version: z.string().nullable(),
  error: z.enum(PAPERLESS_ERRORS).nullable(),
});

const Status = z.object({
  connected: z.boolean(),
  reachable: z.boolean().nullable(),
  version: z.string().nullable(),
  error: z.enum(PAPERLESS_ERRORS).nullable(),
  url: z.string().nullable(),
});

const SearchHit = z.object({
  documentId: z.number().int(),
  title: z.string(),
  kind: z.enum(PAPERLESS_KINDS),
  typeName: z.string().nullable(),
  correspondent: z.string().nullable(),
  createdOn: z.string().nullable(),
  tags: z.array(z.string()),
  linked: z.boolean(),
  openUrl: z.string(),
});
type SearchHit = z.infer<typeof SearchHit>;

const LinkView = z.object({
  id: z.uuid(),
  documentId: z.number().int(),
  subject: z.union([z.object({ thingId: z.uuid() }), z.object({ placeId: z.uuid() })]),
  title: z.string(),
  kind: z.enum(PAPERLESS_KINDS),
  typeName: z.string().nullable(),
  correspondent: z.string().nullable(),
  createdOn: z.string().nullable(),
  copiedAttachmentId: z.uuid().nullable(),
  openUrl: z.string(),
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }),
  createdAt: Iso,
});
type LinkView = z.infer<typeof LinkView>;

const SubjectQuery = z
  .object({ thingId: z.uuid().optional(), placeId: z.uuid().optional() })
  .refine((q) => (q.thingId ? 1 : 0) + (q.placeId ? 1 : 0) === 1, {
    message: 'Give thingId or placeId.',
  });

const LinkBody = z
  .object({
    thingId: z.uuid().optional(),
    placeId: z.uuid().optional(),
    documentIds: z.array(DocId).min(1).max(MAX_LINK_BATCH),
  })
  .strict()
  .refine((b) => (b.thingId ? 1 : 0) + (b.placeId ? 1 : 0) === 1, {
    message: 'Give thingId or placeId.',
  });

type Subject = { kind: 'thing' | 'place'; id: string; locationId: string; name: string };

type ConnRow = {
  id: string;
  base_url: string;
  server_version: string | null;
  created_by: string;
  creator_name: string | null;
  updated_at: Date;
  links: number;
};

type LinkRow = {
  id: string;
  location_id: string;
  connection_id: string;
  thing_id: string | null;
  place_id: string | null;
  document_id: number;
  title: string;
  kind: PaperlessKind;
  type_name: string | null;
  correspondent: string | null;
  created_on: string | null;
  copied_attachment_id: string | null;
  created_by: string;
  creator_name: string | null;
  created_at: Date;
  base_url: string;
};

const LINK_SELECT = `SELECT l.id, l.location_id, l.connection_id, l.thing_id, l.place_id,
         l.document_id, l.title, l.kind, l.type_name, l.correspondent, l.created_on::text,
         l.copied_attachment_id, l.created_by, p.display_name AS creator_name, l.created_at,
         c.base_url
    FROM public.paperless_links l
    JOIN public.paperless_connections c ON c.id = l.connection_id
    LEFT JOIN public.user_profiles p ON p.user_id = l.created_by`;

/** "Open in Paperless": the document's page in Paperless's own web app (its `documents/:id` route). */
export const openUrlOf = (baseUrl: string, documentId: number) =>
  `${baseUrl.replace(/\/+$/, '')}/documents/${documentId}`;

function linkView(r: LinkRow): LinkView {
  return {
    id: r.id,
    documentId: r.document_id,
    subject: r.thing_id ? { thingId: r.thing_id } : { placeId: r.place_id as string },
    title: r.title,
    kind: r.kind,
    typeName: r.type_name,
    correspondent: r.correspondent,
    createdOn: r.created_on,
    copiedAttachmentId: r.copied_attachment_id,
    openUrl: openUrlOf(r.base_url, r.document_id),
    createdBy: { id: r.created_by, displayName: r.creator_name ?? '' },
    createdAt: r.created_at.toISOString(),
  };
}

/** The audit image of a link: the document and its cached words, never a URL or token. */
const linkImage = (r: Pick<LinkRow, 'document_id' | 'title' | 'kind'>) => ({
  paperless_document_id: r.document_id,
  title: r.title,
  kind: r.kind,
});

async function requireSettings(client: pg.ClientBase, locationId: string): Promise<void> {
  const { role } = await requireMembership(client, locationId);
  requireCan(role, 'location.settings');
}

async function connRow(client: pg.ClientBase, locationId: string): Promise<ConnRow | null> {
  const { rows } = await client.query<ConnRow>(
    `SELECT c.id, c.base_url, c.server_version, c.created_by, p.display_name AS creator_name,
            c.updated_at,
            (SELECT count(*)::int FROM public.paperless_links l WHERE l.connection_id = c.id) AS links
       FROM public.paperless_connections c
       LEFT JOIN public.user_profiles p ON p.user_id = c.created_by
      WHERE c.location_id = $1`,
    [locationId],
  );
  return rows[0] ?? null;
}

const connView = (r: ConnRow): ConnectionView => ({
  id: r.id,
  url: r.base_url,
  version: r.server_version,
  createdBy: { id: r.created_by, displayName: r.creator_name ?? '' },
  updatedAt: r.updated_at.toISOString(),
  links: r.links,
});

/** The thing or place a request names, as the caller sees it (live only): 404 otherwise. */
async function subjectOf(
  client: pg.ClientBase,
  q: { thingId?: string | undefined; placeId?: string | undefined },
): Promise<Subject> {
  if (q.thingId) {
    const { rows } = await client.query<{ location_id: string; name: string | null }>(
      'SELECT location_id, name FROM public.things WHERE id = $1 AND deleted_at IS NULL',
      [q.thingId.toLowerCase()],
    );
    const r = rows[0];
    if (!r) throw notFound();
    return {
      kind: 'thing',
      id: q.thingId.toLowerCase(),
      locationId: r.location_id,
      name: r.name ?? '',
    };
  }
  const { rows } = await client.query<{ location_id: string; name: string }>(
    'SELECT location_id, name FROM public.places WHERE id = $1 AND deleted_at IS NULL',
    [(q.placeId as string).toLowerCase()],
  );
  const r = rows[0];
  if (!r) throw notFound();
  return {
    kind: 'place',
    id: (q.placeId as string).toLowerCase(),
    locationId: r.location_id,
    name: r.name,
  };
}

/** 403 unless the caller adds files where `locationId` is (members and up). */
async function requireAdder(client: pg.ClientBase, locationId: string): Promise<Role> {
  const { role } = await requireMembership(client, locationId);
  requireCan(role, 'attachments.add', 'Viewers can see linked documents but not link them.');
  return role;
}

const WRITERS = new Set<Role>(['owner', 'admin', 'member']);

/** A link the caller can see, money-gated: 404 otherwise. */
async function readLink(tx: Tx, client: pg.ClientBase, scope: Scope, id: string): Promise<LinkRow> {
  const { rows } = await client.query<LinkRow>(`${LINK_SELECT} WHERE l.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw notFound();
  if (isMoneyRole(row.kind) && !(await gateFor(tx, row.location_id, scope)).showMoney) {
    throw notFound();
  }
  return row;
}

/** Re-encodes a thumbnail as a small JPEG: Kept never serves Paperless's bytes as they came. */
async function reencode(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes, { limitInputPixels: 4096 * 4096 })
      .rotate()
      .resize(THUMB_SIDE, THUMB_SIDE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 78 })
      .toBuffer();
  } catch {
    throw new PaperlessError('not_paperless');
  }
}

function sendThumb(reply: FastifyReply, jpeg: Buffer) {
  reply
    .header('cache-control', `private, max-age=${THUMB_TTL_MS / 1000}`)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox");
  return reply.type('image/jpeg').send(jpeg);
}

const fileClassOf = (mime: string) => (mime.startsWith('image/') ? 'photo' : 'document');

/** The cached words of a document: its title, kind, type, correspondent and date. */
type Cached = {
  title: string;
  kind: PaperlessKind;
  typeName: string | null;
  correspondent: string | null;
  createdOn: string | null;
  tags: string[];
};

const clip = (s: string | null | undefined, n: number) => {
  const t = s?.trim();
  return t ? t.slice(0, n) : null;
};
const dateOf = (s: string | null | undefined) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s ?? '');
  return m?.[1] ?? null;
};

/** Each document's cached words, the names behind its ids read in three calls at most. */
async function describe(client: PaperlessClient, docs: PaperlessDocument[]): Promise<Cached[]> {
  const [types, correspondents, tags] = await Promise.all([
    client.names(
      'document_types',
      docs.flatMap((d) => (d.document_type ? [d.document_type] : [])),
    ),
    client.names(
      'correspondents',
      docs.flatMap((d) => (d.correspondent ? [d.correspondent] : [])),
    ),
    client.names(
      'tags',
      docs.flatMap((d) => d.tags ?? []),
    ),
  ]);
  return docs.map((d) => {
    const typeName = d.document_type ? (types.get(d.document_type) ?? null) : null;
    const tagNames = (d.tags ?? []).flatMap((t) => {
      const n = tags.get(t);
      return n ? [n] : [];
    });
    return {
      title: clip(d.title, 300) ?? `#${d.id}`,
      kind: kindOf(typeName, tagNames),
      typeName: clip(typeName, 128),
      correspondent: clip(d.correspondent ? correspondents.get(d.correspondent) : null, 128),
      createdOn: dateOf(d.created),
      tags: tagNames.map((t) => t.slice(0, 128)),
    };
  });
}

export async function paperlessRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const thumbs = new TtlCache<Buffer>(THUMB_TTL_MS, 8 << 20, (b) => b.length);
  const statuses = new TtlCache<z.infer<typeof Status>>(STATUS_TTL_MS, 500);
  // Copies go one at a time: a Pi-sized server resizes one image at once (storage/derivatives.ts).
  const limiter = new ImageLimiter(1);

  function keysOf(): SecretKeys {
    if (!deps.secretKeys) {
      throw new AppError('internal', 503, 'Secret values are not configured on this server.');
    }
    return deps.secretKeys;
  }

  async function clientOptions(): Promise<ClientOptions> {
    return { allowPrivate: await allowPrivateAddresses(pools) };
  }

  /** The location's connection with its token, opened (kept_system, after kept_app's checks). */
  async function connectionOf(
    locationId: string,
  ): Promise<{ id: string; config: PaperlessConfig } | null> {
    const row = await withSystem(pools.system, async (_tx, c) => {
      const { rows } = await c.query<{ id: string; config_ciphertext: Sealed }>(
        'SELECT id, config_ciphertext FROM kept.paperless_config($1)',
        [locationId],
      );
      return rows[0] ?? null;
    });
    if (!row) return null;
    const keys = keysOf();
    return {
      id: row.id,
      config: openPaperlessConfig(keys.get().keyring, row.id, row.config_ciphertext),
    };
  }

  async function clientOf(locationId: string) {
    const conn = await connectionOf(locationId);
    if (!conn) throw notFound('This location is not connected to Paperless.');
    return { conn, client: new PaperlessClient(conn.config, await clientOptions()) };
  }

  async function limit(
    kind: 'paperless-check' | 'paperless-search',
    userId: string,
    reply: FastifyReply,
  ) {
    const max = kind === 'paperless-check' ? CHECKS_PER_MINUTE : SEARCHES_PER_MINUTE;
    const decision = await reserveInWindow(pools.auth, limiterKey(kind, userId), max, 60);
    if (!decision.allowed) throw rateLimited(reply, decision.retryAfter);
  }

  /** Signs in: the version, or the reason it failed. */
  async function ping(config: PaperlessConfig): Promise<{ version: string } | { error: string }> {
    try {
      return await new PaperlessClient(config, await clientOptions()).ping();
    } catch (e) {
      if (e instanceof PaperlessError) return { error: e.reason };
      return { error: 'failed' };
    }
  }

  // --- the connection --------------------------------------------------------------------------

  app.get(
    '/api/v1/locations/:id/paperless',
    {
      schema: {
        params: IdParams,
        response: { 200: z.object({ connection: ConnectionView.nullable() }) },
      },
    },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        await requireSettings(client, req.params.id);
        const row = await connRow(client, req.params.id);
        return { connection: row ? connView(row) : null };
      }),
  );

  app.put(
    '/api/v1/locations/:id/paperless',
    { schema: { params: IdParams, body: PutBody, response: { 200: ConnectionView } } },
    async (req, reply) => {
      const keys = keysOf().get();
      const locationId = req.params.id.toLowerCase();
      const existing = await scopedRead(pools, req, async (_tx, client) => {
        await requireSettings(client, locationId);
        return connRow(client, locationId);
      });
      const baseUrl = paperlessRoot(req.body.url);
      let token = req.body.token !== undefined ? paperlessToken(req.body.token) : undefined;
      if (!token && existing) token = (await connectionOf(locationId))?.config.token;
      if (!token) throw invalid('token: the API token from your Paperless profile.');
      const config: PaperlessConfig = { baseUrl, token };
      await limit('paperless-check', requireScope(req).userId, reply);
      const signedIn = await ping(config);
      if ('error' in signedIn) {
        const err = new PaperlessError(signedIn.error as PaperlessError['reason']);
        throw new AppError('validation', 400, err.hint, { paperlessError: signedIn.error });
      }
      const result = await scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await requireSettings(client, locationId);
        const id = existing?.id ?? newId();
        const sealed = sealPaperlessConfig(keys.current, id, config);
        if (existing) {
          await client.query(
            `UPDATE public.paperless_connections
                SET base_url = $2, config_ciphertext = $3::jsonb, key_version = $4,
                    server_version = $5
              WHERE id = $1`,
            [id, baseUrl, JSON.stringify(sealed), keys.current.keyVersion, signedIn.version],
          );
        } else {
          await client.query(
            `INSERT INTO public.paperless_connections (id, location_id, base_url, config_ciphertext,
                                                       key_version, server_version, created_by)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, kept.current_user_id())`,
            [
              id,
              locationId,
              baseUrl,
              JSON.stringify(sealed),
              keys.current.keyVersion,
              signedIn.version,
            ],
          );
        }
        const row = (await connRow(client, locationId)) as ConnRow;
        // Never the token: the address and the version, and that the token changed.
        await audited(tx, {
          locationId,
          actor: { type: 'user', id: scope.userId },
          action: existing ? 'paperless.update' : 'paperless.connect',
          entity: { type: 'paperless_connection', id },
          ...(existing
            ? { before: { url: existing.base_url, version: existing.server_version } }
            : {}),
          after: {
            url: baseUrl,
            version: signedIn.version,
            ...(existing && req.body.token !== undefined ? { token_changed: true } : {}),
          },
          requestId: req.id,
        });
        return { status: 200, body: connView(row) };
      });
      thumbs.deletePrefix(`${existing?.id ?? ''}|`);
      statuses.delete(locationId);
      return result;
    },
  );

  app.post(
    '/api/v1/locations/:id/paperless/check',
    { schema: { params: IdParams, response: { 200: Check } } },
    async (req, reply) => {
      const locationId = req.params.id.toLowerCase();
      await scopedRead(pools, req, (_tx, client) => requireSettings(client, locationId));
      const conn = await connectionOf(locationId);
      if (!conn) throw notFound();
      await limit('paperless-check', requireScope(req).userId, reply);
      const result = await ping(conn.config);
      statuses.delete(locationId);
      return 'error' in result
        ? { ok: false, version: null, error: result.error as PaperlessError['reason'] }
        : { ok: true, version: result.version, error: null };
    },
  );

  app.delete(
    '/api/v1/locations/:id/paperless',
    { schema: { params: IdParams } },
    async (req, reply) => {
      const locationId = req.params.id.toLowerCase();
      let gone: string | null = null;
      const out = await scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await requireSettings(client, locationId);
        const row = await connRow(client, locationId);
        if (!row) throw notFound();
        await client.query('DELETE FROM public.paperless_connections WHERE id = $1', [row.id]);
        gone = row.id;
        await audited(tx, {
          locationId,
          actor: { type: 'user', id: scope.userId },
          action: 'paperless.disconnect',
          entity: { type: 'paperless_connection', id: row.id },
          before: { url: row.base_url, version: row.server_version, links: row.links },
          requestId: req.id,
        });
        return { status: 204, body: undefined };
      });
      if (gone) thumbs.deletePrefix(`${gone}|`);
      statuses.delete(locationId);
      return out;
    },
  );

  // --- status and search -----------------------------------------------------------------------

  app.get(
    '/api/v1/locations/:id/paperless/status',
    { schema: { params: IdParams, response: { 200: Status } } },
    async (req) => {
      const locationId = req.params.id.toLowerCase();
      const row = await scopedRead(pools, req, async (_tx, client) => {
        await requireMembership(client, locationId);
        return connRow(client, locationId);
      });
      if (!row) {
        return { connected: false, reachable: null, version: null, error: null, url: null };
      }
      const cached = statuses.get(locationId);
      if (cached) return cached;
      const conn = await connectionOf(locationId);
      const result = conn ? await ping(conn.config) : { error: 'failed' };
      const status = {
        connected: true,
        reachable: !('error' in result),
        version: 'error' in result ? row.server_version : result.version,
        error: 'error' in result ? (result.error as PaperlessError['reason']) : null,
        url: row.base_url,
      };
      statuses.set(locationId, status);
      return status;
    },
  );

  app.get(
    '/api/v1/locations/:id/paperless/documents',
    {
      schema: {
        params: IdParams,
        querystring: z.object({
          q: z.string().trim().max(200).optional(),
          page: z.coerce.number().int().min(1).max(500).default(1),
          thingId: z.uuid().optional(),
          placeId: z.uuid().optional(),
        }),
        response: {
          200: z.object({
            count: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
            items: z.array(SearchHit),
          }),
        },
      },
    },
    async (req, reply) => {
      const locationId = req.params.id.toLowerCase();
      const { q, page, thingId, placeId } = req.query;
      const showMoney = await scopedRead(pools, req, async (tx, client, scope) => {
        await requireAdder(client, locationId);
        if (thingId || placeId) {
          const s = await subjectOf(client, { thingId, placeId });
          if (s.locationId !== locationId) throw notFound();
        }
        return (await gateFor(tx, locationId, scope)).showMoney;
      });
      await limit('paperless-search', requireScope(req).userId, reply);
      const { conn, client } = await clientOf(locationId);
      const found = await client.search(q ?? '', page);
      const words = await describe(client, found.results);
      const linked = new Set<number>();
      if (thingId || placeId) {
        const ids = await scopedRead(pools, req, async (_tx, c) => {
          const { rows } = await c.query<{ document_id: number }>(
            `SELECT document_id FROM public.paperless_links
              WHERE ${thingId ? 'thing_id' : 'place_id'} = $1 AND document_id = ANY ($2::int[])`,
            [(thingId ?? placeId) as string, found.results.map((d) => d.id)],
          );
          return rows.map((r) => r.document_id);
        });
        for (const id of ids) linked.add(id);
      }
      const items: SearchHit[] = found.results.flatMap((d, i) => {
        const w = words[i] as Cached;
        // Receipts and invoices are money: left out where the caller's gate hides it.
        if (!showMoney && isMoneyRole(w.kind)) return [];
        return [
          {
            documentId: d.id,
            title: w.title,
            kind: w.kind,
            typeName: w.typeName,
            correspondent: w.correspondent,
            createdOn: w.createdOn,
            tags: w.tags,
            linked: linked.has(d.id),
            openUrl: openUrlOf(conn.config.baseUrl, d.id),
          },
        ];
      });
      return { count: found.count, page, pageSize: PAGE_SIZE, items };
    },
  );

  async function thumbOf(
    connId: string,
    client: PaperlessClient,
    documentId: number,
  ): Promise<Buffer> {
    const key = `${connId}|${documentId}`;
    const hit = thumbs.get(key);
    if (hit) return hit;
    const jpeg = await reencode((await client.thumb(documentId)).bytes);
    thumbs.set(key, jpeg);
    return jpeg;
  }

  app.get(
    '/api/v1/locations/:id/paperless/documents/:documentId/thumb',
    { schema: { params: z.object({ id: z.uuid(), documentId: DocId }) } },
    async (req, reply) => {
      const locationId = req.params.id.toLowerCase();
      await scopedRead(pools, req, (_tx, client) => requireAdder(client, locationId));
      const { conn, client } = await clientOf(locationId);
      return sendThumb(reply, await thumbOf(conn.id, client, req.params.documentId));
    },
  );

  // --- links -----------------------------------------------------------------------------------

  app.get(
    '/api/v1/paperless-links',
    {
      schema: {
        querystring: SubjectQuery,
        response: {
          200: z.object({
            connected: z.boolean(),
            url: z.string().nullable(),
            items: z.array(LinkView),
          }),
        },
      },
    },
    (req) =>
      scopedRead(pools, req, async (tx, client, scope) => {
        const s = await subjectOf(client, req.query);
        const { rows } = await client.query<LinkRow>(
          `${LINK_SELECT} WHERE l.${s.kind === 'thing' ? 'thing_id' : 'place_id'} = $1
            ORDER BY l.created_on DESC NULLS LAST, l.created_at DESC, l.id`,
          [s.id],
        );
        const showMoney = (await gateFor(tx, s.locationId, scope)).showMoney;
        const { rows: conn } = await client.query<{ base_url: string }>(
          'SELECT base_url FROM public.paperless_connections WHERE location_id = $1',
          [s.locationId],
        );
        return {
          connected: conn.length > 0,
          url: conn[0]?.base_url ?? null,
          items: rows.filter((r) => showMoney || !isMoneyRole(r.kind)).map(linkView),
        };
      }),
  );

  app.post(
    '/api/v1/paperless-links',
    { schema: { body: LinkBody, response: { 201: z.object({ items: z.array(LinkView) }) } } },
    async (req, reply) => {
      const body = req.body;
      const subject = await scopedRead(pools, req, async (_tx, client) => {
        const s = await subjectOf(client, body);
        await requireAdder(client, s.locationId);
        return s;
      });
      const { conn, client } = await clientOf(subject.locationId);
      // Kept caches what Paperless says about each document, never what the browser sent.
      const ids = [...new Set(body.documentIds)];
      const docs = await Promise.all(ids.map((id) => client.document(id)));
      const words = await describe(client, docs);
      return scopedWrite(pools, req, reply, async (tx, c, scope) => {
        await requireAdder(c, subject.locationId);
        const gate = await gateFor(tx, subject.locationId, scope);
        const column = subject.kind === 'thing' ? 'thing_id' : 'place_id';
        const { rows: count } = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.paperless_links WHERE ${column} = $1`,
          [subject.id],
        );
        const made: string[] = [];
        let n = count[0]?.n ?? 0;
        for (const [i, doc] of docs.entries()) {
          const w = words[i] as Cached;
          if (isMoneyRole(w.kind) && !gate.showMoney) {
            throw new AppError(
              'module_off',
              409,
              'Receipts and invoices show money, which is hidden for you in this location.',
            );
          }
          if (n >= MAX_LINKS_PER_SUBJECT) {
            throw conflict(
              `A ${subject.kind} holds at most ${MAX_LINKS_PER_SUBJECT} Paperless documents.`,
            );
          }
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO public.paperless_links (location_id, connection_id, ${column}, document_id,
                                                 title, kind, type_name, correspondent, created_on,
                                                 created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, kept.current_user_id())
             ON CONFLICT (${column}, document_id) DO NOTHING
             RETURNING id`,
            [
              subject.locationId,
              conn.id,
              subject.id,
              doc.id,
              w.title,
              w.kind,
              w.typeName,
              w.correspondent,
              w.createdOn,
            ],
          );
          const id = rows[0]?.id;
          if (!id) continue; // already linked
          n += 1;
          made.push(id);
          await audited(tx, {
            locationId: subject.locationId,
            actor: { type: 'user', id: scope.userId },
            action: 'paperless_link.create',
            entity: { type: 'paperless_link', id },
            after: {
              ...linkImage({ document_id: doc.id, title: w.title, kind: w.kind }),
              [column]: subject.id,
            },
            ...(subject.kind === 'thing'
              ? { subjects: [subject.id], rootThingId: subject.id }
              : {}),
            requestId: req.id,
          });
        }
        const { rows } = await c.query<LinkRow>(
          `${LINK_SELECT} WHERE l.${column} = $1 AND l.document_id = ANY ($2::int[])
            ORDER BY l.created_at, l.id`,
          [subject.id, ids],
        );
        return { status: 201, body: { items: rows.map(linkView) } };
      });
    },
  );

  app.delete('/api/v1/paperless-links/:id', { schema: { params: IdParams } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      const row = await readLink(tx, client, scope, req.params.id.toLowerCase());
      const { role } = await requireMembership(client, row.location_id);
      const own = row.created_by === scope.userId;
      if (!can(role, own ? 'attachments.delete-own' : 'attachments.delete-any')) {
        throw forbidden(
          own
            ? 'Viewers can see linked documents but not unlink them.'
            : 'Only owners and admins unlink a document someone else linked.',
        );
      }
      await client.query('DELETE FROM public.paperless_links WHERE id = $1', [row.id]);
      await audited(tx, {
        locationId: row.location_id,
        actor: { type: 'user', id: scope.userId },
        action: 'paperless_link.delete',
        entity: { type: 'paperless_link', id: row.id },
        before: {
          ...linkImage(row),
          ...(row.thing_id ? { thing_id: row.thing_id } : { place_id: row.place_id }),
        },
        ...(row.thing_id ? { subjects: [row.thing_id], rootThingId: row.thing_id } : {}),
        requestId: req.id,
      });
      return { status: 204, body: undefined };
    }),
  );

  app.get(
    '/api/v1/paperless-links/:id/thumb',
    { schema: { params: IdParams } },
    async (req, reply) => {
      const row = await scopedRead(pools, req, (tx, client, scope) =>
        readLink(tx, client, scope, req.params.id.toLowerCase()),
      );
      const { conn, client } = await clientOf(row.location_id);
      if (conn.id !== row.connection_id) throw notFound();
      return sendThumb(reply, await thumbOf(conn.id, client, row.document_id));
    },
  );

  app.get(
    '/api/v1/paperless-links/:id/preview',
    { schema: { params: IdParams } },
    async (req, reply) => {
      const files = deps.files;
      const max = files?.maxFileBytes ?? 50 << 20;
      const row = await scopedRead(pools, req, async (tx, client, scope) => {
        const r = await readLink(tx, client, scope, req.params.id.toLowerCase());
        const { role } = await requireMembership(client, r.location_id);
        if (!WRITERS.has(role)) {
          throw forbidden('Documents are for members and above. Viewers see the thumbnails.');
        }
        return r;
      });
      const { conn, client } = await clientOf(row.location_id);
      if (conn.id !== row.connection_id) throw notFound();
      const file = await client.file(row.document_id, 'preview');
      if (file.length !== null && file.length > max) {
        await file.body.cancel().catch(() => {});
        throw new PaperlessError('too_large');
      }
      let seen = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          seen += chunk.length;
          done(seen > max ? new PaperlessError('too_large') : null, chunk);
        },
      });
      const stream = Readable.fromWeb(file.body as unknown as WebReadableStream<Uint8Array>).pipe(
        cap,
      );
      const ext = file.contentType === 'application/pdf' ? '.pdf' : '';
      reply
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('content-disposition', contentDisposition('attachment', `${row.title}${ext}`));
      if (file.length !== null) reply.header('content-length', String(file.length));
      return reply.type(file.contentType).send(stream);
    },
  );

  app.post(
    '/api/v1/paperless-links/:id/copy',
    {
      schema: {
        params: IdParams,
        response: { 201: z.object({ link: LinkView, attachmentId: z.uuid() }) },
      },
    },
    async (req, reply) => {
      const files = deps.files;
      if (!files) throw new AppError('internal', 503, 'File storage is not configured.');
      const scope = requireScope(req);
      const linkId = req.params.id.toLowerCase();
      const row = await scopedRead(pools, req, async (tx, client, s) => {
        const r = await readLink(tx, client, s, linkId);
        await requireAdder(client, r.location_id);
        return r;
      });
      if (row.copied_attachment_id) {
        throw conflict('This document is already copied into Kept.');
      }
      const { conn, client } = await clientOf(row.location_id);
      if (conn.id !== row.connection_id) throw notFound();
      // Fresh words for the cache, then the file Paperless serves for download (the archived PDF
      // when it made one, otherwise the original), counted and capped as an upload is.
      const doc = await client.document(row.document_id);
      const words = (await describe(client, [doc]))[0] as Cached;
      if (limiter.full) {
        throw new AppError(
          'internal',
          503,
          'Kept is busy with other files. Try again in a few seconds.',
        );
      }
      const file = await client.file(row.document_id, 'download');
      if (file.length !== null && file.length > files.maxFileBytes) {
        await file.body.cancel().catch(() => {});
        throw new PaperlessError('too_large');
      }
      let received: Awaited<ReturnType<typeof receive>>;
      try {
        received = await receive(
          Readable.fromWeb(file.body as unknown as WebReadableStream<Uint8Array>),
          files.tmpDir,
          files.maxFileBytes,
        );
      } catch (e) {
        if (e instanceof AppError && e.code === 'payload_too_large')
          throw new PaperlessError('too_large');
        if (e instanceof AppError) throw e;
        throw new PaperlessError('unreachable');
      }
      try {
        const fileId = newId();
        const ingested = await ingestFile(
          { pools, files, limiter, log: req.log, jobs: deps.jobs },
          scope,
          {
            file: received.file,
            sha256: received.sha256,
            bytes: received.bytes,
            fileId,
            locationId: row.location_id,
            class: fileClassOf(file.contentType),
          },
          { auditAction: 'file.import', requestId: req.id },
        );
        const storedId = ingested.body.deduplicatedFrom ?? ingested.body.id;
        return await scopedWrite(pools, req, reply, async (tx, c, s) => {
          const fresh = await readLink(tx, c, s, linkId);
          if (fresh.copied_attachment_id)
            throw conflict('This document is already copied into Kept.');
          const attachment = await createAttachment(
            tx,
            c,
            files,
            (locationId) => gateFor(tx, locationId, s),
            s.userId,
            {
              id: newId(),
              locationId: fresh.location_id,
              fileId: storedId,
              subject: fresh.thing_id
                ? { thingId: fresh.thing_id }
                : { placeId: fresh.place_id as string },
              role: words.kind,
            },
            req.id,
          );
          await c.query(
            `UPDATE public.paperless_links
                SET copied_attachment_id = $2, title = $3, kind = $4, type_name = $5,
                    correspondent = $6, created_on = $7, refreshed_at = now()
              WHERE id = $1`,
            [
              fresh.id,
              attachment.id,
              words.title,
              words.kind,
              words.typeName,
              words.correspondent,
              words.createdOn,
            ],
          );
          await audited(tx, {
            locationId: fresh.location_id,
            actor: { type: 'user', id: s.userId },
            action: 'paperless_link.copy',
            entity: { type: 'paperless_link', id: fresh.id },
            before: { copied_attachment_id: null },
            after: {
              ...linkImage({ ...fresh, title: words.title, kind: words.kind }),
              copied_attachment_id: attachment.id,
            },
            ...(fresh.thing_id ? { subjects: [fresh.thing_id], rootThingId: fresh.thing_id } : {}),
            requestId: req.id,
          });
          const updated = await readLink(tx, c, s, linkId);
          return { status: 201, body: { link: linkView(updated), attachmentId: attachment.id } };
        });
      } finally {
        await rm(received.file, { force: true });
      }
    },
  );
}
