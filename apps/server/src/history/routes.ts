import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead } from '../http/write.js';
import {
  ActivityQuery,
  ActorsSchema,
  activity,
  HistoryPageSchema,
  HistoryQuery,
  locationActors,
  placeHistory,
  ThingHistoryQuery,
  thingHistory,
} from './service.js';

// History and the activity feed (T21; D76, D110, D150, D174, D183), in the shapes of the web
// contract (apps/web/src/api/inventory/types.ts HistoryEvent, ActivityParams) plus the T27
// decisions (summaryKey/summaryParams, diff labels, `q`, the actors list):
//
// GET /api/v1/things/:id/history?limit&cursor&kind    → {items: HistoryEvent[], next_cursor}
//   `kind` (step 6, T18): `changes`, `ai` (its AI calls, `action: 'ai.call'`) or `all` (default).
// GET /api/v1/places/:id/history?limit&cursor         → {items: HistoryEvent[], next_cursor}
// GET /api/v1/activity?locationId*&actorId*&entityType*&not*&from&to&q&limit&cursor
//                                                     → {items: HistoryEvent[], next_cursor}
//   `*`: repeatable, "is any of"; `not` names those that are "is none of" (D205).
// GET /api/v1/locations/:id/actors                    → {items: [{id, displayName}]}
//
// All reads. Undo (POST /api/v1/audit/:eventId/undo) is audit/undo.ts's, registered by things.

const Params = z.object({ id: z.uuid() });

export async function historyRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/things/:id/history',
    {
      schema: {
        params: Params,
        querystring: ThingHistoryQuery,
        response: { 200: HistoryPageSchema },
      },
    },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        thingHistory(tx, client, scope, req.params.id.toLowerCase(), req.query),
      ),
  );

  app.get(
    '/api/v1/places/:id/history',
    { schema: { params: Params, querystring: HistoryQuery, response: { 200: HistoryPageSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        placeHistory(tx, client, scope, req.params.id.toLowerCase(), req.query),
      ),
  );

  app.get(
    '/api/v1/activity',
    { schema: { querystring: ActivityQuery, response: { 200: HistoryPageSchema } } },
    (req) => scopedRead(pools, req, (tx, client, scope) => activity(tx, client, scope, req.query)),
  );

  app.get(
    '/api/v1/locations/:id/actors',
    { schema: { params: Params, response: { 200: ActorsSchema } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) => locationActors(client, req.params.id.toLowerCase())),
  );
}
