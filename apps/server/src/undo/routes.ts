import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead } from '../http/write.js';
import { registerStep3Undo } from './registry.js';
import { UndoableResponse, undoableFor } from './service.js';

// In-app undo (T20; D150, D124; plan Q23). Registered by http/routes.ts; add routes here, never
// there.
//
// GET /api/v1/things/:id/undoable → {items: [{eventId, action, at, until}]}   (service.ts)
//
// The undo itself, POST /api/v1/audit/:eventId/undo → {undoOf, eventId}, is audit/undo.ts's
// (registered by things/routes.ts since step 2); its refusals are 409 `undo_refused` with a
// `reason`. An undoable write names its event in `X-Kept-Audit-Event` (http/write.ts), and the
// step-3 routes whose web contract says so repeat it as `undo: {eventId, until}` in the body.
// This module registers the handlers no area registers itself (registry.ts).

const Params = z.object({ id: z.uuid() });

export async function undoRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  registerStep3Undo();
  app.get(
    '/api/v1/things/:id/undoable',
    { schema: { params: Params, response: { 200: UndoableResponse } } },
    (req) =>
      scopedRead(deps.pools, req, (_tx, client) =>
        undoableFor(client, req.params.id.toLowerCase()),
      ),
  );
}
