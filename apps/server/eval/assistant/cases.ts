/**
 * The assistant evaluation's cases (step-6 plan T17): test/fixtures/assistant/cases.json, or a
 * folder's `cases.json` of the same shape (the maintainer's own questions, git-ignored). Each case
 * names who asks (the seed's cast), the interface language, the page it is asked from, what a
 * right answer does, and the script the mock plays (src/ai/mock-script.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ScriptStep } from '../../src/ai/mock-script.js';
import { packageRoot } from '../../src/package-root.js';
import type { PersonKey } from '../../src/seed/cast.js';
import type { Fixture } from '../world.js';

export const CASE_KINDS = [
  'find',
  'figure',
  'secret',
  'act',
  'viewer',
  'cross_owner',
  'injection',
  'injection_defence',
  'invisible',
  'context',
  'link',
] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export type Expect = {
  /** Tools the answer must have called (any order, others allowed). */
  tools?: string[];
  /** A card for this write tool must exist (and nothing executed). */
  proposes?: string;
  /** No card at all. */
  noProposal?: boolean;
  /** Kept's fixed viewer sentence, no card. */
  refuses?: boolean;
  /** Things (by name) the answer must link. */
  cites?: string[];
  /** Words in neither the answer nor any tool result: a location the person can't see. */
  hidden?: string[];
  /** Words the answer must not say (a secret, an injected figure). */
  notSay?: string[];
  /** An injection case: nothing executed, no card unless `proposes`, `notSay` held. */
  injection?: boolean;
  /** No link in the answer to a thing no tool showed (they're stripped, D179). */
  noStrayLinks?: boolean;
  language: 'en' | 'ar';
};

export type AssistantCase = {
  id: string;
  kind: CaseKind;
  user: PersonKey;
  locale: 'en' | 'ar';
  question: string;
  context?: { kind: 'location' | 'thing' | 'place'; location?: string; thing?: string };
  expect: Expect;
  mock: ScriptStep[];
};

export type AssistantSet = { set: string; fixtures: Fixture[]; cases: AssistantCase[] };

export const ASSISTANT_CASES_PATH = path.join(packageRoot(), 'test/fixtures/assistant/cases.json');

export function loadAssistantCases(file: string = ASSISTANT_CASES_PATH): AssistantSet {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AssistantSet>;
  const cases = raw.cases ?? [];
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
    ids.add(c.id);
    if (!(CASE_KINDS as readonly string[]).includes(c.kind)) {
      throw new Error(`case ${c.id}: unknown kind ${c.kind}`);
    }
  }
  return { set: raw.set ?? path.basename(file), fixtures: raw.fixtures ?? [], cases };
}
