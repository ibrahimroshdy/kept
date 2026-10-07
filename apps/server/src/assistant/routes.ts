import { CONTEXT_KINDS, TURN_LIMITS } from '@kept/shared';
import { z } from 'zod';
import { requireScope } from '../auth/http.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { decodeCursor, paginationQuery } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import type { ToolDeps } from '../tools/types.js';
import { cancelProposals, confirmProposals } from './proposals.js';
import { ask, askContext, askPreflight, cancelTurn } from './service.js';
import {
  createThread,
  deleteThread,
  listThreads,
  resolveContext,
  threadDetail,
  turnView,
} from './threads.js';

// The assistant's routes (step-6 plan T13; D22–D24, D123, D164, D166, D179; Q2, Q5). Threads are
// the caller's own, private even from admins and the instance admin (D23): someone else's is a
// 404. There is no streaming (Q2): POST …/turns answers 202 with the turn's id, and the web polls
// GET /assistant/turns/:id every second while it is live.
//
// Audit (D188): threads, turns and the private messages in them are not audit subjects (D23); a
// confirmed proposal's write is audited by the tool's own operation, as the person (actor
// `user`), with its 7-day undo. The route catalogue's allowlist says so for the rest.

const Id = z.object({ id: z.uuid() });
const ContextBody = z
  .object({ kind: z.enum(CONTEXT_KINDS), id: z.string().min(1).max(200).optional() })
  .optional();
const ThreadsQuery = paginationQuery.extend({ q: z.string().max(200).optional() });
const CreateBody = z.object({ context: ContextBody }).default({});
const AskBodySchema = z.object({
  text: z
    .string()
    .min(1)
    .max(TURN_LIMITS.maxQuestionChars * 2),
  context: ContextBody,
  locale: z.string().min(2).max(20),
});
const ConfirmBodySchema = z.object({
  batchId: z.uuid(),
  proposals: z
    .array(
      z.object({
        id: z.uuid(),
        argsHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
        // add_thing (D213): the items kept on the card, with the person's edits.
        items: z
          .array(
            z.object({
              index: z.number().int().min(0).max(19),
              name: z.string().trim().min(1).max(200).optional(),
              quantity: z.number().int().min(1).max(100_000).optional(),
            }),
          )
          .min(1)
          .max(20)
          .optional(),
      }),
    )
    .min(1)
    .max(40),
});
const CancelBody = z.object({ batchId: z.uuid() });

const lower = (s: string) => s.toLowerCase();

/** The interface language of a request that sends none (confirming a card). */
function localeOf(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const tag = raw?.split(',')[0]?.trim().slice(0, 20);
  return tag && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(tag) ? tag : 'en';
}

export async function assistantRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const tools: ToolDeps = {
    pools: deps.pools,
    jobs: deps.jobs,
    files: deps.files,
    log: deps.log,
  };

  app.get('/api/v1/assistant/threads', { schema: { querystring: ThreadsQuery } }, (req) =>
    scopedRead(deps.pools, req, (_tx, client) =>
      listThreads(
        client,
        {
          limit: req.query.limit,
          after: req.query.cursor ? decodeCursor<[string, string]>(req.query.cursor) : null,
        },
        req.query.q,
      ),
    ),
  );

  app.post('/api/v1/assistant/threads', { schema: { body: CreateBody } }, (req, reply) =>
    scopedWrite(deps.pools, req, reply, async (_tx, client, scope) => ({
      status: 201,
      body: await createThread(
        client,
        scope.userId,
        await resolveContext(client, req.body.context),
      ),
    })),
  );

  app.get('/api/v1/assistant/threads/:id', { schema: { params: Id } }, (req) =>
    scopedRead(deps.pools, req, (_tx, client) =>
      threadDetail(client, lower(req.params.id), new Date()),
    ),
  );

  app.delete('/api/v1/assistant/threads/:id', { schema: { params: Id } }, (req, reply) =>
    scopedWrite(deps.pools, req, reply, async (_tx, client) => {
      await deleteThread(client, lower(req.params.id));
      return { status: 204, body: undefined };
    }),
  );

  app.post(
    '/api/v1/assistant/threads/:id/turns',
    { schema: { params: Id, body: AskBodySchema } },
    async (req, reply) => {
      const threadId = lower(req.params.id);
      const { context } = await scopedRead(deps.pools, req, (_tx, client) =>
        askContext(client, threadId, req.body),
      );
      const scope = requireScope(req);
      await withScope(deps.pools.app, scope, (_tx, client) =>
        askPreflight(deps.ai, client, scope, context.locationId ?? null),
      );
      return scopedWrite(deps.pools, req, reply, async (_tx, client, s) => ({
        status: 202,
        body: await ask(client, deps.jobs, s, threadId, req.body, context),
      }));
    },
  );

  app.get('/api/v1/assistant/turns/:id', { schema: { params: Id } }, (req) =>
    scopedRead(deps.pools, req, (_tx, client) =>
      turnView(client, lower(req.params.id), new Date()),
    ),
  );

  app.post('/api/v1/assistant/turns/:id/cancel', { schema: { params: Id } }, (req, reply) =>
    scopedWrite(deps.pools, req, reply, async (_tx, client) => ({
      status: 200,
      body: await cancelTurn(client, lower(req.params.id), new Date()),
    })),
  );

  app.post('/api/v1/assistant/proposals/confirm', { schema: { body: ConfirmBodySchema } }, (req) =>
    confirmProposals(
      { tools },
      requireScope(req),
      req.body,
      req.id,
      localeOf(req.headers['accept-language']),
    ),
  );

  app.post('/api/v1/assistant/proposals/cancel', { schema: { body: CancelBody } }, (req, reply) =>
    scopedWrite(deps.pools, req, reply, async (_tx, client, scope) => {
      await cancelProposals(client, scope.userId, req.body.batchId);
      return { status: 204, body: undefined };
    }),
  );
}
