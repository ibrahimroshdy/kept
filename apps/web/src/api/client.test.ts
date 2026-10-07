import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, auditEventIds, written } from './client';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn(
    async () =>
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  );

afterEach(() => vi.unstubAllGlobals());

describe('the fetch wrapper', () => {
  it('sends same-origin JSON with cookies', async () => {
    const fetch = reply(200, { ok: true });
    vi.stubGlobal('fetch', fetch);
    await api.post('/api/v1/x', { a: 1 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/x');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it("maps Kept's {error, hint, code}", async () => {
    vi.stubGlobal('fetch', reply(409, { error: 'Taken', hint: 'Pick another', code: 'conflict' }));
    const err = (await api.get('/x').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'Taken',
      hint: 'Pick another',
    });
  });

  it("maps Better Auth's {message, code} by status, keeping its code", async () => {
    vi.stubGlobal('fetch', reply(401, { message: 'Invalid', code: 'INVALID_EMAIL_OR_PASSWORD' }));
    const err = (await api.post('/x').catch((e) => e)) as ApiError;
    expect(err).toMatchObject({ code: 'unauthenticated', authCode: 'INVALID_EMAIL_OR_PASSWORD' });
  });

  it('turns MFA_REQUIRED into mfa_required', async () => {
    vi.stubGlobal('fetch', reply(403, { message: 'x', code: 'MFA_REQUIRED' }));
    const err = (await api.get('/x').catch((e) => e)) as ApiError;
    expect(err.code).toBe('mfa_required');
  });

  it('reads Retry-After on a 429', async () => {
    vi.stubGlobal(
      'fetch',
      reply(429, { message: 'slow', code: 'SIGN_IN_DELAYED' }, { 'x-retry-after': '30' }),
    );
    const err = (await api.get('/x').catch((e) => e)) as ApiError;
    expect(err).toMatchObject({ code: 'rate_limited', retryAfter: 30 });
  });

  it('a non-JSON failure still becomes an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })),
    );
    const err = (await api.get('/x').catch((e) => e)) as ApiError;
    expect(err).toMatchObject({ status: 502, code: 'internal' });
  });

  it('a network failure is offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = (await api.get('/x').catch((e) => e)) as ApiError;
    expect(err).toMatchObject({ status: 0, code: 'offline' });
  });

  it('204 is undefined', async () => {
    vi.stubGlobal('fetch', reply(204, null));
    expect(await api.del('/x')).toBeUndefined();
  });

  it("keeps a Kept error's extra fields as details (a 412's conflicts, D156)", async () => {
    vi.stubGlobal(
      'fetch',
      reply(412, {
        error: 'This changed since you opened it.',
        code: 'precondition_failed',
        conflicts: ['name'],
        row_version: 4,
        changedBy: { displayName: 'Alfred' },
      }),
    );
    const err = (await api.patch('/x', { name: 'a' }).catch((e) => e)) as ApiError;
    expect(err.code).toBe('precondition_failed');
    expect(err.details).toEqual({
      conflicts: ['name'],
      row_version: 4,
      changedBy: { displayName: 'Alfred' },
    });
  });

  it('keeps a server code the client does not know yet as serverCode', async () => {
    vi.stubGlobal('fetch', reply(409, { error: 'Choose', code: 'some_future_code', counts: {} }));
    const err = (await api.post('/x').catch((e) => e)) as ApiError;
    expect(err).toMatchObject({ code: 'conflict', serverCode: 'some_future_code' });
    expect(err.details).toEqual({ counts: {} });
  });

  it('DELETE can carry a body, and If-Match goes on any write', async () => {
    const fetch = reply(204, null);
    vi.stubGlobal('fetch', fetch);
    await api.del('/x', { reason: 'wrong file' });
    await api.post('/y', {}, { 'if-match': '3' });
    const [, del] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(del.body).toBe('{"reason":"wrong file"}');
    const [, post] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect((post.headers as Record<string, string>)['if-match']).toBe('3');
  });
});

describe('X-Kept-Audit-Event (D150, §7.7)', () => {
  it('splits one id, several for a bulk move, or none', () => {
    expect(auditEventIds('a1')).toEqual(['a1']);
    expect(auditEventIds('a1, b2, c3')).toEqual(['a1', 'b2', 'c3']);
    expect(auditEventIds(null)).toEqual([]);
    expect(auditEventIds('')).toEqual([]);
  });

  it('a write hands back its body and the events it recorded', async () => {
    vi.stubGlobal('fetch', reply(200, { moved: ['t1', 't2'] }, { 'x-kept-audit-event': 'e1, e2' }));
    await expect(written.post('/api/v1/things/move', {})).resolves.toEqual({
      body: { moved: ['t1', 't2'] },
      auditEvents: ['e1', 'e2'],
    });
    vi.stubGlobal('fetch', reply(200, { id: 'p1' }));
    await expect(written.patch('/api/v1/places/p1', {})).resolves.toEqual({
      body: { id: 'p1' },
      auditEvents: [],
    });
  });
});
