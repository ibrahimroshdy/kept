import { describe, expect, it } from 'vitest';
import { CLOSED, clearAuth, FOREVER, nextBreaker, trippedAt } from './breaker.js';

const t0 = new Date('2026-09-26T12:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);

describe('the breaker (L45)', () => {
  it('trips on the first 429 until retry-after, else 60 s', () => {
    const a = nextBreaker(CLOSED, { kind: 'rate_limited', retryAfterMs: 7000 }, t0);
    expect(trippedAt(a, at(6))).toEqual({ reason: 'rate_limited', until: at(7) });
    expect(trippedAt(a, at(7))).toBeNull();
    const b = nextBreaker(CLOSED, { kind: 'quota', retryAfterMs: null }, t0);
    expect(trippedAt(b, t0)).toEqual({ reason: 'quota', until: at(60) });
  });

  it('doubles each consecutive trip up to an hour, and a success resets the count', () => {
    let s = CLOSED;
    const untils: number[] = [];
    for (let i = 0; i < 8; i++) {
      s = nextBreaker(s, { kind: 'rate_limited', retryAfterMs: null }, t0);
      untils.push(((s.until as Date).getTime() - t0.getTime()) / 1000);
    }
    expect(untils).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600]);
    s = nextBreaker(s, { kind: 'ok' }, t0);
    s = nextBreaker(s, { kind: 'rate_limited', retryAfterMs: null }, t0);
    expect(trippedAt(s, t0)?.until).toEqual(at(60));
  });

  it('holds a rejected key until it is replaced', () => {
    const s = nextBreaker(CLOSED, { kind: 'auth' }, t0);
    expect(trippedAt(s, at(10 ** 8))).toEqual({ reason: 'auth', until: FOREVER });
    expect(trippedAt(clearAuth(s), t0)).toBeNull();
    const rl = nextBreaker(CLOSED, { kind: 'rate_limited', retryAfterMs: 1000 }, t0);
    expect(clearAuth(rl)).toBe(rl);
  });

  it('marks the provider down after three transient failures within 5 minutes', () => {
    let s = nextBreaker(CLOSED, { kind: 'transient' }, t0);
    s = nextBreaker(s, { kind: 'transient' }, at(100));
    expect(trippedAt(s, at(100))).toBeNull();
    s = nextBreaker(s, { kind: 'transient' }, at(200));
    expect(trippedAt(s, at(200))).toEqual({ reason: 'provider_down', until: at(500) });
  });

  it('forgets transient failures older than 5 minutes', () => {
    let s = nextBreaker(CLOSED, { kind: 'transient' }, t0);
    s = nextBreaker(s, { kind: 'transient' }, at(100));
    s = nextBreaker(s, { kind: 'transient' }, at(301));
    expect(trippedAt(s, at(301))).toBeNull();
  });
});
