import { randomUUID } from 'node:crypto';
import {
  type Envelope,
  isToolError,
  isToolName,
  TOOL_DEFS,
  type ToolName,
  toolError,
} from '@kept/mcp';
import {
  ASSISTANT_OUTPUT,
  type AssistantContext,
  type Part,
  REASONING_ALLOWANCE,
  TURN_LIMITS,
  type TurnStatus,
} from '@kept/shared';
import type pg from 'pg';
import { FOREVER } from '../ai/breaker.js';
import { type CallResult, callModel } from '../ai/call.js';
import type { KeptMessage, ToolCallOut } from '../ai/convert.js';
import { allowanceLevel } from '../ai/extract.js';
import type { AiDeps } from '../ai/routes.js';
import type { Pools } from '../db/pools.js';
import { type Scope, withScope } from '../db/scope.js';
import type { JobMeta } from '../jobs/boss.js';
import { runTool, toolsFor } from '../tools/context.js';
import type { ToolDeps } from '../tools/types.js';
import { checkLinks, locationsIn, seenIn } from './cite.js';
import { payingLocation } from './payer.js';
import { instructionsFor, PROMPT_VERSION, type PromptLocation, toolSpecOf } from './prompt.js';
import { propose } from './proposals.js';
import type { TurnRow } from './threads.js';
import { noAnswer, viewerRefusal } from './words.js';

// One assistant turn (step-6 plan T13; D22, D23, D123, D164, D166, D167, D179, D206; Q2–Q5,
// Q11, Q21–Q23). Kept runs the loop: every model step is one callModel() (one provider request,
// one reservation, one ledger row: `assistant_turn`, then `assistant_followup`), with no
// transaction open around it. Each step is stored as it finishes, so a retried job resumes after
// the last stored step and never repeats a paid call.
//
// Per step:
// - the payer is resolved from the locations touched so far plus the context's (payer.ts, Q3);
// - the tools are those the person may call in each of their locations where the assistant is on
//   (tools/context.ts toolsFor(): module, role and door, D113, D123, D191). Write tools only where
//   they may write; none to a viewer anywhere. The last step offers none, to force an answer;
// - read tools run now through runTool() as the person; each result is stored with the locations
//   it named (cite.ts), which join the turn's (D164);
// - write tools never run: each becomes a proposal (proposals.ts), all of one step in one batch
//   (one card, D213), and the turn stops there (D22);
// - a call the SDK flagged invalid is answered with an error once; the second time the turn fails.
//   A viewer whose model still reaches for a write gets Kept's fixed sentence, no card (Q23);
// - an answer's links to things no tool showed this turn are reduced to text (D179), and the
//   answer cites the locations of its links and the turn's (Q11).

export type LoopDeps = {
  pools: Pick<Pools, 'app'>;
  ai: AiDeps | null;
  /** The tool registry's deps (no base URL: the web renders the assistant's links, D179). */
  tools: ToolDeps;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  /** Sends the turn's job again for `startAfter` (a provider's wait), on the given transaction. */
  sendLater?: (client: pg.ClientBase, data: TurnJobData, startAfter: Date) => Promise<void>;
  now?: () => Date;
  /** Wall-clock milliseconds, for the turn's 180 s (tests shorten it). */
  clock?: () => number;
};

export type TurnJobData = { turnId: string; locale: string };

export type TurnOutcome =
  | { status: 'skipped'; why: 'missing' | 'not_runnable' }
  | { status: TurnStatus; reason?: string };

/** A failure pg-boss retries: the turn is back to `queued`, its stored steps kept. */
export class RetryTurn extends Error {
  constructor(readonly reason: string) {
    super(`assistant turn will be retried: ${reason}`);
    this.name = 'RetryTurn';
  }
}

/** How long a `running` turn is left alone: the job's expiry (JOB_POLICIES['assistant-turn']). */
const STALE_RUNNING_MS = 200_000;
/** Tools that write nothing and so run without a card: a capture link (D63). */
const RUN_WITHOUT_CARD: ReadonlySet<ToolName> = new Set(['attach_link']);

type Candidate = PromptLocation & { tools: ToolName[] };

type Claimed = { turn: TurnRow; context: AssistantContext; userId: string };

async function claim(
  deps: LoopDeps,
  scope: Scope,
  turnId: string,
  job: JobMeta | undefined,
  now: Date,
): Promise<Claimed | TurnOutcome> {
  return withScope(deps.pools.app, scope, async (_tx, client) => {
    const { rows } = await client.query<TurnRow & { context: AssistantContext }>(
      `SELECT t.id, t.thread_id, t.status, t.status_reason, t.paused_until, t.steps,
              t.location_ids, t.created_at, t.updated_at, t.row_version, th.context
         FROM public.assistant_turns t
         JOIN public.assistant_threads th ON th.id = t.thread_id
        WHERE t.id = $1 FOR UPDATE OF t`,
      [turnId],
    );
    const t = rows[0];
    if (!t) return { status: 'skipped', why: 'missing' };
    const stale =
      t.status === 'running' &&
      ((job?.retryCount ?? 0) > 0 || now.getTime() - t.updated_at.getTime() > STALE_RUNNING_MS);
    if (t.status !== 'queued' && t.status !== 'waiting_provider' && !stale) {
      return { status: 'skipped', why: 'not_runnable' };
    }
    await client.query(
      `UPDATE public.assistant_turns
          SET status = 'running', status_reason = NULL, paused_until = NULL
        WHERE id = $1`,
      [turnId],
    );
    return { turn: { ...t, status: 'running' }, context: t.context, userId: scope.userId };
  });
}

/** Ends the turn unless it was cancelled meanwhile. */
async function finish(
  deps: LoopDeps,
  scope: Scope,
  turnId: string,
  status: TurnStatus,
  extra: { reason?: string | null; pausedUntil?: Date | null } = {},
  after?: (client: pg.PoolClient) => Promise<void>,
): Promise<TurnOutcome> {
  const live = status === 'waiting_provider' || status === 'queued';
  return withScope(deps.pools.app, scope, async (_tx, client) => {
    const { rowCount } = await client.query(
      `UPDATE public.assistant_turns
          SET status = $2, status_reason = $3, paused_until = $4,
              finished_at = CASE WHEN $5 THEN NULL ELSE now() END
        WHERE id = $1 AND status = 'running'`,
      [
        turnId,
        status,
        extra.reason?.slice(0, 60) ?? null,
        extra.pausedUntil && extra.pausedUntil.getTime() >= FOREVER.getTime()
          ? 'infinity'
          : (extra.pausedUntil ?? null),
        live,
      ],
    );
    if (!rowCount) return { status: 'cancelled' as const };
    await after?.(client);
    return { status, ...(extra.reason ? { reason: extra.reason } : {}) };
  });
}

type StoredMessage = KeptMessage & { turnId: string | null; cited: string[] };

/** The thread's last messages, starting at a question (Q4: the last 20). */
async function history(client: pg.ClientBase, threadId: string): Promise<StoredMessage[]> {
  const { rows } = await client.query<{
    role: KeptMessage['role'];
    parts: Part[];
    turn_id: string | null;
    cited_location_ids: string[] | null;
    redacted: boolean;
  }>(
    `SELECT role, parts, turn_id, cited_location_ids, redacted FROM (
       SELECT role, parts, turn_id, cited_location_ids, redacted_at IS NOT NULL AS redacted,
              created_at, id
         FROM public.assistant_messages
        WHERE thread_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2) m
      ORDER BY created_at, id`,
    [threadId, TURN_LIMITS.historyMessages],
  );
  const first = rows.findIndex((r) => r.role === 'user');
  return rows.slice(first === -1 ? rows.length : first).map((r) => ({
    role: r.role,
    parts: r.parts,
    turnId: r.turn_id,
    // A redacted answer is the placeholder alone: it no longer carries what it cited, and the
    // location may be one the person can't see any more (an answer may cite only locations they
    // see, security review S2), so it passes nothing on. A tool message's surviving results
    // still name theirs.
    cited: [
      ...(r.redacted && r.role === 'assistant' ? [] : (r.cited_location_ids ?? [])),
      ...r.parts.flatMap((p) => (p.type === 'tool_result' ? (p.locationIds ?? []) : [])),
    ],
  }));
}

async function insertMessage(
  client: pg.ClientBase,
  m: {
    threadId: string;
    turnId: string;
    userId: string;
    role: 'assistant' | 'tool';
    step: number;
    parts: Part[];
    cited: string[];
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.assistant_messages
       (thread_id, turn_id, user_id, role, step, parts, cited_location_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[]) RETURNING id`,
    [m.threadId, m.turnId, m.userId, m.role, m.step, JSON.stringify(m.parts), m.cited],
  );
  return rows[0]?.id as string;
}

/** Every result of the step was a refused write (or the step had only those). */
const isWriteRefusal = (output: unknown) =>
  !!output &&
  typeof output === 'object' &&
  'error' in output &&
  (output as { error: string }).error === 'forbidden';

const union = (...lists: (readonly string[])[]) => [...new Set(lists.flat())];

/** Runs one turn to its end, a pause, or a card. */
export async function runTurn(
  deps: LoopDeps,
  scope: Scope,
  data: TurnJobData,
  job?: JobMeta,
): Promise<TurnOutcome> {
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => Date.now());
  const started = clock();
  const claimed = await claim(deps, scope, data.turnId, job, now());
  if ('status' in claimed) return claimed;
  try {
    return await steps(deps, scope, data, job, claimed, started);
  } catch (err) {
    if (err instanceof RetryTurn) throw err;
    deps.log.error({ err, turnId: data.turnId }, 'assistant turn failed');
    if (job && job.retryCount < job.retryLimit) {
      await finish(deps, scope, data.turnId, 'queued', { reason: 'internal' });
      throw err;
    }
    return finish(deps, scope, data.turnId, 'failed', { reason: 'internal' });
  }
}

async function steps(
  deps: LoopDeps,
  scope: Scope,
  data: TurnJobData,
  job: JobMeta | undefined,
  claimed: Claimed,
  started: number,
): Promise<TurnOutcome> {
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => Date.now());
  const { turn, context } = claimed;
  const { locale } = data;
  const requestId = (job?.id ?? `turn:${turn.id}`).slice(0, 64);
  const attempt = Math.min(20, (job?.retryCount ?? 0) + 1);
  let touched = [...turn.location_ids];
  // What this turn's messages cite beyond `touched` (runCalls, RunCalls.reached).
  let reached: string[] = [];
  let step = turn.steps;
  let invalidOnce = false;

  if (!deps.ai) return finish(deps, scope, turn.id, 'failed', { reason: 'no_provider' });
  const toolCtx = {
    deps: deps.tools,
    principal: { userId: scope.userId, mfa: scope.mfa, scope: 'write' as const },
    locale,
    requestId,
    via: 'assistant' as const,
    now,
  };

  while (step < TURN_LIMITS.maxSteps) {
    if (clock() - started > TURN_LIMITS.turnTimeoutMs) {
      return answerWith(
        deps,
        scope,
        turn,
        step + 1,
        noAnswer(locale),
        touched,
        'failed',
        'turn_timeout',
      );
    }
    // The candidates: the person's locations where the assistant is on, with their tools.
    const reach = await toolsFor(toolCtx);
    const candidates: Candidate[] = reach
      .filter((r) => r.tools.length > 0)
      .map((r) => ({
        id: r.location.id,
        name: r.location.name,
        role: r.location.role,
        canWrite: r.tools.some((t) => TOOL_DEFS[t].scope === 'write'),
        tools: r.tools,
      }));
    const known = new Set(candidates.map((c) => c.id));
    const ctxLocation =
      context.locationId && known.has(context.locationId) ? [context.locationId] : [];

    const prepared = await withScope(deps.pools.app, scope, async (_tx, client) => {
      const { rows } = await client.query<{ status: TurnStatus }>(
        'SELECT status FROM public.assistant_turns WHERE id = $1',
        [turn.id],
      );
      if (rows[0]?.status !== 'running') return null;
      return {
        messages: await history(client, turn.thread_id),
        payer: await payingLocation(
          client,
          union(
            touched.filter((id) => known.has(id)),
            ctxLocation,
          ),
        ),
      };
    });
    if (!prepared) return { status: 'cancelled' };
    // Earlier turns' messages go to the model again; what it says from them is theirs too
    // (D164; security review T25, M5).
    reached = union(
      reached,
      prepared.messages.filter((m) => m.turnId !== turn.id).flatMap((m) => m.cited),
    );

    const rt = await deps.ai.runtime(scope);
    const resolved = await rt.keys.resolve({
      locationId: prepared.payer,
      userId: scope.userId,
      task: 'assistant',
    });
    if (!resolved) return finish(deps, scope, turn.id, 'failed', { reason: 'no_provider' });

    const last = step + 1 >= TURN_LIMITS.maxSteps;
    const names = [...new Set(candidates.flatMap((c) => c.tools))];
    const writes = names.some((n) => TOOL_DEFS[n].scope === 'write');
    const result: CallResult<string> = await callModel<string>(rt, {
      resolved,
      task: step === 0 ? 'assistant_turn' : 'assistant_followup',
      locationId: prepared.payer,
      userId: scope.userId,
      links: { threadId: turn.thread_id },
      instructions: instructionsFor({ locale, locations: candidates, context, writes }),
      text: '',
      images: [],
      output: null,
      conversation: { messages: prepared.messages },
      tools: {
        defs: names.map((n) => toolSpecOf(n, { oneLocation: candidates.length === 1 })),
        choice: last ? 'none' : 'auto',
      },
      maxOutputTokens:
        ASSISTANT_OUTPUT.maxTokens +
        REASONING_ALLOWANCE[allowanceLevel(resolved.provider.reasoning)],
      expectedOutputTokens: last
        ? ASSISTANT_OUTPUT.expectedAnswer
        : ASSISTANT_OUTPUT.expectedToolStep,
      promptVersion: PROMPT_VERSION,
      requestId,
      attempt,
      jobId: job?.id ?? turn.id,
    });
    step += 1;

    // The model's outcome.
    let calls: ToolCallOut[] | null = null;
    let reasoning: string | null = null;
    if (result.status === 'paused') {
      if (result.kind === 'cap') {
        return finish(deps, scope, turn.id, 'paused_budget', {
          reason: result.reason,
          pausedUntil: result.until,
        });
      }
      if (result.until.getTime() >= FOREVER.getTime()) {
        return finish(deps, scope, turn.id, 'failed', { reason: `provider_${result.reason}` });
      }
      const send = deps.sendLater;
      return finish(
        deps,
        scope,
        turn.id,
        'waiting_provider',
        { reason: result.reason, pausedUntil: result.until },
        send ? (client) => send(client, data, result.until) : undefined,
      );
    }
    if (result.status === 'failed') {
      if (result.errorCode === 'tool_input' && result.toolCalls && !invalidOnce) {
        invalidOnce = true;
        calls = result.toolCalls;
        reasoning = result.reasoning ?? null;
      } else if (result.retryable && job && job.retryCount < job.retryLimit) {
        await finish(deps, scope, turn.id, 'queued', { reason: result.errorCode });
        throw new RetryTurn(result.errorCode);
      } else {
        return finish(deps, scope, turn.id, 'failed', {
          reason: result.errorCode || result.outcome,
        });
      }
    } else if (result.toolCalls.length > 0) {
      calls = result.toolCalls;
      reasoning = result.reasoning;
    } else {
      // An answer: links checked against what this turn's tools showed (D179).
      const outputs = prepared.messages
        .filter((m) => m.turnId === turn.id && m.role === 'tool')
        .flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool_result' ? [p.output] : [])));
      const checked = checkLinks(result.value.trim() || noAnswer(locale), seenIn(outputs));
      return answerWith(
        deps,
        scope,
        turn,
        step,
        checked.text,
        union(touched, reached, checked.cited),
        'done',
        null,
        result.reasoning,
      );
    }

    // Tool calls. A viewer everywhere whose model reaches for a write: the fixed sentence (Q23).
    const reachedForWrite = calls.some(
      (c) =>
        isToolName(c.tool) && TOOL_DEFS[c.tool].scope === 'write' && !RUN_WITHOUT_CARD.has(c.tool),
    );
    if (reachedForWrite && !candidates.some((c) => c.canWrite)) {
      const where =
        candidates.find((c) => c.id === context.locationId) ??
        (candidates.length === 1 ? candidates[0] : null);
      return answerWith(
        deps,
        scope,
        turn,
        step,
        viewerRefusal(locale, where?.name ?? null),
        touched,
        'done',
      );
    }

    const outcome = await runCalls(deps, scope, {
      turn,
      step,
      calls,
      reasoning,
      candidates,
      known,
      touched,
      reached,
      toolCtx,
      now: now(),
    });
    touched = outcome.touched;
    reached = outcome.reached;
    if (outcome.proposed) {
      return finish(deps, scope, turn.id, 'done');
    }
    if (outcome.viewerIn) {
      // A write where the person is a viewer, and nothing else proposed: Kept's sentence (Q23).
      return answerWith(
        deps,
        scope,
        turn,
        step + 1,
        viewerRefusal(locale, outcome.viewerIn),
        touched,
        'done',
      );
    }
  }
  return answerWith(deps, scope, turn, step, noAnswer(locale), touched, 'failed', 'max_steps');
}

/** Stores an answer and ends the turn. */
async function answerWith(
  deps: LoopDeps,
  scope: Scope,
  turn: TurnRow,
  step: number,
  text: string,
  cited: string[],
  status: TurnStatus,
  reason: string | null = null,
  reasoning: string | null = null,
): Promise<TurnOutcome> {
  return finish(deps, scope, turn.id, status, { reason }, async (client) => {
    const parts: Part[] = [
      ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      { type: 'text', text },
    ];
    await insertMessage(client, {
      threadId: turn.thread_id,
      turnId: turn.id,
      userId: scope.userId,
      role: 'assistant',
      step: Math.min(20, step),
      parts,
      cited,
    });
    await client.query('UPDATE public.assistant_turns SET steps = $2 WHERE id = $1', [
      turn.id,
      Math.min(20, step),
    ]);
  });
}

type RunCalls = {
  turn: TurnRow;
  step: number;
  calls: ToolCallOut[];
  reasoning: string | null;
  candidates: Candidate[];
  known: ReadonlySet<string>;
  touched: string[];
  /** What the turn's messages cite beyond `touched`: every location a read ran over, and what
   * the history fed to the model came from (D164; security review T25, M5). */
  reached: string[];
  toolCtx: Parameters<typeof runTool>[0];
  now: Date;
};

/** Stores the step's calls, runs the reads, proposes the writes, stores the results. */
async function runCalls(
  deps: LoopDeps,
  scope: Scope,
  r: RunCalls,
): Promise<{ touched: string[]; reached: string[]; proposed: boolean; viewerIn: string | null }> {
  const step = Math.min(20, r.step);
  const asked = (c: ToolCallOut) => {
    const id = (c.input as { location_id?: unknown } | null)?.location_id;
    return typeof id === 'string' ? id.toLowerCase() : null;
  };
  // 1. The model's message: what it called, citing what the turn has touched (Q11).
  await withScope(deps.pools.app, scope, async (_tx, client) => {
    const parts: Part[] = [
      ...(r.reasoning ? [{ type: 'reasoning' as const, text: r.reasoning }] : []),
      ...r.calls.map((c) => ({
        type: 'tool_call' as const,
        callId: c.callId,
        tool: c.tool,
        input: c.input,
      })),
    ];
    const cited = union(
      r.touched,
      r.reached,
      r.calls.flatMap((c) => {
        const id = asked(c);
        return id && r.known.has(id) ? [id] : [];
      }),
    );
    await insertMessage(client, {
      threadId: r.turn.thread_id,
      turnId: r.turn.id,
      userId: scope.userId,
      role: 'assistant',
      step,
      parts,
      cited,
    });
  });

  // 2. Reads now, as the person; writes become proposals below.
  type Done = { call: ToolCallOut; output: unknown; locations: string[]; touches?: string[] };
  const done: Done[] = [];
  const writes: ToolCallOut[] = [];
  for (const [i, c] of r.calls.entries()) {
    if (i >= TURN_LIMITS.maxToolCallsPerStep) {
      done.push({
        call: c,
        output: toolError(
          'too_many_calls',
          `At most ${TURN_LIMITS.maxToolCallsPerStep} tool calls a step.`,
        ),
        locations: [],
      });
      continue;
    }
    if (c.invalid || !isToolName(c.tool)) {
      done.push({
        call: c,
        output: toolError(
          'tool_input',
          c.invalid?.error === 'AI_NoSuchToolError'
            ? 'That tool is not offered here.'
            : 'The input does not match the tool’s schema.',
        ),
        locations: [],
      });
      continue;
    }
    const at = asked(c);
    if (at && !r.known.has(at)) {
      // A location outside the thread's candidates (D179): the same answer as an unknown one.
      done.push({
        call: c,
        output: toolError(
          'tool_unavailable',
          'Call capabilities to see the tools you can use in each location.',
        ),
        locations: [],
      });
      continue;
    }
    if (TOOL_DEFS[c.tool].scope === 'write' && !RUN_WITHOUT_CARD.has(c.tool)) {
      writes.push(c);
      continue;
    }
    // The locations the call ran over, as runTool resolved them (security review T25, M5): a
    // result whose output names no location id (thing_history, find_documents, upcoming) is
    // still stored by its location, so losing that location redacts it (D164).
    let ran: string[] = [];
    const env = (await runTool(
      {
        ...r.toolCtx,
        requestId: `${r.toolCtx.requestId}:${step}:${i}`,
        onLocations: (ids) => {
          ran = ids.filter((id) => r.known.has(id));
        },
      },
      c.tool,
      c.input,
    )) as Envelope<unknown>;
    // What a read showed is its location's, an empty answer included ("nothing there").
    // `touches` (what the payer follows, Q3) stays what the output names; `locations` (what the
    // result is stored and redacted by) adds every location the call ran over.
    const named = isToolError(env) ? [] : union(at ? [at] : [], locationsIn(env, r.known));
    done.push({
      call: c,
      output: env,
      locations: isToolError(env) ? [] : union(named, ran),
      touches: named,
    });
  }

  // 3. The writes (one batch, one card) and every result, in one transaction.
  return withScope(deps.pools.app, scope, async (tx, client) => {
    const batchId = randomUUID();
    const proposals: { call: ToolCallOut; proposalId: string; locationId: string }[] = [];
    let viewerIn: string | null = null;
    for (const c of writes) {
      const p = await propose(tx, client, scope, {
        userId: scope.userId,
        threadId: r.turn.thread_id,
        turnId: r.turn.id,
        batchId,
        callId: c.callId,
        tool: c.tool as ToolName,
        args: (c.input ?? {}) as Record<string, unknown>,
        candidates: r.candidates,
        now: r.now,
      });
      if (p.ok) {
        proposals.push({ call: c, proposalId: p.proposalId, locationId: p.locationId });
        done.push({
          call: c,
          output: {
            status: 'proposed',
            proposal_id: p.proposalId,
            hint: 'Shown to the person as a card to confirm; nothing is changed until they do.',
          },
          locations: [p.locationId],
        });
      } else {
        if (p.viewerOf) viewerIn ??= p.viewerOf;
        done.push({ call: c, output: p.error, locations: [] });
      }
    }
    // Results in the order of the calls (convert.ts pairs by call id either way).
    const order = new Map(r.calls.map((c, i) => [c.callId, i]));
    done.sort((a, b) => (order.get(a.call.callId) ?? 0) - (order.get(b.call.callId) ?? 0));
    const parts: Part[] = [
      ...done.map((d) => ({
        type: 'tool_result' as const,
        callId: d.call.callId,
        tool: d.call.tool,
        locationIds: d.locations,
        output: d.output,
      })),
      ...proposals.map((p) => ({ type: 'proposal' as const, proposalId: p.proposalId })),
    ];
    const messageId = await insertMessage(client, {
      threadId: r.turn.thread_id,
      turnId: r.turn.id,
      userId: scope.userId,
      role: 'tool',
      step,
      parts,
      cited: [],
    });
    for (const d of done) {
      const toolName = /^[a-z][a-z0-9_]{0,63}$/.test(d.call.tool) ? d.call.tool : 'unknown';
      for (const loc of d.locations.length ? d.locations : [null]) {
        await client.query(
          `INSERT INTO public.assistant_tool_results (message_id, user_id, location_id, call_id, tool, output)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            messageId,
            scope.userId,
            loc,
            d.call.callId.slice(0, 100),
            toolName,
            JSON.stringify(d.output ?? null),
          ],
        );
      }
    }
    const touched = union(
      r.touched,
      done.flatMap((d) => d.touches ?? d.locations),
    );
    const reached = union(
      r.reached,
      done.flatMap((d) => d.locations),
    );
    await client.query(
      'UPDATE public.assistant_turns SET steps = $2, location_ids = $3::uuid[] WHERE id = $1',
      [r.turn.id, step, touched],
    );
    return {
      touched,
      reached,
      proposed: proposals.length > 0,
      viewerIn:
        proposals.length === 0 && done.every((d) => isWriteRefusal(d.output)) ? viewerIn : null,
    };
  });
}
