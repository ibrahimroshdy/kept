import { normalize, stripPrefixes } from '@kept/shared';
import vectors from '@kept/shared/normalize.vectors.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/db.js';

// Task 4: kept.normalize() / kept.strip_prefixes() against the shared vectors (D42, V20). The
// JavaScript twin (packages/shared) is tested against the same file; a disagreement is fixed in
// the twin, never in the vector.

const db = await testDb();

type Vector = { in: string; normalized: string; stripped: string; note?: string };
const VECTORS = vectors as Vector[];

/** Every vector through SQL at once, as kept_app (the functions are invoker and need no scope). */
async function sqlForms(inputs: string[]) {
  const { rows } = await db.pools.app.query<{ n: string; s: string }>(
    `SELECT kept.normalize(x) AS n, kept.strip_prefixes(kept.normalize(x)) AS s
       FROM unnest($1::text[]) WITH ORDINALITY AS v(x, i) ORDER BY i`,
    [inputs],
  );
  return rows;
}

describe('kept.normalize() and kept.strip_prefixes() (the SQL twin)', () => {
  it('has the vectors to check', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(60);
  });

  it('matches every vector, as kept_app', async () => {
    const rows = await sqlForms(VECTORS.map((v) => v.in));
    const mismatches = VECTORS.flatMap((v, i) => {
      const row = rows[i];
      return row?.n === v.normalized && row?.s === v.stripped
        ? []
        : [{ in: v.in, want: [v.normalized, v.stripped], got: [row?.n, row?.s] }];
    });
    expect(mismatches).toEqual([]);
  });

  it('agrees with the JavaScript twin on text beyond the vectors', async () => {
    const extra = [
      'أحمد إبراهيم آلة ٱلكتاب',
      'رئيس مؤسسة',
      'تلفزيون ٤٥ بوصة',
      '  Ü\tber   Ça  ',
      'ﷲ',
      'كِتَابٌ وَالْقَلَمُ',
      'Crème brûlée ٢٠٢٦',
    ];
    const rows = await sqlForms(extra);
    expect(rows.map((r) => [r.n, r.s])).toEqual(
      extra.map((x) => [normalize(x), stripPrefixes(normalize(x))]),
    );
  });

  it('builds search text from both forms, and empty text from NULL', async () => {
    const { rows } = await db.pools.app.query(
      `SELECT kept.search_text('الكابل') AS a, kept.search_text(NULL) AS b`,
    );
    expect(rows[0]).toEqual({ a: 'الكابل كابل', b: '' });
  });

  it('is IMMUTABLE, so expression indexes may use it', async () => {
    const { rows } = await db.pools.app.query(
      `SELECT proname, provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'kept' AND proname IN ('normalize', 'strip_prefixes', 'search_text')
        ORDER BY 1`,
    );
    expect(rows).toEqual([
      { proname: 'normalize', provolatile: 'i' },
      { proname: 'search_text', provolatile: 'i' },
      { proname: 'strip_prefixes', provolatile: 'i' },
    ]);
  });
});
