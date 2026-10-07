import { z } from 'zod';
import { rateLimited } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import { withScope, withSystem } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { auditMine } from '../notify/prefs.js';
import { buildFeed, FEED_TOKEN, feedTokenHash, newFeedToken } from './feed.js';

// The calendar feed (D142, D181; plan T17, Q23): a private, revocable iCal link to what's due.
//
// GET    /api/v1/me/calendar-feeds      → {items: [{id, createdAt, lastFetchedAt, fetches, revokedAt}]}
// POST   /api/v1/me/calendar-feeds      → 201 {id, url}: the URL (and its token) shown once;
//                                         only the token's SHA-256 is stored. At most 3 live.
// DELETE /api/v1/me/calendar-feeds/:id  → 204 (revoked; the row stays so the list says so)
// GET    /cal/:token.ics (public)        → text/calendar. Unknown, revoked or a disabled user: 404,
//                                         never saying which (Q23). 60 a minute per feed.
//
// The public fetch has no session (`auth: 'none'`): kept.calendar_feed_user() (kept_system's
// door, 0055) turns the token's hash into its user, counting the fetch, and the feed is built in
// that user's own kept_app scope. The token is redacted from request logs (http/logger.ts, D181).

/** Fetches a feed may take a minute (§3.2's share-link rate). */
export const FEED_FETCHES_PER_MINUTE = 60;

const Params = z.object({ token: z.string().min(1).max(200) });
const IdParams = z.object({ id: z.uuid() });
const Iso = z.iso.datetime({ offset: true });

const FeedSchema = z.object({
  id: z.uuid(),
  createdAt: Iso,
  lastFetchedAt: Iso.nullable(),
  fetches: z.number().int(),
  revokedAt: Iso.nullable(),
});

type FeedRow = {
  id: string;
  created_at: Date;
  last_fetched_at: Date | null;
  fetches: number;
  revoked_at: Date | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function calendarRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/me/calendar-feeds',
    { schema: { response: { 200: z.object({ items: z.array(FeedSchema) }) } } },
    (req) =>
      scopedRead(pools, req, async (_tx, client) => {
        const { rows } = await client.query<FeedRow>(
          `SELECT id, created_at, last_fetched_at, fetches, revoked_at FROM public.calendar_feeds
            WHERE user_id = kept.current_user_id()
            ORDER BY (revoked_at IS NULL) DESC, created_at DESC, id`,
        );
        return {
          items: rows.map((r) => ({
            id: r.id,
            createdAt: r.created_at.toISOString(),
            lastFetchedAt: iso(r.last_fetched_at),
            fetches: r.fetches,
            revokedAt: iso(r.revoked_at),
          })),
        };
      }),
  );

  app.post(
    '/api/v1/me/calendar-feeds',
    { schema: { response: { 201: z.object({ id: z.uuid(), url: z.string() }) } } },
    (req, reply) =>
      scopedWrite(
        pools,
        req,
        reply,
        async (tx, client, scope) => {
          const token = newFeedToken();
          // At most 3 live links: kept.guard_notify_caps() refuses a fourth (409, errors.ts).
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO public.calendar_feeds (user_id, token_hash)
             VALUES (kept.current_user_id(), $1) RETURNING id`,
            [feedTokenHash(token)],
          );
          const id = (rows[0] as { id: string }).id;
          await auditMine(tx, scope.userId, {
            action: 'calendar_feed.create',
            entity: { type: 'calendar_feed', id },
            requestId: req.id,
          });
          const url = new URL(`/cal/${token}.ics`, deps.env.KEPT_PUBLIC_URL).toString();
          return { status: 201, body: { id, url } };
        },
        // The link is shown once: a replay says it was made, without it.
        { redact: (body) => ({ id: (body as { id: string }).id, url: '' }) },
      ),
  );

  app.delete('/api/v1/me/calendar-feeds/:id', { schema: { params: IdParams } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      const { rowCount } = await client.query(
        `UPDATE public.calendar_feeds SET revoked_at = now()
          WHERE id = $1 AND user_id = kept.current_user_id() AND revoked_at IS NULL`,
        [req.params.id],
      );
      if (!rowCount) throw notFound();
      await auditMine(tx, scope.userId, {
        action: 'calendar_feed.revoke',
        entity: { type: 'calendar_feed', id: req.params.id },
        before: { revoked: false },
        after: { revoked: true },
        requestId: req.id,
      });
      return { status: 204, body: undefined };
    }),
  );

  app.get(
    '/cal/:token',
    { config: { auth: 'none' }, schema: { hide: true, params: Params } },
    async (req, reply) => {
      const token = req.params.token.replace(/\.ics$/i, '');
      if (!FEED_TOKEN.test(token)) throw notFound();
      const hash = feedTokenHash(token);
      const userId = await withSystem(pools.system, async (_tx, client) => {
        const { rows } = await client.query<{ user_id: string | null }>(
          'SELECT kept.calendar_feed_user($1) AS user_id',
          [hash],
        );
        return rows[0]?.user_id ?? null;
      });
      if (!userId) throw notFound();
      const limit = await reserveInWindow(
        pools.auth,
        limiterKey('calendar-feed', hash),
        FEED_FETCHES_PER_MINUTE,
        60,
      );
      if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);
      // Without a second factor: a feed link is not a session (require_2fa locations stay out).
      const body = await withScope(pools.app, { userId, mfa: false }, (_tx, client) =>
        buildFeed(client, deps.env.KEPT_PUBLIC_URL),
      );
      return reply
        .code(200)
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('cache-control', 'private, max-age=900')
        .header('x-robots-tag', 'noindex')
        .header('referrer-policy', 'no-referrer')
        .send(body);
    },
  );
}
