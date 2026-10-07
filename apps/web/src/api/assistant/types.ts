/**
 * The assistant's API contract (step-6 plan T13's route table; D22–D24, D123, D164, D179, D213).
 * Message parts, proposals and turn statuses are @kept/shared's (assistant.ts), the same shapes
 * the server stores. Threads are the caller's own only, private even from admins (D23).
 */
import type {
  AssistantContext,
  ContextKind,
  Proposal,
  ProposalStatus,
  ThreadMessage,
  TurnStatus,
} from '@kept/shared';
import type { Page } from '../inventory/types';

export type {
  AssistantContext,
  ContextKind,
  Part,
  Proposal,
  ProposalStatus,
  ThreadMessage,
  TurnStatus,
} from '@kept/shared';

/** `GET /assistant/threads?q&cursor` rows: `q` searches the person's own words and answers. */
export type ThreadSummary = {
  id: string;
  /** The first question's first 60 characters (no model call); null before the first turn. */
  title: string | null;
  updatedAt: string;
  /** Deleted then, unless a new turn moves it (90 days by default, D23). */
  expiresAt: string;
  context: AssistantContext;
};
export type ThreadsPage = Page<ThreadSummary>;
/**
 * The list standard's filters (L88), added by T19: `locationId` (repeatable; with
 * `not=locationId`, "is none of") matches the thread's context location, and `from`/`to` bound
 * `updatedAt` (`from` inclusive, `to` exclusive).
 */
export type ThreadsParams = {
  q?: string;
  cursor?: string;
  locationId?: string[];
  not?: 'locationId'[];
  from?: string;
  to?: string;
};

/** `POST /assistant/threads` (201). */
export type CreateThreadBody = { context?: { kind: ContextKind; id?: string } };
export type Thread = ThreadSummary & { locale: string; createdAt: string };

/** The turn in flight on a thread, if any (one at a time, 409 `turn_running`). */
export type LiveTurn = {
  id: string;
  status: TurnStatus;
  statusReason: string | null;
  pausedUntil: string | null;
  steps: number;
};

/** `GET /assistant/threads/:id`: redacted parts are shown as such (D164). */
export type ThreadDetail = {
  thread: Thread;
  messages: ThreadMessage[];
  proposals: Proposal[];
  liveTurn?: LiveTurn;
};

/**
 * `POST /assistant/threads/:id/turns` → 202 `{turnId}`. 409 `turn_running` when one is live; 409
 * `ai_paused` (with `pausedUntil`) when the context's payer is paused; 400 `ai_unavailable` with
 * no provider. `text` is at most TURN_LIMITS.maxQuestionChars; `locale` is the interface
 * language, which the answer is written in (Q22).
 */
export type AskBody = {
  text: string;
  context?: { kind: ContextKind; id?: string };
  locale: string;
};
export type AskResult = { turnId: string };

/**
 * `GET /assistant/turns/:id`, polled every second while live (Q2), and `POST …/cancel`'s answer:
 * the messages since the turn began, and its proposals.
 */
export type TurnView = {
  status: TurnStatus;
  statusReason: string | null;
  pausedUntil: string | null;
  steps: number;
  messages: ThreadMessage[];
  proposals: Proposal[];
};

/**
 * `POST /assistant/proposals/confirm`: the ticked rows of one card, each with its hash. An
 * `add_thing` proposal (D213, a spoken list) may name `items`: the ones the person kept, by their
 * index in `args.items`, with the name or quantity they edited. Absent, every item is added as
 * proposed. The hash still binds the proposed `args`; the edits are the person's own words.
 */
export type ConfirmItem = { index: number; name?: string; quantity?: number };
export type ConfirmBody = {
  batchId: string;
  proposals: { id: string; argsHash: string; items?: ConfirmItem[] }[];
};
export type ConfirmOutcome = Extract<
  ProposalStatus,
  'confirmed' | 'conflict' | 'expired' | 'failed'
>;
export type ConfirmResult = {
  results: {
    id: string;
    status: ConfirmOutcome;
    /**
     * The Undo toast's event, while undoable (step 3's undo route). A write that recorded more
     * than one (an `add_thing` of several items and its new places, D213) lists them all in
     * `eventIds`, in write order; Undo undoes them newest first.
     */
    audit?: { eventId: string; until: string; eventIds?: string[] };
    /** A row changed since it was proposed: both values and who changed it (screens §5). */
    conflict?: { field: string; before: unknown; now: unknown; by: string };
    /** For `failed`: the tool's error code (T13). */
    error?: string;
  }[];
};

/** `POST /assistant/proposals/cancel` → 204. */
export type CancelProposalsBody = { batchId: string };
