import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { asOwner } from '../../test/tenancy.js';

// Task 4: kept.touch_row() with cache columns (engineering spec §7.9, D183, plan Q1). A temporary
// table in a rolled-back owner transaction, so nothing is left behind.

const db = await testDb();

type Row = { row_version: number; change_seq: string; updated_at: Date };

async function withProbe(args: string, fn: (c: pg.ClientBase) => Promise<void>) {
  await asOwner(db, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(
        `CREATE TEMP TABLE probe (id int PRIMARY KEY, name text, quiet_col text, seq_col text,
           updated_at timestamptz NOT NULL DEFAULT now(), row_version int NOT NULL DEFAULT 1,
           change_seq bigint)`,
      );
      await c.query(
        `CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON probe
           FOR EACH ROW EXECUTE FUNCTION kept.touch_row(${args})`,
      );
      await c.query(`INSERT INTO probe (id, name) VALUES (1, 'a')`);
      // Back-date, so an updated_at bump is visible within the transaction's now().
      await c.query(`ALTER TABLE probe DISABLE TRIGGER touch_row`);
      await c.query(`UPDATE probe SET updated_at = now() - interval '1 day'`);
      await c.query(`ALTER TABLE probe ENABLE TRIGGER touch_row`);
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

async function read(c: pg.ClientBase): Promise<Row> {
  const { rows } = await c.query<Row>('SELECT row_version, change_seq, updated_at FROM probe');
  return rows[0] as Row;
}

describe('kept.touch_row() with quiet and sequence columns', () => {
  it('changes neither row_version nor change_seq when only a quiet column changes', async () => {
    await withProbe(`'quiet_col', 'seq_col'`, async (c) => {
      const before = await read(c);
      await c.query(`UPDATE probe SET quiet_col = 'x'`);
      expect(await read(c)).toEqual(before);
    });
  });

  it('bumps change_seq only when a sequence column changes', async () => {
    await withProbe(`'quiet_col', 'seq_col'`, async (c) => {
      const before = await read(c);
      await c.query(`UPDATE probe SET seq_col = 'x', quiet_col = 'y'`);
      const after = await read(c);
      expect(after.row_version).toBe(before.row_version);
      expect(after.updated_at).toEqual(before.updated_at);
      expect(BigInt(after.change_seq)).toBeGreaterThan(BigInt(before.change_seq));
    });
  });

  it('bumps all three when anything else changes', async () => {
    await withProbe(`'quiet_col', 'seq_col'`, async (c) => {
      const before = await read(c);
      await c.query(`UPDATE probe SET name = 'b', quiet_col = 'z'`);
      const after = await read(c);
      expect(after.row_version).toBe(before.row_version + 1);
      expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
      expect(BigInt(after.change_seq)).toBeGreaterThan(BigInt(before.change_seq));
    });
  });

  it('takes several columns per argument', async () => {
    await withProbe(`'quiet_col,name'`, async (c) => {
      const before = await read(c);
      await c.query(`UPDATE probe SET name = 'b', quiet_col = 'z'`);
      expect(await read(c)).toEqual(before);
      await c.query(`UPDATE probe SET seq_col = 'q'`);
      expect((await read(c)).row_version).toBe(before.row_version + 1);
    });
  });

  it('without arguments bumps on every UPDATE, as before', async () => {
    await withProbe('', async (c) => {
      const before = await read(c);
      await c.query(`UPDATE probe SET quiet_col = 'x'`);
      const once = await read(c);
      expect(once.row_version).toBe(before.row_version + 1);
      await c.query(`UPDATE probe SET name = name`);
      const twice = await read(c);
      expect(twice.row_version).toBe(before.row_version + 2);
      expect(BigInt(twice.change_seq)).toBeGreaterThan(BigInt(once.change_seq));
    });
  });

  it('stamps change_seq on insert, with or without arguments', async () => {
    await withProbe(`'quiet_col', 'seq_col'`, async (c) => {
      expect((await read(c)).change_seq).not.toBeNull();
    });
  });

  it("bumps row_version for a bookkeeping-only write when the transaction asks (kept.touch = 'force')", async () => {
    await withProbe(`'quiet_col', 'seq_col'`, async (c) => {
      const before = await read(c);
      await c.query(`UPDATE probe SET updated_at = now()`);
      expect((await read(c)).row_version).toBe(before.row_version);
      await c.query(`SELECT set_config('kept.touch', 'force', true)`);
      await c.query(`UPDATE probe SET updated_at = now()`);
      await c.query(`SELECT set_config('kept.touch', '', true)`);
      expect((await read(c)).row_version).toBe(before.row_version + 1);
      await c.query(`UPDATE probe SET quiet_col = 'z'`);
      expect((await read(c)).row_version).toBe(before.row_version + 1);
    });
  });
});
