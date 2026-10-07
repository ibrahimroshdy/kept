import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Pools } from '../db/pools.js';
import { type Scope, type Tx, withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { paginate, paginationQuery } from '../http/conventions.js';
import { AppError } from '../http/errors.js';
import { locationModuleSet } from '../http/modules.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { requireMembership } from '../locations/access.js';
import type { Ctx } from '../things/service.js';
import { ClaimTarget, claimableCode, claimLabel, labelClaimed } from './claim.js';
import { formerHostHook } from './former-hosts.js';
import {
  CreateBatchBody,
  CreateBatchResultSchema,
  createBatch,
  getBatch,
  LabelBatchPreviewSchema,
  LabelBatchSchema,
  labelSummary,
  listBatches,
  markPrinted,
  SummarySchema,
} from './service.js';

// Labels (plan T16; D43, D44, D45, D120, D137, D172, D175; engineering spec §2.4; Q24, Q28, Q32).
// The web contract is apps/web/src/api/capture/{paths,types}.ts "labels (T16)".
//
// POST /api/v1/labels/batches                   → 201 {batch: LabelBatch, excluded: {pending, other}};
//                                                 with `dryRun`, 200 {labels, blank, excluded} (T28)
// GET  /api/v1/labels/batches/:id               → LabelBatch (a reprint is the same codes, D45)
// GET  /api/v1/labels/batches?locationId&cursor → {items: LabelBatch[], next_cursor}
// POST /api/v1/labels/batches/:id/printed       → LabelBatch ("Printed OK?")
// POST /api/v1/codes/:code/claim                → {outcome: 'claimed', target: {kind, id}};
//                                                 409 label_claimed {claimedFor: {kind, id, name}}
// GET  /api/v1/labels/summary?locationId        → {unprinted, blankUnclaimed}
//
// Module `labels` (§7.6): the writes and a batch by id are gated on their location (a write in a
// location with labels off is 409 `module_off`, a read 404). The list and the summary take the
// location from the query when given (404 `module_off` when labels are off there); without one
// they cover every visible location. Writes need `labels.use` (owners, admins, members).
//
// A claim of anything that isn't a blank of the caller's own writable location (missing, retired,
// another household's, a viewer's) is the same 404 a random code gets: the module gate and the
// claim both answer a code the caller can't see as not found (D137, §2.4).
//
// The former-hostname redirect (former-hosts.ts) is an onRequest hook on the whole app.

const Id = z.uuid();
const CodeParam = z.object({ code: z.string().min(1).max(32) });

const ClaimResultSchema = z.object({
  outcome: z.literal('claimed'),
  target: z.object({ kind: z.enum(['thing', 'place']), id: z.uuid() }),
});

/** The location of a label batch the caller can see, for the module gate. */
function batchLocation(pools: Pick<Pools, 'app'>) {
  return async (req: FastifyRequest): Promise<string | null> => {
    const id = (req.params as { id?: unknown }).id;
    if (!req.scope || typeof id !== 'string' || !Id.safeParse(id).success) return null;
    return withScope(pools.app, req.scope, async (_tx, client) => {
      const { rows } = await client.query<{ location_id: string }>(
        'SELECT location_id FROM public.label_batches WHERE id = $1',
        [id.toLowerCase()],
      );
      return rows[0]?.location_id ?? null;
    });
  };
}

/** The location of a code the caller can see, for the module gate; anything else resolves to
 * nothing, the same 404 as a random code. A claim must be in the code's location anyway (Q24). */
function codeLocation(pools: Pick<Pools, 'app'>) {
  return async (req: FastifyRequest): Promise<string | null> => {
    const raw = (req.params as { code?: unknown }).code;
    if (!req.scope || typeof raw !== 'string') return null;
    let code: string;
    try {
      code = claimableCode(raw);
    } catch {
      return null;
    }
    return withScope(pools.app, req.scope, async (_tx, client) => {
      const { rows } = await client.query<{ location_id: string }>(
        `SELECT location_id FROM public.short_ids WHERE code = $1 AND state IN ('blank', 'assigned')`,
        [code],
      );
      return rows[0]?.location_id ?? null;
    });
  };
}

/** 404 unless the caller sees the location; 404 `module_off` when labels are off there. */
async function requireLabelsOn(tx: Tx, client: pg.ClientBase, locationId: string) {
  await requireMembership(client, locationId);
  if (!(await locationModuleSet(tx, locationId))?.has('labels')) {
    throw new AppError('module_off', 404);
  }
}

export async function labelRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  const publicUrl = deps.env.KEPT_PUBLIC_URL;
  const ctxOf = (req: FastifyRequest, tx: Tx, client: pg.PoolClient, scope: Scope): Ctx => ({
    tx,
    client,
    scope,
    requestId: req.id,
    jobs: deps.jobs,
    files: deps.files,
  });

  // Former hostnames (D120, Q32).
  app.addHook('onRequest', formerHostHook(pools.system, publicUrl));

  app.post(
    '/api/v1/labels/batches',
    {
      config: { module: 'labels' },
      schema: {
        body: CreateBatchBody,
        response: { 200: LabelBatchPreviewSchema, 201: CreateBatchResultSchema },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: req.body.dryRun ? 200 : 201,
        body: await createBatch(ctxOf(req, tx, client, scope), publicUrl, req.body),
      })),
  );

  app.get(
    '/api/v1/labels/batches',
    {
      schema: {
        querystring: paginationQuery.extend({ locationId: Id.optional() }),
        response: {
          200: z.object({ items: z.array(LabelBatchSchema), next_cursor: z.string().nullable() }),
        },
      },
    },
    (req) =>
      scopedRead(pools, req, async (tx, client) => {
        const locationId = req.query.locationId?.toLowerCase() ?? null;
        if (locationId) await requireLabelsOn(tx, client, locationId);
        return listBatches(client, publicUrl, locationId, paginate<[string, string]>(req.query));
      }),
  );

  app.get(
    '/api/v1/labels/batches/:id',
    {
      config: { module: 'labels', moduleLocation: batchLocation(pools) },
      schema: { params: z.object({ id: Id }), response: { 200: LabelBatchSchema } },
    },
    (req) =>
      scopedRead(pools, req, (_tx, client) =>
        getBatch(client, publicUrl, req.params.id.toLowerCase()),
      ),
  );

  app.post(
    '/api/v1/labels/batches/:id/printed',
    {
      config: { module: 'labels', moduleLocation: batchLocation(pools) },
      schema: { params: z.object({ id: Id }), response: { 200: LabelBatchSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 200,
        body: await markPrinted(
          ctxOf(req, tx, client, scope),
          publicUrl,
          req.params.id.toLowerCase(),
        ),
      })),
  );

  app.get(
    '/api/v1/labels/summary',
    {
      schema: {
        querystring: z.object({ locationId: Id.optional() }),
        response: { 200: SummarySchema },
      },
    },
    (req) =>
      scopedRead(pools, req, async (tx, client) => {
        const locationId = req.query.locationId?.toLowerCase() ?? null;
        if (locationId) await requireLabelsOn(tx, client, locationId);
        return labelSummary(client, locationId);
      }),
  );

  app.post(
    '/api/v1/codes/:code/claim',
    {
      config: { module: 'labels', moduleLocation: codeLocation(pools) },
      schema: { params: CodeParam, body: ClaimTarget, response: { 200: ClaimResultSchema } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const out = await claimLabel(ctxOf(req, tx, client, scope), req.params.code, req.body);
        // Thrown, so a new container made for the claim rolls back with it.
        if (out.outcome === 'already_claimed') throw labelClaimed(out.claimedFor);
        return { status: 200, body: out };
      }),
  );
}
