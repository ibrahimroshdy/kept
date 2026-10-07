// The search evaluation in CI (step-6 plan T17, T14): recall@k and MRR on hand-made rankings, and
// the harness on the mock (KEPT_AI_MOCK's concept embedder) over the households seed, keyword-only
// against meaning fused in. Never a real provider.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { ownerTx } from '../../test/tenancy.js';
import { MOCK_PROVIDER } from '../assistant/run.js';
import type { Owner } from '../world.js';
import { loadSearchCases, recallAt, reciprocalRank } from './cases.js';
import { runSearchEval, type SearchCaseScore, summariseSearch } from './run.js';

// Seeding the households and running every case takes about a minute on a quiet machine.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

describe('the maths', () => {
  it('recall@k counts each expected thing once, by any of its ids; MRR the first hit', () => {
    const ranked = ['a', 'b', 'c', 'd'];
    expect(recallAt(2, ranked, [['b'], ['d']])).toBe(0.5);
    expect(recallAt(10, ranked, [['x', 'd']])).toBe(1);
    expect(recallAt(10, ranked, [])).toBe(0);
    expect(reciprocalRank(ranked, [['c'], ['d']])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(ranked, [['z']])).toBe(0);
  });

  it('summarises per mode and kind', () => {
    const s = (
      mode: 'keyword' | 'provider',
      kind: 'words' | 'meaning',
      r: number,
    ): SearchCaseScore => ({
      id: `${mode}${kind}`,
      kind,
      mode,
      recall10: r,
      rr: r,
      semantic: null,
    });
    const [keyword, provider] = summariseSearch([
      s('keyword', 'words', 1),
      s('keyword', 'meaning', 0),
      s('provider', 'words', 1),
      s('provider', 'meaning', 0.5),
    ]);
    expect(keyword).toMatchObject({ mode: 'keyword', cases: 2, recall10: 0.5 });
    expect(provider?.byKind.meaning).toEqual({ cases: 1, recall10: 0.5, mrr: 0.5 });
  });
});

describe('the harness on the mock (households seed)', () => {
  let db: TestDb;
  const set = loadSearchCases();
  let result: Awaited<ReturnType<typeof runSearchEval>>;

  beforeAll(async () => {
    db = await testDb();
    await db.reset();
    const owner: Owner = (sql, values = []) =>
      ownerTx(db, async (c) => (await c.query(sql, values)).rows) as never;
    result = await runSearchEval({
      pools: db.pools,
      owner,
      set,
      provider: MOCK_PROVIDER,
      mock: true,
    });
  });

  it('holds at least 60 queries in English and Arabic, by words and by meaning', () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(set.cases.map((c) => c.locale))).toEqual(new Set(['en', 'ar']));
    expect(new Set(set.cases.map((c) => c.kind))).toEqual(new Set(['words', 'meaning']));
  });

  it('meaning searched in every query on the mock, and it finds what keywords miss', () => {
    const [keyword, provider] = result.summary;
    expect(result.scores.filter((s) => s.mode === 'provider' && s.semantic !== null)).toEqual([]);
    expect(provider?.byKind.meaning?.recall10).toBeGreaterThan(
      keyword?.byKind.meaning?.recall10 ?? 1,
    );
    // Fusing meaning in never costs a query its words.
    expect(provider?.byKind.words?.recall10).toBeGreaterThanOrEqual(
      keyword?.byKind.words?.recall10 ?? 1,
    );
  });
});
