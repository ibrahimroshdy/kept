import { createHash } from 'node:crypto';
import {
  type Envelope,
  isToolError,
  parseRef,
  TOOL_DEFS,
  type ToolName,
  toolError,
} from '@kept/mcp';
import {
  canonicalJson,
  PROPOSAL_TTL_MS,
  type ProposalRef,
  type ProposalStatus,
} from '@kept/shared';
import type pg from 'pg';
import type { Scope, Tx } from '../db/scope.js';
import { withScope } from '../db/scope.js';
import { AppError, notFound } from '../http/errors.js';
import { viewOf } from '../things/view.js';
import { runTool } from '../tools/context.js';
import { placeRefOf, thingRefOf } from '../tools/output.js';
import { handlerOf } from '../tools/registry.js';
import { findRef } from '../tools/resolve.js';
import type { ToolDeps } from '../tools/types.js';
import { PROPOSAL_COLUMNS, type ProposalRow } from './threads.js';

// Write proposals (D22, D123, D179, D213; plan T13, Q5). The model never runs a write: each write
// call becomes a proposal, drawn by the web from its `args`, `before` and `refs` (never from model
// text), bound to the SHA-256 of its canonical arguments, open for 10 minutes, one batch (one card)
// per step. Confirming runs it through runTool() **as the person** (actor `user`), each in its own
// transaction, with If-Match from `before.rowVersion`, and appends the outcome to the thread as the
// call's result, so the next question sees it (convert.ts: the last result per call wins). No model
// call follows (Q5).
//
// `before` is `{callId, rowVersion?, fields?}`: the model's call id (to answer it in the thread),
// and for a tool about one thing, that thing's version and the fields the card shows, as they were
// when proposed.

export const argsHash = (args: unknown): string =>
  createHash('sha256').update(canonicalJson(args)).digest('hex');

/** Tools whose argument names a thing whose version guards the write (If-Match). */
const THING_ARG = 'thing_id';
/** Arguments that name a thing or a place. */
const REF_ARGS = [
  'thing_id',
  'place_id',
  'to_place_id',
  'to_container_id',
  'parent_id',
  'subject_id',
] as const;

type Candidate = { id: string; name: string; tools: readonly string[]; canWrite: boolean };

export type ProposeInput = {
  userId: string;
  threadId: string;
  turnId: string;
  batchId: string;
  callId: string;
  tool: ToolName;
  args: Record<string, unknown>;
  candidates: readonly Candidate[];
  now: Date;
};

export type Proposed =
  | { ok: true; proposalId: string; locationId: string }
  | {
      ok: false;
      error: Envelope<never> & { error: string };
      /** The location's name when the person is a viewer there (Q23's sentence). */
      viewerOf?: string;
    };

const unavailable = () =>
  toolError('tool_unavailable', 'Call capabilities to see the tools you can use in each location.');

/** The location a write call is about: its `location_id`, the row it names, or the only one. */
async function locationOfCall(
  client: pg.ClientBase,
  tool: ToolName,
  args: Record<string, unknown>,
  candidates: readonly Candidate[],
): Promise<string | { error: string; hint: string }> {
  const asked = typeof args.location_id === 'string' ? args.location_id.toLowerCase() : null;
  if (asked) return asked;
  const handler = handlerOf(tool) as
    | { subjectLocation?: (c: pg.ClientBase, i: unknown) => Promise<string | null> }
    | undefined;
  const parsed = TOOL_DEFS[tool].input.safeParse(args);
  if (handler?.subjectLocation && parsed.success) {
    const subject = await handler.subjectLocation(client, parsed.data);
    if (subject) return subject;
  }
  const offering = candidates.filter((c) => c.tools.includes(tool));
  if (offering.length === 1) return (offering[0] as Candidate).id;
  if (offering.length === 0) return unavailable();
  return toolError(
    'validation',
    'Pass location_id: the person has several locations (list_locations lists them).',
  );
}

async function refsOf(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  args: Record<string, unknown>,
  location: Candidate,
): Promise<{
  refs: Record<string, ProposalRef>;
  thing: Awaited<ReturnType<typeof viewOf>> | null;
}> {
  const refs: Record<string, ProposalRef> = {
    [location.id]: { kind: 'location', name: location.name, path: [] },
  };
  let thing: Awaited<ReturnType<typeof viewOf>> | null = null;
  const raws: { key: string; raw: string }[] = [];
  for (const key of REF_ARGS) {
    const v = args[key];
    if (typeof v === 'string') raws.push({ key, raw: v });
  }
  // add_thing: each item's place, and a new place's parent.
  if (Array.isArray(args.items)) {
    for (const item of args.items as Record<string, unknown>[]) {
      if (typeof item?.place_id === 'string') raws.push({ key: 'place_id', raw: item.place_id });
      const np = item?.new_place as Record<string, unknown> | undefined;
      if (typeof np?.parent_id === 'string') raws.push({ key: 'parent_id', raw: np.parent_id });
    }
  }
  for (const { key, raw } of raws) {
    if (!parseRef(raw)) continue;
    const found = await findRef(client, raw);
    if (!found || found.locationId !== location.id) continue;
    if (found.kind === 'thing') {
      const v = await viewOf(tx, client, scope, null, found.id);
      const ref = thingRefOf(v, location.name);
      const r: ProposalRef = { kind: 'thing', name: ref.untrusted.name, path: ref.untrusted.path };
      refs[raw] = r;
      refs[found.id] = r;
      if (key === THING_ARG) {
        thing = v;
        // Where it is now, for the card's "from" (the web names it through refs).
        const at = v.containerId ?? v.placeId;
        if (at && !refs[at]) {
          const now = await findRef(client, at);
          if (now?.kind === 'thing') {
            const c = thingRefOf(await viewOf(tx, client, scope, null, at), location.name);
            refs[at] = { kind: 'thing', name: c.untrusted.name, path: c.untrusted.path };
          } else if (now) {
            const pl = await placeRefOf(client, at);
            refs[at] = { kind: 'place', name: pl.untrusted.name, path: pl.untrusted.path };
          }
        }
      }
    } else {
      const p = await placeRefOf(client, found.id);
      const r: ProposalRef = { kind: 'place', name: p.untrusted.name, path: p.untrusted.path };
      refs[raw] = r;
      refs[found.id] = r;
    }
  }
  return { refs, thing };
}

/** Kept's own bookkeeping in `before`, never a field the card compares. */
const BOOKKEEPING = new Set(['callId', 'rowVersion']);

/**
 * What the card shows of the target before the change, flat and in the tools' words (the web's
 * confirm-rows.ts reads `place_id`, `container_id`, `quantity`, the changed fields of an update,
 * and a meter's `value` and `unit`), with `callId` and `rowVersion` beside them.
 */
function beforeOf(
  callId: string,
  tool: ToolName,
  args: Record<string, unknown>,
  thing: Awaited<ReturnType<typeof viewOf>> | null,
): Record<string, unknown> {
  if (!thing) return { callId };
  const out: Record<string, unknown> = {
    callId,
    rowVersion: thing.rowVersion,
    place_id: thing.placeId,
    container_id: thing.containerId,
    quantity: thing.quantity,
  };
  if (tool === 'update_thing') {
    const asked = (args.fields ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(asked)) {
      if (k === 'brand') out.brand = thing.brand?.name ?? null;
      else if (k === 'aliases') out.aliases = Object.values(thing.aliases ?? {}).flat();
      else if (k === 'custom') {
        const custom: Record<string, unknown> = {};
        for (const ck of Object.keys((asked.custom ?? {}) as object))
          custom[ck] = thing.custom[ck] ?? null;
        out.custom = custom;
      } else if (k === 'name' || k === 'notes' || k === 'model' || k === 'condition') {
        out[k] = thing[k] ?? null;
      }
    }
  }
  if (tool === 'log_reading') {
    const meter =
      thing.meters.find((m) => m.id === args.meter_id) ??
      (thing.meters.length === 1 ? thing.meters[0] : undefined);
    if (meter) {
      out.unit = meter.unit;
      if (meter.latest) out.value = Number(meter.latest.value);
    }
  }
  return out;
}

/** The fields of `before` the card compares (bookkeeping left out). */
function comparable(before: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(before).filter(([k]) => !BOOKKEEPING.has(k)));
}

/**
 * Records one write call as an open proposal, in the person's scope (the policy admits it only
 * where they may write, D123). Answers the error the model is told instead when it can't be one.
 */
export async function propose(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  p: ProposeInput,
): Promise<Proposed> {
  const parsed = TOOL_DEFS[p.tool].input.safeParse(p.args);
  if (!parsed.success) {
    return {
      ok: false,
      error: toolError('validation', 'Check the input against the tool’s schema.'),
    };
  }
  const where = await locationOfCall(client, p.tool, p.args, p.candidates);
  if (typeof where !== 'string') return { ok: false, error: where };
  const location = p.candidates.find((c) => c.id === where);
  if (!location) return { ok: false, error: unavailable() };
  if (!location.tools.includes(p.tool)) {
    if (location.canWrite) return { ok: false, error: unavailable() };
    return {
      ok: false,
      error: toolError('forbidden', 'This person is a viewer there and can’t make changes.'),
      viewerOf: location.name,
    };
  }
  const { refs, thing } = await refsOf(tx, client, scope, p.args, location);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.assistant_proposals
       (user_id, thread_id, turn_id, location_id, batch_id, tool, args, args_hash, before, refs,
        expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      p.userId,
      p.threadId,
      p.turnId,
      location.id,
      p.batchId,
      p.tool,
      JSON.stringify(p.args),
      argsHash(p.args),
      JSON.stringify(beforeOf(p.callId, p.tool, p.args, thing)),
      JSON.stringify(refs),
      new Date(p.now.getTime() + PROPOSAL_TTL_MS),
    ],
  );
  return { ok: true, proposalId: rows[0]?.id as string, locationId: location.id };
}

// ---------------------------------------------------------------------------------------------
// Confirm and cancel

/** An add_thing item the person kept on the card, by its index in `args.items`, with the name or
 * quantity they edited (D213; the web's ConfirmItem). */
export type ConfirmItem = {
  index: number;
  name?: string | undefined;
  quantity?: number | undefined;
};
export type ConfirmBody = {
  batchId: string;
  proposals: { id: string; argsHash: string; items?: ConfirmItem[] | undefined }[];
};
export type ConfirmOutcome = Extract<
  ProposalStatus,
  'confirmed' | 'conflict' | 'expired' | 'failed'
>;
export type ConfirmResultRow = {
  id: string;
  status: ConfirmOutcome;
  /** The Undo toast's event, while undoable (step 3's undo route). `eventIds`: every event the
   * write made, in write order (add_thing: one per thing and new place, D213); Undo undoes them
   * newest first. */
  audit?: { eventId: string; until: string; eventIds?: string[] };
  conflict?: { field: string; before: unknown; now: unknown; by: string };
  /** For `failed`: the tool's error code. */
  error?: string;
};

export type ConfirmDeps = {
  tools: ToolDeps;
  now?: () => Date;
};

type Claimed =
  | { kind: 'run'; row: ProposalRow; args: Record<string, unknown> }
  | { kind: 'done'; result: ConfirmResultRow };

const asOutcome = (s: ProposalStatus): ConfirmOutcome =>
  s === 'confirmed' || s === 'conflict' || s === 'failed' ? s : 'expired';

/** The audit event and undo time a write's answer names. */
function auditOf(data: Record<string, unknown>) {
  const eventId = typeof data.audit_event_id === 'string' ? data.audit_event_id : null;
  const until = typeof data.undo_until === 'string' ? data.undo_until : null;
  const events = Array.isArray(data.audit_event_ids)
    ? (data.audit_event_ids as string[])
    : eventId
      ? [eventId]
      : [];
  return { eventId, until, events };
}

/**
 * The arguments a confirmed proposal runs with: as proposed, or for add_thing only the items the
 * person kept, each with the name or quantity they edited. The hash binds what was proposed; the
 * edits are the person's own words on their own card (D213).
 */
export function argsWithEdits(
  tool: string,
  args: Record<string, unknown>,
  items: ConfirmItem[] | undefined,
): Record<string, unknown> | null {
  if (!items || tool !== 'add_thing' || !Array.isArray(args.items)) return args;
  const proposed = args.items as Record<string, unknown>[];
  const kept: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  for (const it of items) {
    const item = proposed[it.index];
    if (!item || seen.has(it.index)) return null;
    seen.add(it.index);
    kept.push({
      ...item,
      ...(it.name !== undefined ? { name: it.name } : {}),
      ...(it.quantity !== undefined ? { quantity: it.quantity } : {}),
    });
  }
  return kept.length ? { ...args, items: kept } : null;
}

/** Who last changed a thing, for a conflict ("changed by Bruce"), from its newest audit event. */
async function changedBy(client: pg.ClientBase, thingId: string): Promise<string> {
  const { rows } = await client.query<{ name: string | null }>(
    `SELECT p.display_name AS name FROM public.audit_events e
       LEFT JOIN public.user_profiles p ON p.user_id = e.actor_id
      WHERE e.entity_type = 'thing' AND e.entity_id = $1
      ORDER BY e.id DESC LIMIT 1`,
    [thingId],
  );
  return rows[0]?.name ?? '';
}

/** The first field that differs between the card's `before` and the thing now. */
async function conflictOf(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  row: ProposalRow,
): Promise<ConfirmResultRow['conflict']> {
  const ref =
    typeof row.args.thing_id === 'string' ? await findRef(client, row.args.thing_id) : null;
  const before = comparable(row.before);
  if (ref?.kind !== 'thing') return { field: 'thing', before: null, now: null, by: '' };
  const now = await viewOf(tx, client, scope, null, ref.id);
  const current = comparable(beforeOf('', row.tool as ToolName, row.args, now));
  const by = await changedBy(client, ref.id);
  for (const [field, was] of Object.entries(before)) {
    if (canonicalJson(was) !== canonicalJson(current[field] ?? null)) {
      return { field, before: was, now: current[field] ?? null, by };
    }
  }
  return { field: 'rowVersion', before: row.before.rowVersion, now: now.rowVersion, by };
}

/** Appends a confirmed (or refused) proposal's outcome as its call's result (Q5). */
async function appendOutcome(
  client: pg.ClientBase,
  userId: string,
  row: ProposalRow,
  output: unknown,
): Promise<void> {
  const callId = typeof row.before.callId === 'string' ? row.before.callId : null;
  if (!callId) return;
  const { rows: turn } = await client.query<{ steps: number }>(
    'SELECT steps FROM public.assistant_turns WHERE id = $1',
    [row.turn_id],
  );
  const parts = [
    { type: 'tool_result', callId, tool: row.tool, locationIds: [row.location_id], output },
  ];
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.assistant_messages (thread_id, turn_id, user_id, role, step, parts)
     VALUES ($1, $2, $3, 'tool', $4, $5) RETURNING id`,
    [row.thread_id, row.turn_id, userId, Math.min(20, turn[0]?.steps ?? 0), JSON.stringify(parts)],
  );
  await client.query(
    `INSERT INTO public.assistant_tool_results (message_id, user_id, location_id, call_id, tool, output)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [rows[0]?.id, userId, row.location_id, callId, row.tool, JSON.stringify(output)],
  );
}

/**
 * POST /assistant/proposals/confirm. Every ticked row is checked first (its batch, its hash: a
 * card that doesn't match what was proposed is refused whole, 409 `proposal_conflict`, nothing
 * applied); then each is claimed, run as the person and recorded, one transaction each.
 */
export async function confirmProposals(
  deps: ConfirmDeps,
  scope: Scope,
  body: ConfirmBody,
  requestId: string,
  locale: string,
): Promise<{ results: ConfirmResultRow[] }> {
  const now = deps.now ?? (() => new Date());
  const ids = [...new Set(body.proposals.map((p) => p.id.toLowerCase()))];
  const wanted = new Map(body.proposals.map((p) => [p.id.toLowerCase(), p.argsHash.toLowerCase()]));
  const itemsOf = new Map(body.proposals.map((p) => [p.id.toLowerCase(), p.items]));

  // 1. Check every row and claim the open ones (status → confirmed) before any runs, so a replay
  //    or a double tap never applies a write twice.
  const claimed = await withScope(deps.tools.pools.app, scope, async (_tx, client) => {
    const { rows } = await client.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM public.assistant_proposals
        WHERE id = ANY ($1::uuid[]) AND batch_id = $2 FOR UPDATE`,
      [ids, body.batchId.toLowerCase()],
    );
    if (rows.length !== ids.length) throw notFound();
    const argsOf = new Map<string, Record<string, unknown> | null>();
    for (const r of rows) {
      if (wanted.get(r.id) !== r.args_hash) {
        throw new AppError('proposal_conflict', 409, 'review the new values and ask again');
      }
      const edited = argsWithEdits(r.tool, r.args, itemsOf.get(r.id));
      if (!edited) throw new AppError('validation', 400, 'keep at least one item, each once');
      argsOf.set(r.id, edited);
    }
    const out: Claimed[] = [];
    for (const id of ids) {
      const r = rows.find((x) => x.id === id) as ProposalRow;
      if (r.status !== 'open') {
        out.push({ kind: 'done', result: { id, status: asOutcome(r.status) } });
        continue;
      }
      if (r.expires_at.getTime() <= now().getTime()) {
        await client.query(
          `UPDATE public.assistant_proposals SET status = 'expired' WHERE id = $1`,
          [id],
        );
        out.push({ kind: 'done', result: { id, status: 'expired' } });
        continue;
      }
      await client.query(
        `UPDATE public.assistant_proposals SET status = 'confirmed' WHERE id = $1`,
        [id],
      );
      out.push({ kind: 'run', row: r, args: argsOf.get(id) as Record<string, unknown> });
    }
    return out;
  });

  // 2. Run each as the person, then record what happened.
  const results: ConfirmResultRow[] = [];
  for (const [i, c] of claimed.entries()) {
    if (c.kind === 'done') {
      results.push(c.result);
      continue;
    }
    const row = c.row;
    const rowVersion = row.before.rowVersion;
    const env = (await runTool(
      {
        deps: deps.tools,
        principal: { userId: scope.userId, mfa: scope.mfa, scope: 'write' },
        locale,
        requestId: `${requestId}:${i}`.slice(0, 100),
        via: 'assistant',
        ...(typeof rowVersion === 'number' ? { ifMatch: rowVersion } : {}),
        now,
      },
      row.tool,
      c.args,
    )) as Envelope<Record<string, unknown>>;
    const result = await withScope(deps.tools.pools.app, scope, async (tx, client) => {
      if (isToolError(env)) {
        const conflict =
          env.error === 'precondition_failed'
            ? await conflictOf(tx, client, scope, row)
            : undefined;
        const status: ConfirmOutcome = conflict ? 'conflict' : 'failed';
        await client.query(
          'UPDATE public.assistant_proposals SET status = $2, result = $3 WHERE id = $1',
          [row.id, status, JSON.stringify(env)],
        );
        await appendOutcome(client, scope.userId, row, { status, ...env });
        return {
          id: row.id,
          status,
          ...(conflict ? { conflict } : { error: env.error }),
        } satisfies ConfirmResultRow;
      }
      const a = auditOf(env.data);
      await client.query(
        'UPDATE public.assistant_proposals SET result = $2, audit_event_id = $3 WHERE id = $1',
        [row.id, JSON.stringify(env.data), a.eventId],
      );
      await appendOutcome(client, scope.userId, row, { status: 'confirmed', ...env });
      return {
        id: row.id,
        status: 'confirmed',
        ...(a.eventId && a.until
          ? {
              audit: {
                eventId: a.eventId,
                until: a.until,
                ...(a.events.length > 1 ? { eventIds: a.events } : {}),
              },
            }
          : {}),
      } satisfies ConfirmResultRow;
    });
    results.push(result);
  }
  return { results };
}

/** POST /assistant/proposals/cancel: the batch's open proposals, cancelled and told to the thread. */
export async function cancelProposals(
  client: pg.ClientBase,
  userId: string,
  batchId: string,
): Promise<void> {
  const { rows } = await client.query<ProposalRow>(
    `UPDATE public.assistant_proposals SET status = 'cancelled'
      WHERE batch_id = $1 AND status = 'open'
      RETURNING ${PROPOSAL_COLUMNS}`,
    [batchId.toLowerCase()],
  );
  if (rows.length === 0) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.assistant_proposals WHERE batch_id = $1',
      [batchId.toLowerCase()],
    );
    if (!rowCount) throw notFound();
  }
  for (const r of rows) await appendOutcome(client, userId, r, { status: 'cancelled' });
}
