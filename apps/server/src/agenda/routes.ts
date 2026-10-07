import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { paginate, paginationQuery } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead } from '../http/write.js';
import { AgendaQuery, listAgenda } from './query.js';
import { AgendaCountsSchema, AgendaItemSchema } from './view.js';

// The agenda (plan T13; Q7, Q24): every reminder source as one list. The web contract is
// apps/web/src/api/household/{types,paths}.ts, "the agenda (T13)"; query.ts says how it's read.
//
// GET /api/v1/agenda?state&sourceType&locationId&from&to&cursor&limit
//   → {items: AgendaItem[], counts: {overdue, due, expiring}, next_cursor}
//
// Global (screens §1): every visible location, narrowed by `locationId`; the view leaves out the
// sources whose module is off, so the route declares no module. The Expiring screen reads
// `sourceType=warranty,registration,document,thing_expiry`.

export async function agendaRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/agenda',
    {
      schema: {
        querystring: paginationQuery.extend(AgendaQuery.shape),
        response: {
          200: z.object({
            items: z.array(AgendaItemSchema),
            counts: AgendaCountsSchema,
            next_cursor: z.string().nullable(),
          }),
        },
      },
    },
    (req) => {
      const page = paginate(req.query);
      return scopedRead(pools, req, (_tx, client) => listAgenda(client, req.query, page));
    },
  );
}
