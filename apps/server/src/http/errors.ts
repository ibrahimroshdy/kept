import {
  type ApiError,
  CAPTURE_ERROR_MESSAGES,
  CONNECTIONS_ERROR_MESSAGES,
  ErrorCode,
  HOUSEHOLD_ERROR_MESSAGES,
  OPS_ERROR_MESSAGES,
  PORTABILITY_ERROR_MESSAGES,
  VEHICLE_ERROR_MESSAGES,
} from '@kept/shared';
import { ScopeError } from '../db/scope.js';

// One error shape for every response: `{error, hint?, code}` (D81, engineering spec §7.7).
// A 500 never carries a stack trace or the underlying message; the log gets a redacted copy
// (safeErrorForLog), never query parameters or values (D81: no argument values in logs).

const MESSAGES: Record<ErrorCode, string> = {
  ...CAPTURE_ERROR_MESSAGES,
  ...HOUSEHOLD_ERROR_MESSAGES,
  ...VEHICLE_ERROR_MESSAGES,
  ...CONNECTIONS_ERROR_MESSAGES,
  ...PORTABILITY_ERROR_MESSAGES,
  ...OPS_ERROR_MESSAGES,
  validation: 'The request is not valid.',
  unauthenticated: 'Sign in to continue.',
  mfa_required: 'Confirm your second factor to continue.',
  forbidden: "You don't have permission to do that.",
  not_found: 'Not found.',
  conflict: 'That conflicts with the current state.',
  precondition_failed: 'This changed since you opened it.',
  module_off: 'That feature is turned off for this location.',
  rate_limited: 'Too many attempts. Try again later.',
  id_out_of_window: 'The id is not a current UUIDv7.',
  idempotency_mismatch: 'That idempotency key was used for a different request.',
  setup_required: 'Kept needs to be set up first.',
  setup_code_invalid: 'The setup code is not valid.',
  invite_invalid: 'The invite is not valid.',
  last_owner: 'A location needs an owner.',
  reauth_required: 'Confirm it is you to continue.',
  token_invalid: 'That link is invalid or has expired.',
  recovery_kit_required: 'Save the recovery kit first.',
  in_use: 'It is still in use.',
  contents_choice_required: 'Choose what happens to what is inside first.',
  payload_too_large: 'That file is too large.',
  unsupported_media_type: "That kind of file can't be added.",
  checksum_mismatch: "The file didn't arrive intact. Try again.",
  database_unavailable: "Kept can't reach its database right now. Try again in a minute.",
  internal: 'Something went wrong.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint?: string;
  /** Extra top-level fields for the body, e.g. `{conflicts}` on a 412 (§7.7, D156). */
  readonly extra?: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    status: number,
    hint?: string,
    extra?: Record<string, unknown>,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (hint !== undefined) this.hint = hint;
    if (extra !== undefined) this.extra = Object.freeze({ ...extra });
  }
}

export const notFound = (hint?: string) => new AppError(ErrorCode.not_found, 404, hint);
export const forbidden = (hint?: string) => new AppError(ErrorCode.forbidden, 403, hint);
export const conflict = (hint?: string) => new AppError(ErrorCode.conflict, 409, hint);
export const invalid = (hint?: string) => new AppError(ErrorCode.validation, 400, hint);
export const unauthenticated = () => new AppError(ErrorCode.unauthenticated, 401);

export type ErrorBody = ApiError & Record<string, unknown>;
export type ErrorReply = { status: number; body: ErrorBody };

function body(err: AppError): ErrorBody {
  const out: ErrorBody = { ...(err.extra ?? {}), error: err.message, code: err.code };
  if (err.hint !== undefined) out.hint = err.hint;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------------------------

export type PgErrorLike = {
  code: string;
  severity?: string;
  constraint?: string;
  table?: string;
  column?: string;
  routine?: string;
};

const SQLSTATE = /^[0-9A-Z]{5}$/;

function isPgError(value: unknown): value is PgErrorLike {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && SQLSTATE.test(v.code) && typeof v.severity === 'string';
}

/** The pg error behind `err`: itself, or a `cause` a few levels down (DrizzleQueryError). */
export function pgErrorOf(err: unknown): PgErrorLike | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur; depth++) {
    if (isPgError(cur)) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Constraints the triggers raise that describe a state conflict, not bad input (handoff for
 * task 16; migration 0005). */
const CONFLICT_HINTS: Record<string, string> = {
  locations_owner_membership:
    "A location needs exactly one owner membership, held by the owner account's user.",
  locations_personal_owner_only: 'A Personal location has no members but its owner.',
  places_no_loop: "A place can't be moved under itself or one of its descendants.",
  places_unplaced_fixed: "The Unplaced area can't be trashed or moved.",
  places_parent_fk: 'Move or remove what is inside this place first.',
  locations_personal_undeletable: "A Personal location can't be deleted.",
  memberships_location_user_uq: 'They already belong to this location.',
  instance_already_set_up: 'Kept is already set up.',
  // Step 2 (migration 0014): the type tree and the registries' names.
  types_no_loop: "A type can't sit under itself or one of its descendants.",
  type_fields_inherited_key: 'A field with that key is already defined along this type.',
  brands_name_uq: 'A brand with that name already exists.',
  tags_name_uq: 'A tag with that name already exists.',
  // Step 2 (T13): converting a place that still has places inside it (0024).
  places_has_children: 'Move the places inside it elsewhere first.',
  // Step 2 (T14): things (0016, 0018, 0024). The routes check most of these first with a 400.
  things_quantity_one:
    'A serialized or metered thing, or one with a meter, has quantity 1; split it instead.',
  things_quantity_positive: 'Only a consumable can have quantity 0.',
  things_no_loop: "A thing can't go inside itself or something inside it.",
  things_one_parent_chk: 'A thing sits in exactly one place or container.',
  things_named_chk: 'A thing needs a name unless it is a draft.',
  things_has_meters: "A thing with a meter can't become a place.",
  things_custom_secret: 'Secret fields are written through the secrets route, not in custom.',
  things_move_secret_field: "A secret value can't move to a location whose type lacks the field.",
  thing_links_uq: 'These two things are already linked that way.',
  // Step 2 route review (#3): every other state conflict a request can meet. The currencies and
  // types routes catch theirs first with a `reason`; these are the answer when one slips past.
  currencies_default_fixed: 'The default currencies stay turned on.',
  currencies_in_use: 'A location uses this currency; it stays turned on.',
  secret_values_field_key: "The value's key doesn't match its secret field; reload and try again.",
  type_fields_secret_fixed:
    "A field can't become secret or stop being secret; add a new field and archive this one.",
  type_fields_secret_text_chk: 'A secret field is a text field.',
  types_field_group_chk: "A field group can't have types under it.",
  types_merge_secret_fields:
    'A secret value would lose its field; only the location owner may merge these.',
  types_merge_secret_policy:
    'The merge would change who may reveal a secret; only the location owner may merge these.',
  // Step 3 (T7, 0042): labels and duplicate merges.
  short_ids_blank_cap: 'This place already has 1,000 unclaimed blank labels; claim some first.',
  things_merge_meters: 'Both things have a meter; remove one before merging them.',
  // Step 3 (T17a, 0046): own codes' numbering.
  own_code_numbers_taken:
    'The next 10,000 numbers are all taken as codes here; change the prefix in the numbering.',
  // Step 4 (plan T5): the names the T5 migration raises or declares. The ones with a code of
  // their own are in CODED below.
  warranties_quantity_one: 'Split it first: a warranty covers one thing.',
  claims_transition:
    'An open claim can go in repair, be resolved or be rejected; a closed claim reopens only through Undo.',
  claims_one_repair_uq: 'It is already in repair; close that claim first.',
  loans_one_open_uq: 'It is already on loan; mark it returned first.',
  claims_warranty_thing: "Pick one of this thing's own warranties.",
  // Step 4 (0056): merged parts (a lent part merged back, a duplicate merged away).
  things_merged_into: 'It can only be merged into a thing that is here and not in the trash.',
  things_merged_restore:
    'It was merged into another thing, so it can’t come back from the trash on its own. Undo the merge instead.',
  things_move_open_loan: 'It is on loan; mark it returned before moving it to another location.',
  things_move_in_repair: 'It is in repair; close the claim before moving it to another location.',
  // Step 4 (plan T7): the caps its triggers enforce. The plan names no constraint for them; these
  // are the names T2 proposes, and T7 raises them or renames them here.
  notification_channels_webhook_cap: 'You already have 5 webhooks; remove one first.',
  calendar_feeds_cap: 'You already have 3 calendar links; revoke one first.',
  // Step 5 (plan T2): the unique names Phase A declares (T5, T6). One reading has one owner, a
  // fill or a service (Q11); the API refuses first, these are the answer when one slips past.
  fuel_entries_reading_uq: 'That reading already belongs to another fuel entry.',
  service_records_reading_uq: 'That reading already belongs to another service.',
  // Step 5 (0063, 0065): the names Phase A's triggers raise.
  service_records_review_state: "This service is already logged; it can't go back to a draft.",
  fuel_entries_reading_thing: "A fill's odometer reading is one of its own vehicle's meter.",
  // Step 7 (plan T4, T6): the names Phase A's triggers raise.
  import_runs_target_fixed: "An import's location can't change once it is set.",
  stock_rules_consumable: 'Only things you run out of can have a minimum.',
  // Step 6 (Phase A, 0069–0070): tokens and OAuth grants. Their location guards refuse with
  // 42501 (a 404), so they need no hint.
  api_tokens_revoked_final: 'A revoked token stays revoked; create a new one in Connections.',
  api_tokens_lookup_uq: 'Try again.',
  api_tokens_oauth_uq: 'This app is already connected; change its access in Connections.',
  token_locations_none: 'Pick at least one location.',
  // Step 6 (0072): one live turn per thread; the code is turn_running (CODED below).
  assistant_turns_one_live_uq: 'Wait for the answer, or cancel it, before asking again.',
};

/** Step 4: constraints a request can hit that answer with a code of their own (plan T1's codes),
 * 409 with the hint above, instead of the generic `conflict`. */
const CODED: Record<string, ErrorCode> = {
  warranties_quantity_one: ErrorCode.quantity_not_one,
  claims_transition: ErrorCode.invalid_transition,
  claims_one_repair_uq: ErrorCode.thing_in_repair,
  loans_one_open_uq: ErrorCode.already_on_loan,
  things_move_open_loan: ErrorCode.open_loan,
  things_move_in_repair: ErrorCode.open_claim,
  // Step 7 (plan T6).
  stock_rules_consumable: ErrorCode.not_consumable,
  // Step 6 (0072).
  assistant_turns_one_live_uq: ErrorCode.turn_running,
};

/** Primary keys: Postgres names inline ones `<table>_pkey`, Drizzle names composite ones
 * `<table>_<cols>_pk`. */
const isPrimaryKey = (constraint: string | undefined) =>
  !!constraint && /_(pkey|pk)$/.test(constraint);

/** Doors that refuse with RAISE (P0001) name the refusal as the constraint (0040): the step-3 AI
 * caps. Each maps to its own code; any other P0001 stays an internal error. */
const RAISED: Record<string, { code: ErrorCode; status: number }> = {
  cap_above_account: { code: ErrorCode.cap_above_account, status: 400 },
  ai_cap_still_reached: { code: ErrorCode.ai_cap_still_reached, status: 409 },
};

const INPUT_STATES = new Set(['23502', '22P02', '22001', '22003', '22007', '22008', '22023']);

function fromPg(pg: PgErrorLike): AppError | null {
  const hint = pg.constraint ? CONFLICT_HINTS[pg.constraint] : undefined;
  const coded = pg.constraint ? CODED[pg.constraint] : undefined;
  if (coded && (pg.code === '23514' || pg.code === '23505')) return new AppError(coded, 409, hint);
  switch (pg.code) {
    // An RLS refusal (or a missing grant) on a row the user can't see: indistinguishable from a
    // missing row (§7.7). A visible read-only resource gets its 403 from can() before the write.
    // kept.accept_invite() (0006) refuses every bad invite alike, by name: 404 `invite_invalid`,
    // never 410, which would confirm that the token once existed (task 20).
    case '42501':
      return pg.constraint === 'invite_invalid'
        ? new AppError(
            ErrorCode.invite_invalid,
            404,
            'Ask the person who invited you for a new link.',
          )
        : notFound();
    // A client-supplied id that already exists, in this tenant or any other, is the same 404 as
    // an id that exists nowhere (§7.7, D178). Any other unique index is a real conflict.
    case '23505':
      return isPrimaryKey(pg.constraint) ? notFound() : conflict(hint);
    case '23503':
    case '23001':
      return conflict(hint);
    case '23514':
      return hint ? conflict(hint) : invalid();
    case 'P0001': {
      const raised = pg.constraint ? RAISED[pg.constraint] : undefined;
      return raised ? new AppError(raised.code, raised.status) : null;
    }
    // Serialization failure, deadlock: the client may simply retry.
    case '40001':
    case '40P01':
      return conflict('Try again.');
    default:
      return INPUT_STATES.has(pg.code) ? invalid() : null;
  }
}

/**
 * Postgres can't be reached (2026-09-30: the disk filled and Postgres PANICked, ending every
 * connection): the connection-exception class 08, an administrator or crash shutdown, a
 * server still starting, no connection slots, or a database not accepting connections; or,
 * before any SQLSTATE, a refused, reset or timed-out socket and pg's own "terminated" errors.
 */
const UNAVAILABLE_STATES = new Set(['57P01', '57P02', '57P03', '53300']);
const UNAVAILABLE_SOCKET = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);
/** pg's and pg-pool's own messages for a connection that went away or never came (pg 8). */
const UNAVAILABLE_MESSAGES = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
]);

/** Whether `err`, or a `cause` a few levels down (DrizzleQueryError), is the database being
 * unreachable rather than anything the request did. */
export function isDatabaseUnavailable(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    const e = cur as { code?: unknown; severity?: unknown; message?: unknown; cause?: unknown };
    if (isPgError(e)) {
      const { code, severity } = e as PgErrorLike;
      return (
        code.startsWith('08') ||
        UNAVAILABLE_STATES.has(code) ||
        // "database … is not currently accepting connections" (ALLOW_CONNECTIONS false).
        (code === '55000' && severity === 'FATAL')
      );
    }
    if (typeof e.code === 'string' && UNAVAILABLE_SOCKET.has(e.code)) return true;
    if (typeof e.message === 'string' && UNAVAILABLE_MESSAGES.has(e.message)) return true;
    cur = e.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Fastify and zod
// ---------------------------------------------------------------------------------------------

type FastifyValidationError = {
  validation: { instancePath?: string; message?: string; params?: unknown }[];
  validationContext?: string;
};

function isValidationError(err: unknown): err is FastifyValidationError {
  return (
    !!err && typeof err === 'object' && Array.isArray((err as { validation?: unknown }).validation)
  );
}

/** "Check body.name, query.limit.": paths only, never the values that failed. */
function validationHint(err: FastifyValidationError): string | undefined {
  const where = err.validationContext ?? 'request';
  const paths = [
    ...new Set(
      err.validation.map((issue) => {
        const path = (issue.instancePath ?? '').replace(/^\//, '').replaceAll('/', '.');
        return path ? `${where}.${path}` : where;
      }),
    ),
  ];
  return paths.length > 0 ? `Check ${paths.join(', ')}.` : undefined;
}

function fromStatus(status: number): AppError {
  switch (status) {
    case 401:
      return unauthenticated();
    case 403:
      return forbidden();
    case 404:
      return notFound();
    case 429:
      return new AppError(ErrorCode.rate_limited, 429);
    default:
      // 400 (bad JSON), 413 (too large), 415 (content type) and the like.
      return new AppError(ErrorCode.validation, status);
  }
}

/** Maps anything thrown by a route to the status and body the client sees. */
export function toErrorReply(err: unknown): ErrorReply {
  let mapped: AppError | null = null;
  if (err instanceof AppError) mapped = err;
  else if (err instanceof ScopeError)
    mapped = null; // a programming error: 500
  else if (isValidationError(err)) mapped = invalid(validationHint(err));
  else if (isDatabaseUnavailable(err)) mapped = new AppError(ErrorCode.database_unavailable, 503);
  else {
    const pg = pgErrorOf(err);
    if (pg) mapped = fromPg(pg);
    else {
      const status = (err as { statusCode?: unknown } | null)?.statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) mapped = fromStatus(status);
    }
  }
  const final = mapped ?? new AppError(ErrorCode.internal, 500);
  return { status: final.status, body: body(final) };
}

/**
 * What the log may hold about an error. A pg error's message and detail can quote values
 * (`invalid input syntax for type uuid: "…"`, `Key (email)=(…)`), and DrizzleQueryError's
 * message is the query with its parameters, so both are reduced to their codes and names.
 */
export function safeErrorForLog(err: unknown): Record<string, unknown> {
  const pg = pgErrorOf(err);
  if (pg) {
    return {
      type: 'DatabaseError',
      code: pg.code,
      constraint: pg.constraint,
      table: pg.table,
      column: pg.column,
      routine: pg.routine,
    };
  }
  if (err instanceof Error) {
    if (err.name === 'DrizzleQueryError') {
      return { type: err.name, message: 'query failed (parameters withheld)' };
    }
    return { type: err.name, message: err.message, stack: err.stack };
  }
  if (err !== null && typeof err === 'object') {
    // An error copied into a plain object: pg-boss reports a worker's failure as
    // `{ ...err, message, stack, queue, worker }`, whose String() is "[object Object]".
    const copy = err as Record<string, unknown>;
    const type = typeof copy.name === 'string' ? copy.name : 'Error';
    const out: Record<string, unknown> = {
      type,
      message:
        type === 'DrizzleQueryError'
          ? 'query failed (parameters withheld)'
          : typeof copy.message === 'string'
            ? copy.message
            : '(no message)',
    };
    if (typeof copy.stack === 'string') out.stack = copy.stack;
    for (const key of ['queue', 'worker'] as const) {
      if (typeof copy[key] === 'string') out[key] = copy[key];
    }
    return out;
  }
  return { type: typeof err, message: String(err) };
}
