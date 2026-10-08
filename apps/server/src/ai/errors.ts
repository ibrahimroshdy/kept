/**
 * What a failed model call means (D206's outcome table, plan T8 step 5) and what of it may be
 * logged. **Never log an `APICallError` whole** (spike): `requestBodyValues` is the whole
 * request body, the prompt and the base64 image, and `responseBody` can echo the request or an
 * account id. The ledger stores none of it; pino gets the status, retryability, the rate-limit
 * headers and a trimmed, scrubbed message.
 */
import type { LedgerOutcome } from '@kept/shared';
import { APICallError, NoObjectGeneratedError } from 'ai';
import type { BreakerSignal } from './breaker.js';
import { header, parseRetryAfter, readOutputLimit } from './pacing.js';

export type Classified = {
  outcome: LedgerOutcome;
  errorCode: string;
  httpStatus: number | null;
  retryable: boolean;
  /** For the breaker. `ok`: the provider worked, the answer didn't. */
  signal: BreakerSignal;
  /** The call should pause for the provider (a trip), not fail. */
  pauses: boolean;
  headers: Record<string, string> | undefined;
  /** An output-token (OTPM) limit a 429 named (pacing.ts readOutputLimit). */
  outputLimit?: ReturnType<typeof readOutputLimit>;
  retryAfterMs?: number | null;
};

/**
 * Quota and spend-limit markers in an error body, from each provider's error reference:
 * OpenAI's 429 codes (`insufficient_quota` type; `credit_balance_exhausted`,
 * `*_spend_limit_exceeded`, `organization_usage_limit_exceeded`), Anthropic's spend cap
 * (`enforced_spend_limit_reached`) and its self-set limit (400, "reached your specified …
 * usage limits"), and OpenRouter's key credit limit (403 "Key limit exceeded", spike §2).
 */
const QUOTA =
  /insufficient_quota|credit_balance_exhausted|spend_limit_exceeded|usage_limit_exceeded|enforced_spend_limit_reached|reached your specified (?:workspace )?api usage limits|key limit exceeded/i;

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export function classifyError(e: unknown, now: Date): Classified {
  if (NoObjectGeneratedError.isInstance(e)) {
    const base = {
      httpStatus: null,
      retryable: false,
      signal: { kind: 'ok' } as const,
      pauses: false,
      headers: undefined,
    };
    if (e.finishReason === 'length') return { ...base, outcome: 'truncated', errorCode: 'length' };
    if (e.finishReason === 'content-filter')
      return { ...base, outcome: 'refused', errorCode: 'content_filter' };
    const cause = (e.cause as { name?: string } | undefined)?.name;
    return {
      ...base,
      outcome: 'schema_invalid',
      errorCode: cause === 'AI_JSONParseError' ? 'invalid_json' : 'schema',
    };
  }
  if (APICallError.isInstance(e)) {
    const status = e.statusCode ?? null;
    const headers = e.responseHeaders;
    const body = e.responseBody ?? '';
    const retryAfterMs = parseRetryAfter(header(headers, 'retry-after'), now);
    const quota =
      status !== null &&
      [400, 402, 403, 429].includes(status) &&
      QUOTA.test(`${body} ${e.message}`);
    if (quota || status === 402) {
      return {
        outcome: 'rate_limited',
        errorCode: 'quota',
        httpStatus: status,
        retryable: true,
        signal: { kind: 'quota', retryAfterMs },
        pauses: true,
        headers,
      };
    }
    if (status === 429) {
      return {
        outcome: 'rate_limited',
        errorCode: 'http_429',
        httpStatus: status,
        retryable: true,
        signal: { kind: 'rate_limited', retryAfterMs },
        pauses: true,
        headers,
        outputLimit: readOutputLimit(`${body} ${e.message}`),
        retryAfterMs,
      };
    }
    if (status === 413) {
      // The request itself is over what the plan allows at once: Groq answers 413 "Request too
      // large … on tokens per minute (TPM): Limit 8000, Requested 9571" (the maintainer's
      // instance, 2026-10-07). Asking again sends the same request, so it fails with a reason
      // the person can act on: a model or plan with a higher limit.
      return {
        outcome: 'provider_error',
        errorCode: 'too_large',
        httpStatus: status,
        retryable: false,
        signal: { kind: 'ok' },
        pauses: false,
        headers,
      };
    }
    if (status === 401 || status === 403) {
      return {
        outcome: 'provider_error',
        errorCode: 'auth',
        httpStatus: status,
        retryable: false,
        signal: { kind: 'auth' },
        pauses: true,
        headers,
      };
    }
    if (status === null || status >= 500) {
      return {
        outcome: 'provider_error',
        errorCode: status === null ? 'network' : 'http_5xx',
        httpStatus: status,
        retryable: true,
        signal: { kind: 'transient' },
        pauses: false,
        headers,
      };
    }
    if (status < 400) {
      // An error inside an HTTP 200 (OpenRouter, spike finding 7): retryable.
      return {
        outcome: 'provider_error',
        errorCode: 'error_in_200',
        httpStatus: status,
        retryable: true,
        signal: { kind: 'transient' },
        pauses: false,
        headers,
      };
    }
    return {
      outcome: 'provider_error',
      errorCode: 'http_4xx',
      httpStatus: status,
      retryable: false,
      signal: { kind: 'ok' },
      pauses: false,
      headers,
    };
  }
  if (isTimeout(e)) {
    return {
      outcome: 'timeout',
      errorCode: 'timeout',
      httpStatus: null,
      retryable: true,
      signal: { kind: 'transient' },
      pauses: false,
      headers: undefined,
    };
  }
  return {
    outcome: 'provider_error',
    errorCode: 'network',
    httpStatus: null,
    retryable: true,
    signal: { kind: 'transient' },
    pauses: false,
    headers: undefined,
  };
}

/** Anything shaped like a provider key, whatever the provider (D202's prefixes and bearer-ish
 * tokens), so a message that echoes one never reaches the log. */
const KEYISH =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gsk[_][A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/g;

/** A provider organisation or account id in a message (Groq's `org_…`). */
const ORG_ID = /\borg_[A-Za-z0-9]{6,}/g;

/** How much of a provider's message is logged: 200 characters, but a 429's in full (up to this
 * guard), because its end says which limit and how long (Groq's OTPM refusal, pacing.ts). */
const MESSAGE_CHARS = 200;
const RATE_LIMIT_MESSAGE_CHARS = 2000;

/** The fields of a provider error that may be logged: never the request or response body. */
export function providerErrorForLog(e: unknown, secret?: string | null): Record<string, unknown> {
  const scrub = (s: string, max = MESSAGE_CHARS) => {
    // The key is removed before the cut, so a cut can't leave part of it behind.
    let out = secret ? s.split(secret).join('[redacted]') : s;
    out = out.replace(KEYISH, '[redacted]').replace(ORG_ID, 'org_[redacted]');
    return out.slice(0, max);
  };
  if (APICallError.isInstance(e)) {
    const h = e.responseHeaders ?? {};
    const rate = Object.fromEntries(
      Object.entries(h).filter(([k]) => /ratelimit|retry-after/i.test(k)),
    );
    return {
      type: 'APICallError',
      statusCode: e.statusCode ?? null,
      isRetryable: e.isRetryable,
      rateLimit: rate,
      message: scrub(e.message, e.statusCode === 429 ? RATE_LIMIT_MESSAGE_CHARS : MESSAGE_CHARS),
    };
  }
  if (NoObjectGeneratedError.isInstance(e)) {
    return { type: 'NoObjectGeneratedError', finishReason: e.finishReason ?? null };
  }
  const name = (e as { name?: unknown })?.name;
  const message = (e as { message?: unknown })?.message;
  return {
    type: typeof name === 'string' ? name : 'Error',
    message: typeof message === 'string' ? scrub(message) : null,
  };
}
