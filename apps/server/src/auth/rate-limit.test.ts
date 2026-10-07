import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_URL, requestHeaders, signUp, testAuth } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';
import { AUTH_BASE_PATH } from './auth.js';
import { authRequestHeaders } from './client-ip.js';
import { delayAfter, FREE_FAILURES, MAX_DELAY_SECONDS, MAX_FAILURES } from './sign-in-limiter.js';

// Spike S2 (V32): a database-backed rate limiter shared by two processes. Two Better Auth
// instances on one database stand in for two replicas.

const PASSWORD = 'correct horse battery';

function uniqueIp(): string {
  const n = Math.floor(Math.random() * 250) + 1;
  const m = Math.floor(Math.random() * 250) + 1;
  return `198.51.${n}.${m}`;
}

describe('delayAfter', () => {
  it('is free up to the allowance, then doubles to a cap', () => {
    expect(delayAfter(0)).toBe(0);
    expect(delayAfter(FREE_FAILURES)).toBe(0);
    expect(delayAfter(FREE_FAILURES + 1)).toBe(2);
    expect(delayAfter(FREE_FAILURES + 2)).toBe(4);
    expect(delayAfter(FREE_FAILURES + 3)).toBe(8);
    expect(delayAfter(MAX_FAILURES)).toBe(MAX_DELAY_SECONDS);
  });
});

/** A sign-in request as the Fastify mount will build it: the client address comes from the
 * socket (`remoteAddress`), never from what the client wrote in X-Forwarded-For. */
function signInRequest(
  email: string,
  remoteAddress: string,
  headers: Record<string, string> = {},
  trustedProxies: string[] = [],
): Request {
  return new Request(`${PUBLIC_URL}${AUTH_BASE_PATH}/sign-in/email`, {
    method: 'POST',
    headers: authRequestHeaders({
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL, ...headers },
      remoteAddress,
      trustedProxies,
    }),
    body: JSON.stringify({ email, password: 'wrong password' }),
  });
}

describe('sign-in rate limits across two instances', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await testDb();
    await db.reset();
  });

  it('per IP (Better Auth, storage: database): 6 sign-ins split across two instances hit 5/min', async () => {
    const a = testAuth(db);
    const b = testAuth(db);
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const instance = i % 2 === 0 ? a : b;
      // A different account each time, so only the IP limit can be what stops the sixth.
      const res = await instance.handler(signInRequest(`nobody-${i}@example.com`, ip));
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);

    const { rows } = await db.pools.auth.query(
      'SELECT key, count FROM auth.rate_limit WHERE key LIKE $1',
      [`${ip}|%`],
    );
    expect(rows).toEqual([{ key: `${ip}|/sign-in/email`, count: 5 }]);
  });

  it('per IP: a forged X-Forwarded-For does not move a client out of its socket bucket', async () => {
    const a = testAuth(db);
    const socket = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await a.handler(
        signInRequest(`nobody-${i}@example.com`, socket, { 'x-forwarded-for': uniqueIp() }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('per IP behind a trusted proxy: each client gets its own bucket', async () => {
    const a = testAuth(db);
    const proxy = '10.1.2.3';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await a.handler(
        signInRequest(`nobody-${i}@example.com`, proxy, { 'x-forwarded-for': uniqueIp() }, [
          '10.0.0.0/8',
        ]),
      );
      statuses.push(res.status);
    }
    // Six different clients behind one proxy: none is limited by the others.
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401]);
  });

  describe('per account and IP (Kept, auth.sign_in_failures)', () => {
    it('refuses a password sign-in with no client address instead of sharing a bucket', async () => {
      const a = testAuth(db);
      const email = `n-${randomUUID()}@example.com`;
      await signUp(a, email, PASSWORD);
      await expect(
        a.api.signInEmail({
          body: { email, password: PASSWORD },
          headers: new Headers({ origin: PUBLIC_URL, 'x-forwarded-for': '203.0.113.5' }),
        }),
      ).rejects.toMatchObject({ statusCode: 400, body: { code: 'CLIENT_IP_UNKNOWN' } });
    });

    it('30 parallel wrong passwords never get more than the free attempts', async () => {
      const a = testAuth(db);
      const email = `p-${randomUUID()}@example.com`;
      await signUp(a, email, PASSWORD);
      const ip = uniqueIp();
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, () =>
          a.api.signInEmail({
            body: { email, password: 'wrong password' },
            headers: requestHeaders('', ip),
          }),
        ),
      );
      const statuses = results.map((r) =>
        r.status === 'rejected' ? (r.reason as { statusCode: number }).statusCode : 200,
      );
      expect(statuses.filter((s) => s === 401)).toHaveLength(FREE_FAILURES + 1);
      expect(statuses.filter((s) => s === 429)).toHaveLength(30 - (FREE_FAILURES + 1));
      const { rows } = await db.pools.auth.query('SELECT count FROM auth.sign_in_failures');
      expect(rows).toEqual([{ count: FREE_FAILURES + 1 }]);
    });

    it('delays progressively instead of locking out, and only for that account and IP', async () => {
      // auth.api calls skip Better Auth's per-IP limiter (it runs in the HTTP router), which
      // isolates Kept's account + IP limiter.
      const a = testAuth(db);
      const b = testAuth(db);
      const email = `r-${randomUUID()}@example.com`;
      await signUp(a, email, PASSWORD);
      const ip = uniqueIp();
      const attempt = (instance: typeof a, password: string, from = ip) =>
        instance.api.signInEmail({ body: { email, password }, headers: requestHeaders('', from) });

      for (let i = 0; i < FREE_FAILURES + 1; i++) {
        await expect(attempt(i % 2 === 0 ? a : b, 'wrong password')).rejects.toMatchObject({
          statusCode: 401,
        });
      }
      // Five failures: the next attempt from this IP, even with the right password, waits 2 s,
      // on either instance.
      await expect(attempt(b, PASSWORD)).rejects.toMatchObject({
        statusCode: 429,
        body: { code: 'SIGN_IN_DELAYED', retryAfter: 2 },
      });
      await expect(attempt(a, PASSWORD)).rejects.toMatchObject({ statusCode: 429 });

      // Someone else's failures don't lock the owner out from their own address.
      await expect(attempt(a, PASSWORD, uniqueIp())).resolves.toMatchObject({
        user: { email },
      });

      // Once the delay has passed, the right password works and clears the counter.
      const owner = new pg.Client({ connectionString: db.urls.owner });
      await owner.connect();
      try {
        await owner.query(
          `UPDATE auth.sign_in_failures SET last_failure_at = now() - interval '10 minutes'`,
        );
        await expect(attempt(b, PASSWORD)).resolves.toMatchObject({ user: { email } });
        const left = await owner.query('SELECT count(*)::int AS n FROM auth.sign_in_failures');
        expect(left.rows[0].n).toBe(0);
      } finally {
        await owner.end();
      }
    });

    it('stops at 20 failures an hour until the window ends', async () => {
      const a = testAuth(db);
      const email = `w-${randomUUID()}@example.com`;
      await signUp(a, email, PASSWORD);
      const ip = uniqueIp();
      await expect(
        a.api.signInEmail({ body: { email, password: 'wrong' }, headers: requestHeaders('', ip) }),
      ).rejects.toMatchObject({ statusCode: 401 });

      const owner = new pg.Client({ connectionString: db.urls.owner });
      await owner.connect();
      try {
        await owner.query(
          `UPDATE auth.sign_in_failures
              SET count = $1, window_start = now() - interval '50 minutes',
                  last_failure_at = now() - interval '30 minutes'`,
          [MAX_FAILURES],
        );
        const blocked = a.api.signInEmail({
          body: { email, password: PASSWORD },
          headers: requestHeaders('', ip),
        });
        await expect(blocked).rejects.toMatchObject({ statusCode: 429 });
        const retryAfter = await blocked.catch(
          (e: { body: { retryAfter: number } }) => e.body.retryAfter,
        );
        expect(retryAfter).toBeGreaterThan(9 * 60);
        expect(retryAfter).toBeLessThanOrEqual(10 * 60);

        // A lapsed window starts over.
        await owner.query(
          `UPDATE auth.sign_in_failures SET window_start = now() - interval '2 hours'`,
        );
        await expect(
          a.api.signInEmail({
            body: { email, password: PASSWORD },
            headers: requestHeaders('', ip),
          }),
        ).resolves.toMatchObject({ user: { email } });
      } finally {
        await owner.end();
      }
    });
  });
});
