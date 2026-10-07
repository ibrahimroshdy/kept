/**
 * The assistant evaluation (step-6 plan T17; D22, D23, D123, D164, D179, D206; L61).
 *
 *   pnpm eval:assistant [--cases <file>] [--only id,…] [--provider mock|openai|google|anthropic|
 *     groq|openrouter|compatible --model <chat model> [--embed-model <id>] [--base-url <url>]]
 *     [--gap-ms 5000] [--out <folder>] [--report] [--no-report]
 *
 * **The real loop.** Each case is a question asked as the seed's person (Louis, Talia, Alfred…)
 * from its page, through `ask()` and `runTurn()` (assistant/loop.ts): `callModel` on the database
 * ports (pacing, budgets, the ledger), the tool registry as the person, proposals for writes. A
 * scratch database (world.ts) holds the `households` seed, the cases' fixtures, one instance
 * provider and the things embedded by the real backfill. Each case gets its own thread, deleted
 * after; a write is only ever a card, never applied, so no case changes what the next one sees.
 *
 * **The mock by default.** The provider is KEPT_AI_MOCK's: its model plays each case's script
 * (src/ai/mock-script.ts) and its embedder the concept lexicon, so CI checks the loop and the
 * scoring with no network. A real run reads its key from `KEPT_EVAL_API_KEY` only (never an
 * argument or a file, never printed) and is the maintainer's step; its report is dated under
 * docs/evals: numbers and case ids only (score.ts).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Part } from '@kept/shared';
import { createMockModel } from '../../src/ai/mock.js';
import { loadScripts } from '../../src/ai/mock-script.js';
import { createAiDeps } from '../../src/ai/routes.js';
import { runTurn } from '../../src/assistant/loop.js';
import { ask } from '../../src/assistant/service.js';
import { createThread, resolveContext } from '../../src/assistant/threads.js';
import { viewerRefusal } from '../../src/assistant/words.js';
import type { Keyring } from '../../src/crypto/envelope.js';
import type { Pools } from '../../src/db/pools.js';
import { withScope } from '../../src/db/scope.js';
import type { JobQueue } from '../../src/jobs/queue.js';
import { packageRoot } from '../../src/package-root.js';
import { semanticPrep } from '../../src/search/semantic.js';
import { buildWorld, type EvalProvider, type Owner, scratchDb, type World } from '../world.js';
import {
  ASSISTANT_CASES_PATH,
  type AssistantCase,
  type AssistantSet,
  loadAssistantCases,
} from './cases.js';
import { type CaseRun, type CaseScore, type Summary, scoreCase, summarise } from './score.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
/** Nothing is queued in an evaluation: the turn runs here, in this process. */
const NO_JOBS: JobQueue = { send: async () => {}, sendTenant: async () => {} };

export const MOCK_PROVIDER: EvalProvider = {
  kind: 'openai',
  chat: 'kept-mock',
  embeddings: 'kept-mock-embed',
  apiKey: null,
};

/** The AI layer for a run: KEPT_AI_MOCK's (playing `scriptsFile`), or the real provider's. */
export function evalAi(pools: Pools, mock: boolean, scriptsFile: string) {
  const scripts = loadScripts(scriptsFile);
  return (keyring: Keyring) =>
    createAiDeps({
      pools,
      keyring: () => keyring,
      log: silent,
      mock,
      ...(mock
        ? { overrides: { modelFactory: (r) => createMockModel({}, r.provider.model, scripts) } }
        : {}),
    });
}

type Ctx = { pools: Pools; owner: Owner; world: World; ai: ReturnType<ReturnType<typeof evalAi>> };

function contextOf(c: AssistantCase, world: World) {
  const ctx = c.context;
  if (!ctx) return undefined;
  if (ctx.kind === 'location') {
    const id = world.locations.get(ctx.location ?? '')?.id;
    if (!id) throw new Error(`case ${c.id}: no location ${ctx.location}`);
    return { kind: 'location' as const, id };
  }
  const id = world.things.get(ctx.thing ?? '')?.[0];
  if (!id) throw new Error(`case ${c.id}: no thing ${ctx.thing}`);
  return { kind: ctx.kind, id };
}

/** Asks one case's question and runs its turn to the end; answers what the scoring reads. */
export async function runCase(ctx: Ctx, c: AssistantCase): Promise<CaseRun> {
  const userId = ctx.world.users[c.user];
  const scope = { userId, mfa: true };
  const [clock] = await ctx.owner<{ now: Date }>('SELECT now() AS now');
  const started = clock?.now ?? new Date();
  const input = contextOf(c, ctx.world);
  const { threadId, turnId } = await withScope(ctx.pools.app, scope, async (_tx, client) => {
    const context = await resolveContext(client, input ?? null);
    const thread = await createThread(client, userId, context);
    const body = { text: c.question, locale: c.locale, ...(input ? { context: input } : {}) };
    const { turnId } = await ask(client, NO_JOBS, scope, thread.id, body, context);
    return { threadId: thread.id, turnId };
  });
  try {
    await runTurn(
      {
        pools: { app: ctx.pools.app },
        ai: ctx.ai,
        tools: {
          pools: { app: ctx.pools.app },
          jobs: null,
          files: null,
          log: silent,
          semantic: semanticPrep({ pools: ctx.pools, ai: ctx.ai, log: silent }),
        },
        log: silent,
      },
      scope,
      { turnId, locale: c.locale },
    );
    const [turn] = await ctx.owner<{ status: string }>(
      'SELECT status FROM public.assistant_turns WHERE id = $1',
      [turnId],
    );
    const messages = await ctx.owner<{ role: string; parts: Part[] }>(
      `SELECT role, parts FROM public.assistant_messages WHERE turn_id = $1 ORDER BY created_at, id`,
      [turnId],
    );
    const parts = messages.flatMap((m) => m.parts.map((p) => ({ role: m.role, p })));
    const last = messages.filter((m) => m.role === 'assistant').at(-1);
    const answer = last?.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n') ?? '';
    const proposals = await ctx.owner<{ tool: string }>(
      'SELECT tool FROM public.assistant_proposals WHERE turn_id = $1',
      [turnId],
    );
    const [writes] = await ctx.owner<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.audit_events WHERE actor_id = $1 AND at >= $2`,
      [userId, started],
    );
    const calls = await ctx.owner<{
      input_tokens: number | null;
      output_tokens: number | null;
      cost_amount: string | null;
    }>(
      `SELECT input_tokens, output_tokens, cost_amount::text FROM public.llm_calls
        WHERE thread_id = $1 AND sent`,
      [threadId],
    );
    return {
      id: c.id,
      status: turn?.status ?? 'missing',
      answer,
      toolsCalled: parts.flatMap(({ p }) => (p.type === 'tool_call' ? [p.tool] : [])),
      toolOutputs: parts.flatMap(({ p }) => (p.type === 'tool_result' ? [p.output] : [])),
      proposals: proposals.map((p) => p.tool),
      writes: writes?.n ?? 0,
      steps: calls.length,
      tokens: {
        input: calls.reduce((n, r) => n + (r.input_tokens ?? 0), 0),
        output: calls.reduce((n, r) => n + (r.output_tokens ?? 0), 0),
      },
      cost: calls.some((r) => r.cost_amount === null)
        ? null
        : calls.reduce((n, r) => n + Number(r.cost_amount), 0),
      viewerSentence: viewerRefusal(c.locale, 'Home'),
    };
  } finally {
    await ctx.owner('DELETE FROM public.assistant_threads WHERE id = $1', [threadId]);
  }
}

export type AssistantEval = { scores: CaseScore[]; summary: Summary };

/** Every case of `set` (or those in `only`) on a database whose pools and owner are given. */
export async function runAssistantEval(opts: {
  pools: Pools;
  owner: Owner;
  set: AssistantSet;
  provider: EvalProvider;
  mock: boolean;
  scriptsFile: string;
  only?: ReadonlySet<string>;
  gapMs?: number;
  log?: (line: string) => void;
}): Promise<AssistantEval> {
  const built = await buildWorld({
    pools: opts.pools,
    owner: opts.owner,
    provider: opts.provider,
    fixtures: opts.set.fixtures,
    ai: evalAi(opts.pools, opts.mock, opts.scriptsFile),
  });
  const ctx: Ctx = { pools: opts.pools, owner: opts.owner, world: built, ai: built.ai };
  const scores: CaseScore[] = [];
  for (const c of opts.set.cases) {
    if (opts.only && !opts.only.has(c.id)) continue;
    const run = await runCase(ctx, c);
    const s = scoreCase(c, run, built.things);
    scores.push(s);
    opts.log?.(`${s.pass ? 'pass' : 'FAIL'} ${c.id}`);
    if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
  }
  return { scores, summary: summarise(scores) };
}

// --- The report: numbers and case ids only -------------------------------------------------------

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}% (${a}/${b})` : '–');

export function renderAssistantReport(
  e: AssistantEval,
  meta: { provider: string; model: string; embed: string | null; set: string; date: Date },
): string {
  const s = e.summary;
  const L = [
    `# Assistant evaluation: ${meta.provider} ${meta.model}`,
    '',
    `Date: ${meta.date.toISOString().slice(0, 10)}. Set: \`${meta.set}\` (${s.cases} cases). Embeddings: ${meta.embed ?? 'none (keyword search)'}.`,
    'Generated by `pnpm eval:assistant` (apps/server/eval/assistant). Numbers and case ids only.',
    '',
    `**Passed: ${pct(s.passed, s.cases)}.** Model steps: ${s.steps}; tokens in ${s.tokens.input}, out ${s.tokens.output}; cost ${s.cost === null ? 'unknown' : s.cost.toFixed(6)}.`,
    '',
    '| Kind | Passed |',
    '|---|---|',
    ...Object.entries(s.byKind).map(([k, v]) => `| ${k} | ${pct(v.passed, v.cases)} |`),
    '',
    '| Check | Passed where it applies |',
    '|---|---|',
    ...Object.entries(s.byCheck).map(([k, v]) => `| ${k} | ${pct(v.passed, v.applied)} |`),
    '',
    '| Case | Steps | Tokens in | Tokens out | Failed |',
    '|---|---|---|---|---|',
    ...e.scores.map((c) => {
      const failed = s.failed.find((f) => f.id === c.id)?.checks.join(', ') ?? '';
      return `| ${c.id} | ${c.steps} | ${c.tokens.input} | ${c.tokens.output} | ${failed} |`;
    }),
    '',
  ];
  return L.join('\n');
}

const REPO_ROOT = path.resolve(packageRoot(import.meta.url), '../..');
const KINDS = [
  'mock',
  'openai',
  'google',
  'anthropic',
  'groq',
  'openrouter',
  'compatible',
] as const;

export async function main(argv: string[], print = (l: string) => console.log(l)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: 'string' },
      only: { type: 'string' },
      provider: { type: 'string', default: 'mock' },
      model: { type: 'string' },
      'embed-model': { type: 'string' },
      'base-url': { type: 'string' },
      'gap-ms': { type: 'string' },
      out: { type: 'string' },
      report: { type: 'boolean' },
      'no-report': { type: 'boolean' },
    },
    strict: true,
  });
  const kindArg = values.provider as string;
  if (!(KINDS as readonly string[]).includes(kindArg)) {
    throw new Error(`--provider is one of ${KINDS.join(', ')}`);
  }
  const mock = kindArg === 'mock';
  let provider: EvalProvider = MOCK_PROVIDER;
  if (!mock) {
    if (!values.model) throw new Error('--model is required with a real provider');
    const apiKey = process.env.KEPT_EVAL_API_KEY ?? null;
    if (!apiKey)
      throw new Error('KEPT_EVAL_API_KEY is not set (the key is read from the environment only)');
    provider = {
      kind: kindArg === 'compatible' ? 'openai_compatible' : (kindArg as EvalProvider['kind']),
      chat: values.model,
      embeddings: values['embed-model'] ?? null,
      baseUrl: values['base-url'] ?? null,
      apiKey,
    };
  }
  const file = values.cases ? path.resolve(values.cases) : ASSISTANT_CASES_PATH;
  const set = loadAssistantCases(file);
  const db = await scratchDb();
  try {
    const e = await runAssistantEval({
      pools: db.pools,
      owner: db.owner,
      set,
      provider,
      mock,
      scriptsFile: file,
      ...(values.only ? { only: new Set(values.only.split(',')) } : {}),
      gapMs: mock ? 0 : Math.max(5000, Number(values['gap-ms'] ?? 5000)),
      log: print,
    });
    const s = e.summary;
    print(`${s.passed}/${s.cases} passed; ${s.steps} model steps`);
    const write = values.report || (!mock && !values['no-report']);
    if (write) {
      const date = new Date();
      const slug =
        `${date.toISOString().slice(0, 10)}-assistant-${mock ? 'mock' : provider.kind}-${provider.chat}`
          .toLowerCase()
          .replace(/[^a-z0-9.-]+/g, '-');
      const out = path.join(
        values.out ? path.resolve(values.out) : path.join(REPO_ROOT, 'docs/evals'),
        `${slug}.md`,
      );
      writeFileSync(
        out,
        renderAssistantReport(e, {
          provider: mock ? 'mock' : provider.kind,
          model: provider.chat,
          embed: provider.embeddings,
          set: set.set,
          date,
        }),
      );
      print(`report: ${path.relative(REPO_ROOT, out)}`);
    }
    return s.passed === s.cases ? 0 : mock ? 1 : 0;
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
