import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { rateLimited } from '../auth/http.js';
import { limiterKey, reserveInWindow } from '../auth/sign-in-limiter.js';
import type { Scope, Tx } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  EmptyIntoBody,
  emptyInto,
  MoveBody,
  MovePreviewBody,
  MovePreviewSchema,
  MoveResultSchema,
  moveThings,
  PREVIEWS_PER_MINUTE,
  previewMove,
} from './move.js';
import type { Ctx } from './service.js';
import { Params } from './validate.js';

// Moves (T15; D45, D161), registered from things/routes.ts:
//
// POST /api/v1/things/move/preview {thingIds (≤200), to}  → MovePreview (read-only; allowlisted
//                                                            in the route catalogue); 60 a
//                                                            minute per person, ≤1000 things
// POST /api/v1/things/move {thingIds (≤200), to, quantity?} → {moved}; If-Match optional, for
//                                                            one thing only (else 400)
// POST /api/v1/things/:id/empty-into {to}                  → {moved}

/** If-Match when the client sent one: a one-thing move takes it (security review #25). */
function optionalIfMatch(req: FastifyRequest): number | null {
  return req.headers['if-match'] === undefined ? null : requireIfMatch(req);
}

export async function moveRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const ctxOf = (tx: Tx, client: pg.PoolClient, scope: Scope, requestId: string): Ctx => ({
    tx,
    client,
    scope,
    requestId,
    jobs: deps.jobs,
    files: deps.files,
  });

  app.post(
    '/api/v1/things/move/preview',
    { schema: { body: MovePreviewBody, response: { 200: MovePreviewSchema } } },
    (req, reply) =>
      scopedRead(pools, req, async (tx, client, scope) => {
        // A preview runs the move in a savepoint: at most 60 a minute per person (review #27).
        const limit = await reserveInWindow(
          pools.auth,
          limiterKey('move-preview', scope.userId),
          PREVIEWS_PER_MINUTE,
          60,
        );
        if (!limit.allowed) throw rateLimited(reply, limit.retryAfter);
        return previewMove(ctxOf(tx, client, scope, req.id), req.body);
      }),
  );

  app.post(
    '/api/v1/things/move',
    { schema: { body: MoveBody, response: { 200: MoveResultSchema } } },
    (req, reply) => {
      const expected = optionalIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await moveThings(ctxOf(tx, client, scope, req.id), req.body, expected),
      }));
    },
  );

  app.post(
    '/api/v1/things/:id/empty-into',
    { schema: { params: Params, body: EmptyIntoBody, response: { 200: MoveResultSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await emptyInto(
          ctxOf(tx, client, scope, req.id),
          req.params.id.toLowerCase(),
          req.body,
        ),
      })),
  );
}
