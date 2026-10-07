/**
 * The one error-code enum (engineering spec §7.7). Every API error body carries one of these as
 * `code`; `error` is the human sentence and `hint` the optional next step (D63's `{error, hint}`).
 * Step-1 codes, then step 2's; later steps add theirs here.
 */
export const ErrorCode = Object.freeze({
  validation: 'validation',
  unauthenticated: 'unauthenticated',
  mfa_required: 'mfa_required',
  forbidden: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  precondition_failed: 'precondition_failed',
  module_off: 'module_off',
  rate_limited: 'rate_limited',
  id_out_of_window: 'id_out_of_window',
  idempotency_mismatch: 'idempotency_mismatch',
  setup_required: 'setup_required',
  setup_code_invalid: 'setup_code_invalid',
  invite_invalid: 'invite_invalid',
  last_owner: 'last_owner',
  /** A sensitive change (email) needs the password again, or a fresh sign-in (D176). */
  reauth_required: 'reauth_required',
  /** An emailed link's token (magic link, email change) is unknown, used or expired. */
  token_invalid: 'token_invalid',
  /** The instance admin has not yet acknowledged the recovery kit (D193): needed before the
   * first secret value, AI key or backup setup. */
  recovery_kit_required: 'recovery_kit_required',
  /** Step 2: a registry row (type, place kind, brand, vendor, person, tag) is still referenced;
   * archive or merge it instead (D92, D160). */
  in_use: 'in_use',
  /** Step 2: trashing a place or container that holds something needs `contents: 'move' |
   * 'trash'` (D160, D162); the body carries `counts: {places, things}`. */
  contents_choice_required: 'contents_choice_required',
  /** Step 2: an upload over KEPT_MAX_FILE_MB (§3.4). */
  payload_too_large: 'payload_too_large',
  /** Step 2: an upload whose sniffed content is not on the allow-list (D157). */
  unsupported_media_type: 'unsupported_media_type',
  /** Step 2: an upload whose bytes don't match the SHA-256 the client declared (D117). */
  checksum_mismatch: 'checksum_mismatch',
  /** Step 3: a sync batch holds a payload older than MIN_PAYLOAD_VERSION (D148, Q3). */
  client_outdated: 'client_outdated',
  /** Step 3: a sync batch holds a payload newer than this server's PAYLOAD_VERSION (Q3). */
  server_outdated: 'server_outdated',
  /** Step 3: the event can't be undone: too late, not yours, or changed since (D150). */
  undo_refused: 'undo_refused',
  /** Step 3: a blank label was claimed first by someone else (D43, D112). */
  label_claimed: 'label_claimed',
  /** Step 3: the location already has 1,000 unclaimed blank labels (D172, §3.1b). */
  blank_cap_reached: 'blank_cap_reached',
  /** Step 3: no AI provider resolves for this location, or the provider failed (D19, D121). */
  ai_unavailable: 'ai_unavailable',
  /** Step 3: the paying account's AI budget is used up; the body carries `pausedUntil` (D19). */
  ai_paused: 'ai_paused',
  /** Step 3: a URL resolves to a private address and private addresses are off (D83, Q9). */
  private_address: 'private_address',
  /** Step 3: a location's AI cap above its account's cap in the same unit (D206, §7.15). */
  cap_above_account: 'cap_above_account',
  /** Step 3: "Resume now" while usage is still at the cap: raise or remove it (§7.15). */
  ai_cap_still_reached: 'ai_cap_still_reached',
  /** Step 3: an AI cap or price in a currency the instance hasn't turned on (§7.15). */
  currency_not_enabled: 'currency_not_enabled',
  /** Step 4: a warranty needs quantity 1; split the row first (D10, step-4 plan Q26). */
  quantity_not_one: 'quantity_not_one',
  /** Step 4: the thing already has an open loan (one per thing, §7.13). */
  already_on_loan: 'already_on_loan',
  /** Step 4: the thing already has a claim in repair (one per thing). */
  thing_in_repair: 'thing_in_repair',
  /** Step 4: a thing with an open loan can't leave its location (Q17). */
  open_loan: 'open_loan',
  /** Step 4: a thing with a claim in repair can't leave its location (Q17). */
  open_claim: 'open_claim',
  /** Step 4: a status change the record's transitions don't allow (a claim's, Q18). */
  invalid_transition: 'invalid_transition',
  /** Step 4: a schedule needs an interval in months or units, or a date (screens §7). */
  schedule_interval_required: 'schedule_interval_required',
  /** Step 4: no exchange rate for a pair on or before the date; the body lists `missing`
   * pairs (D76, Q21). Never estimated. */
  rate_missing: 'rate_missing',
  /** Step 4: web push isn't set up on this server, or this device can't receive it (Q11, V8). */
  push_unavailable: 'push_unavailable',
  /** Step 4: a test send to a channel (webhook, push) failed to arrive. */
  channel_unreachable: 'channel_unreachable',
  /** Step 4: a download link (a claim pack's) is unknown, revoked or expired (Q19). */
  link_expired: 'link_expired',
  /** Step 5: a reading a fuel entry or service record owns is changed through its owner (Q11);
   * the body carries `ownedBy: {type: 'fuel' | 'service', id}`. */
  reading_owned: 'reading_owned',
  /** Step 5: a draft service record (an invoice read by AI) is finished before it's used (Q12). */
  service_draft: 'service_draft',
  /** Step 5: a fill's odometer needs the thing to have a meter. */
  fuel_needs_meter: 'fuel_needs_meter',
  /** Step 6: the token is revoked or expired; make a new one (§5). */
  token_revoked: 'token_revoked',
  /** Step 6: a token called a route or tool its scope or the route's catalogue entry doesn't
   * allow (Q20). */
  token_scope: 'token_scope',
  /** Step 6: the tool isn't offered here: its module is off, the location isn't reachable, or no
   * handler exists yet. The same answer for each, so nothing leaks (D113). */
  tool_unavailable: 'tool_unavailable',
  /** Step 6: a proposal's 10 minutes are up (D22). */
  proposal_expired: 'proposal_expired',
  /** Step 6: the proposal's target changed since it was proposed (screens §5). */
  proposal_conflict: 'proposal_conflict',
  /** Step 6: the thread already has a turn in flight (Q21). */
  turn_running: 'turn_running',
  /** Step 6: what was asked for was removed when access ended (D164). */
  thread_redacted: 'thread_redacted',
  /** Step 7: an archive Kept won't read; the body's `reason` says why (ARCHIVE_REFUSALS, D157). */
  archive_invalid: 'archive_invalid',
  /** Step 7: an archive over the upload cap or the 5 GB uncompressed cap (§3.1b). */
  archive_too_large: 'archive_too_large',
  /** Step 7: the passphrase doesn't open the export's secrets (D68). */
  passphrase_wrong: 'passphrase_wrong',
  /** Step 7: a passphrase shorter than PASSPHRASE_MIN, or the two entries differ (Q7). */
  passphrase_weak: 'passphrase_weak',
  /** Step 7: an export past its seven days (§3.3). */
  export_expired: 'export_expired',
  /** Step 7: an export is already running for that location (Q17). */
  export_running: 'export_running',
  /** Step 7: an archive import needs its target location first (screens §6). */
  import_target_needed: 'import_target_needed',
  /** Step 7: a field of this kind can't be converted to that one (CONVERSIONS, D172). */
  field_convert_blocked: 'field_convert_blocked',
  /** Step 7: "Keep at least" needs a consumable type (D14). */
  not_consumable: 'not_consumable',
  /** Step 7: the optional Homebox connection failed: unreachable, a redirect, a refused key or
   * sign-in, or an answer that isn't Homebox's (502, plan T11). */
  homebox_unreachable: 'homebox_unreachable',
  /** Step 8: no backup target with a password is set (plan Q6: no password, no backup). */
  backup_not_configured: 'backup_not_configured',
  /** Step 8: a backup run (nightly, manual or pre-upgrade) already holds the lock. */
  backup_running: 'backup_running',
  /** Step 8: the backup target can't be reached (a directory, a bucket or an SFTP server). */
  backup_target_unreachable: 'backup_target_unreachable',
  /** Step 8: a backup password shorter than BACKUP_PASSWORD_MIN (plan Q6). */
  backup_password_weak: 'backup_password_weak',
  /** Step 8: a setting the server's environment fixes was changed (D186, §7.11). */
  setting_locked: 'setting_locked',
  /** Step 8: restic failed; the body's `reason` is a RESTIC_ERROR_REASONS code. */
  restic_failed: 'restic_failed',
  /** Step 8: a secret, an export or an admin change over plain HTTP (D181). */
  https_required: 'https_required',
  /** Step 8: the database is more than one release ahead of this image (plan Q9). */
  downgrade_refused: 'downgrade_refused',
  /** Step 8: keeping this offline would pass the device's cap (KEEP_OFFLINE, plan Q21). */
  keep_offline_too_large: 'keep_offline_too_large',
  /** Postgres can't be reached: refused, ended, restarting, out of connections (503). Nothing
   * the request did; the same request works once the database is back. */
  database_unavailable: 'database_unavailable',
  internal: 'internal',
} as const);

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Step 3's error codes. */
export type CaptureErrorCode =
  | 'client_outdated'
  | 'server_outdated'
  | 'undo_refused'
  | 'label_claimed'
  | 'blank_cap_reached'
  | 'ai_unavailable'
  | 'ai_paused'
  | 'private_address'
  | 'cap_above_account'
  | 'ai_cap_still_reached'
  | 'currency_not_enabled';

/**
 * The English sentence for each step-3 code, for the server's message table (spread into
 * `MESSAGES` in apps/server/src/http/errors.ts) and for the phone, which shows some of these
 * without a server round trip ("Update Kept to finish syncing").
 */
export const CAPTURE_ERROR_MESSAGES: Readonly<Record<CaptureErrorCode, string>> = Object.freeze({
  client_outdated: 'Update Kept to finish syncing.',
  server_outdated: 'Kept on the server is older than this app; ask your admin.',
  undo_refused: "That can't be undone any more.",
  label_claimed: 'This label was already claimed.',
  blank_cap_reached:
    'This location already has 1,000 unclaimed labels. Use some before printing more.',
  ai_unavailable: "AI isn't available for this location right now.",
  ai_paused: 'AI is paused until the budget resets.',
  private_address: 'That address is on a private network.',
  cap_above_account: "A location's AI cap can't be above its account's cap.",
  ai_cap_still_reached: 'This month is still at the cap. Raise or remove the cap to resume.',
  currency_not_enabled: "That currency isn't turned on for this server.",
});

/** Step 4's error codes. */
export type HouseholdErrorCode =
  | 'quantity_not_one'
  | 'already_on_loan'
  | 'thing_in_repair'
  | 'open_loan'
  | 'open_claim'
  | 'invalid_transition'
  | 'schedule_interval_required'
  | 'rate_missing'
  | 'push_unavailable'
  | 'channel_unreachable'
  | 'link_expired';

/** The English sentence for each step-4 code (spread into the server's `MESSAGES`). */
export const HOUSEHOLD_ERROR_MESSAGES: Readonly<Record<HouseholdErrorCode, string>> = Object.freeze(
  {
    quantity_not_one: 'A warranty is for a single thing.',
    already_on_loan: 'This is already on loan.',
    thing_in_repair: 'This is already in repair.',
    open_loan: "A thing that's on loan can't move to another location.",
    open_claim: "A thing that's in repair can't move to another location.",
    invalid_transition: "The status can't change that way.",
    schedule_interval_required: 'A schedule needs an interval or a date.',
    rate_missing: 'An exchange rate is missing.',
    push_unavailable: "Push notifications aren't available here.",
    channel_unreachable: "The test didn't arrive.",
    link_expired: 'This link has expired or was revoked.',
  },
);

/** Step 6's error codes. */
export type ConnectionsErrorCode =
  | 'token_revoked'
  | 'token_scope'
  | 'tool_unavailable'
  | 'proposal_expired'
  | 'proposal_conflict'
  | 'turn_running'
  | 'thread_redacted';

/** The English sentence for each step-6 code (spread into the server's `MESSAGES`). */
export const CONNECTIONS_ERROR_MESSAGES: Readonly<Record<ConnectionsErrorCode, string>> =
  Object.freeze({
    token_revoked: 'This token was revoked or has expired.',
    token_scope: "This token can't do that.",
    tool_unavailable: "That tool isn't available here.",
    proposal_expired: 'This change expired. Ask again.',
    proposal_conflict: 'This changed since it was proposed.',
    turn_running: 'The assistant is still answering in this thread.',
    thread_redacted: 'Removed: you no longer have access to this.',
  });

/**
 * The next step for each step-6 code: the `hint` of D63's `{error, hint}` (engineering spec §5),
 * for API bodies and for MCP tool errors, which a model reads.
 */
export const CONNECTIONS_ERROR_HINTS: Readonly<Record<ConnectionsErrorCode, string>> =
  Object.freeze({
    token_revoked: 'create a new token in Settings → Connections',
    token_scope: 'use a token with write access, or do this in Kept',
    tool_unavailable: 'call capabilities to see the tools for each location',
    proposal_expired: 'ask the assistant again',
    proposal_conflict: 'review the new values and ask again',
    turn_running: 'wait for the answer or cancel it',
    thread_redacted: 'start a new thread',
  });

/**
 * Step 5's error codes. A reading that doesn't fit (a fill's or a confirmed draft's odometer running
 * backwards) has no code of its own: it is step 4's 409 `conflict` with `reason`
 * (`lower_than_previous` | `higher_than_next`) and the neighbour (`previous` | `next`:
 * `{value, takenAt}`), exactly as the meters and service records refuse one (the step-5 plan's
 * `reading_refused`; its T1 reuses step 4's code).
 */
export type VehicleErrorCode = 'reading_owned' | 'service_draft' | 'fuel_needs_meter';

/** The English sentence for each step-5 code (spread into the server's `MESSAGES`). */
export const VEHICLE_ERROR_MESSAGES: Readonly<Record<VehicleErrorCode, string>> = Object.freeze({
  reading_owned: 'Change this reading from its fuel entry or service.',
  service_draft: 'Finish logging this service first.',
  fuel_needs_meter: 'This thing has no meter for the odometer.',
});

/** Step 7's error codes. */
export type PortabilityErrorCode =
  | 'archive_invalid'
  | 'archive_too_large'
  | 'passphrase_wrong'
  | 'passphrase_weak'
  | 'export_expired'
  | 'export_running'
  | 'import_target_needed'
  | 'field_convert_blocked'
  | 'not_consumable'
  | 'homebox_unreachable';

/** The English sentence for each step-7 code (spread into the server's `MESSAGES`). */
export const PORTABILITY_ERROR_MESSAGES: Readonly<Record<PortabilityErrorCode, string>> =
  Object.freeze({
    archive_invalid: "Kept can't read this archive.",
    archive_too_large: 'This archive is too large to import.',
    passphrase_wrong: "That passphrase doesn't open this export's secrets.",
    passphrase_weak: 'Use a passphrase of at least 12 characters, the same both times.',
    export_expired: 'This export has expired. Export again.',
    export_running: 'An export of this location is already running.',
    import_target_needed: 'Choose where to import it first.',
    field_convert_blocked: "A field of this kind can't be converted to that one.",
    not_consumable: 'Only things you run out of can have a minimum.',
    homebox_unreachable: "Kept couldn't read from that Homebox.",
  });

/** Step 8's error codes. */
export type OpsErrorCode =
  | 'backup_not_configured'
  | 'backup_running'
  | 'backup_target_unreachable'
  | 'backup_password_weak'
  | 'setting_locked'
  | 'restic_failed'
  | 'https_required'
  | 'downgrade_refused'
  | 'keep_offline_too_large';

/** The English sentence for each step-8 code (spread into the server's `MESSAGES`). */
export const OPS_ERROR_MESSAGES: Readonly<Record<OpsErrorCode, string>> = Object.freeze({
  backup_not_configured: 'Backups are not set up yet.',
  backup_running: 'A backup is already running.',
  backup_target_unreachable: "Kept can't reach the backup storage.",
  backup_password_weak: 'Use a backup password of at least 12 characters.',
  setting_locked: "This is set by the server's environment and can't be changed here.",
  restic_failed: 'The backup tool failed.',
  https_required: 'This needs a secure (https) connection to Kept.',
  downgrade_refused: 'This database is from a newer version of Kept.',
  keep_offline_too_large: 'That is more than this device can keep offline.',
});

export type ApiError = { error: string; hint?: string; code: ErrorCode };

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ErrorCode, value);
}
