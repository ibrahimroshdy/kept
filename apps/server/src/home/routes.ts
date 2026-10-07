import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  ALLOWED_HINTS,
  HINT_KEY,
  HintSchema,
  HomeResponse,
  homeOf,
  listHints,
  UpdateHintBody,
  updateHint,
} from './service.js';

// Home: the checklist, the attention panel and hints (T22; D138, D185, D191, D193). The web's
// contract is apps/web/src/api/inventory/{types,paths}.ts (HomeResponse, Hint); service.ts says
// how each value is computed. Registered by http/routes.ts; add routes here, never there.
//
// GET /api/v1/home → {checklist: {dismissed, items: [{key, done}]},
//                     attention: {toReview, uncertain, longUnseen, unplaced, overdue, due,
//                                 expiring, lentOut, borrowedIn, lowStock},
//                     agendaBySource: {overdue, due, expiring: {<source>: count}},
//                     counts: {inbox, unprintedLabels},
//                     locations: [{id, thingCount, unplacedCount}],
//                     meteredThings}                                (step 5, T13)
// GET /api/v1/me/hints → {hints: [{key, seenAt, dismissedAt}]}
// PUT /api/v1/me/hints/:key {seen?, dismissed?} → 204

const HintParams = z.object({
  key: z
    .string()
    .regex(HINT_KEY)
    .refine((k) => ALLOWED_HINTS.has(k), 'not a hint Kept knows'),
});

export async function homeRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get('/api/v1/home', { schema: { response: { 200: HomeResponse } } }, (req) =>
    scopedRead(pools, req, (_tx, client) => homeOf(client)),
  );

  app.get(
    '/api/v1/me/hints',
    { schema: { response: { 200: z.object({ hints: z.array(HintSchema) }) } } },
    async (req) => ({ hints: await scopedRead(pools, req, (_tx, client) => listHints(client)) }),
  );

  app.put(
    '/api/v1/me/hints/:key',
    { schema: { params: HintParams, body: UpdateHintBody } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await updateHint(tx, client, scope.userId, req.params.key, req.body, req.id);
        return { status: 204, body: undefined };
      }),
  );
}
