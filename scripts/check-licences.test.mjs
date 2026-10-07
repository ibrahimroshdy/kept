import { describe, expect, it } from 'vitest';
import {
  classify,
  DEV_ALLOWED,
  expressionAllowed,
  RUNTIME_ALLOWED,
  validateExceptions,
} from './check-licences.mjs';

// The shape `pnpm licenses list --json` prints (pnpm 11.23.0), trimmed to the fields used.
function pkg(name, license, versions = ['1.0.0']) {
  return { name, versions, paths: [`/x/node_modules/${name}`], license };
}
const report = (...packages) => {
  const out = {};
  for (const p of packages) {
    out[p.license] ??= [];
    out[p.license].push(p);
  }
  return out;
};

describe('expressionAllowed', () => {
  const allowed = new Set(['MIT', 'Apache-2.0', 'CC0-1.0']);

  it('accepts a listed identifier and rejects an unlisted one', () => {
    expect(expressionAllowed('MIT', allowed)).toBe(true);
    expect(expressionAllowed('GPL-3.0-only', allowed)).toBe(false);
  });

  it('OR needs one side, AND needs both', () => {
    expect(expressionAllowed('(MIT OR CC0-1.0)', allowed)).toBe(true);
    expect(expressionAllowed('MIT OR GPL-3.0-only', allowed)).toBe(true);
    expect(expressionAllowed('MIT AND Apache-2.0', allowed)).toBe(true);
    expect(expressionAllowed('MIT AND GPL-3.0-only', allowed)).toBe(false);
    expect(expressionAllowed('(MIT AND GPL-2.0) OR Apache-2.0', allowed)).toBe(true);
  });

  it('WITH is only accepted as the exact pair', () => {
    expect(expressionAllowed('Apache-2.0 WITH LLVM-exception', allowed)).toBe(false);
    const withPair = new Set([...allowed, 'Apache-2.0 WITH LLVM-exception']);
    expect(expressionAllowed('Apache-2.0 WITH LLVM-exception', withPair)).toBe(true);
  });

  it('rejects what does not parse, and non-SPDX strings', () => {
    for (const bad of ['', '(MIT', 'MIT OR', 'OR MIT', 'Unknown', 'SEE LICENSE IN LICENSE']) {
      expect(expressionAllowed(bad, allowed)).toBe(false);
    }
    expect(expressionAllowed(undefined, allowed)).toBe(false);
  });
});

describe('the allowlists', () => {
  it('never contain a copyleft licence that would block relicensing (D151)', () => {
    for (const list of [RUNTIME_ALLOWED, DEV_ALLOWED]) {
      for (const bad of ['GPL-3.0-only', 'AGPL-3.0-only', 'SSPL-1.0', 'BUSL-1.1', 'GPL-2.0']) {
        expect(expressionAllowed(bad, list)).toBe(false);
      }
    }
  });

  it('runtime is stricter than dev', () => {
    expect(expressionAllowed('Python-2.0', RUNTIME_ALLOWED)).toBe(false);
    expect(expressionAllowed('Python-2.0', DEV_ALLOWED)).toBe(true);
    expect(expressionAllowed('LGPL-3.0-or-later', RUNTIME_ALLOWED)).toBe(false);
  });
});

describe('classify', () => {
  it('passes a clean report and counts every package', () => {
    const result = classify(
      report(pkg('a', 'MIT'), pkg('b', 'ISC'), pkg('c', '(MIT OR CC0-1.0)')),
      {
        allowed: RUNTIME_ALLOWED,
        scope: 'prod',
      },
    );
    expect(result).toMatchObject({ checked: 3, violations: [], excepted: [] });
  });

  it('lists every violation with name, versions and licence', () => {
    const result = classify(
      report(
        pkg('ok', 'MIT'),
        pkg('bad', 'GPL-3.0-only', ['2.0.0', '2.1.0']),
        pkg('odd', 'Unknown'),
      ),
      { allowed: RUNTIME_ALLOWED, scope: 'prod' },
    );
    expect(result.violations).toEqual([
      { name: 'bad', versions: '2.0.0, 2.1.0', licence: 'GPL-3.0-only' },
      { name: 'odd', versions: '1.0.0', licence: 'Unknown' },
    ]);
  });

  it('an exception applies only to its package, licence and scope', () => {
    const exceptions = {
      argparse: { licence: 'Python-2.0', scope: 'prod', reason: 'Reviewed: permissive, 2026.' },
    };
    const input = report(pkg('argparse', 'Python-2.0'), pkg('other', 'Python-2.0'));

    const prod = classify(input, { allowed: RUNTIME_ALLOWED, exceptions, scope: 'prod' });
    expect(prod.excepted.map((e) => e.name)).toEqual(['argparse']);
    expect(prod.violations.map((v) => v.name)).toEqual(['other']);

    // Relicensed: the exception names the old licence, so it stops applying.
    const moved = classify(report(pkg('argparse', 'BUSL-1.1')), {
      allowed: RUNTIME_ALLOWED,
      exceptions,
      scope: 'prod',
    });
    expect(moved.violations.map((v) => v.name)).toEqual(['argparse']);

    // Wrong scope: a prod exception reports as unused on the dev scan.
    const dev = classify(report(pkg('x', 'MIT')), {
      allowed: DEV_ALLOWED,
      exceptions: { ...exceptions, y: { licence: 'Zlib', scope: 'dev', reason: 'Just a test.' } },
      scope: 'dev',
    });
    expect(dev.unused).toEqual(['y']);
  });

  it('refuses an exception without a reason, or for a forbidden licence', () => {
    expect(() => validateExceptions({ a: { licence: 'Zlib', scope: 'prod', reason: '' } })).toThrow(
      /needs a reason/,
    );
    expect(() =>
      validateExceptions({
        a: { licence: 'AGPL-3.0-only', scope: 'prod', reason: 'We like it a lot.' },
      }),
    ).toThrow(/can never be excepted/);
    expect(() =>
      validateExceptions({
        a: { licence: 'Zlib', scope: 'sometimes', reason: 'Long enough reason.' },
      }),
    ).toThrow(/scope/);
  });

  it('accepts an empty report (no dependencies in scope)', () => {
    expect(classify({}, { allowed: DEV_ALLOWED, scope: 'dev' })).toMatchObject({
      checked: 0,
      violations: [],
    });
  });
});
