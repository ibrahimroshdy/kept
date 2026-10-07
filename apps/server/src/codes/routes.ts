import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { requireIfMatch } from '../http/conventions.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  addCode,
  CodeBody,
  CodeResult,
  CodesView,
  listCodes,
  MismatchesView,
  mismatches,
  RenameBody,
  readSettings,
  removeCode,
  renameCode,
  SettingsBody,
  SettingsView,
  type Target,
  writeSettings,
} from './service.js';
import { registerCodeUndo } from './undo.js';

// Own codes (T17a, D208; engineering spec §7.16). The service is codes/service.ts.
//
// GET    /api/v1/{things|places}/:id/codes          → {codes: [{code, source, sourceCollection}]}
// POST   /api/v1/{things|places}/:id/codes          {code} | {next: true} → 201 {code}
// PUT    /api/v1/{things|places}/:id/codes/:code    {code} → {code}
// DELETE /api/v1/{things|places}/:id/codes/:code    → 204
// GET    /api/v1/locations/:locationId/own-codes    → the options, with the next number
// PUT    /api/v1/locations/:locationId/own-codes    {numbering, rule} (If-Match) → the options
// GET    /api/v1/locations/:locationId/own-codes/mismatches → own codes the rule refuses now
//
// Writes on codes are `things.edit` (a viewer: 403), audited `thing.codes` / `place.codes` and
// undoable; the options are `location.settings` and audited `location.own_codes`. A duplicate in
// the location (any source) is 409; a code breaking the rule is 400 with the owner's message.

const Params = z.object({ id: z.uuid() });
const CodeParams = z.object({ id: z.uuid(), code: z.string().min(1).max(200) });
const LocationParams = z.object({ locationId: z.uuid() });

export async function codeRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerCodeUndo();

  for (const kind of ['thing', 'place'] as const) {
    const base = `/api/v1/${kind}s/:id/codes`;
    const target = (id: string): Target => ({ kind, id: id.toLowerCase() });

    app.get(base, { schema: { params: Params, response: { 200: CodesView } } }, (req) =>
      scopedRead(pools, req, (_tx, client) => listCodes(client, target(req.params.id))),
    );

    app.post(
      base,
      { schema: { params: Params, body: CodeBody, response: { 201: CodeResult } } },
      (req, reply) =>
        scopedWrite(pools, req, reply, async (tx, client, scope) => ({
          status: 201,
          body: await addCode(
            { tx, client, scope, requestId: req.id },
            target(req.params.id),
            req.body,
          ),
        })),
    );

    app.put(
      `${base}/:code`,
      { schema: { params: CodeParams, body: RenameBody, response: { 200: CodeResult } } },
      (req, reply) =>
        scopedWrite(pools, req, reply, async (tx, client, scope) => ({
          status: 200,
          body: await renameCode(
            { tx, client, scope, requestId: req.id },
            target(req.params.id),
            req.params.code,
            req.body,
          ),
        })),
    );

    app.delete(`${base}/:code`, { schema: { params: CodeParams } }, (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await removeCode(
          { tx, client, scope, requestId: req.id },
          target(req.params.id),
          req.params.code,
        );
        return { status: 204, body: undefined };
      }),
    );
  }

  app.get(
    '/api/v1/locations/:locationId/own-codes',
    { schema: { params: LocationParams, response: { 200: SettingsView } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        readSettings(client, req.params.locationId.toLowerCase()),
      ),
  );

  app.put(
    '/api/v1/locations/:locationId/own-codes',
    { schema: { params: LocationParams, body: SettingsBody, response: { 200: SettingsView } } },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await writeSettings(
          { tx, client, scope, requestId: req.id },
          req.params.locationId.toLowerCase(),
          req.body,
          expected,
        ),
      }));
    },
  );

  app.get(
    '/api/v1/locations/:locationId/own-codes/mismatches',
    { schema: { params: LocationParams, response: { 200: MismatchesView } } },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        mismatches(client, req.params.locationId.toLowerCase()),
      ),
  );
}
