import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { paginate, requireIfMatch } from '../http/conventions.js';
import { AppError } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import {
  ClaimPackLinkBody,
  ClaimPackView,
  CreateClaimPackBody,
  claimPackView,
  createClaimPack,
  createPackLink,
  LINK_DAYS_DEFAULT,
  revokePackLink,
} from './claim-pack.js';
import { serveClaimPack } from './download.js';
import {
  CreateIncidentBody,
  changeIncidentThings,
  createIncident,
  deleteIncident,
  IncidentsQuery,
  IncidentThingsBody,
  incidentView,
  listIncidents,
  UpdateIncidentBody,
  updateIncident,
  type WriteCtx,
} from './service.js';
import { registerIncidentUndo } from './undo.js';

// Incidents and claim packs (D158, D169, D180, D201; step-4 plan T18). The web contract is
// apps/web/src/api/household/types.ts, "incidents, the insurance report and claim packs"; the
// insurance report's own routes are in reports/routes.ts.
//
// GET    /api/v1/incidents?locationId&kind&cursor&limit   → {items: IncidentRow[], next_cursor}
// GET    /api/v1/incidents/:id                             → Incident
// POST   /api/v1/locations/:id/incidents                   → 201 Incident (owners, admins)
// PATCH  /api/v1/incidents/:id (If-Match)                  → Incident; undoable
// DELETE /api/v1/incidents/:id (If-Match)                  → 204; undoable (Q25)
// POST   /api/v1/incidents/:id/things (If-Match)           {add?, remove?, lifecycle?} → Incident;
//                                                          undoable
// POST   /api/v1/claim-packs                               → 202 {id, status} (owners, admins)
// GET    /api/v1/claim-packs/:id                           → ClaimPack (the creator only)
// POST   /api/v1/claim-packs/:id/link {days?: 1..7}        → {url, expiresAt}, shown once
// DELETE /api/v1/claim-packs/:id/link                      → 204
// GET    /x/:token                                         the ZIP, no session; 410 when refused
//
// Incidents and claim packs belong to Warranties & claims (product design §5): off in a
// location, its incident routes answer `module_off`, and the list leaves its incidents out.

const Params = z.object({ id: z.uuid() });
const TokenParams = z.object({ token: z.string().min(1).max(200) });

const IncidentRowSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  kind: z.string(),
  occurredOn: z.string(),
  policeReference: z.string().nullable(),
  insurerReference: z.string().nullable(),
  thingCount: z.number().int(),
  claimCount: z.number().int(),
  rowVersion: z.number().int(),
});
const IncidentSchema = IncidentRowSchema.extend({
  notes: z.string().nullable(),
  // Step 2's ThingRow and AttachmentView, as things/view.ts and files/views.ts build them.
  things: z.array(z.looseObject({ id: z.uuid() })),
  claims: z.array(
    z.object({
      id: z.uuid(),
      thingId: z.uuid(),
      status: z.string(),
      reference: z.string().nullable(),
    }),
  ),
  documents: z.array(z.looseObject({ id: z.uuid() })),
  createdBy: z.object({ displayName: z.string() }),
});
const IncidentPage = z.object({
  items: z.array(IncidentRowSchema),
  next_cursor: z.string().nullable(),
});
const Created = z.object({ id: z.uuid(), status: z.literal('queued') });
const Link = z.object({ url: z.string().nullable(), expiresAt: z.string() });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function incidentRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  registerIncidentUndo();
  const publicUrl = deps.env.KEPT_PUBLIC_URL;

  const locationOfIncident = (req: FastifyRequest, id: unknown): Promise<string | null> => {
    const scope = req.scope;
    if (!scope || typeof id !== 'string' || !UUID.test(id)) return Promise.resolve(null);
    return withScope(pools.app, scope, async (_tx, c) => {
      const { rows } = await c.query<{ location_id: string }>(
        'SELECT location_id FROM public.incidents WHERE id = $1',
        [id.toLowerCase()],
      );
      return rows[0]?.location_id ?? null;
    });
  };
  /** The incident's location as the caller sees it (a moduleLocation resolver). */
  const incidentLocation = (req: FastifyRequest) =>
    locationOfIncident(req, (req.params as { id?: unknown } | undefined)?.id);
  /** A claim pack's location: its scope's location, or its incident's. */
  const packLocation = (req: FastifyRequest) => {
    const scope = (req.body as { scope?: { locationId?: unknown; incidentId?: unknown } } | null)
      ?.scope;
    if (typeof scope?.locationId === 'string') return scope.locationId;
    return locationOfIncident(req, scope?.incidentId);
  };
  const ctxOf = (
    tx: WriteCtx['tx'],
    client: WriteCtx['client'],
    scope: WriteCtx['scope'],
    requestId: string,
  ): WriteCtx => ({ tx, client, scope, files: deps.files, requestId });

  app.get(
    '/api/v1/incidents',
    { schema: { querystring: IncidentsQuery, response: { 200: IncidentPage } } },
    (req) =>
      scopedRead(pools, req, (tx, client) =>
        listIncidents(tx, client, req.query, paginate(req.query).after),
      ),
  );

  app.get(
    '/api/v1/incidents/:id',
    {
      config: { module: 'warranties', moduleLocation: incidentLocation },
      schema: { params: Params, response: { 200: IncidentSchema } },
    },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        incidentView(tx, client, scope, deps.files, req.params.id),
      ),
  );

  app.post(
    '/api/v1/locations/:id/incidents',
    {
      config: {
        module: 'warranties',
        moduleLocation: (req) => (req.params as { id?: string }).id ?? null,
      },
      schema: { params: Params, body: CreateIncidentBody, response: { 201: IncidentSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 201,
        body: await createIncident(ctxOf(tx, client, scope, req.id), req.params.id, req.body),
      })),
  );

  app.patch(
    '/api/v1/incidents/:id',
    {
      config: { module: 'warranties', moduleLocation: incidentLocation },
      schema: { params: Params, body: UpdateIncidentBody, response: { 200: IncidentSchema } },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await updateIncident(
          ctxOf(tx, client, scope, req.id),
          req.params.id,
          expected,
          req.body,
        ),
      }));
    },
  );

  app.delete(
    '/api/v1/incidents/:id',
    {
      config: { module: 'warranties', moduleLocation: incidentLocation },
      schema: { params: Params },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => {
        await deleteIncident(ctxOf(tx, client, scope, req.id), req.params.id, expected);
        return { status: 204, body: undefined };
      });
    },
  );

  app.post(
    '/api/v1/incidents/:id/things',
    {
      config: { module: 'warranties', moduleLocation: incidentLocation },
      schema: { params: Params, body: IncidentThingsBody, response: { 200: IncidentSchema } },
    },
    (req, reply) => {
      const expected = requireIfMatch(req);
      return scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await changeIncidentThings(
          ctxOf(tx, client, scope, req.id),
          req.params.id,
          expected,
          req.body,
        ),
      }));
    },
  );

  // ----- claim packs -----

  const needJobs = () => {
    if (!deps.jobs || !deps.files) {
      throw new AppError('internal', 503, 'Claim packs need file storage and the job queue.');
    }
    return deps.jobs;
  };

  app.post(
    '/api/v1/claim-packs',
    {
      config: { module: 'warranties', moduleLocation: packLocation },
      schema: { body: CreateClaimPackBody, response: { 202: Created } },
    },
    async (req, reply) => {
      const jobs = needJobs();
      try {
        return await scopedWrite(pools, req, reply, async (tx, client, scope) => ({
          status: 202,
          body: await createClaimPack(tx, client, scope, jobs, req.body, req.id),
        }));
      } catch (err) {
        const retryAfter = err instanceof AppError ? err.extra?.retryAfter : undefined;
        if (typeof retryAfter === 'number') reply.header('retry-after', String(retryAfter));
        throw err;
      }
    },
  );

  app.get(
    '/api/v1/claim-packs/:id',
    { schema: { params: Params, response: { 200: ClaimPackView } } },
    (req) => scopedRead(pools, req, (_tx, client) => claimPackView(client, req.params.id)),
  );

  app.post(
    '/api/v1/claim-packs/:id/link',
    { schema: { params: Params, body: ClaimPackLinkBody.optional(), response: { 200: Link } } },
    (req, reply) =>
      scopedWrite(
        pools,
        req,
        reply,
        async (tx, client, scope) => ({
          status: 200,
          body: await createPackLink(
            tx,
            client,
            scope,
            req.params.id,
            req.body?.days ?? LINK_DAYS_DEFAULT,
            publicUrl,
            req.id,
          ),
        }),
        // The URL carries the token: a replay says the link was made, and never repeats it.
        { redact: (body) => ({ ...(body as object), url: null }) },
      ),
  );

  app.delete('/api/v1/claim-packs/:id/link', { schema: { params: Params } }, (req, reply) =>
    scopedWrite(pools, req, reply, async (tx, client, scope) => {
      await revokePackLink(tx, client, scope, req.params.id, req.id);
      return { status: 204, body: undefined };
    }),
  );

  // ----- the public link -----

  app.get(
    '/x/:token',
    { config: { auth: 'none' }, schema: { hide: true, params: TokenParams } },
    (req, reply) => serveClaimPack({ pools, files: deps.files }, req.params.token, req, reply),
  );
}
