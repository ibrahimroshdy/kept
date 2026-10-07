/**
 * The assistant's contracts (D22, D23, D24, D123, D164, D179, D213; step-6 plan Q2–Q5, Q11, Q17,
 * Q21). The server stores and the web renders these shapes; the ledger never holds any of them
 * (D206).
 */

/** Where the question was asked from (D24): the removable context chip. */
export const CONTEXT_KINDS = ['location', 'place', 'thing', 'search', 'inbox', 'none'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export type AssistantContext = {
  kind: ContextKind;
  /** The place's or thing's id, or the search query; absent for `location` (its id is
   * `locationId`), `inbox` and `none`. */
  id?: string;
  locationId?: string;
};

export const MESSAGE_ROLES = ['user', 'assistant', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * A message part. `reasoning` is the model's own reasoning as the provider returned it (spike
 * S6.3, finding 4): kept in the private thread so the next request can send it back, never
 * shown and never in the ledger. `redacted` replaces what a person may no longer see (D164); it
 * names no location.
 */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; callId: string; tool: string; input: unknown }
  | { type: 'tool_result'; callId: string; tool: string; locationIds: string[]; output: unknown }
  | { type: 'proposal'; proposalId: string }
  | { type: 'redacted'; reason: 'access_ended' };
export type PartType = Part['type'];
export const PART_TYPES = [
  'text',
  'reasoning',
  'tool_call',
  'tool_result',
  'proposal',
  'redacted',
] as const satisfies readonly PartType[];

export type ThreadMessage = {
  id: string;
  role: MessageRole;
  parts: Part[];
  createdAt: string;
  turnId: string | null;
  /** The model step the message belongs to (0 for the question). */
  step: number;
};

/** The loop's bounds (Q4, Q21): Kept runs the loop, one provider request per step. */
export const TURN_LIMITS = Object.freeze({
  maxSteps: 6,
  maxToolCallsPerStep: 4,
  turnTimeoutMs: 180_000,
  maxQuestionChars: 2000,
  historyMessages: 20,
});

export const TURN_STATUSES = [
  'queued',
  'running',
  'waiting_provider',
  'paused_budget',
  'done',
  'failed',
  'cancelled',
] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];
/** A turn still in flight: one per thread at a time (409 `turn_running`). */
export const LIVE_TURN_STATUSES = [
  'queued',
  'running',
  'waiting_provider',
] as const satisfies readonly TurnStatus[];

export function isLiveTurn(status: TurnStatus): boolean {
  return (LIVE_TURN_STATUSES as readonly TurnStatus[]).includes(status);
}

/** A write proposal lives 10 minutes (D22, §3.4). */
export const PROPOSAL_TTL_MS = 600_000;
export const PROPOSAL_STATUS = [
  'open',
  'confirmed',
  'cancelled',
  'expired',
  'conflict',
  'failed',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUS)[number];

/**
 * A write the model proposed and the person confirms (D22, D179). The card is drawn from `args`
 * and `before`, never from model text. One turn's writes share a `batchId` and one card (D213).
 */
export type Proposal = {
  id: string;
  batchId: string;
  turnId: string;
  locationId: string;
  tool: string;
  args: Record<string, unknown>;
  /** SHA-256 of the canonical JSON of `args`, lower-case hex; Confirm sends it back. */
  argsHash: string;
  /** The target's fields and `rowVersion` when proposed. */
  before: Record<string, unknown>;
  /**
   * Kept's own names for every id in `args` and `before` (a thing, a place, a location), looked up
   * when proposed, so the card names them without any model text (D179). User-written: shown as
   * untrusted text, bidi-isolated.
   */
  refs: Record<string, ProposalRef>;
  status: ProposalStatus;
  expiresAt: string;
  result?: unknown;
  audit?: { eventId: string; until: string };
};

export type ProposalRef = {
  kind: 'thing' | 'place' | 'location';
  name: string;
  /** Place names from the location down to it (empty for a location). */
  path: string[];
};

/** Threads are private and deleted after this many days without a new turn (D23, §3.3). */
export const THREAD_RETENTION_DAYS = 90;

/**
 * JSON with object keys sorted at every depth: what `argsHash` hashes, so the web and the server
 * agree on a proposal's hash whatever order the model wrote the keys in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
