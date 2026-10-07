import type {
  AssistantContext,
  ContextKind,
  Part,
  Proposal,
  ProposalRef,
  ProposalStatus,
  ThreadMessage,
  TurnStatus,
} from '@kept/shared';
import { CONTEXT_KINDS } from '@kept/shared';
import type pg from 'pg';
import { notFound } from '../http/errors.js';
import { findRef } from '../tools/resolve.js';

// Threads, messages and proposals as the web reads them (D23, D24, D164; @kept/shared
// assistant.ts; apps/web/src/api/assistant/types.ts). Every query runs as the person on kept_app:
// row-level security keeps a thread its owner's alone, private even from admins and the instance
// admin, and never a token's (0073). Someone else's thread is a 404, the same as none.

export const TITLE_CHARS = 60;

/** A thread's title: the first question's first 60 characters (no model call). */
export function titleOf(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, TITLE_CHARS).join('');
}

type ThreadRow = {
  id: string;
  title: string | null;
  context: AssistantContext;
  locale: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
};

export type ThreadSummary = {
  id: string;
  title: string | null;
  updatedAt: string;
  expiresAt: string;
  context: AssistantContext;
};
export type Thread = ThreadSummary & { locale: string; createdAt: string };

const summaryOf = (r: ThreadRow): ThreadSummary => ({
  id: r.id,
  title: r.title,
  updatedAt: r.updated_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  context: contextOf(r.context),
});
const threadOf = (r: ThreadRow): Thread => ({
  ...summaryOf(r),
  locale: r.locale,
  createdAt: r.created_at.toISOString(),
});

function contextOf(raw: unknown): AssistantContext {
  const c = (raw ?? {}) as Partial<AssistantContext>;
  const kind = (CONTEXT_KINDS as readonly string[]).includes(c.kind ?? '')
    ? (c.kind as ContextKind)
    : 'none';
  return {
    kind,
    ...(typeof c.id === 'string' ? { id: c.id } : {}),
    ...(typeof c.locationId === 'string' ? { locationId: c.locationId } : {}),
  };
}

/**
 * The context as stored (D24): a location, place or thing is checked as the person and named by
 * its location; anything they can't see is dropped (`none`), never echoed back. A search keeps
 * its words (at most 200 characters).
 */
export async function resolveContext(
  client: pg.ClientBase,
  input: { kind: ContextKind; id?: string | undefined } | undefined | null,
): Promise<AssistantContext> {
  if (!input || input.kind === 'none' || input.kind === 'inbox') {
    return { kind: input?.kind ?? 'none' };
  }
  if (input.kind === 'search') {
    return { kind: 'search', id: (input.id ?? '').slice(0, 200) };
  }
  if (!input.id) return { kind: 'none' };
  if (input.kind === 'location') {
    const { rows } = await client.query<{ id: string }>(
      `SELECT l.id FROM public.locations l
        WHERE l.id::text = lower($1) AND l.deleted_at IS NULL
          AND l.id IN (SELECT v.id FROM kept.visible_location_ids() AS v(id))`,
      [input.id],
    );
    return rows[0]
      ? { kind: 'location', id: rows[0].id, locationId: rows[0].id }
      : { kind: 'none' };
  }
  const found = await findRef(client, input.id);
  if (!found || found.kind !== input.kind) return { kind: 'none' };
  return { kind: input.kind, id: found.id, locationId: found.locationId };
}

const THREAD_COLUMNS = 'id, title, context, locale, created_at, updated_at, expires_at';

export async function createThread(
  client: pg.ClientBase,
  userId: string,
  context: AssistantContext,
): Promise<Thread> {
  const { rows } = await client.query<ThreadRow>(
    `INSERT INTO public.assistant_threads (user_id, context, locale)
     VALUES ($1, $2, coalesce((SELECT p.locale FROM public.user_profiles p WHERE p.user_id = $1),
                              'en'))
     RETURNING ${THREAD_COLUMNS}`,
    [userId, JSON.stringify(context)],
  );
  return threadOf(rows[0] as ThreadRow);
}

export async function threadRow(client: pg.ClientBase, id: string): Promise<Thread> {
  const { rows } = await client.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM public.assistant_threads WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound();
  return threadOf(rows[0]);
}

/** The person's threads, newest activity first; `q` searches their own words and the answers. */
export async function listThreads(
  client: pg.ClientBase,
  page: { limit: number; after: [string, string] | null },
  q: string | undefined,
): Promise<{ items: ThreadSummary[]; next_cursor: string | null }> {
  const args: unknown[] = [page.limit + 1];
  let where = 'TRUE';
  if (q?.trim()) {
    args.push(q.trim().slice(0, 200));
    where += ` AND search_tsv @@ plainto_tsquery('simple', kept.search_text($${args.length}))`;
  }
  if (page.after) {
    args.push(page.after[0], page.after[1]);
    where += ` AND (updated_at, id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`;
  }
  const { rows } = await client.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM public.assistant_threads
      WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT $1`,
    args,
  );
  const items = rows.slice(0, page.limit);
  const last = rows.length > page.limit ? items.at(-1) : undefined;
  return {
    items: items.map(summaryOf),
    next_cursor: last
      ? Buffer.from(JSON.stringify({ k: [last.updated_at.toISOString(), last.id] })).toString(
          'base64url',
        )
      : null,
  };
}

/** Deletes a thread and everything in it at once (D23: no audit copy). */
export async function deleteThread(client: pg.ClientBase, id: string): Promise<void> {
  const { rowCount } = await client.query('DELETE FROM public.assistant_threads WHERE id = $1', [
    id,
  ]);
  if (!rowCount) throw notFound();
}

// ---------------------------------------------------------------------------------------------
// Messages, proposals, turns

type MessageRow = {
  id: string;
  role: ThreadMessage['role'];
  parts: Part[];
  created_at: Date;
  turn_id: string | null;
  step: number;
  cited_location_ids: string[];
};

export const messageOf = (r: MessageRow): ThreadMessage => ({
  id: r.id,
  role: r.role,
  parts: r.parts,
  createdAt: r.created_at.toISOString(),
  turnId: r.turn_id,
  step: r.step,
});

const MESSAGE_COLUMNS = 'id, role, parts, created_at, turn_id, step, cited_location_ids';

/** A thread's messages in order (`turnId`: only that turn's). */
export async function messagesOf(
  client: pg.ClientBase,
  threadId: string,
  turnId?: string,
): Promise<(ThreadMessage & { citedLocationIds: string[] })[]> {
  const { rows } = await client.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM public.assistant_messages
      WHERE thread_id = $1 ${turnId ? 'AND turn_id = $2' : ''}
      ORDER BY created_at, id`,
    turnId ? [threadId, turnId] : [threadId],
  );
  return rows.map((r) => ({ ...messageOf(r), citedLocationIds: r.cited_location_ids }));
}

export type ProposalRow = {
  id: string;
  batch_id: string;
  turn_id: string;
  thread_id: string;
  location_id: string;
  tool: string;
  args: Record<string, unknown>;
  args_hash: string;
  before: Record<string, unknown>;
  refs: Record<string, ProposalRef>;
  status: ProposalStatus;
  result: unknown;
  audit_event_id: string | null;
  expires_at: Date;
  row_version: number;
};

export const PROPOSAL_COLUMNS = `id, batch_id, turn_id, thread_id, location_id, tool, args,
  args_hash, before, refs, status, result, audit_event_id, expires_at, row_version`;

/** An open proposal past its 10 minutes reads as expired, before the daily prune marks it. */
export function proposalOf(r: ProposalRow, now: Date): Proposal {
  const status: ProposalStatus =
    r.status === 'open' && r.expires_at.getTime() <= now.getTime() ? 'expired' : r.status;
  const until = (r.result as { undo_until?: unknown } | null)?.undo_until;
  return {
    id: r.id,
    batchId: r.batch_id,
    turnId: r.turn_id,
    locationId: r.location_id,
    tool: r.tool,
    args: r.args,
    argsHash: r.args_hash,
    before: r.before,
    refs: r.refs,
    status,
    expiresAt: r.expires_at.toISOString(),
    ...(r.result !== null && r.result !== undefined ? { result: r.result } : {}),
    ...(r.audit_event_id && typeof until === 'string'
      ? { audit: { eventId: r.audit_event_id, until } }
      : {}),
  };
}

export async function proposalsOf(
  client: pg.ClientBase,
  where: { threadId: string } | { turnId: string },
  now: Date,
): Promise<Proposal[]> {
  const [col, id] = 'threadId' in where ? ['thread_id', where.threadId] : ['turn_id', where.turnId];
  // D164 (security review T25, M4): a proposal in a location the person no longer sees isn't
  // shown. Its args, before and refs carry that location's names and field values, and the
  // membership trigger only cancels open ones (the scrub at the source is queued for the
  // migration owner).
  const { rows } = await client.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM public.assistant_proposals
      WHERE ${col} = $1 AND location_id IN (SELECT kept.visible_location_ids())
      ORDER BY created_at, id`,
    [id],
  );
  return rows.map((r) => proposalOf(r, now));
}

export type TurnRow = {
  id: string;
  thread_id: string;
  status: TurnStatus;
  status_reason: string | null;
  paused_until: Date | number | null;
  steps: number;
  location_ids: string[];
  created_at: Date;
  updated_at: Date;
  row_version: number;
};

export const TURN_COLUMNS = `id, thread_id, status, status_reason, paused_until, steps,
  location_ids, created_at, updated_at, row_version`;

export async function turnRow(client: pg.ClientBase, id: string): Promise<TurnRow> {
  const { rows } = await client.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM public.assistant_turns WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

/** A timestamptz that may be `infinity` (a manual pause), as an ISO string or null. */
export function isoOrNull(v: Date | number | null): string | null {
  if (v === null) return null;
  if (typeof v === 'number') return v > 0 ? '9999-12-31T23:59:59.999Z' : null;
  return v.toISOString();
}

export type LiveTurn = {
  id: string;
  status: TurnStatus;
  statusReason: string | null;
  pausedUntil: string | null;
  steps: number;
};

export const liveTurnOf = (t: TurnRow): LiveTurn => ({
  id: t.id,
  status: t.status,
  statusReason: t.status_reason,
  pausedUntil: isoOrNull(t.paused_until),
  steps: t.steps,
});

export type TurnView = Omit<LiveTurn, 'id'> & {
  messages: ThreadMessage[];
  proposals: Proposal[];
};

/** GET /assistant/turns/:id: the turn, its messages and its proposals. */
export async function turnView(client: pg.ClientBase, id: string, now: Date): Promise<TurnView> {
  const t = await turnRow(client, id);
  const messages = (await messagesOf(client, t.thread_id, t.id)).map(stripCited);
  return {
    status: t.status,
    statusReason: t.status_reason,
    pausedUntil: isoOrNull(t.paused_until),
    steps: t.steps,
    messages,
    proposals: await proposalsOf(client, { turnId: t.id }, now),
  };
}

export function stripCited(m: ThreadMessage & { citedLocationIds?: string[] }): ThreadMessage {
  const { citedLocationIds: _c, ...rest } = m;
  return rest;
}

/** GET /assistant/threads/:id. */
export async function threadDetail(client: pg.ClientBase, id: string, now: Date) {
  const thread = await threadRow(client, id);
  const messages = (await messagesOf(client, id)).map(stripCited);
  const proposals = await proposalsOf(client, { threadId: id }, now);
  const { rows } = await client.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM public.assistant_turns
      WHERE thread_id = $1 AND status IN ('queued', 'running', 'waiting_provider')`,
    [id],
  );
  return {
    thread,
    messages,
    proposals,
    ...(rows[0] ? { liveTurn: liveTurnOf(rows[0]) } : {}),
  };
}
