import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ApiError,
  CAPTURE_ERROR_MESSAGES,
  CONNECTIONS_ERROR_HINTS,
  CONNECTIONS_ERROR_MESSAGES,
  ErrorCode,
  HOUSEHOLD_ERROR_MESSAGES,
  isErrorCode,
  OPS_ERROR_MESSAGES,
  PORTABILITY_ERROR_MESSAGES,
  VEHICLE_ERROR_MESSAGES,
} from './errors.js';

describe('ErrorCode', () => {
  it('holds exactly the step-1 to step-6 codes, each mapped to itself', () => {
    const codes = [
      'validation',
      'unauthenticated',
      'mfa_required',
      'forbidden',
      'not_found',
      'conflict',
      'precondition_failed',
      'module_off',
      'rate_limited',
      'id_out_of_window',
      'idempotency_mismatch',
      'setup_required',
      'setup_code_invalid',
      'invite_invalid',
      'last_owner',
      'reauth_required',
      'token_invalid',
      'recovery_kit_required',
      'in_use',
      'contents_choice_required',
      'payload_too_large',
      'unsupported_media_type',
      'checksum_mismatch',
      'client_outdated',
      'server_outdated',
      'undo_refused',
      'label_claimed',
      'blank_cap_reached',
      'ai_unavailable',
      'ai_paused',
      'private_address',
      'cap_above_account',
      'ai_cap_still_reached',
      'currency_not_enabled',
      'quantity_not_one',
      'already_on_loan',
      'thing_in_repair',
      'open_loan',
      'open_claim',
      'invalid_transition',
      'schedule_interval_required',
      'rate_missing',
      'push_unavailable',
      'channel_unreachable',
      'link_expired',
      'reading_owned',
      'service_draft',
      'fuel_needs_meter',
      'token_revoked',
      'token_scope',
      'tool_unavailable',
      'proposal_expired',
      'proposal_conflict',
      'turn_running',
      'thread_redacted',
      'archive_invalid',
      'archive_too_large',
      'passphrase_wrong',
      'passphrase_weak',
      'export_expired',
      'export_running',
      'import_target_needed',
      'field_convert_blocked',
      'not_consumable',
      'homebox_unreachable',
      'backup_not_configured',
      'backup_running',
      'backup_target_unreachable',
      'backup_password_weak',
      'setting_locked',
      'restic_failed',
      'https_required',
      'downgrade_refused',
      'keep_offline_too_large',
      'database_unavailable',
      'internal',
    ];
    expect(Object.keys(ErrorCode).sort()).toEqual([...codes].sort());
    for (const [key, value] of Object.entries(ErrorCode)) expect(value).toBe(key);
  });

  it('gives every step-3 code an English sentence', () => {
    expect(Object.keys(CAPTURE_ERROR_MESSAGES)).toHaveLength(11);
    for (const [code, message] of Object.entries(CAPTURE_ERROR_MESSAGES)) {
      expect(isErrorCode(code)).toBe(true);
      expect(message).toMatch(/^[A-Z].+\.$/);
    }
  });

  it('gives every step-4 code an English sentence', () => {
    expect(Object.keys(HOUSEHOLD_ERROR_MESSAGES)).toHaveLength(11);
    for (const [code, message] of Object.entries(HOUSEHOLD_ERROR_MESSAGES)) {
      expect(isErrorCode(code)).toBe(true);
      expect(message).toMatch(/^[A-Z].+\.$/);
    }
  });

  it('gives every step-7 code an English sentence', () => {
    expect(Object.keys(PORTABILITY_ERROR_MESSAGES)).toHaveLength(10);
    for (const [code, message] of Object.entries(PORTABILITY_ERROR_MESSAGES)) {
      expect(isErrorCode(code)).toBe(true);
      expect(message).toMatch(/^[A-Z].+\.$/);
    }
  });

  it('gives every step-8 code an English sentence', () => {
    expect(Object.keys(OPS_ERROR_MESSAGES)).toHaveLength(9);
    for (const [code, message] of Object.entries(OPS_ERROR_MESSAGES)) {
      expect(isErrorCode(code)).toBe(true);
      expect(message).toMatch(/^[A-Z].+\.$/);
    }
  });

  it('gives every step-5 code an English sentence', () => {
    expect(Object.keys(VEHICLE_ERROR_MESSAGES)).toHaveLength(3);
    for (const [code, message] of Object.entries(VEHICLE_ERROR_MESSAGES)) {
      expect(isErrorCode(code)).toBe(true);
      expect(message).toMatch(/^[A-Z].+\.$/);
    }
    // A reading that doesn't fit keeps step 4's `conflict` (plan T1: `reading_refused` reuses it).
    expect(isErrorCode('reading_refused')).toBe(false);
  });

  it('gives every step-6 code an English sentence and a hint', () => {
    expect(Object.keys(CONNECTIONS_ERROR_MESSAGES)).toHaveLength(7);
    expect(Object.keys(CONNECTIONS_ERROR_HINTS).sort()).toEqual(
      Object.keys(CONNECTIONS_ERROR_MESSAGES).sort(),
    );
    for (const [code, message] of Object.entries(CONNECTIONS_ERROR_MESSAGES)) {
      expect(isErrorCode(code)).toBe(true);
      expect(message).toMatch(/^[A-Z].+\.$/);
    }
    expect(CONNECTIONS_ERROR_HINTS.token_revoked).toBe(
      'create a new token in Settings → Connections',
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ErrorCode)).toBe(true);
  });

  it('recognises its own codes only', () => {
    expect(isErrorCode('not_found')).toBe(true);
    expect(isErrorCode('teapot')).toBe(false);
    expect(isErrorCode('toString')).toBe(false);
  });

  it('types an API error body as {error, hint?, code}', () => {
    const body: ApiError = { error: 'Not found', code: ErrorCode.not_found };
    expectTypeOf(body.code).toEqualTypeOf<ErrorCode>();
    expectTypeOf<ApiError['hint']>().toEqualTypeOf<string | undefined>();
  });
});
