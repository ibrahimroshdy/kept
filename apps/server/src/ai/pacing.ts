/**
 * Pacing from the provider's own rate-limit headers (D206; engineering spec §3.5, §7.15 "The
 * pacer"; spike 2026-09-26 §4). After every call the headers are stored; before the next one,
 * when the provider's remaining tokens are below the call's estimate and the reset is still
 * ahead, the call waits: in the job for up to 10 s, otherwise by holding the work until the
 * reset (`waiting_provider`, no attempt spent).
 *
 * Header names, each read from the provider's own API reference:
 * - Groq and OpenAI: `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, and
 *   `x-ratelimit-reset-tokens` as a Go-style duration (`21.037s`, `1m26.4s`, `6m0s`). Groq's
 *   values are the spike's recorded ones; OpenAI's rate-limits guide lists the same three.
 * - Anthropic: `anthropic-ratelimit-tokens-limit`, `-remaining` (rounded to the nearest
 *   thousand) and `-reset` (RFC 3339), from platform.claude.com/docs/en/api/rate-limits.
 * - Google, OpenRouter and OpenAI-compatible servers: none documented (OpenRouter sent none in
 *   the spike), so `readLimits` returns null and Kept's budgets and the breaker pace them.
 */
import type { ProviderKind } from '@kept/shared';

export type ProviderLimits = {
  limitTokens: number | null;
  remainingTokens: number | null;
  resetAt: Date | null;
};

export type HeaderBag = Record<string, string | undefined> | undefined;

/** Case-insensitive header lookup (the SDK hands them over lowercased; be safe anyway). */
export function header(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

const UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  ns: 1e-6,
};

/**
 * A Go `time.Duration` string (`1m26.4s`, `21.037s`, `6m0s`, `250ms`, `0s`) in milliseconds, or
 * null when it isn't one.
 */
export function parseGoDuration(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s === '0') return 0;
  const re = /(\d+(?:\.\d+)?)(h|ms|us|µs|ns|m|s)/y;
  let ms = 0;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return null;
    ms += Number(m[1]) * (UNIT_MS[m[2] as string] as number);
    pos = re.lastIndex;
  }
  return pos === 0 ? null : ms;
}

function int(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/** The provider's token window from its response headers, or null when it sends none. */
export function readLimits(
  kind: ProviderKind,
  headers: HeaderBag,
  now: Date,
): ProviderLimits | null {
  let limit: number | null;
  let remaining: number | null;
  let resetAt: Date | null = null;
  switch (kind) {
    case 'groq':
    case 'openai': {
      limit = int(header(headers, 'x-ratelimit-limit-tokens'));
      remaining = int(header(headers, 'x-ratelimit-remaining-tokens'));
      const ms = parseGoDuration(header(headers, 'x-ratelimit-reset-tokens'));
      if (ms !== null) resetAt = new Date(now.getTime() + Math.ceil(ms));
      break;
    }
    case 'anthropic': {
      limit = int(header(headers, 'anthropic-ratelimit-tokens-limit'));
      remaining = int(header(headers, 'anthropic-ratelimit-tokens-remaining'));
      const raw = header(headers, 'anthropic-ratelimit-tokens-reset');
      const t = raw === undefined ? Number.NaN : Date.parse(raw);
      if (Number.isFinite(t)) resetAt = new Date(t);
      break;
    }
    default:
      return null;
  }
  if (limit === null && remaining === null && resetAt === null) return null;
  return { limitTokens: limit, remainingTokens: remaining, resetAt };
}

/** The longest the job sleeps in place; anything longer holds the work (§7.15). */
export const MAX_INLINE_WAIT_MS = 10_000;

export type PaceDecision =
  | { kind: 'go' }
  | { kind: 'sleep'; ms: number }
  | { kind: 'hold'; until: Date };

/**
 * Whether a call estimated at `estimateTokens` may go now against the provider's last known
 * window: go; sleep up to 10 s; or hold until the reset. Unknown remaining or a reset in the
 * past means go (the window has refilled, or the provider doesn't tell).
 */
export function waitFor(
  limits: ProviderLimits | null,
  estimateTokens: number,
  now: Date,
): PaceDecision {
  if (!limits || limits.remainingTokens === null || limits.resetAt === null) return { kind: 'go' };
  const ms = limits.resetAt.getTime() - now.getTime();
  if (ms <= 0 || limits.remainingTokens >= estimateTokens) return { kind: 'go' };
  if (ms <= MAX_INLINE_WAIT_MS) return { kind: 'sleep', ms };
  return { kind: 'hold', until: limits.resetAt };
}

/** `retry-after`: delay-seconds or an HTTP date (RFC 9110 §10.2.3), in ms from `now`. */
export function parseRetryAfter(raw: string | undefined, now: Date): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.ceil(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now.getTime()) : null;
}

// ---------------------------------------------------------------------------------------------
// Output tokens per minute (OTPM)
// ---------------------------------------------------------------------------------------------
//
// Some Groq organisations also have a per-minute limit on **output** tokens (Groq's rate-limit
// guide: "separate per-minute limits on input tokens (ITPM) and output tokens (OTPM)"), which no
// response header reports: the guide documents only the TPM and RPD headers, and a recorded
// response on 2026-09-29 carried only those. It shows only in the 429 that enforces it, whose
// error message names it (recorded that day, organisation id removed):
//
//   Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_…` service tier
//   `on_demand` on output tokens per minute (OTPM): Limit 1000, Used 997, Requested 192. Please
//   try again in 11.34s. …   (with `retry-after: 12`)
//
// It also refuses one request outright, in a second wording (recorded in full 2026-09-29 by the
// evaluation harness, organisation id removed):
//
//   Request too large for model `qwen/qwen3.8-27b` in organization `org_…` service tier
//   `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1080. The request's
//   expected output tokens exceed the enforced limit; reduce max_tokens (or the request's
//   expected output) and try again. …
//
// with no `retry-after` and `x-ratelimit-remaining-tokens: 8000` (the TPM window was empty).
// That day "Requested" was, six times out of six, the output of the largest answer the key had
// had in the last few minutes (1,308 once, 1,029 three times, 1,080 twice), never the request's
// `max_tokens` (2,248 to 4,548), and it kept refusing for minutes (65 s to 150 s apart).
// Inferred, not documented: Groq expects a request to produce as much as the key's largest
// recent answer, capped by `max_tokens` (hence its advice), and refuses one whose expectation
// alone passes the limit. Retrying at once cannot
// help, so the refusal counts as a full window: the key waits one minute, and the breaker
// doubles its trip on each refusal in a row.
//
// So the limit is learned from either message, and from then on each call's output tokens are
// counted in a one-minute window per key; a call whose expected output would pass the limit
// waits for the window to end instead of drawing the provider's 429.

export const OUTPUT_WINDOW_MS = 60_000;

/** A key's learned output limit and its current window. */
export type OutputWindow = {
  /** The OTPM limit the provider named; null until a 429 names one. */
  limit: number | null;
  used: number;
  windowStart: Date;
};

/** What a provider's OTPM refusal named. */
export type OutputLimitSeen = {
  limit: number;
  /** The window's use: as named, or the whole limit when the message names none (the window
   * is taken to be full). */
  used: number;
  requested: number | null;
  /** "Please try again in …", when the message says it (never for `tooLarge`). */
  retryMs: number | null;
  /** "Request too large": this request was refused outright, not paced; wait a full window. */
  tooLarge: boolean;
};

/** Where the OTPM part of a message starts: Groq names the limit "output tokens per minute
 * (OTPM)"; either half is enough. The TPM wording ("tokens per minute (TPM)") never matches. */
const OTPM_AT = /output tokens per minute|\(OTPM\)/i;
const count = (label: string) => new RegExp(`\\b${label}:?\\s*(\\d[\\d,]*)`, 'i');
const LIMIT = count('Limit');
const USED = count('Used');
const REQUESTED = count('Requested');
const RETRY = /try again in\s*((?:\d+(?:\.\d+)?(?:h|ms|us|µs|ns|m|s))+)/i;
const TOO_LARGE = /request too large/i;

/**
 * The OTPM limit a provider's 429 message names, in either of Groq's wordings ("Rate limit
 * reached … Limit N, Used N, Requested N. Please try again in 11.34s" and "Request too large …
 * Limit N, Requested N"), or null when it names none. Fields are read independently, so their
 * order and a cut-off tail don't matter.
 */
export function readOutputLimit(message: string | undefined): OutputLimitSeen | null {
  const s = message ?? '';
  const at = s.search(OTPM_AT);
  if (at < 0) return null;
  const tail = s.slice(at);
  const num = (re: RegExp) => {
    const m = re.exec(tail);
    return m?.[1] === undefined ? null : Number(m[1].replace(/,/g, ''));
  };
  const limit = num(LIMIT);
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return null;
  const tooLarge = TOO_LARGE.test(s);
  const used = num(USED);
  const retry = tooLarge ? null : RETRY.exec(tail)?.[1];
  const retryMs = retry === undefined || retry === null ? null : parseGoDuration(retry);
  return {
    limit,
    used: tooLarge || used === null ? limit : used,
    requested: num(REQUESTED),
    retryMs: retryMs === null ? null : Math.round(retryMs) || null,
    tooLarge,
  };
}

/** How long until the key's output window is free again, after an OTPM 429: a refusal waits
 * the full window; a rate limit, as long as the message or `retry-after` said (at most a
 * window). The in-memory and database pacers both use it. */
export function outputFreeInMs(seen: OutputLimitSeen, retryAfterMs: number | null): number {
  if (seen.tooLarge) return OUTPUT_WINDOW_MS;
  return Math.min(seen.retryMs ?? retryAfterMs ?? OUTPUT_WINDOW_MS, OUTPUT_WINDOW_MS);
}

/**
 * The window after a call: a 429 naming the limit restarts it so that it ends when the provider
 * said to try again, or a full minute from now for a refusal (`outputFreeInMs`); otherwise the
 * call's output tokens are added (a new window when the last one has ended). Null while no limit
 * is known and nothing is counted yet.
 */
export function nextOutputWindow(
  win: OutputWindow | null,
  seen: {
    outputTokens: number | null;
    outputLimit: OutputLimitSeen | null;
    retryAfterMs?: number | null;
  },
  now: Date,
): OutputWindow | null {
  if (seen.outputLimit) {
    const freeIn = outputFreeInMs(seen.outputLimit, seen.retryAfterMs ?? null);
    return {
      limit: seen.outputLimit.limit,
      used: seen.outputLimit.used,
      windowStart: new Date(now.getTime() + freeIn - OUTPUT_WINDOW_MS),
    };
  }
  if (!win) return null;
  const tokens = Math.max(0, seen.outputTokens ?? 0);
  if (now.getTime() - win.windowStart.getTime() >= OUTPUT_WINDOW_MS) {
    return { limit: win.limit, used: tokens, windowStart: now };
  }
  return { ...win, used: win.used + tokens };
}

/** Whether a call expecting `expectedOutput` output tokens may go against the learned limit. */
export function waitForOutput(
  win: OutputWindow | null,
  expectedOutput: number,
  now: Date,
): PaceDecision {
  if (!win || win.limit === null) return { kind: 'go' };
  const ends = win.windowStart.getTime() + OUTPUT_WINDOW_MS;
  const ms = ends - now.getTime();
  if (ms <= 0 || win.used + Math.max(0, expectedOutput) <= win.limit) return { kind: 'go' };
  if (ms <= MAX_INLINE_WAIT_MS) return { kind: 'sleep', ms };
  return { kind: 'hold', until: new Date(ends) };
}
