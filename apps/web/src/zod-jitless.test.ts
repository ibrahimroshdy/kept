// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// index.html turns zod's JIT off before any module runs: the CSP allows no eval, and zod's eval
// probe is reported as a CSP violation even though its throw is caught (T32).
describe("index.html's zod config", () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const setter = scripts.find((s) => s.includes('__zod_globalConfig'));

  it('sets jitless in an inline script that comes before the app’s module', () => {
    expect(setter).toBeDefined();
    const at = html.indexOf('__zod_globalConfig');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('<script type="module"'));
  });

  it('writes the object zod reads its config from', () => {
    runInThisContext(setter ?? '');
    expect(z.config()).toBe((globalThis as { __zod_globalConfig?: object }).__zod_globalConfig);
    expect(z.config().jitless).toBe(true);
    expect(z.object({ a: z.string() }).parse({ a: 'x' })).toEqual({ a: 'x' });
  });
});
