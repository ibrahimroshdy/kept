import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { paginate, paginationQuery } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  BoxCheckBody,
  BoxCheckResultSchema,
  BoxCheckSummarySchema,
  boxCheck,
  listBoxChecks,
  registerBoxCheckUndo,
} from './service.js';

// The box check (plan T17; D40, D175; screens §6, §8; Q25). boxcheck/service.ts has the rules;
// the `box_check` sync op (T14) calls the same boxCheck().
//
// POST /api/v1/things/:id/box-check {id, lines, foundElsewhereIds?}
//      → {boxCheckId, seen, notHere, split, movedIn, undo} (X-Kept-Audit-Event: the undo)
// GET  /api/v1/things/:id/box-checks?cursor → {items: BoxCheckSummary[], next_cursor}

const Params = z.object({ id: z.uuid() });

export async function boxCheckRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerBoxCheckUndo();

  app.post(
    '/api/v1/things/:id/box-check',
    { schema: { params: Params, body: BoxCheckBody, response: { 200: BoxCheckResultSchema } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await boxCheck(
          { tx, client, scope, requestId: req.id, jobs: deps.jobs, files: deps.files },
          req.params.id,
          req.body,
        ),
      })),
  );

  app.get(
    '/api/v1/things/:id/box-checks',
    {
      schema: {
        params: Params,
        querystring: paginationQuery,
        response: {
          200: z.object({
            items: z.array(BoxCheckSummarySchema),
            next_cursor: z.string().nullable(),
          }),
        },
      },
    },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        listBoxChecks(client, req.params.id.toLowerCase(), paginate<[string, string]>(req.query)),
      ),
  );
}
