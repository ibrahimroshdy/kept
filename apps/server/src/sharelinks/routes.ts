import {
  SHARE_LINK_DEFAULT_DAYS,
  SHARE_LINK_MAX_DAYS,
  SHARE_LINK_SCOPES,
  SHARE_LINK_STATES,
  SHARE_LINK_TOKEN,
  SHARE_LINK_VIEWS_PER_MINUTE,
  SHARE_VIEW_FILTERS,
} from '@kept/shared';
import { z } from 'zod';
import { rateLimited } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import { withSystem } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { SharedPageSchema, sharedPageOf } from './page.js';
import {
  createShareLink,
  listShareLinks,
  openSharedPage,
  previewShareLink,
  revokeShareLink,
  shareTokenHash,
} from './service.js';

// Read-only share links (1.5, D233; D39 item 7, D72, D116, D180; engineering spec §3.2, §3.3).
// The web's contract is apps/web/src/api/sharelinks/{paths,types}.ts and its mock.
//
// GET    /api/v1/locations/:id/share-links      → {items: ShareLinkRow[]} (never a token)
// POST   /api/v1/locations/:id/share-links      {thingId | placeId | view+title, expiresInDays}
//                                               → 201 {link, url}: the URL shown once
// DELETE /api/v1/share-links/:id                → 204 (revoked; the row stays so the list says so)
// GET    /api/v1/share-links/:id/preview?page   → SharedPage, "Preview as recipient"
// GET    /api/v1/shared/:token?page (public)    → SharedPage. Unknown, revoked, expired or no
//                                               longer backed by its creator: 404, never saying
//                                               which. 60 views a minute per link (§3.2).
//
// `share-links.create` (owner and admin) on the signed-in routes; closed to tokens
// (tokens/access.ts NEVER_FOR_TOKENS). The public route has no session (`auth: 'none'`):
// kept.share_link_open() (kept_system's door, 0127) turns the token's hash into the D116
// whitelist and counts the view; photos leave as five-minute signed URLs, for the things the
// link shows only. The token is redacted from request logs (http/logger.ts).

const IdParams = z.object({ id: z.uuid() });
const TokenParams = z.object({ token: z.string().min(1).max(200) });
const PageQuery = z.object({ page: z.coerce.number().int().min(0).max(100).optional() });
const Iso = z.iso.datetime({ offset: true });

const ViewSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    // SHARE_VIEW_FILTERS, each "any of" (or "none of", in `not`) at most 50 ids.
    filters: z
      .object({
        place: z.array(z.uuid()).max(50).optional(),
        type: z.array(z.uuid()).max(50).optional(),
        tag: z.array(z.uuid()).max(50).optional(),
      })
      .strict()
      .optional(),
    not: z.array(z.enum(SHARE_VIEW_FILTERS)).max(SHARE_VIEW_FILTERS.length).optional(),
  })
  .strict();

const ShareLinkSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  scope: z.enum(SHARE_LINK_SCOPES),
  subject: z
    .object({ id: z.uuid(), name: z.string().nullable(), isUnplaced: z.boolean() })
    .nullable(),
  title: z.string().nullable(),
  view: ViewSchema.nullable(),
  state: z.enum(SHARE_LINK_STATES),
  expiresAt: Iso,
  revokedAt: Iso.nullable(),
  createdAt: Iso,
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }),
  views: z.number().int(),
  lastViewedAt: Iso.nullable(),
});

const CreateBody = z
  .object({
    thingId: z.uuid().optional(),
    placeId: z.uuid().optional(),
    view: ViewSchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(SHARE_LINK_MAX_DAYS)
      .default(SHARE_LINK_DEFAULT_DAYS),
  })
  .strict();

/** The link is shown once: a replay says it was made, without it. */
const redactUrl = (body: unknown) => ({ ...(body as object), url: '' });

export async function shareLinkRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/locations/:id/share-links',
    {
      schema: {
        params: IdParams,
        response: { 200: z.object({ items: z.array(ShareLinkSchema) }) },
      },
    },
    (req) => scopedRead(pools, req, (_tx, client) => listShareLinks(client, req.params.id)),
  );

  app.post(
    '/api/v1/locations/:id/share-links',
    {
      schema: {
        params: IdParams,
        body: CreateBody,
        response: { 201: z.object({ link: ShareLinkSchema, url: z.string() }) },
      },
    },
    (req, reply) =>
      scopedWrite(
        pools,
        req,
        reply,
        async (tx, client, scope) => ({
          status: 201,
          body: await createShareLink(
            { tx, client, scope, requestId: req.id },
            req.params.id,
            req.body,
            deps.env.KEPT_PUBLIC_URL,
          ),
        }),
        { redact: redactUrl },
      ),
  );

  app.delete('/api/v1/share-links/:id', { schema: { params: IdParams } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await revokeShareLink({ tx, client, scope, requestId: req.id }, req.params.id);
      return { status: 204, body: undefined };
    }),
  );

  app.get(
    '/api/v1/share-links/:id/preview',
    {
      schema: { params: IdParams, querystring: PageQuery, response: { 200: SharedPageSchema } },
    },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        previewShareLink(client, deps.files, req.params.id, req.query.page ?? 0),
      ),
  );

  app.get(
    '/api/v1/shared/:token',
    {
      config: { auth: 'none' },
      schema: {
        hide: true,
        params: TokenParams,
        querystring: PageQuery,
        response: { 200: SharedPageSchema },
      },
    },
    async (req, reply) => {
      const { token } = req.params;
      if (!SHARE_LINK_TOKEN.test(token)) throw notFound();
      const hash = shareTokenHash(token);
      const door = await withSystem(pools.system, (_tx, client) =>
        openSharedPage(client, hash, req.query.page ?? 0),
      );
      if (!door) throw notFound();
      const limit = await reserveInWindow(
        pools.auth,
        limiterKey('share-link', hash),
        SHARE_LINK_VIEWS_PER_MINUTE,
        60,
      );
      if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);
      const page = await sharedPageOf(deps.files, door);
      reply
        .header('cache-control', 'no-store')
        .header('x-robots-tag', 'noindex, nofollow')
        .header('referrer-policy', 'no-referrer');
      return page;
    },
  );
}
