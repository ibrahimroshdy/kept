import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { LayoutBody, putLayout } from './service.js';
import { registerMapUndo } from './undo.js';
import { MapViewSchema, mapView } from './view.js';

// The location map (1.x, D237). The web's contract is apps/web/src/api/map/{types,paths}.ts.
//
// GET /api/v1/locations/:id/map     → MapView (every role that sees the location)
// PUT /api/v1/locations/:id/layout  {version, rooms, nodes} → {version} (members and up;
//                                   audited `place.arrange`, undoable for ten minutes)

const Params = z.object({ id: z.uuid() });

export async function mapRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerMapUndo();

  app.get(
    '/api/v1/locations/:id/map',
    { schema: { params: Params, response: { 200: MapViewSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client) => mapView(tx, client, req.params.id.toLowerCase())),
  );

  app.put(
    '/api/v1/locations/:id/layout',
    {
      schema: {
        params: Params,
        body: LayoutBody,
        response: { 200: z.object({ version: z.string().nullable() }) },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await putLayout(
          { tx, client, scope, requestId: req.id },
          req.params.id.toLowerCase(),
          req.body,
        ),
      })),
  );
}
