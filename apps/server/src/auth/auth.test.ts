import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { testAuth } from '../../test/auth.js';
import { type TestDb, testDb } from '../../test/db.js';

// Spike S1 (V33): Better Auth on the Drizzle adapter, in schema `auth`, logged in as kept_auth,
// issuing UUIDv7 ids.

function uuidV7Millis(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

describe('Better Auth as kept_auth in schema auth', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await testDb();
    await db.reset();
  });

  it('signs up with email and password, storing a UUIDv7 user in auth.user', async () => {
    const auth = testAuth(db);
    const before = Date.now();
    const result = await auth.api.signUpEmail({
      body: { email: 'ada@example.com', password: 'correct horse battery', name: 'Ada' },
    });
    const after = Date.now();

    const id = result.user.id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const millis = uuidV7Millis(id);
    expect(millis).toBeGreaterThanOrEqual(before - 1000);
    expect(millis).toBeLessThanOrEqual(after + 1000);

    const { rows } = await db.pools.auth.query(
      'SELECT id, email, current_user AS role FROM auth."user" WHERE id = $1',
      [id],
    );
    expect(rows).toEqual([{ id, email: 'ada@example.com', role: 'kept_auth' }]);

    const sessions = await db.pools.auth.query('SELECT id FROM auth.session WHERE user_id = $1', [
      id,
    ]);
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('gives kept_auth nothing outside schema auth', async () => {
    const owner = new pg.Client({ connectionString: db.urls.owner });
    await owner.connect();
    try {
      await owner.query('CREATE TABLE IF NOT EXISTS public.s1_scratch (id int)');
    } finally {
      await owner.end();
    }
    await expect(db.pools.auth.query('SELECT * FROM public.s1_scratch')).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.pools.auth.query('SELECT * FROM pgboss.job')).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.pools.auth.query('SELECT * FROM kept_meta.migrations')).rejects.toThrow(
      /permission denied/,
    );
    // Nothing in schema kept either: not its functions, not its sequence.
    await expect(db.pools.auth.query('SELECT kept.current_user_id()')).rejects.toThrow(
      /permission denied for schema kept/,
    );
    await expect(db.pools.auth.query(`SELECT nextval('kept.change_seq')`)).rejects.toThrow(
      /permission denied for schema kept/,
    );
    // …and the request role can't read Better Auth's tables either.
    await expect(db.pools.app.query('SELECT * FROM auth.session')).rejects.toThrow(
      /permission denied/,
    );
  });
});
