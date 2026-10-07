import vm from 'node:vm';

// A location's format rule for own codes (T17a, D208): a pattern the owner writes, a plain-words
// message for a code that doesn't match, and an example that does.
//
// The pattern is a JavaScript regular expression, matched against the whole code (as stored:
// upper case, so the rule is case-insensitive) with the `u` flag. An owner's pattern can
// backtrack catastrophically (`(a+)+$` on "aaaa…!"), which would stall the event loop; Node 24
// has no linear-time engine without a process flag (V8's `--enable-experimental-regexp-engine`,
// experimental), so every match here runs in a `node:vm` context with a timeout, which V8
// interrupts even mid-backtrack:
// - when the rule is set (`vetRule`): it must compile on its own (so it can't escape the
//   anchors: `a)|(b` is refused), its example must match, and it must answer each of a set of
//   long test strings within VET_MS, or it is refused as too slow;
// - on every check (`checkCodes`, a save or an import's rows): a check that runs out of time is
//   treated as not matching, with its own reason, never as a pass.

export const RULE_LIMITS = { pattern: 200, message: 200, example: 100 } as const;

/** The longest code (legacy_codes_code_chk). */
export const CODE_MAX = 100;

export type FormatRule = { pattern: string; message: string; example: string };

/** Each test string must be answered within this many milliseconds when a rule is set. */
export const VET_MS = 10;
/** A save's check, and the fixed part of an import's batch. */
const CHECK_MS = 50;
/** Added per code of a batch, up to BATCH_MAX_MS. */
const PER_CODE_MS = 2;
const BATCH_MAX_MS = 5_000;

const FLAGS = 'iu';

/** The anchored expression, or null when the pattern doesn't compile on its own. */
export function compileRule(pattern: string): RegExp | null {
  try {
    new RegExp(pattern, FLAGS);
    return new RegExp(`^(?:${pattern})$`, FLAGS);
  } catch {
    return null;
  }
}

const TEST_SCRIPT = new vm.Script('re.test(s)');
const BATCH_SCRIPT = new vm.Script('codes.map((c) => re.test(c))');

type Sandbox = { re: RegExp; s: string; codes: string[] };

/** A context to time runs in; its globals are the sandbox's properties, so one context serves
 * many runs (creating one costs about a millisecond). */
function sandbox(re: RegExp): Sandbox & vm.Context {
  return vm.createContext({ re, s: '', codes: [] }) as Sandbox & vm.Context;
}

/** Runs `script` with a timeout; null when it ran out of time. */
function timed<T>(script: vm.Script, context: vm.Context, ms: number): T | null {
  try {
    return script.runInContext(context, { timeout: ms }) as T;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
    throw err;
  }
}

/**
 * Long strings to time a pattern on: each character of the pattern, the example and a few
 * common ones repeated to a code's length and then broken by a character that fails most rules
 * (the classic catastrophic shape), the example's neighbouring pairs repeated the same way, and
 * the example repeated.
 */
export function testStrings(rule: Pick<FormatRule, 'pattern' | 'example'>): string[] {
  const chars = new Set<string>(['a', 'A', '0', '9', '-', '_', '.', ' ', '/']);
  for (const c of `${rule.pattern}${rule.example}`) {
    if (chars.size >= 64) break;
    if (/[\p{L}\p{N}\p{P}\p{S} ]/u.test(c)) chars.add(c);
  }
  const out = new Set<string>();
  const long = (unit: string) => unit.repeat(Math.ceil((CODE_MAX - 1) / unit.length));
  for (const c of chars) {
    out.add(`${long(c).slice(0, CODE_MAX - 1)}!`);
    out.add(`${long(c).slice(0, CODE_MAX - 1)}\u0000`);
  }
  const ex = [...rule.example];
  for (let i = 0; i + 1 < ex.length && out.size < 200; i++) {
    out.add(`${long(`${ex[i]}${ex[i + 1]}`).slice(0, CODE_MAX - 1)}!`);
  }
  if (rule.example) out.add(`${long(rule.example).slice(0, CODE_MAX - 1)}!`);
  return [...out];
}

export type VetResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'slow' | 'example'; hint: string };

/** Whether `rule` may be set: see the header. */
export function vetRule(rule: FormatRule): VetResult {
  const re = compileRule(rule.pattern);
  if (!re) {
    return {
      ok: false,
      reason: 'invalid',
      hint: "The pattern isn't a regular expression Kept can read.",
    };
  }
  const box = sandbox(re);
  for (const s of testStrings(rule)) {
    box.s = s;
    if (timed<boolean>(TEST_SCRIPT, box, VET_MS) === null) {
      return {
        ok: false,
        reason: 'slow',
        hint: 'The pattern is too slow to check: it takes too long on a long code. Simplify it.',
      };
    }
  }
  box.s = rule.example.trim().toUpperCase();
  if (timed<boolean>(TEST_SCRIPT, box, CHECK_MS) !== true) {
    return { ok: false, reason: 'example', hint: "The example doesn't match the pattern." };
  }
  return { ok: true };
}

/** One code's verdict: matches, doesn't, or couldn't be checked in time. */
export type CodeCheck = 'ok' | 'mismatch' | 'slow';

/** Each of `codes` (as stored) against `rule`, in one timed run. */
export function checkCodes(rule: Pick<FormatRule, 'pattern'>, codes: readonly string[]) {
  if (codes.length === 0) return [];
  const re = compileRule(rule.pattern);
  // A stored rule was vetted when it was set; one that no longer compiles (a newer engine's
  // grammar) passes nothing.
  if (!re) return codes.map((): CodeCheck => 'mismatch');
  const ms = Math.min(BATCH_MAX_MS, CHECK_MS + PER_CODE_MS * codes.length);
  const box = sandbox(re);
  box.codes = [...codes];
  const batch = timed<boolean[]>(BATCH_SCRIPT, box, ms);
  if (batch) return batch.map((m): CodeCheck => (m ? 'ok' : 'mismatch'));
  // The batch ran out of time: check one by one, so one slow code doesn't fail the rest.
  return codes.map((s): CodeCheck => {
    box.s = s;
    const one = timed<boolean>(TEST_SCRIPT, box, CHECK_MS);
    return one === null ? 'slow' : one ? 'ok' : 'mismatch';
  });
}
