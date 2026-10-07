/**
 * The mock's scripted tool calls (step-6 plan T17, for KEPT_AI_MOCK and the assistant evaluation):
 * a question the script knows is answered step by step, as a model would, with tool calls and then
 * an answer built from what the tools returned. Before this the mock answered every turn "red".
 *
 * A script is `{question, mock: [step, …]}` (test/fixtures/assistant/cases.json holds them, one
 * per evaluation case; e2e questions are cases too). The question matches the thread's last
 * question after Kept's normalize(). The step taken is the number of model steps already made
 * since that question (the assistant messages after it). A step is either
 * - `{calls: [{tool, input}]}`: the model calls these tools (one provider request, one step), or
 * - `{answer, empty?}`: the model answers with this text.
 * Templates in a call's string inputs and in the answer read the turn's tool results:
 * - `{{id N}}`, `{{loc N}}`, `{{name N}}`, `{{path N}}`, `{{link N}}`: the Nth item of the latest
 *   result (`data.items[N]`, or `data` itself when it is one item): its id, location id, name,
 *   path joined with " › ", and `[name](kept:thing/<id>)`;
 * - `{{find NAME}}`, `{{linkfind NAME}}`: the first item named NAME (case and marks aside) in any
 *   result this turn, its id or its link;
 * - `{{qty N}}`: the Nth item's quantity; `{{locfind NAME}}`: the named item's location id;
 * - `{{location NAME}}`: the id of the person's location of that name, and `{{context}}`: the id
 *   of the page the question was asked from (both from the step's instructions);
 * - `{{count}}`: the latest result's item count;
 * - `{{raw TEXT}}`: TEXT as is (a link to a thing no tool showed, for the strip test).
 * A template with nothing to read makes the step's `empty` answer (or "Nothing found.").
 * A question no script knows is answered "red", as before.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { normalize } from '@kept/shared';
import { packageRoot } from '../package-root.js';

export type ScriptCall = { tool: string; input: Record<string, unknown> };
export type ScriptStep = { calls: ScriptCall[] } | { answer: string; empty?: string };
export type Script = { question: string; mock: ScriptStep[] };

/** Where the scripts live: the assistant evaluation's cases (T17). */
export const MOCK_SCRIPTS_PATH = path.join(packageRoot(), 'test/fixtures/assistant/cases.json');

let cache: Map<string, Script> | undefined;

/** The scripts of a cases file, by normalised question. */
export function loadScripts(file: string): Map<string, Script> {
  const out = new Map<string, Script>();
  if (!existsSync(file)) return out;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { cases?: Partial<Script>[] };
  for (const c of parsed.cases ?? []) {
    if (typeof c.question === 'string' && Array.isArray(c.mock)) {
      out.set(normalize(c.question), { question: c.question, mock: c.mock });
    }
  }
  return out;
}

/** The committed scripts (cached); empty where the fixtures aren't shipped. */
export function mockScripts(): Map<string, Script> {
  cache ??= loadScripts(MOCK_SCRIPTS_PATH);
  return cache;
}

type Item = {
  id?: string;
  location_id?: string;
  name?: string;
  path?: string[];
  quantity?: number;
};

function itemOf(v: unknown): Item | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as {
    id?: unknown;
    location_id?: unknown;
    quantity?: unknown;
    untrusted?: { name?: unknown; path?: unknown };
  };
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    ...(typeof r.location_id === 'string' ? { location_id: r.location_id } : {}),
    ...(typeof r.untrusted?.name === 'string' ? { name: r.untrusted.name } : {}),
    ...(Array.isArray(r.untrusted?.path) ? { path: r.untrusted.path.map(String) } : {}),
    ...(typeof r.quantity === 'number' ? { quantity: r.quantity } : {}),
  };
}

/** A tool result's items: `data.items`, or `data` when it is one thing. */
function itemsOf(output: unknown): Item[] {
  const data = (output as { data?: unknown } | null)?.data;
  const items = (data as { items?: unknown } | null)?.items;
  // A contents list nests each row's thing or place (`{depth, thing}`).
  const row = (v: unknown) =>
    itemOf(v) ??
    itemOf((v as { thing?: unknown } | null)?.thing) ??
    itemOf((v as { place?: unknown } | null)?.place);
  if (Array.isArray(items)) return items.map(row).filter((i): i is Item => i !== null);
  const one = itemOf(data) ?? itemOf((data as { thing?: unknown } | null)?.thing);
  return one ? [one] : [];
}

type Turn = { question: string; steps: number; results: unknown[]; system: string };

/** The last question, the steps made since, and the tool results since, from the prompt. */
export function turnOf(options: Pick<LanguageModelV4CallOptions, 'prompt'>): Turn | null {
  let last = -1;
  options.prompt.forEach((m, i) => {
    if (m.role === 'user') last = i;
  });
  if (last === -1) return null;
  const system = options.prompt
    .map((m) => (m.role === 'system' ? m.content : ''))
    .filter(Boolean)
    .join('\n');
  const user = options.prompt[last];
  const question =
    user?.role === 'user'
      ? user.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
      : '';
  let steps = 0;
  const results: unknown[] = [];
  for (const m of options.prompt.slice(last + 1)) {
    if (m.role === 'assistant') steps += 1;
    if (m.role !== 'tool') continue;
    for (const p of m.content) {
      if (p.type !== 'tool-result') continue;
      const o = p.output as { type: string; value?: unknown };
      results.push(o.type === 'json' ? o.value : null);
    }
  }
  return { question, steps, results, system };
}

class Missing extends Error {}

/** The person's locations, as the instructions list them (assistant/prompt.ts). */
function locationsIn(system: string): { id: string; name: string }[] {
  const at = system.indexOf('with their role (JSON; names untrusted): ');
  if (at === -1) return [];
  const json = system.slice(at).split(': ').slice(1).join(': ').split('\n')[0] ?? '[]';
  try {
    return (JSON.parse(json) as { location_id: string; untrusted: { name: string } }[]).map(
      (l) => ({ id: l.location_id, name: l.untrusted.name }),
    );
  } catch {
    return [];
  }
}

const sameName = (a: string, b: string) => normalize(a) === normalize(b);

function fill(template: string, turn: Turn): string {
  const latest = itemsOf(turn.results.at(-1));
  const all = turn.results.flatMap(itemsOf);
  const at = (n: string) => {
    const item = latest[Number(n)];
    if (!item) throw new Missing();
    return item;
  };
  const named = (name: string) => {
    const item = all.find((i) => i.name !== undefined && sameName(i.name, name));
    if (!item?.id) throw new Missing();
    return item;
  };
  const link = (i: Item) => `[${i.name ?? ''}](kept:thing/${i.id})`;
  return template.replace(/\{\{(\w+)(?: ([^}]*))?\}\}/g, (_m, op: string, arg = '') => {
    switch (op) {
      case 'id':
        return at(arg).id ?? '';
      case 'loc': {
        const l = at(arg).location_id;
        if (!l) throw new Missing();
        return l;
      }
      case 'name':
        return at(arg).name ?? '';
      case 'path':
        return (at(arg).path ?? []).join(' › ');
      case 'link':
        return link(at(arg));
      case 'find':
        return named(arg).id ?? '';
      case 'linkfind':
        return link(named(arg));
      case 'count':
        return String(latest.length);
      case 'qty': {
        const q = at(arg).quantity;
        if (q === undefined) throw new Missing();
        return String(q);
      }
      case 'locfind': {
        const l = named(arg).location_id;
        if (!l) throw new Missing();
        return l;
      }
      case 'location': {
        const l = locationsIn(turn.system).find((x) => sameName(x.name, arg));
        if (!l) throw new Missing();
        return l.id;
      }
      case 'context': {
        const id = /"id":"([0-9a-f-]{36})"/.exec(
          turn.system.split('asked from this page')[1] ?? '',
        );
        if (!id?.[1]) throw new Missing();
        return id[1];
      }
      case 'raw':
        return arg;
      default:
        return _m;
    }
  });
}

function fillInput(v: unknown, turn: Turn): unknown {
  if (typeof v === 'string') return fill(v, turn);
  if (Array.isArray(v)) return v.map((x) => fillInput(x, turn));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillInput(x, turn)]));
  }
  return v;
}

export type ScriptedReply =
  | { kind: 'calls'; calls: { id: string; tool: string; input: unknown }[] }
  | { kind: 'text'; text: string };

/** What the script says this request answers; null when no script knows the question. */
export function scriptedReply(
  options: Pick<LanguageModelV4CallOptions, 'prompt'>,
  scripts: Map<string, Script> = mockScripts(),
): ScriptedReply | null {
  const turn = turnOf(options);
  if (!turn) return null;
  const script = scripts.get(normalize(turn.question));
  if (!script) return null;
  const step = script.mock[Math.min(turn.steps, script.mock.length - 1)];
  if (!step) return null;
  if ('calls' in step && turn.steps < script.mock.length) {
    try {
      return {
        kind: 'calls',
        calls: step.calls.map((c, i) => ({
          id: `mock-${turn.steps}-${i}`,
          tool: c.tool,
          input: fillInput(c.input, turn),
        })),
      };
    } catch (e) {
      if (!(e instanceof Missing)) throw e;
      return { kind: 'text', text: 'Nothing found.' };
    }
  }
  if ('answer' in step) {
    try {
      return { kind: 'text', text: fill(step.answer, turn) };
    } catch (e) {
      if (!(e instanceof Missing)) throw e;
      return { kind: 'text', text: step.empty ?? 'Nothing found.' };
    }
  }
  return { kind: 'text', text: 'Nothing found.' };
}
