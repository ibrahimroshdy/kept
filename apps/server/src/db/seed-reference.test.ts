import { ISO_CURRENCIES } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';
import { asOwner } from '../../test/tenancy.js';
import { seedReference } from './seed-reference.js';

// Task 4: the reference seed `kept migrate` runs (D136, D168). The template database was
// migrated (and so seeded) once; these tests re-run the seed as kept_owner.

const db = await testDb();

const snapshot = () =>
  asOwner(db, async (c) => {
    const { rows } = await c.query(
      `SELECT code, name, minor_units, symbol, enabled, xmin::text AS xmin
         FROM public.currencies ORDER BY code`,
    );
    return rows;
  });

describe('currencies', () => {
  it('holds every ISO currency, with only the five defaults enabled (D136)', async () => {
    const rows = await snapshot();
    expect(rows.map((r) => r.code)).toEqual(ISO_CURRENCIES.map((c) => c.code).sort());
    expect(rows.filter((r) => r.enabled).map((r) => [r.code, r.minor_units])).toEqual([
      ['CAD', 2],
      ['EGP', 2],
      ['EUR', 2],
      ['GBP', 2],
      ['USD', 2],
    ]);
    expect(rows.find((r) => r.code === 'JPY')).toMatchObject({ minor_units: 0, enabled: false });
    // The five keep the symbols 0004 chose: never a bare £ for EGP.
    expect(rows.find((r) => r.code === 'EGP')?.symbol).toBe('E£');
  });

  it('changes nothing on a second run', async () => {
    const before = await snapshot();
    await asOwner(db, (c) => seedReference(c));
    expect(await snapshot()).toEqual(before);
  });

  it("keeps an admin's enabled choice across a re-run", async () => {
    await asOwner(db, (c) =>
      c.query(`UPDATE public.currencies SET enabled = NOT enabled WHERE code IN ('JPY', 'CAD')`),
    );
    try {
      await asOwner(db, (c) => seedReference(c));
      const rows = await snapshot();
      expect(rows.find((r) => r.code === 'JPY')?.enabled).toBe(true);
      expect(rows.find((r) => r.code === 'CAD')?.enabled).toBe(false);
    } finally {
      await asOwner(db, (c) =>
        c.query(`UPDATE public.currencies SET enabled = NOT enabled WHERE code IN ('JPY', 'CAD')`),
      );
    }
  });
});
