/**
 * The search evaluation (step-6 plan T17, T14; D200, D207; Q14; S6.5).
 *
 *   pnpm eval:search [--cases <file>] [--provider mock|openai|google|compatible
 *     --model <chat model> --embed-model <id> [--base-url <url>]] [--out <folder>] [--report]
 *     [--no-report]
 *
 * Each query runs as its person through Kept's own search (search/service.ts), first by keywords
 * only, then with meaning fused in (search/semantic.ts prepareSemantic(): the location's embeddings
 * model, the query embedded once per payer and model), on the `households` seed embedded by the
 * real backfill. Recall@10 and MRR per mode, and per kind of query (`words`, `meaning`). The local
 * model (D207) isn't built (S6.5): its column says so.
 *
 * The mock by default (KEPT_AI_MOCK's concept embedder): CI checks the harness and the maths. A
 * real run reads its key from `KEPT_EVAL_API_KEY` only and is the maintainer's step; its report is
 * dated under docs/evals, numbers and case ids only.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Pools } from '../../src/db/pools.js';
import { withScope } from '../../src/db/scope.js';
import { packageRoot } from '../../src/package-root.js';
import { SearchQuery } from '../../src/search/query.js';
import { prepareSemantic } from '../../src/search/semantic.js';
import { search } from '../../src/search/service.js';
import { evalAi, MOCK_PROVIDER } from '../assistant/run.js';
import { buildWorld, type EvalProvider, type Owner, scratchDb } from '../world.js';
import {
  loadSearchCases,
  recallAt,
  reciprocalRank,
  SEARCH_CASES_PATH,
  type SearchSet,
} from './cases.js';

export const SEARCH_MODES = ['keyword', 'provider'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export type SearchCaseScore = {
  id: string;
  kind: 'words' | 'meaning';
  mode: SearchMode;
  recall10: number;
  rr: number;
  /** Why meaning wasn't searched (search's `semantic` state), when it wasn't. */
  semantic: string | null;
};

export type ModeSummary = {
  mode: SearchMode;
  cases: number;
  recall10: number;
  mrr: number;
  byKind: Record<string, { cases: number; recall10: number; mrr: number }>;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summariseSearch(scores: readonly SearchCaseScore[]): ModeSummary[] {
  return SEARCH_MODES.map((mode) => {
    const of = scores.filter((s) => s.mode === mode);
    const byKind: ModeSummary['byKind'] = {};
    for (const kind of ['words', 'meaning']) {
      const k = of.filter((s) => s.kind === kind);
      byKind[kind] = {
        cases: k.length,
        recall10: mean(k.map((s) => s.recall10)),
        mrr: mean(k.map((s) => s.rr)),
      };
    }
    return {
      mode,
      cases: of.length,
      recall10: mean(of.map((s) => s.recall10)),
      mrr: mean(of.map((s) => s.rr)),
      byKind,
    };
  });
}

export async function runSearchEval(opts: {
  pools: Pools;
  owner: Owner;
  set: SearchSet;
  provider: EvalProvider;
  mock: boolean;
}): Promise<{ scores: SearchCaseScore[]; summary: ModeSummary[] }> {
  const world = await buildWorld({
    pools: opts.pools,
    owner: opts.owner,
    provider: opts.provider,
    // The mock's chat model is never called here; its scripts don't matter.
    ai: evalAi(opts.pools, opts.mock, SEARCH_CASES_PATH),
  });
  const scores: SearchCaseScore[] = [];
  for (const c of opts.set.cases) {
    const scope = { userId: world.users[c.user], mfa: true };
    const expected = c.expect.map((name) => world.things.get(name) ?? []);
    for (const mode of SEARCH_MODES) {
      const semantic =
        mode === 'provider'
          ? await prepareSemantic({ pools: opts.pools, ai: world.ai }, scope, c.query, null)
          : null;
      const res = await withScope(opts.pools.app, scope, (tx, client) =>
        search(
          tx,
          client,
          scope,
          null,
          SearchQuery.parse({ q: c.query, kind: 'things', limit: 10 }),
          semantic,
        ),
      );
      const ranked = res.things.items.map((t) => t.id);
      scores.push({
        id: c.id,
        kind: c.kind,
        mode,
        recall10: recallAt(10, ranked, expected),
        rr: reciprocalRank(ranked, expected),
        semantic: res.semantic?.state ?? null,
      });
    }
  }
  return { scores, summary: summariseSearch(scores) };
}

const f3 = (n: number) => n.toFixed(3);

export function renderSearchReport(
  e: { scores: SearchCaseScore[]; summary: ModeSummary[] },
  meta: { provider: string; embed: string | null; set: string; date: Date },
): string {
  const ids = [...new Set(e.scores.map((s) => s.id))];
  const at = (id: string, mode: SearchMode) => e.scores.find((s) => s.id === id && s.mode === mode);
  return [
    `# Search evaluation: ${meta.provider} ${meta.embed ?? '(no embeddings model)'}`,
    '',
    `Date: ${meta.date.toISOString().slice(0, 10)}. Set: \`${meta.set}\` (${ids.length} queries). Generated by \`pnpm eval:search\` (apps/server/eval/search). Numbers and case ids only.`,
    '',
    '| Mode | Recall@10 | MRR | Words: recall@10 | Words: MRR | Meaning: recall@10 | Meaning: MRR |',
    '|---|---|---|---|---|---|---|',
    ...e.summary.map(
      (m) =>
        `| ${m.mode} | ${f3(m.recall10)} | ${f3(m.mrr)} | ${f3(m.byKind.words?.recall10 ?? 0)} | ${f3(m.byKind.words?.mrr ?? 0)} | ${f3(m.byKind.meaning?.recall10 ?? 0)} | ${f3(m.byKind.meaning?.mrr ?? 0)} |`,
    ),
    '| local | not built (spike S6.5) | | | | | |',
    '',
    '| Case | Keyword recall@10 | Provider recall@10 | Provider RR | Semantic state |',
    '|---|---|---|---|---|',
    ...ids.map((id) => {
      const k = at(id, 'keyword');
      const p = at(id, 'provider');
      return `| ${id} | ${f3(k?.recall10 ?? 0)} | ${f3(p?.recall10 ?? 0)} | ${f3(p?.rr ?? 0)} | ${p?.semantic ?? 'searched'} |`;
    }),
    '',
  ].join('\n');
}

const REPO_ROOT = path.resolve(packageRoot(import.meta.url), '../..');
const KINDS = ['mock', 'openai', 'google', 'compatible'] as const;

export async function main(argv: string[], print = (l: string) => console.log(l)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: 'string' },
      provider: { type: 'string', default: 'mock' },
      model: { type: 'string' },
      'embed-model': { type: 'string' },
      'base-url': { type: 'string' },
      out: { type: 'string' },
      report: { type: 'boolean' },
      'no-report': { type: 'boolean' },
    },
    strict: true,
  });
  const kindArg = values.provider as string;
  if (!(KINDS as readonly string[]).includes(kindArg)) {
    throw new Error(
      `--provider is one of ${KINDS.join(', ')} (the others have no embeddings model)`,
    );
  }
  const mock = kindArg === 'mock';
  let provider: EvalProvider = MOCK_PROVIDER;
  if (!mock) {
    if (!values['embed-model']) throw new Error('--embed-model is required with a real provider');
    const apiKey = process.env.KEPT_EVAL_API_KEY ?? null;
    if (!apiKey)
      throw new Error('KEPT_EVAL_API_KEY is not set (the key is read from the environment only)');
    provider = {
      kind: kindArg === 'compatible' ? 'openai_compatible' : (kindArg as EvalProvider['kind']),
      chat: values.model ?? values['embed-model'],
      embeddings: values['embed-model'],
      baseUrl: values['base-url'] ?? null,
      apiKey,
    };
  }
  const set = loadSearchCases(values.cases ? path.resolve(values.cases) : SEARCH_CASES_PATH);
  const db = await scratchDb();
  try {
    const e = await runSearchEval({ pools: db.pools, owner: db.owner, set, provider, mock });
    for (const m of e.summary) {
      print(`${m.mode}: recall@10 ${f3(m.recall10)}, MRR ${f3(m.mrr)} over ${m.cases} queries`);
    }
    if (values.report || (!mock && !values['no-report'])) {
      const date = new Date();
      const slug =
        `${date.toISOString().slice(0, 10)}-search-${mock ? 'mock' : provider.kind}-${provider.embeddings}`
          .toLowerCase()
          .replace(/[^a-z0-9.-]+/g, '-');
      const out = path.join(
        values.out ? path.resolve(values.out) : path.join(REPO_ROOT, 'docs/evals'),
        `${slug}.md`,
      );
      writeFileSync(
        out,
        renderSearchReport(e, {
          provider: mock ? 'mock' : provider.kind,
          embed: provider.embeddings,
          set: set.set,
          date,
        }),
      );
      print(`report: ${path.relative(REPO_ROOT, out)}`);
    }
    return 0;
  } finally {
    await db.drop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      const key = process.env.KEPT_EVAL_API_KEY;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(key ? msg.split(key).join('[KEY]') : msg);
      process.exit(1);
    },
  );
}
