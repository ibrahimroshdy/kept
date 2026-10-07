import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { BOOT_RETRY_DELAYS_MS, isTransientDbError, retryAtBoot } from './boot-retry.js';

const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

describe('isTransientDbError (T24)', () => {
  it("counts pg-boss's connect timeout, refused connections and Postgres starting up", () => {
    expect(isTransientDbError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientDbError(coded('ECONNREFUSED'))).toBe(true);
    expect(isTransientDbError(coded('57P03', 'the database system is starting up'))).toBe(true);
    expect(isTransientDbError(coded('53300', 'sorry, too many clients already'))).toBe(true);
    expect(
      isTransientDbError(new AggregateError([coded('ECONNREFUSED'), coded('ECONNREFUSED')], '')),
    ).toBe(true);
    expect(isTransientDbError(new Error('wrapped', { cause: coded('ETIMEDOUT') }))).toBe(true);
  });

  it('does not count a wrong password, a missing database or a downgrade refusal', () => {
    expect(isTransientDbError(coded('28P01', 'password authentication failed'))).toBe(false);
    expect(isTransientDbError(coded('3D000', 'database "kept" does not exist'))).toBe(false);
    expect(isTransientDbError(coded('downgrade_refused'))).toBe(false);
    expect(isTransientDbError('timeout exceeded when trying to connect')).toBe(false);
  });

  it('counts the error pg really gives for a port nothing listens on', async () => {
    const client = new pg.Client({ connectionString: 'postgres://x:y@127.0.0.1:1/none' });
    const err = await client.connect().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isTransientDbError(err)).toBe(true);
  });
});

describe('retryAtBoot (T24)', () => {
  const log = () => ({ warn: vi.fn<(obj: Record<string, unknown>, msg: string) => void>() });
  const noSleep = async (_ms: number) => {};

  it('waits out transient failures, one warning each, then returns', async () => {
    const l = log();
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
      .mockRejectedValueOnce(coded('57P03'))
      .mockResolvedValue('started');
    await expect(retryAtBoot('job queue', fn, { log: l, sleep })).resolves.toBe('started');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual(BOOT_RETRY_DELAYS_MS.slice(0, 2));
    expect(l.warn).toHaveBeenCalledTimes(2);
    expect(l.warn.mock.calls[0]?.[1]).toContain('job queue');
  });

  it('throws anything else at once', async () => {
    const fn = vi.fn().mockRejectedValue(coded('28P01', 'password authentication failed'));
    await expect(retryAtBoot('release guard', fn, { log: log(), sleep: noSleep })).rejects.toThrow(
      'password authentication failed',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last wait with the last error', async () => {
    const fn = vi.fn().mockRejectedValue(coded('ECONNREFUSED', 'connect ECONNREFUSED'));
    await expect(
      retryAtBoot('job queue', fn, { log: log(), sleep: noSleep, delays: [1, 1] }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
