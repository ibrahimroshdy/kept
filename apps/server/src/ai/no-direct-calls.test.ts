// Every model call goes through ai/call.ts's callModel (step-3 ground rules; L41–L47, D206):
// reserve, pace, retries off, settle, one ledger row. This fails on any direct call of the SDK's
// generation functions anywhere else under src/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED = new Set(['ai/call.ts', 'ai/no-direct-calls.test.ts']);
const CALLS = /\b(?:generateText|generateObject|streamText|streamObject|embed|embedMany)\s*\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('no direct model calls', () => {
  it('only ai/call.ts calls generateText and friends', () => {
    const offenders = files(SRC)
      .map((f) => relative(SRC, f).split('\\').join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => CALLS.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  // Step 6 (T8): one provider request per call. The stop condition is set once, to one step, and
  // only call.ts builds SDK tools (a tool with `execute` elsewhere could start a loop Kept can't
  // see, pace or ledger).
  it('call.ts sets the stop condition exactly once, to one step', () => {
    // The code only: the file's comments name what it never passes.
    const src = readFileSync(join(SRC, 'ai/call.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src.match(/stopWhen/g)).toHaveLength(1);
    expect(src).toMatch(/stopWhen: isStepCount\(1\)/);
    for (const banned of [
      'toolApproval',
      'repairToolCall',
      'prepareStep',
      'toolCaller',
      'execute:',
    ]) {
      expect(src.includes(banned), banned).toBe(false);
    }
  });

  it('only ai/call.ts imports tool or dynamicTool from the SDK', () => {
    const IMPORT = /import\s*\{([^}]*)\}\s*from\s*'(?:ai|@ai-sdk\/provider-utils)'/g;
    const offenders = files(SRC)
      .map((f) => relative(SRC, f).split('\\').join('/'))
      .filter((rel) => rel !== 'ai/call.ts' && rel !== 'ai/no-direct-calls.test.ts')
      .filter((rel) => {
        const src = readFileSync(join(SRC, rel), 'utf8');
        return [...src.matchAll(IMPORT)].some((m) =>
          (m[1] ?? '')
            .split(',')
            .map(
              (n) =>
                n
                  .trim()
                  .replace(/^type\s+/, '')
                  .split(/\s+as\s+/)[0],
            )
            .some((n) => n === 'tool' || n === 'dynamicTool'),
        );
      });
    expect(offenders).toEqual([]);
  });

  it('the pattern would catch one', () => {
    expect(CALLS.test('await generateText({ model })')).toBe(true);
    expect(CALLS.test('const r = embed ({})')).toBe(true);
    expect(CALLS.test('callModel(rt, req)')).toBe(false);
  });
});
