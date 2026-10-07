import { describe, expect, it } from 'vitest';
import {
  nextOutputWindow,
  type OutputLimitSeen,
  type OutputWindow,
  outputFreeInMs,
  parseGoDuration,
  parseRetryAfter,
  readLimits,
  readOutputLimit,
  waitFor,
  waitForOutput,
} from './pacing.js';

const now = new Date('2026-09-26T12:00:00.000Z');

describe('parseGoDuration', () => {
  it.each([
    ['21.037s', 21_037],
    ['1m26.4s', 86_400],
    ['6m0s', 360_000],
    ['250ms', 250],
    ['1h2m3s', 3_723_000],
    ['0s', 0],
    ['0', 0],
  ])('%s → %d ms', (raw, ms) => {
    expect(parseGoDuration(raw)).toBeCloseTo(ms, 6);
  });

  it.each([
    ['', null],
    ['abc', null],
    ['12', null],
    ['1m x', null],
    [undefined, null],
  ])('%j is not a duration', (raw, want) => {
    expect(parseGoDuration(raw)).toBe(want);
  });
});

describe('readLimits', () => {
  it('reads Groq’s headers as the spike recorded them', () => {
    const limits = readLimits(
      'groq',
      {
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '5195',
        'x-ratelimit-reset-tokens': '21.037s',
        'x-ratelimit-reset-requests': '1m26.4s',
      },
      now,
    );
    expect(limits).toEqual({
      limitTokens: 8000,
      remainingTokens: 5195,
      resetAt: new Date('2026-09-26T12:00:21.037Z'),
    });
  });

  it('reads OpenAI’s (same names) and Anthropic’s RFC 3339 reset', () => {
    expect(
      readLimits(
        'openai',
        { 'x-ratelimit-remaining-tokens': '149984', 'x-ratelimit-reset-tokens': '6m0s' },
        now,
      ),
    ).toEqual({
      limitTokens: null,
      remainingTokens: 149_984,
      resetAt: new Date('2026-09-26T12:06:00Z'),
    });
    expect(
      readLimits(
        'anthropic',
        {
          'anthropic-ratelimit-tokens-limit': '2000000',
          'anthropic-ratelimit-tokens-remaining': '1999000',
          'anthropic-ratelimit-tokens-reset': '2026-09-26T12:00:05Z',
        },
        now,
      ),
    ).toEqual({
      limitTokens: 2_000_000,
      remainingTokens: 1_999_000,
      resetAt: new Date('2026-09-26T12:00:05Z'),
    });
  });

  it('is null for kinds without documented headers, and when none were sent', () => {
    expect(readLimits('openrouter', { 'x-ratelimit-remaining-tokens': '1' }, now)).toBeNull();
    expect(readLimits('google', {}, now)).toBeNull();
    expect(readLimits('groq', {}, now)).toBeNull();
    expect(readLimits('groq', undefined, now)).toBeNull();
  });
});

describe('waitFor', () => {
  const limits = (remaining: number, resetInMs: number) => ({
    limitTokens: 8000,
    remainingTokens: remaining,
    resetAt: new Date(now.getTime() + resetInMs),
  });

  it('goes when enough tokens remain, the reset has passed, or nothing is known', () => {
    expect(waitFor(limits(5000, 20_000), 2800, now)).toEqual({ kind: 'go' });
    expect(waitFor(limits(100, -1), 2800, now)).toEqual({ kind: 'go' });
    expect(waitFor(null, 2800, now)).toEqual({ kind: 'go' });
  });

  it('sleeps up to 10 s in place, and holds past that until the reset', () => {
    expect(waitFor(limits(1000, 7_000), 2800, now)).toEqual({ kind: 'sleep', ms: 7000 });
    expect(waitFor(limits(1000, 21_037), 2800, now)).toEqual({
      kind: 'hold',
      until: new Date('2026-09-26T12:00:21.037Z'),
    });
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('7', now)).toBe(7000);
    expect(parseRetryAfter('Sat, 26 Sep 2026 12:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
  });
});

/** Groq's 429 for an output-token limit, recorded 2026-09-29 (organisation id removed). */
const OTPM_429 =
  'Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Used 997, Requested 192. Please try again in 11.34s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';

/** Groq's refusal of one request, recorded 2026-09-29 by the evaluation harness (T11): exactly
 * as logged, which cut provider messages at 200 characters, with the organisation id removed. */
const OTPM_TOO_LARGE_1308 =
  "Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1308. The request's e";
const OTPM_TOO_LARGE_1029 =
  "Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1029. The request's e";
/** The same refusal in full, recorded 2026-09-29 by the harness's full-message log (T15),
 * organisation id removed. */
const OTPM_TOO_LARGE_FULL =
  "Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1080. The request's expected output tokens exceed the enforced limit; reduce max_tokens (or the request's expected output) and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing";

describe('output tokens per minute (OTPM)', () => {
  const now = new Date('2026-09-29T10:00:00.000Z');

  it('reads the limit, use and retry from the 429 message, and nothing from others', () => {
    expect(readOutputLimit(OTPM_429)).toEqual({
      limit: 1000,
      used: 997,
      requested: 192,
      retryMs: 11_340,
      tooLarge: false,
    });
    expect(
      readOutputLimit('Rate limit reached ... on tokens per minute (TPM): Limit 8000'),
    ).toBeNull();
    expect(readOutputLimit(undefined)).toBeNull();
  });

  it('reads Groq\'s "Request too large" refusal, as recorded and cut at 200 characters', () => {
    for (const [message, requested] of [
      [OTPM_TOO_LARGE_1308, 1308],
      [OTPM_TOO_LARGE_1029, 1029],
      [OTPM_TOO_LARGE_FULL, 1080],
      [`{"error":{"message":${JSON.stringify(OTPM_TOO_LARGE_1308)}}} ${OTPM_TOO_LARGE_1308}`, 1308],
    ] as const) {
      // No "Used": the window is taken to be full. No retry: a refusal waits a whole window.
      expect(readOutputLimit(message), message).toEqual({
        limit: 1000,
        used: 1000,
        requested,
        retryMs: null,
        tooLarge: true,
      });
    }
  });

  it('reads the fields in any order, with thousands separators, and needs a limit', () => {
    expect(
      readOutputLimit('on output tokens per minute (OTPM): Requested 1,519, Used 12, Limit 1,000.'),
    ).toEqual({ limit: 1000, used: 12, requested: 1519, retryMs: null, tooLarge: false });
    // Only the OTPM part counts: "Rate limit reached" before it names no limit.
    expect(readOutputLimit('Rate limit reached ... (OTPM): Used 5')).toBeNull();
    // Groq's TPM refusal has the same shape and is not an output limit.
    expect(
      readOutputLimit(
        'Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 9500',
      ),
    ).toBeNull();
  });

  it('a refusal fills the window for a full minute from now, whatever retry-after says', () => {
    const seen = readOutputLimit(OTPM_TOO_LARGE_1308);
    expect(nextOutputWindow(null, { outputTokens: null, outputLimit: seen }, now)).toEqual({
      limit: 1000,
      used: 1000,
      windowStart: now,
    });
    expect(
      nextOutputWindow(null, { outputTokens: null, outputLimit: seen, retryAfterMs: 2000 }, now)
        ?.windowStart,
    ).toEqual(now);
    const win = nextOutputWindow(null, { outputTokens: null, outputLimit: seen }, now);
    // Even a small call waits for the window to end, not an immediate retry.
    expect(waitForOutput(win, 1, new Date(now.getTime() + 5000))).toEqual({
      kind: 'hold',
      until: new Date(now.getTime() + 60_000),
    });
    expect(waitForOutput(win, 1, new Date(now.getTime() + 60_000))).toEqual({ kind: 'go' });
    // The rate-limit wording still waits only as long as it said.
    expect(outputFreeInMs(readOutputLimit(OTPM_429) as OutputLimitSeen, null)).toBe(11_340);
    expect(outputFreeInMs(seen as OutputLimitSeen, 2000)).toBe(60_000);
  });

  it('learns the limit from the 429, with the window ending when the provider said', () => {
    const win = nextOutputWindow(
      null,
      { outputTokens: null, outputLimit: readOutputLimit(OTPM_429) },
      now,
    );
    expect(win).toEqual({
      limit: 1000,
      used: 997,
      windowStart: new Date(now.getTime() + 11_340 - 60_000),
    });
    // Nothing is counted for a key whose limit is unknown.
    expect(nextOutputWindow(null, { outputTokens: 500, outputLimit: null }, now)).toBeNull();
  });

  it('counts output in a one-minute window, and waits when the next call would pass the limit', () => {
    const start: OutputWindow = { limit: 1000, used: 0, windowStart: now };
    const after = nextOutputWindow(
      start,
      { outputTokens: 785, outputLimit: null },
      new Date(now.getTime() + 3000),
    );
    expect(after).toEqual({ limit: 1000, used: 785, windowStart: now });
    // 785 + 200 fits; 785 + 300 doesn't: hold until the window ends (57 s away), or sleep ≤ 10 s.
    expect(waitForOutput(after, 200, new Date(now.getTime() + 3000))).toEqual({ kind: 'go' });
    expect(waitForOutput(after, 300, new Date(now.getTime() + 3000))).toEqual({
      kind: 'hold',
      until: new Date(now.getTime() + 60_000),
    });
    expect(waitForOutput(after, 300, new Date(now.getTime() + 55_000))).toEqual({
      kind: 'sleep',
      ms: 5000,
    });
    // A new window after the last one ends.
    const later = new Date(now.getTime() + 61_000);
    expect(nextOutputWindow(after, { outputTokens: 40, outputLimit: null }, later)).toEqual({
      limit: 1000,
      used: 40,
      windowStart: later,
    });
    expect(waitForOutput(after, 5000, later)).toEqual({ kind: 'go' });
    expect(waitForOutput(null, 5000, later)).toEqual({ kind: 'go' });
  });
});
