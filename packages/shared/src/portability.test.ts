import { describe, expect, it } from 'vitest';
import {
  EXPORT_ENTITIES,
  EXPORT_LIMITS,
  EXPORT_VERSION,
  IMPORT_SOURCES,
  kdfParamsAccepted,
  PASSPHRASE_KDF,
  PASSPHRASE_MIN,
  ZIP_LIMITS,
} from './portability.js';

describe('portability limits (D157, §3.1b, §3.3)', () => {
  it('caps archives at 200,000 entries, 5 GB and 100 : 1 above 1 MiB', () => {
    expect(ZIP_LIMITS).toEqual({
      entries: 200_000,
      uncompressedBytes: 5_368_709_120,
      ratio: 100,
      ratioFloorBytes: 1_048_576,
      archiveBytes: 5_368_709_120,
    });
  });

  it('allows five exports an hour, one running per location, kept seven days', () => {
    expect(EXPORT_LIMITS).toEqual({ perHour: 5, runningPerLocation: 1, keepDays: 7 });
  });

  it('writes the location first and the history last, each entity once', () => {
    expect(EXPORT_VERSION).toBe(1);
    expect(EXPORT_ENTITIES[0]).toBe('location');
    expect(EXPORT_ENTITIES.at(-1)).toBe('history');
    expect(new Set(EXPORT_ENTITIES).size).toBe(EXPORT_ENTITIES.length);
  });

  it('lists the import sources the database allows', () => {
    expect(IMPORT_SOURCES).toEqual([
      'csv',
      'homebox_zip',
      'homebox_api',
      'kept_zip',
      'lubelogger_csv',
    ]);
  });
});

describe('the passphrase (D68, Q7, spike P1)', () => {
  it('is at least 12 characters, derived with scrypt at 2^16', () => {
    expect(PASSPHRASE_MIN).toBe(12);
    expect(PASSPHRASE_KDF).toEqual({
      name: 'scrypt',
      N: 65_536,
      r: 8,
      p: 1,
      keyBytes: 32,
      saltBytes: 16,
    });
    expect(kdfParamsAccepted(PASSPHRASE_KDF)).toBe(true);
  });

  it("accepts an export's recorded KDF only within bounds", () => {
    const k = { name: 'scrypt', N: 2 ** 15, r: 8, p: 1 };
    expect(kdfParamsAccepted(k)).toBe(true);
    expect(kdfParamsAccepted({ ...k, N: 2 ** 13 })).toBe(false);
    expect(kdfParamsAccepted({ ...k, N: 2 ** 21 })).toBe(false);
    expect(kdfParamsAccepted({ ...k, N: 50_000 })).toBe(false);
    expect(kdfParamsAccepted({ ...k, r: 16 })).toBe(false);
    expect(kdfParamsAccepted({ ...k, name: 'pbkdf2' })).toBe(false);
  });
});
