import {
  CAPTURE_MODES,
  type CaptureMode,
  COST_SOURCES,
  can,
  EXTRACTION_STATUSES,
  LEDGER_OUTCOMES,
  newId,
  PROVIDER_KINDS,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { aiCaptureOn } from '../capture/service.js';
import type { Scope, Tx } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, invalid, notFound } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { gateFor } from '../serialize/gates.js';
import { liveThing, writableThing } from '../things/service.js';
import type { Applied } from './apply.js';
import { EXTRACT_JOB } from './job.js';

// Extraction on request, and its attempts (plan T10; D19, D206, L58; engineering spec §7.8,
// §7.15 "Elsewhere"). The web contract is apps/web/src/api/capture/types.ts "extraction (T10)".
//
// POST /api/v1/things/:id/extract {attachmentId?, mode?} → 202 {extractionId}
//   Explicit only (D19, L58): the attachment's live or succeeded attempt becomes `superseded`, a
//   new attempt (attempt + 1) is queued, and its result replaces the draft's extracted fields
//   (apply.ts puts back what the superseded one applied first). Needs `ai.capture` and the
//   `ai_capture` module (409 `ai_unavailable` otherwise). Audited `thing.reextract`.
// POST /api/v1/purchases/:id/extract → 202 {extractionId}
//   Step 6 (T18, step-3 Q13): the same for a receipt. Its first page owns the extraction (the
//   job reads every page); the live or succeeded attempt is superseded. Audited
//   `purchase.reextract`.
// GET /api/v1/things/:id/extractions → {items: ExtractionAttempt[]}
//   Every attempt on the thing's photos and proof (and its meters' readings), newest first, each
//   with the ledger row it made (`call`, the AI line, D206) where the caller may see that row
//   (llm_calls' policy); its cost only where the money gate shows money, or the caller paid.

const Id = z.uuid();

/** Attempts that stop a re-run from being a new one: what a re-run supersedes. */
const SUPERSEDED_BY_RERUN = ['queued', 'running', 'paused_budget', 'waiting_provider', 'succeeded'];

const Money = z.object({ amount: z.string(), currency: z.string() });

export const CallSummary = z.object({
  id: z.uuid().optional(),
  model: z.string(),
  providerKind: z.enum(PROVIDER_KINDS),
  tokens: z.number(),
  images: z.number(),
  cost: Money.optional(),
  costSource: z.enum(COST_SOURCES),
  /** `mine`: the caller paid, by their own key or their own account's ("paid by you"). */
  paidBy: z.object({
    scope: z.enum(['instance', 'account', 'user']),
    label: z.string(),
    mine: z.boolean(),
  }),
  outcome: z.enum(LEDGER_OUTCOMES),
  errorCode: z.string().nullable(),
});

const Attempt = z.object({
  id: z.uuid(),
  attempt: z.number(),
  mode: z.enum(CAPTURE_MODES),
  status: z.enum(EXTRACTION_STATUSES),
  statusReason: z.string().nullable(),
  pausedUntil: z.string().nullable(),
  createdAt: z.string(),
  model: z.string().nullable(),
  applied: z.array(z.string()),
  call: CallSummary.nullable(),
});

export type ExtractionAttempt = z.infer<typeof Attempt>;

const ExtractBody = z.strictObject({
  attachmentId: Id.optional(),
  mode: z.enum(['thing', 'label', 'reading']).optional(),
});

type Ctx = { tx: Tx; client: pg.PoolClient; scope: Scope; requestId: string };

/** The attachment a re-run reads, and its mode. */
async function targetOf(
  client: pg.ClientBase,
  thingId: string,
  body: z.infer<typeof ExtractBody>,
): Promise<{ attachmentId: string; mode: CaptureMode; meterId: string | null }> {
  const { rows } = await client.query<{ id: string; role: string; last_mode: CaptureMode | null }>(
    `SELECT a.id, a.role,
            (SELECT e.mode FROM public.extractions e WHERE e.attachment_id = a.id
              ORDER BY e.attempt DESC LIMIT 1) AS last_mode
       FROM public.attachments a
      WHERE a.thing_id = $1 AND a.role IN ('photo', 'proof')
      ORDER BY (SELECT max(e.created_at) FROM public.extractions e WHERE e.attachment_id = a.id)
               DESC NULLS LAST, a.sort, a.created_at`,
    [thingId],
  );
  const att = body.attachmentId
    ? rows.find((r) => r.id === body.attachmentId?.toLowerCase())
    : rows[0];
  if (!att) throw body.attachmentId ? notFound() : invalid('This thing has no photo to read.');
  const mode: CaptureMode =
    body.mode ?? att.last_mode ?? (att.role === 'proof' ? 'reading' : 'thing');
  if (mode === 'receipt') throw invalid('A receipt is read from its purchase, not a thing.');
  let meterId: string | null = null;
  if (mode === 'reading') {
    const { rows: m } = await client.query<{ id: string }>(
      `SELECT coalesce(
                (SELECT e.meter_id FROM public.extractions e
                  WHERE e.attachment_id = $2 AND e.meter_id IS NOT NULL
                  ORDER BY e.attempt DESC LIMIT 1),
                (SELECT (array_agg(m.id))[1] FROM public.meters m WHERE m.thing_id = $1
                  HAVING count(*) = 1)) AS id`,
      [thingId, att.id],
    );
    meterId = m[0]?.id ?? null;
    if (!meterId) throw invalid('Choose which meter this is.');
  }
  return { attachmentId: att.id, mode, meterId };
}

/** POST /api/v1/things/:id/extract. */
export async function requestExtraction(
  ctx: Ctx,
  deps: Pick<InventoryDeps, 'jobs'>,
  thingId: string,
  body: z.infer<typeof ExtractBody>,
): Promise<{ extractionId: string }> {
  const { tx, client, scope } = ctx;
  const thing = await writableThing(client, thingId, 'things.edit');
  if (!can(thing.role, 'ai.capture')) {
    throw new AppError('forbidden', 403, 'Your role in this location can’t use AI capture.');
  }
  if (!(await aiCaptureOn(tx, client, thing.location_id, thing.role))) {
    throw new AppError('ai_unavailable', 409);
  }
  const target = await targetOf(client, thing.id, body);
  const { rows: prior } = await client.query<{ id: string; attempt: number; status: string }>(
    `SELECT id, attempt, status FROM public.extractions
      WHERE attachment_id = $1 ORDER BY attempt DESC FOR UPDATE`,
    [target.attachmentId],
  );
  const superseded = prior.filter((p) => SUPERSEDED_BY_RERUN.includes(p.status)).map((p) => p.id);
  if (superseded.length > 0) {
    await client.query(
      `UPDATE public.extractions SET status = 'superseded', status_reason = NULL,
              paused_until = NULL
        WHERE id = ANY ($1::uuid[])`,
      [superseded],
    );
  }
  const attempt = (prior[0]?.attempt ?? 0) + 1;
  if (attempt > 50) throw new AppError('conflict', 409, 'This photo has been read 50 times.');
  const id = newId();
  await client.query(
    `INSERT INTO public.extractions (id, location_id, attachment_id, thing_id, meter_id, mode,
                                     attempt, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, kept.current_user_id())`,
    [
      id,
      thing.location_id,
      target.attachmentId,
      target.mode === 'reading' ? null : thing.id,
      target.meterId,
      target.mode,
      attempt,
    ],
  );
  await deps.jobs?.sendTenant(client, EXTRACT_JOB, { extractionId: id });
  // The thing's open draft item follows this attempt (its payload names the latest, apply.ts),
  // so the inbox says "Naming…" for it, not the superseded one's state or nothing at all (a
  // draft captured before any provider had no attempt: "Name N unnamed photos", T27).
  await client.query(
    `UPDATE public.inbox_items SET payload = payload || jsonb_build_object('extractionId', $2::text)
      WHERE thing_id = $1 AND kind = 'draft' AND resolved_at IS NULL`,
    [thing.id, id],
  );
  await audited(tx, {
    locationId: thing.location_id,
    actor: { type: 'user', id: scope.userId },
    action: 'thing.reextract',
    entity: { type: 'thing', id: thing.id },
    after: {
      extraction_id: id,
      attachment_id: target.attachmentId,
      mode: target.mode,
      attempt,
      superseded,
    },
    rootThingId: thing.id,
    subjects: [thing.id],
    requestId: ctx.requestId,
  });
  return { extractionId: id };
}

/** POST /api/v1/purchases/:id/extract: read a receipt again, on request only (D19, L58). */
export async function requestReceiptExtraction(
  ctx: Ctx,
  deps: Pick<InventoryDeps, 'jobs'>,
  purchaseId: string,
): Promise<{ extractionId: string }> {
  const { tx, client, scope } = ctx;
  const { rows: found } = await client.query<{ location_id: string }>(
    'SELECT location_id FROM public.purchases WHERE id = $1',
    [purchaseId],
  );
  const locationId = found[0]?.location_id;
  if (!locationId) throw notFound();
  const { role } = await requireMembership(client, locationId);
  requireCan(role, 'things.edit', 'Your role in this location can’t change receipts.');
  if (!can(role, 'ai.capture')) {
    throw new AppError('forbidden', 403, 'Your role in this location can’t use AI capture.');
  }
  if (!(await aiCaptureOn(tx, client, locationId, role))) {
    throw new AppError('ai_unavailable', 409);
  }
  // The first page, as the capture keyed it (capture/service.ts) and the job orders the pages.
  const { rows: pages } = await client.query<{ id: string }>(
    `SELECT a.id FROM public.attachments a
      WHERE a.purchase_id = $1 AND a.role = 'receipt'
      ORDER BY a.created_at, a.sort, a.id LIMIT 1`,
    [purchaseId],
  );
  const first = pages[0]?.id;
  if (!first) throw invalid('This receipt has no page to read.');
  const { rows: prior } = await client.query<{ id: string; attempt: number; status: string }>(
    `SELECT id, attempt, status FROM public.extractions
      WHERE purchase_id = $1 AND mode = 'receipt' ORDER BY attempt DESC FOR UPDATE`,
    [purchaseId],
  );
  const superseded = prior.filter((p) => SUPERSEDED_BY_RERUN.includes(p.status)).map((p) => p.id);
  if (superseded.length > 0) {
    await client.query(
      `UPDATE public.extractions SET status = 'superseded', status_reason = NULL,
              paused_until = NULL
        WHERE id = ANY ($1::uuid[])`,
      [superseded],
    );
  }
  const attempt = Math.max(0, ...prior.map((p) => p.attempt)) + 1;
  if (attempt > 50) throw new AppError('conflict', 409, 'This receipt has been read 50 times.');
  const id = newId();
  await client.query(
    `INSERT INTO public.extractions (id, location_id, attachment_id, purchase_id, mode, attempt,
                                     requested_by)
     VALUES ($1, $2, $3, $4, 'receipt', $5, kept.current_user_id())`,
    [id, locationId, first, purchaseId, attempt],
  );
  await deps.jobs?.sendTenant(client, EXTRACT_JOB, { extractionId: id });
  // The receipt's open inbox item follows this attempt, as a thing's draft does.
  await client.query(
    `UPDATE public.inbox_items SET payload = payload || jsonb_build_object('extractionId', $2::text)
      WHERE purchase_id = $1 AND kind = 'receipt' AND resolved_at IS NULL`,
    [purchaseId, id],
  );
  await audited(tx, {
    locationId,
    actor: { type: 'user', id: scope.userId },
    action: 'purchase.reextract',
    entity: { type: 'purchase', id: purchaseId },
    after: { extraction_id: id, attachment_id: first, mode: 'receipt', attempt, superseded },
    requestId: ctx.requestId,
  });
  return { extractionId: id };
}

/** An extraction's ledger row, as CALL_COLUMNS selects it (joined as `c`, the location as `l`). */
export type CallRow = {
  call_id: string | null;
  model: string | null;
  provider_kind: (typeof PROVIDER_KINDS)[number] | null;
  input_tokens: number | null;
  output_tokens: number | null;
  image_count: number | null;
  cost_amount: string | null;
  cost_currency: string | null;
  cost_source: (typeof COST_SOURCES)[number] | null;
  paying_scope: 'instance' | 'account' | 'user' | null;
  paying_user_id: string | null;
  paying_account_id: string | null;
  outcome: (typeof LEDGER_OUTCOMES)[number] | null;
  error_code: string | null;
  location_name: string;
  payer_name: string | null;
  /** The paying account's user: readable only when it is the caller's own (RLS on
   * owner_accounts), which is all "paid by you" needs. */
  payer_account_user_id: string | null;
};

/** The columns of CallRow, over `llm_calls c` and `locations l`. */
export const CALL_COLUMNS = `c.id AS call_id, c.model, c.provider_kind, c.input_tokens,
            c.output_tokens, c.image_count, c.cost_amount::text AS cost_amount, c.cost_currency,
            c.cost_source, c.paying_scope, c.paying_user_id, c.paying_account_id, c.outcome,
            c.error_code, l.name AS location_name,
            (SELECT up.display_name FROM public.user_profiles up
              WHERE up.user_id = c.paying_user_id) AS payer_name,
            (SELECT oa.user_id FROM public.owner_accounts oa
              WHERE oa.id = c.paying_account_id) AS payer_account_user_id`;

/**
 * The AI line of an attempt (§7.15 "Elsewhere"), or null without a visible ledger row. Money
 * follows the gate, unless the caller is the one who paid. Shared with the inbox view (T15).
 */
export function callSummaryOf(
  r: CallRow,
  showMoney: boolean,
  userId: string,
): z.infer<typeof CallSummary> | null {
  if (!(r.call_id && r.model && r.provider_kind && r.cost_source && r.paying_scope && r.outcome)) {
    return null;
  }
  return {
    id: r.call_id,
    model: r.model,
    providerKind: r.provider_kind,
    tokens: (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    images: r.image_count ?? 0,
    ...(r.cost_amount !== null &&
    r.cost_currency !== null &&
    (showMoney || r.paying_user_id === userId)
      ? { cost: { amount: r.cost_amount, currency: r.cost_currency.trim() } }
      : {}),
    costSource: r.cost_source,
    paidBy: {
      scope: r.paying_scope,
      label:
        r.paying_scope === 'account'
          ? r.location_name
          : r.paying_scope === 'user'
            ? (r.payer_name ?? '')
            : '',
      mine:
        (r.paying_scope === 'user' && r.paying_user_id === userId) ||
        (r.paying_scope === 'account' && r.payer_account_user_id === userId),
    },
    outcome: r.outcome,
    errorCode: r.error_code,
  };
}

type AttemptRow = CallRow & {
  id: string;
  attempt: number;
  mode: CaptureMode;
  status: (typeof EXTRACTION_STATUSES)[number];
  status_reason: string | null;
  paused_until: Date | number | null;
  created_at: Date;
  applied: Applied;
  location_id: string;
};

const iso = (v: Date | number | null): string | null => {
  if (v === null) return null;
  if (typeof v === 'number') return v > 0 ? 'infinity' : null;
  return v.toISOString();
};

/** GET /api/v1/things/:id/extractions. */
export async function listExtractions(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  thingId: string,
): Promise<{ items: ExtractionAttempt[] }> {
  const thing = await liveThing(client, thingId);
  const gate = await gateFor(tx, thing.location_id, scope);
  // The ledger row is read through llm_calls' own policy (§7.15): each person their own calls,
  // admins their locations', owners their account's. `at` narrows the partitions to the
  // extraction's lifetime.
  const { rows } = await client.query<AttemptRow>(
    `SELECT e.id, e.attempt, e.mode, e.status, e.status_reason, e.paused_until, e.created_at,
            e.applied, e.location_id, ${CALL_COLUMNS}
       FROM public.extractions e
       JOIN public.locations l ON l.id = e.location_id
       LEFT JOIN public.llm_calls c ON c.id = e.llm_call_id AND c.at >= e.created_at
      WHERE e.thing_id = $1
         OR e.attachment_id IN (SELECT a.id FROM public.attachments a WHERE a.thing_id = $1)
         OR e.meter_id IN (SELECT m.id FROM public.meters m WHERE m.thing_id = $1)
      ORDER BY e.created_at DESC, e.attempt DESC`,
    [thing.id],
  );
  return {
    items: rows.map((r) => {
      const call = callSummaryOf(r, gate.showMoney, scope.userId);
      return {
        id: r.id,
        attempt: r.attempt,
        mode: r.mode,
        status: r.status,
        statusReason: r.status_reason,
        pausedUntil: iso(r.paused_until),
        createdAt: r.created_at.toISOString(),
        model: r.model,
        applied: Object.keys(r.applied?.fields ?? {}),
        call,
      };
    }),
  };
}

/** Extraction: re-extract on request and its attempts (T10). The work itself is a job
 * (extraction/job.ts). Registered by http/routes.ts; add routes here, never there. */
export async function extractionRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.post(
    '/api/v1/things/:id/extract',
    {
      schema: {
        params: z.object({ id: Id }),
        body: ExtractBody.optional(),
        response: { 202: z.object({ extractionId: z.uuid() }) },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 202,
        body: await requestExtraction(
          { tx, client, scope, requestId: req.id },
          deps,
          req.params.id.toLowerCase(),
          req.body ?? {},
        ),
      })),
  );

  app.post(
    '/api/v1/purchases/:id/extract',
    {
      schema: {
        params: z.object({ id: Id }),
        response: { 202: z.object({ extractionId: z.uuid() }) },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => ({
        status: 202,
        body: await requestReceiptExtraction(
          { tx, client, scope, requestId: req.id },
          deps,
          req.params.id.toLowerCase(),
        ),
      })),
  );

  app.get(
    '/api/v1/things/:id/extractions',
    {
      schema: {
        params: z.object({ id: Id }),
        response: { 200: z.object({ items: z.array(Attempt) }) },
      },
    },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) =>
        listExtractions(tx, client, scope, req.params.id.toLowerCase()),
      ),
  );
}
