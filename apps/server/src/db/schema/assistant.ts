import { MESSAGE_ROLES, PROPOSAL_STATUS, TURN_STATUSES } from '@kept/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { id, mutable, textEnum, tstz } from './common.js';
import { locations } from './tenancy.js';

// The assistant's private threads (step-6 plan T5; engineering spec §1.8, §3.3, §7.13; D22, D23,
// D123, D164, D179; plan Q3, Q11, Q17, Q21). Every row is its user's own, private even from
// admins and instance admins, and never a token's. Each child names its user and reaches its
// thread through (user_id, thread_id), so a row can't sit in someone else's thread. Row-level
// security, retention, the search text and redaction are in the custom migration that follows
// (0073); see src/db/assistant.test.ts.

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const turnStatus = textEnum('status', TURN_STATUSES);
const role = textEnum('role', MESSAGE_ROLES);
const proposalStatus = textEnum('status', PROPOSAL_STATUS);

/**
 * A conversation (D23): its title, the page it was asked from (D24, `{kind, id?, locationId?}`),
 * the interface language, and the search text over the person's own questions and the answers,
 * never tool results (Q17). `expires_at` is set from `assistant_thread_days` at creation and on
 * each new turn (0072).
 */
export const assistantThreads = pgTable(
  'assistant_threads',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title'),
    context: jsonb('context').notNull().default({}),
    locale: text('locale').notNull(),
    searchTsv: tsvector('search_tsv'),
    expiresAt: tstz('expires_at').notNull().default(sql`now() + interval '90 days'`),
    ...mutable(),
  },
  (t) => [
    unique('assistant_threads_user_id_uq').on(t.userId, t.id),
    check('assistant_threads_title_chk', sql`char_length(title) <= 120`),
    check('assistant_threads_context_chk', sql`jsonb_typeof(context) = 'object'`),
    check('assistant_threads_locale_chk', sql`char_length(locale) BETWEEN 1 AND 20`),
    index('assistant_threads_user_idx').on(t.userId, t.updatedAt.desc()),
    index('assistant_threads_tsv_idx').using('gin', t.searchTsv),
    index('assistant_threads_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * One question's run (D166, Q2–Q4, Q21): its status, the steps taken, and the locations it has
 * touched so far (the payer, Q3). One live turn per thread (409 `turn_running`).
 */
export const assistantTurns = pgTable(
  'assistant_turns',
  {
    id: id(),
    threadId: uuid('thread_id').notNull(),
    userId: uuid('user_id').notNull(),
    status: turnStatus.col().notNull().default('queued'),
    statusReason: text('status_reason'),
    pausedUntil: tstz('paused_until'),
    steps: integer('steps').notNull().default(0),
    locationIds: uuid('location_ids').array().notNull().default(sql`'{}'::uuid[]`),
    finishedAt: tstz('finished_at'),
    ...mutable(),
  },
  (t) => [
    turnStatus.check('assistant_turns'),
    check('assistant_turns_status_reason_chk', sql`char_length(status_reason) <= 60`),
    check('assistant_turns_steps_chk', sql`steps BETWEEN 0 AND 20`),
    unique('assistant_turns_user_id_uq').on(t.userId, t.id),
    foreignKey({
      name: 'assistant_turns_thread_fk',
      columns: [t.userId, t.threadId],
      foreignColumns: [assistantThreads.userId, assistantThreads.id],
    }).onDelete('cascade'),
    uniqueIndex('assistant_turns_one_live_uq')
      .on(t.threadId)
      .where(sql`status IN ('queued', 'running', 'waiting_provider')`),
    index('assistant_turns_thread_idx').on(t.threadId, t.createdAt),
  ],
);

/**
 * A message (append-only; §7.13 `user_id`): the question (step 0), the model's answer or tool
 * calls, or the tool results, as @kept/shared `Part`s. `cited_location_ids` is what an answer
 * drew on (Q11). Redaction replaces parts in place (D164).
 */
export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: id(),
    threadId: uuid('thread_id').notNull(),
    turnId: uuid('turn_id'),
    userId: uuid('user_id').notNull(),
    role: role.col().notNull(),
    step: smallint('step').notNull().default(0),
    parts: jsonb('parts').notNull(),
    citedLocationIds: uuid('cited_location_ids').array().notNull().default(sql`'{}'::uuid[]`),
    redactedAt: tstz('redacted_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    role.check('assistant_messages'),
    check('assistant_messages_parts_chk', sql`jsonb_typeof(parts) = 'array'`),
    check('assistant_messages_step_chk', sql`step BETWEEN 0 AND 20`),
    unique('assistant_messages_user_id_uq').on(t.userId, t.id),
    foreignKey({
      name: 'assistant_messages_thread_fk',
      columns: [t.userId, t.threadId],
      foreignColumns: [assistantThreads.userId, assistantThreads.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'assistant_messages_turn_fk',
      columns: [t.userId, t.turnId],
      foreignColumns: [assistantTurns.userId, assistantTurns.id],
    }).onDelete('cascade'),
    index('assistant_messages_thread_idx').on(t.threadId, t.createdAt, t.id),
    index('assistant_messages_turn_idx').on(t.turnId),
  ],
);

/**
 * One tool result, by location, so losing a location redacts exactly its results (D164, Q11).
 * `location_id` is null for a result that touched none; it keeps no key to the location, so a
 * purge can still redact it.
 */
export const assistantToolResults = pgTable(
  'assistant_tool_results',
  {
    id: id(),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id').notNull(),
    locationId: uuid('location_id'),
    callId: text('call_id').notNull(),
    tool: text('tool').notNull(),
    output: jsonb('output'),
    redactedAt: tstz('redacted_at'),
  },
  (t) => [
    check('assistant_tool_results_call_id_chk', sql`char_length(call_id) BETWEEN 1 AND 100`),
    check('assistant_tool_results_tool_chk', sql`tool ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check('assistant_tool_results_redacted_chk', sql`(output IS NULL) = (redacted_at IS NOT NULL)`),
    foreignKey({
      name: 'assistant_tool_results_message_fk',
      columns: [t.userId, t.messageId],
      foreignColumns: [assistantMessages.userId, assistantMessages.id],
    }).onDelete('cascade'),
    index('assistant_tool_results_message_idx').on(t.messageId),
    index('assistant_tool_results_redact_idx')
      .on(t.userId, t.locationId)
      .where(sql`redacted_at IS NULL`),
  ],
);

/**
 * A write the model proposed (D22, D179, D213): drawn as a card from `args`, `before` and `refs`
 * (Kept's own names for the ids, looked up when proposed; @kept/shared `Proposal`), bound to
 * `args_hash`, open for 10 minutes. Only in a location its user may write (D123).
 */
export const assistantProposals = pgTable(
  'assistant_proposals',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    threadId: uuid('thread_id').notNull(),
    turnId: uuid('turn_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull(),
    tool: text('tool').notNull(),
    args: jsonb('args').notNull(),
    argsHash: text('args_hash').notNull(),
    before: jsonb('before').notNull().default({}),
    refs: jsonb('refs').notNull().default({}),
    status: proposalStatus.col().notNull().default('open'),
    result: jsonb('result'),
    auditEventId: uuid('audit_event_id'),
    expiresAt: tstz('expires_at').notNull(),
    ...mutable(),
  },
  (t) => [
    proposalStatus.check('assistant_proposals'),
    check('assistant_proposals_tool_chk', sql`tool ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check('assistant_proposals_args_chk', sql`jsonb_typeof(args) = 'object'`),
    check('assistant_proposals_args_hash_chk', sql`args_hash ~ '^[0-9a-f]{64}$'`),
    check(
      'assistant_proposals_objects_chk',
      sql`jsonb_typeof(before) = 'object' AND jsonb_typeof(refs) = 'object'`,
    ),
    foreignKey({
      name: 'assistant_proposals_thread_fk',
      columns: [t.userId, t.threadId],
      foreignColumns: [assistantThreads.userId, assistantThreads.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'assistant_proposals_turn_fk',
      columns: [t.userId, t.turnId],
      foreignColumns: [assistantTurns.userId, assistantTurns.id],
    }).onDelete('cascade'),
    index('assistant_proposals_thread_idx').on(t.threadId),
    index('assistant_proposals_turn_idx').on(t.turnId),
    index('assistant_proposals_open_idx').on(t.userId, t.locationId).where(sql`status = 'open'`),
    index('assistant_proposals_location_idx').on(t.locationId),
  ],
);
