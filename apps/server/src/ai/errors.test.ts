import { Writable } from 'node:stream';
import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../http/logger.js';
import { classifyError, providerErrorForLog } from './errors.js';

const now = new Date('2026-09-26T12:00:00Z');
const apiError = (
  statusCode: number,
  responseBody = '',
  responseHeaders: Record<string, string> = {},
) =>
  new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.example.test/v1/chat/completions',
    requestBodyValues: { messages: [{ content: 'PROMPT-MARKER data:image/jpeg;base64,/9j/AAAA' }] },
    statusCode,
    responseHeaders,
    responseBody,
    isRetryable: statusCode >= 500 || statusCode === 429,
  });

describe('classifyError', () => {
  it.each([
    [
      apiError(429, '', { 'retry-after': '7' }),
      'rate_limited',
      'http_429',
      { kind: 'rate_limited', retryAfterMs: 7000 },
    ],
    [
      apiError(429, '{"error":{"code":"credit_balance_exhausted"}}'),
      'rate_limited',
      'quota',
      { kind: 'quota', retryAfterMs: null },
    ],
    [
      apiError(429, '{"error":{"details":{"error_code":"enforced_spend_limit_reached"}}}'),
      'rate_limited',
      'quota',
      { kind: 'quota', retryAfterMs: null },
    ],
    [
      apiError(403, '{"error":{"message":"Key limit exceeded (total limit)"}}'),
      'rate_limited',
      'quota',
      { kind: 'quota', retryAfterMs: null },
    ],
    [apiError(402), 'rate_limited', 'quota', { kind: 'quota', retryAfterMs: null }],
    [
      apiError(
        429,
        '{"error":{"message":"Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1308."}}',
      ),
      'rate_limited',
      'http_429',
      { kind: 'rate_limited', retryAfterMs: null },
    ],
    [apiError(401), 'provider_error', 'auth', { kind: 'auth' }],
    [apiError(403, 'forbidden'), 'provider_error', 'auth', { kind: 'auth' }],
    [apiError(503), 'provider_error', 'http_5xx', { kind: 'transient' }],
    [apiError(200, '{"error":{}}'), 'provider_error', 'error_in_200', { kind: 'transient' }],
    [
      Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }),
      'timeout',
      'timeout',
      { kind: 'transient' },
    ],
    [new TypeError('fetch failed'), 'provider_error', 'network', { kind: 'transient' }],
  ])('%#', (err, outcome, errorCode, signal) => {
    expect(classifyError(err, now)).toMatchObject({ outcome, errorCode, signal });
  });
});

describe('classifyError: output-token limits', () => {
  it('reads the OTPM refusal from the body, as a full-window wait', () => {
    const c = classifyError(
      apiError(
        429,
        '{"error":{"message":"Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1308. The request\'s e"}}',
      ),
      now,
    );
    expect(c.outputLimit).toEqual({
      limit: 1000,
      used: 1000,
      requested: 1308,
      retryMs: null,
      tooLarge: true,
    });
    expect(c.pauses).toBe(true);
  });
});

describe('providerErrorForLog (never the request or response body)', () => {
  it('logs status, retryability, rate-limit headers and a scrubbed message only', () => {
    const e = apiError(429, 'BODY-MARKER', {
      'retry-after': '7',
      'x-ratelimit-remaining-tokens': '0',
      'set-cookie': 'x',
    });
    // Key-shaped values built at runtime, so no key-prefixed literal is committed.
    e.message = `Rate limited for key ${'gsk'}_ABCDEFGHIJKLMNOP and ${'sk-or'}-v1-0123456789abcdef`;
    const out = providerErrorForLog(e, null);
    expect(out).toEqual({
      type: 'APICallError',
      statusCode: 429,
      isRetryable: true,
      rateLimit: { 'retry-after': '7', 'x-ratelimit-remaining-tokens': '0' },
      message: 'Rate limited for key [redacted] and [redacted]',
    });
  });

  it("logs a 429's message in full, scrubbed of the key and the organisation id", () => {
    const secret = 'plain-secret-without-prefix-123';
    const tail = ` ${'x'.repeat(300)} END-OF-MESSAGE`;
    const e = apiError(429, 'BODY-MARKER');
    e.message = `Request too large for model \`qwen/qwen3.8-27b\` in organization \`org_01abcdefghijkl\` service tier \`on_demand\` on output tokens per minute (OTPM): Limit 1000, Requested 1308. key ${secret}${tail}`;
    const out = providerErrorForLog(e, secret);
    const message = out.message as string;
    expect(message).toContain('Limit 1000, Requested 1308');
    expect(message).toContain('END-OF-MESSAGE');
    expect(message).toContain('org_[redacted]');
    for (const needle of [secret, 'org_01abcdefghijkl', 'BODY-MARKER'])
      expect(JSON.stringify(out)).not.toContain(needle);
    // Any other status keeps the 200-character cut.
    const other = apiError(400);
    other.message = `Bad request${tail}`;
    expect((providerErrorForLog(other, null).message as string).length).toBe(200);
  });

  it('a key at the 200-character cut is redacted whole, not cut in half', () => {
    const secret = 'plain-secret-without-prefix-123';
    const e = apiError(400);
    e.message = `${'y'.repeat(190)}${secret}`;
    expect(providerErrorForLog(e, secret).message).toBe(`${'y'.repeat(190)}[redacted]`);
  });

  it('through pino: no prompt, image, body or key', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger({ KEPT_LOG_LEVEL: 'info', KEPT_LOG_FORMAT: 'json' }, sink);
    const secret = 'plain-secret-without-prefix-123';
    const e = apiError(401, `BODY-MARKER ${secret}`);
    e.message = `Invalid key ${secret}`;
    log.warn({ ai: providerErrorForLog(e, secret) }, 'AI call failed');
    const text = lines.join('');
    for (const needle of ['PROMPT-MARKER', 'base64', 'BODY-MARKER', secret])
      expect(text).not.toContain(needle);
    expect(text).toContain('"statusCode":401');
  });
});
