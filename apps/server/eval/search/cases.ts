/**
 * The search evaluation's cases (step-6 plan T17, T14; D200, D207): test/fixtures/semantic/
 * search-cases.json, or a file of the same shape with the maintainer's own phrasings. Each case is a
 * query asked as one of the seed's people, and the things (by the seed's names) a right answer
 * holds. `words` cases are found by their words, `meaning` cases by what they are.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../../src/package-root.js';
import type { PersonKey } from '../../src/seed/cast.js';

export type SearchCase = {
  id: string;
  kind: 'words' | 'meaning';
  user: PersonKey;
  locale: 'en' | 'ar';
  query: string;
  expect: string[];
};

export type SearchSet = { set: string; cases: SearchCase[] };

export const SEARCH_CASES_PATH = path.join(
  packageRoot(),
  'test/fixtures/semantic/search-cases.json',
);

export function loadSearchCases(file: string = SEARCH_CASES_PATH): SearchSet {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SearchSet>;
  const cases = raw.cases ?? [];
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    ids.add(c.id);
    if (c.expect.length === 0) throw new Error(`case ${c.id} expects nothing`);
  }
  return { set: raw.set ?? path.basename(file), cases };
}

/** recall@k: the share of the expected things among the first k results. */
export function recallAt(k: number, ranked: readonly string[], expected: readonly string[][]) {
  const top = new Set(ranked.slice(0, k));
  const found = expected.filter((ids) => ids.some((id) => top.has(id))).length;
  return expected.length > 0 ? found / expected.length : 0;
}

/** Reciprocal rank of the first expected thing (0 when none is ranked). */
export function reciprocalRank(ranked: readonly string[], expected: readonly string[][]) {
  const all = new Set(expected.flat());
  const i = ranked.findIndex((id) => all.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}
