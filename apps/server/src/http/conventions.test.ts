import { newId } from '@kept/shared';
import { v7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { asOwner, seedTenant, type Tenant } from '../../test/tenancy.js';
import { withScope } from '../db/scope.js';
import {
  assertClientId,
  checkVersion,
  decodeCursor,
  encodeCursor,
  hashRequest,
  pageOf,
  paginate,
  requireIfMatch,
  withIdempotency,
} from './conventions.js';
import { AppError, toErrorReply } from './errors.js';

// Task 16: API conventions (engineering spec §7.7; D156, D178).

const db = await testDb();

function thrown(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError');
}

describe('If-Match and row versions (D156)', () => {
  it.each([
    ['3', 3],
    ['"3"', 3],
    ['W/"12"', 12],
  ])('reads %s as %i', (header, version) => {
    expect(requireIfMatch({ headers: { 'if-match': header } })).toBe(version);
  });

  it('refuses a write without If-Match with 428 precondition_failed', () => {
    const err = thrown(() => requireIfMatch({ headers: {} }));
    expect([err.status, err.code]).toEqual([428, 'precondition_failed']);
  });

  it('refuses a malformed If-Match with 400 validation', () => {
    const err = thrown(() => requireIfMatch({ headers: { 'if-match': '*' } }));
    expect([err.status, err.code]).toEqual([400, 'validation']);
  });

  it('checkVersion() passes a match and 412s a mismatch with the conflicting fields', () => {
    expect(() => checkVersion({ rowVersion: 4 }, 4, ['name'])).not.toThrow();
    const err = thrown(() => checkVersion({ rowVersion: 5 }, 4, ['name', 'timezone']));
    expect(toErrorReply(err)).toEqual({
      status: 412,
      body: {
        error: 'This changed since you opened it.',
        hint: 'Reload to see the latest version.',
        code: 'precondition_failed',
        conflicts: ['name', 'timezone'],
        row_version: 5,
      },
    });
  });

  it('checkVersion() names who changed it when the caller knows (step 2, T26)', () => {
    const err = thrown(() =>
      checkVersion({ rowVersion: 7 }, 6, ['name'], { displayName: 'Bruce' }),
    );
    expect(toErrorReply(err).body).toMatchObject({
      conflicts: ['name'],
      row_version: 7,
      changedBy: { displayName: 'Bruce' },
    });
    const unknown = thrown(() => checkVersion({ rowVersion: 7 }, 6, [], null));
    expect(toErrorReply(unknown).body).not.toHaveProperty('changedBy');
  });
});

describe('pagination', () => {
  it('defaults to 20 per page and allows at most 200', () => {
    expect(paginate({})).toEqual({ limit: 20, after: null });
    expect(paginate({ limit: '200' }).limit).toBe(200);
    expect(thrown(() => paginate({ limit: '201' })).code).toBe('validation');
    expect(thrown(() => paginate({ limit: '0' })).code).toBe('validation');
  });

  it('round-trips an opaque base64url cursor {k: lastKey}', () => {
    const key = ['2026-09-01T00:00:00.000Z', newId()];
    const cursor = encodeCursor(key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toEqual({ k: key });
    expect(paginate({ cursor }).after).toEqual(key);
  });

  it('refuses a garbled cursor as validation', () => {
    expect(thrown(() => decodeCursor('not-a-cursor')).code).toBe('validation');
    expect(thrown(() => paginate({ cursor: encodeCursor(1).slice(2) })).code).toBe('validation');
  });

  it('pageOf() cuts the lookahead row and points the cursor at the last item', () => {
    const rows = [1, 2, 3].map((n) => ({ n }));
    expect(pageOf(rows, 2, (r) => r.n)).toEqual({
      items: [{ n: 1 }, { n: 2 }],
      next_cursor: encodeCursor(2),
    });
    expect(pageOf(rows, 3, (r) => r.n)).toEqual({ items: rows, next_cursor: null });
  });
});

describe('assertClientId() (§7.7)', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const at = (offsetDays: number) => v7({ msecs: now + offsetDays * 86_400_000 });

  it('accepts a UUIDv7 within 7 days either side', () => {
    for (const d of [-7, -1, 0, 1, 7]) {
      const id = at(d);
      expect(assertClientId(id.toUpperCase(), now)).toBe(id);
    }
  });

  it('refuses ids outside the window, other versions and junk with id_out_of_window', () => {
    for (const id of [at(-8), at(8), '0b3c1e5e-2a9f-4d7a-9c1b-2f5e6d7c8b9a', 'x']) {
      const err = thrown(() => assertClientId(id, now));
      expect([err.status, err.code]).toEqual([400, 'id_out_of_window']);
    }
  });
});

describe('withIdempotency()', () => {
  let t: Tenant;

  beforeEach(async () => {
    await db.reset();
    t = await seedTenant(db, 'idem');
  });

  const run = (key: string, hash: string, fn: () => Promise<{ status: number; body: unknown }>) =>
    withScope(db.pools.app, { userId: t.userId, mfa: false }, (tx) =>
      withIdempotency(tx, t.userId, key, hash, fn),
    );

  it('runs once and replays the stored response for a repeat', async () => {
    let calls = 0;
    const fn = async () => ({ status: 201, body: { id: `n${++calls}` } });
    const hash = hashRequest('POST', '/api/v1/x', { a: 1 });
    expect(await run('k1', hash, fn)).toEqual({ status: 201, body: { id: 'n1' }, replayed: false });
    expect(await run('k1', hash, fn)).toEqual({ status: 201, body: { id: 'n1' }, replayed: true });
    expect(calls).toBe(1);
  });

  it('refuses a repeat with a different request as 409 idempotency_mismatch', async () => {
    const fn = async () => ({ status: 200, body: {} });
    await run('k2', hashRequest('POST', '/a', { a: 1 }), fn);
    const err = await run('k2', hashRequest('POST', '/a', { a: 2 }), fn).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect([err.status, err.code]).toEqual([409, 'idempotency_mismatch']);
  });

  it('forgets the key when the work fails, so a retry runs afresh', async () => {
    const hash = hashRequest('POST', '/a', null);
    await expect(
      run('k3', hash, async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const again = await run('k3', hash, async () => ({ status: 200, body: { ok: true } }));
    expect(again.replayed).toBe(false);
  });

  it('keys per user: the same key from another user is a different request', async () => {
    const other = await seedTenant(db, 'idem-other');
    const hash = hashRequest('POST', '/a', null);
    await run('shared', hash, async () => ({ status: 200, body: { who: 'a' } }));
    const b = await withScope(db.pools.app, { userId: other.userId, mfa: false }, (tx) =>
      withIdempotency(tx, other.userId, 'shared', hash, async () => ({
        status: 200,
        body: { who: 'b' },
      })),
    );
    expect(b).toEqual({ status: 200, body: { who: 'b' }, replayed: false });
    const { rows } = await asOwner(db, (c) =>
      c.query(`SELECT count(*)::int AS n FROM public.idempotency_keys WHERE key = 'shared'`),
    );
    expect(rows[0].n).toBe(2);
  });

  it('refuses a malformed key', async () => {
    const err = await run('', 'h', async () => ({ status: 200, body: {} })).catch((e) => e);
    expect(err.code).toBe('validation');
  });
});
