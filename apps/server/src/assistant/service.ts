import { type ContextKind, isLiveTurn, TURN_LIMITS } from '@kept/shared';
import type pg from 'pg';
import type { AiDeps } from '../ai/routes.js';
import { statusOf } from '../ai/status.js';
import type { Scope } from '../db/scope.js';
import { AppError, notFound, pgErrorOf } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import type { TurnJobData } from './loop.js';
import { resolveContext, type TurnView, threadRow, titleOf, turnView } from './threads.js';

// Asking and cancelling (step-6 plan T13's route table; D22, D166, D206; Q2, Q21; §7.15). A
// question is stored with its turn and the turn's job **in one transaction**, so a turn exists
// only with its job; the job runs in the asker's scope (D166). One live turn per thread (409
// `turn_running`, enforced by assistant_turns_one_live_uq). No provider → 400 `ai_unavailable`;
// the context's location paused → 409 `ai_paused` (the assistant is refused while paused, never
// queued, §7.15).

export const ASSISTANT_TURN_JOB = 'assistant-turn';

export type AskBody = {
  text: string;
  context?: { kind: ContextKind; id?: string | undefined } | undefined;
  locale: string;
};

/** Checked before the transaction, with its own short doors: a provider, and no pause. */
export async function askPreflight(
  ai: AiDeps | null | undefined,
  client: pg.ClientBase,
  scope: Scope,
  locationId: string | null,
): Promise<void> {
  if (!ai) throw new AppError('ai_unavailable', 400, 'connect AI in Settings');
  const rt = await ai.runtime(scope);
  const resolved = await rt.keys.resolve({ locationId, userId: scope.userId, task: 'assistant' });
  if (!resolved) throw new AppError('ai_unavailable', 400, 'connect AI in Settings');
  if (!locationId) return;
  // kept.ai_status reads the extraction cascade's buckets; a location's and a member's caps
  // count every task, so a pause there pauses the assistant too. (An account cap named for
  // the assistant alone pauses the turn's first step instead, with its over_budget row.)
  const status = await statusOf(client, locationId);
  if (
    status.pausedUntil &&
    (status.pausedBy?.scope === 'location' || status.pausedBy?.scope === 'member')
  ) {
    throw new AppError('ai_paused', 409, 'wait for the budget to reset, or ask its manager', {
      pausedUntil: status.pausedUntil,
      reason: status.reason,
    });
  }
}

/** The context a question is asked in: the body's, else the thread's. */
export async function askContext(client: pg.ClientBase, threadId: string, body: AskBody) {
  const thread = await threadRow(client, threadId);
  // The thread's own context is checked again: a location the person no longer sees is dropped.
  const context = await resolveContext(client, body.context ?? thread.context);
  return { thread, context };
}

/** Stores the question, its turn and the turn's job, in the caller's transaction. */
export async function ask(
  client: pg.ClientBase,
  jobs: JobQueue | null,
  scope: Scope,
  threadId: string,
  body: AskBody,
  context: Awaited<ReturnType<typeof askContext>>['context'],
): Promise<{ turnId: string }> {
  if (!jobs) throw new AppError('ai_unavailable', 400, 'the assistant needs the job queue');
  const text = body.text.trim();
  if (!text || [...text].length > TURN_LIMITS.maxQuestionChars) {
    throw new AppError(
      'validation',
      400,
      `a question is 1 to ${TURN_LIMITS.maxQuestionChars} characters`,
    );
  }
  await client.query('SAVEPOINT ask_turn');
  let turnId: string;
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.assistant_turns (thread_id, user_id) VALUES ($1, $2) RETURNING id`,
      [threadId, scope.userId],
    );
    turnId = rows[0]?.id as string;
    await client.query('RELEASE SAVEPOINT ask_turn');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT ask_turn');
    if (pgErrorOf(err)?.code === '23505') {
      throw new AppError('turn_running', 409, 'wait for the answer or cancel it');
    }
    throw err;
  }
  await client.query(
    `INSERT INTO public.assistant_messages (thread_id, turn_id, user_id, role, step, parts)
     VALUES ($1, $2, $3, 'user', 0, $4)`,
    [threadId, turnId, scope.userId, JSON.stringify([{ type: 'text', text }])],
  );
  await client.query(
    `UPDATE public.assistant_threads
        SET title = coalesce(title, $2), context = $3
      WHERE id = $1`,
    [threadId, titleOf(text), JSON.stringify(context)],
  );
  const data: TurnJobData = { turnId, locale: body.locale.slice(0, 20) };
  await jobs.sendTenant(client, ASSISTANT_TURN_JOB, data);
  return { turnId };
}

/** POST /assistant/turns/:id/cancel: a live turn stops before its next step (a call in flight
 * still settles and is billed, Q21). */
export async function cancelTurn(client: pg.ClientBase, id: string, now: Date): Promise<TurnView> {
  const { rows } = await client.query<{ status: string }>(
    'SELECT status FROM public.assistant_turns WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw notFound();
  if (isLiveTurn(rows[0].status as never)) {
    await client.query(
      `UPDATE public.assistant_turns SET status = 'cancelled', finished_at = now() WHERE id = $1`,
      [id],
    );
  }
  return turnView(client, id, now);
}
