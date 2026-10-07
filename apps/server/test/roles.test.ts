import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const client = new pg.Client({
  connectionString: 'postgres://postgres:postgres@localhost:5452/kept',
});

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe('dev roles and extensions', () => {
  it.each(['kept_owner', 'kept_app', 'kept_auth', 'kept_system'])(
    '%s exists, is not super, cannot create roles and cannot bypass RLS',
    async (role) => {
      const { rows } = await client.query(
        'SELECT rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [role],
      );
      expect(rows).toEqual([{ rolsuper: false, rolcreaterole: false, rolbypassrls: false }]);
    },
  );

  it.each(['pg_trgm', 'unaccent', 'vector'])('extension %s is installed', async (ext) => {
    const { rows } = await client.query('SELECT 1 FROM pg_extension WHERE extname = $1', [ext]);
    expect(rows).toHaveLength(1);
  });
});

describe('kept_app role defaults (review, minor)', () => {
  it('has a statement timeout and an idle-in-transaction timeout', async () => {
    const { rows } = await client.query<{ config: string[] | null }>(
      `SELECT rolconfig AS config FROM pg_roles WHERE rolname = 'kept_app'`,
    );
    expect([...(rows[0]?.config ?? [])].sort()).toEqual([
      'idle_in_transaction_session_timeout=30s',
      'statement_timeout=15s',
    ]);
  });
});
