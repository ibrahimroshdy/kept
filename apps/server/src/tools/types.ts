import type { ToolInput, ToolName, ToolOutput, ToolScope } from '@kept/mcp';
import type { Action, ModuleId, Role } from '@kept/shared';
import type pg from 'pg';
import type { Pools } from '../db/pools.js';
import type { Scope, Tx } from '../db/scope.js';
import type { ProviderResolver } from '../http/modules.js';
import type { JobQueue } from '../jobs/queue.js';
import type { SemanticInput, SemanticPrep } from '../search/semantic.js';
import type { FileStorage } from '../storage/blob-store.js';

// The tool registry's types (step-6 plan T9, Q1). One registry serves the assistant (T13) and
// MCP (T11): each handler calls the same operation its route calls, inside withScope, with the
// same rules (can(), the module gate, the money gate, audited()).

/**
 * Who calls a tool.
 * - The assistant (T13): the person themself, `scope: 'write'` (a proposal they confirmed runs as
 *   them; their role decides the rest).
 * - MCP (T11): a token (T4, T10): `tokenId` and the token's `scope`. RLS reads `app.token_id`
 *   beside `app.user_id` (principalScope(), context.ts), and its writes audit as the token. A
 *   read principal is never offered, and can never run, a write tool.
 */
export type ToolPrincipal = {
  userId: string;
  mfa: boolean;
  scope: ToolScope;
  tokenId?: string;
};

export type ToolVia = 'assistant' | 'mcp';

export type ToolDeps = {
  pools: Pick<Pools, 'app'>;
  jobs: JobQueue | null;
  files: FileStorage | null;
  /** Whether an AI provider resolves in a location (the AI modules follow it, D191). Defaults
   * to kept.ai_provider_resolved(). */
  providerResolved?: ProviderResolver;
  /** Prefixed to the internal links a tool answers (`/t/K7D2QX`): the public URL for MCP,
   * nothing for the assistant, whose answers the web renders as internal links (D179). */
  baseUrl?: string;
  log?: { error: (obj: object, msg: string) => void };
  /** Semantic search's query side (step-6 T14, search/semantic.ts semanticPrep()): a handler
   * with `meaning` gets its query's vectors in `op.semantic`, embedded before the transaction
   * (D166). Absent: those tools search by keywords only. */
  semantic?: SemanticPrep;
};

export type ToolContext = {
  deps: ToolDeps;
  principal: ToolPrincipal;
  /** The interface language of the question (Q22). Tool output itself is language-neutral. */
  locale: string;
  requestId: string;
  via: ToolVia;
  /** The row version a confirmed proposal was drawn against (T13: If-Match from
   * `before.rowVersion`); a write tool on a versioned row refuses a changed row with
   * `precondition_failed`. Absent, the row's current version is used. */
  ifMatch?: number;
  now?: () => Date;
  /** Told the locations the call ran over, once resolved (the assistant stores a result by them,
   * so losing one redacts it even when the output names no location id: D164). */
  onLocations?: (locationIds: string[]) => void;
};

/** What a handler runs with: the area operations' own context (`Ctx` in things/, places/, …)
 * and the resolved location. */
export type Op = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  jobs: JobQueue | null;
  files: FileStorage | null;
  principal: ToolPrincipal;
  via: ToolVia;
  /** The question's interface language (ToolContext.locale). */
  locale: string;
  ifMatch: number | undefined;
  /** The location the call is about; null only for a `global` handler called without one. */
  location: ReachableLocation | null;
  /** Every location the call may read: the one above, or (global handlers) all reachable. */
  locations: ReachableLocation[];
  /** An internal link, with the deps' base URL. */
  link: (path: string) => string;
  /** The query's vectors for a handler with `meaning` (T14); null: keywords only. */
  semantic: SemanticInput | null;
};

export type ReachableLocation = {
  id: string;
  name: string;
  timeZone: string;
  role: Role;
  modules: ReadonlySet<ModuleId>;
};

export type HandlerResult<T> = {
  data: T;
  /** The next page's cursor, when the operation has more. */
  nextCursor?: string | null;
  /** The cursor for "after the first `kept` items of this page", used when fit() shortens it. */
  cursorAt?: (kept: number) => string;
};

export type Handler<N extends ToolName> = {
  /** The can() action a principal's role needs in the location (§7.1). */
  action: Action;
  /** Reads across every reachable location when no `location_id` is given. */
  global?: boolean;
  /** The location of the row the input addresses (a thing, a place), read as the caller; null
   * when it addresses none or the caller can't see it. */
  subjectLocation?: (client: pg.ClientBase, input: ToolInput<N>) => Promise<string | null>;
  /** The text this call searches by meaning (search_things, where_is; T14): runTool embeds it
   * before the call's transaction and hands the vectors over as `op.semantic`. */
  meaning?: (input: ToolInput<N>) => string | undefined;
  run: (op: Op, input: ToolInput<N>) => Promise<HandlerResult<ToolOutput<N>>>;
};

export type HandlerTable = { [N in ToolName]?: Handler<N> };
