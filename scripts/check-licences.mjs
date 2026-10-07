#!/usr/bin/env node
// D151, refined by D187: every dependency's licence must be on an allowlist.
//   - Runtime (`pnpm licenses list --json --prod`): what ships in the image.
//   - Dev (`pnpm licenses list --json --dev`): build and test tooling; a looser list.
// AGPL, GPL, SSPL and BUSL are never allowed, on either list, so Kept's own code stays
// relicensable for a hosted edition (D1, D105).
//
// A package that genuinely needs a licence off the list goes in EXCEPTIONS below, keyed by
// package name, with the exact licence string pnpm reports and a reason. An exception whose
// licence no longer matches stops applying, so a relicensed package is re-reviewed.
//
// Usage: node scripts/check-licences.mjs            (both lists; exit 1 on any violation)
//        node scripts/check-licences.mjs --prod     (runtime only)
//        node scripts/check-licences.mjs --dev      (dev only)
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// D151 + D187. Kept in SPDX form, as pnpm reports it.
export const RUNTIME_ALLOWED = new Set([
  'MIT',
  // MIT without the attribution clause; strictly more permissive than MIT. First scan
  // (2026-09-26): @csstools/color-helpers, @csstools/css-syntax-patches-for-csstree.
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  // Fonts (D151).
  'OFL-1.1',
  // File-level copyleft; allowed after review (D151). First scan: lightningcss.
  'MPL-2.0',
  'CC0-1.0',
  'Unlicense',
  // Data, not code (D187). First scan: caniuse-lite (browserslist data).
  'CC-BY-4.0',
  // Deliberately absent until a dependency needs them, though D187 permits both:
  //   Python-2.0 (argparse's licence), and LGPL for dynamically linked native libraries
  //   (libvips via sharp). Add LGPL as a per-package EXCEPTION, not here, because "dynamically
  //   linked" is a judgement about one package, not a licence-wide rule.
]);

// D187: devDependencies use a looser list. Still never GPL/AGPL/SSPL/BUSL.
export const DEV_ALLOWED = new Set([
  ...RUNTIME_ALLOWED,
  'Python-2.0',
  'CC-BY-3.0',
  'Zlib',
  'Artistic-2.0',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
]);

// Never allowed, even through an exception (D151). Neither allowlist names them, so a dual
// licence such as `MIT OR GPL-3.0` still passes: we take the MIT side.
export const FORBIDDEN = /\b(A?GPL|SSPL|BUSL)\b/i;

/** @type {Record<string, {licence: string, scope: 'prod' | 'dev' | 'both', reason: string}>} */
const LIBVIPS_REASON =
  "sharp's prebuilt libvips (T17: derivatives, D117, D157). LGPL-3.0-or-later, dynamically linked: the shared library ships unmodified as its own package and can be replaced, which is what D187 allows for LGPL";

export const EXCEPTIONS = {
  // One per platform binary pnpm installs: the Mac that runs CI, and the image's two arches
  // (bookworm, glibc). A platform not installed here is reported as unused, which is expected.
  '@img/sharp-libvips-darwin-arm64': {
    licence: 'LGPL-3.0-or-later',
    scope: 'prod',
    reason: LIBVIPS_REASON,
  },
  '@img/sharp-libvips-linux-x64': {
    licence: 'LGPL-3.0-or-later',
    scope: 'prod',
    reason: LIBVIPS_REASON,
  },
  '@img/sharp-libvips-linux-arm64': {
    licence: 'LGPL-3.0-or-later',
    scope: 'prod',
    reason: LIBVIPS_REASON,
  },
};

/** Splits an SPDX expression into tokens: identifiers, `(`, `)`, AND, OR, WITH. */
function tokenize(expression) {
  return expression
    .replace(/[()]/g, (paren) => ` ${paren} `)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when an SPDX licence expression is satisfied by `allowed`:
 * `A OR B` needs one side, `A AND B` needs both, and `A WITH B` is looked up as a whole,
 * so an exception clause is only accepted when that exact pair is on the list.
 * Anything that doesn't parse is not allowed.
 */
export function expressionAllowed(expression, allowed) {
  if (typeof expression !== 'string' || expression.trim() === '') return false;
  const tokens = tokenize(expression);
  let pos = 0;

  function primary() {
    const token = tokens[pos++];
    if (token === undefined) throw new Error('unexpected end');
    if (token === '(') {
      const value = orExpr();
      if (tokens[pos++] !== ')') throw new Error('unbalanced parenthesis');
      return value;
    }
    if (token === ')' || /^(AND|OR|WITH)$/i.test(token)) throw new Error(`unexpected ${token}`);
    if (tokens[pos]?.toUpperCase() === 'WITH') {
      const exception = tokens[pos + 1];
      if (exception === undefined) throw new Error('WITH without an exception');
      pos += 2;
      return allowed.has(`${token} WITH ${exception}`);
    }
    return allowed.has(token);
  }
  function andExpr() {
    let value = primary();
    while (tokens[pos]?.toUpperCase() === 'AND') {
      pos++;
      value = primary() && value;
    }
    return value;
  }
  function orExpr() {
    let value = andExpr();
    while (tokens[pos]?.toUpperCase() === 'OR') {
      pos++;
      value = andExpr() || value;
    }
    return value;
  }

  try {
    const value = orExpr();
    return pos === tokens.length && value;
  } catch {
    return false;
  }
}

/** Throws when an exception entry is malformed, so a reasonless exception can't be added. */
export function validateExceptions(exceptions) {
  for (const [name, entry] of Object.entries(exceptions)) {
    if (typeof entry?.reason !== 'string' || entry.reason.trim().length < 10) {
      throw new Error(`licence exception for ${name} needs a reason (at least a sentence)`);
    }
    if (typeof entry.licence !== 'string' || entry.licence === '') {
      throw new Error(`licence exception for ${name} must name the exact licence it covers`);
    }
    if (!['prod', 'dev', 'both'].includes(entry.scope)) {
      throw new Error(`licence exception for ${name} needs scope 'prod', 'dev' or 'both'`);
    }
    if (FORBIDDEN.test(entry.licence)) {
      throw new Error(`licence exception for ${name}: ${entry.licence} can never be excepted`);
    }
  }
}

/**
 * Classifies one `pnpm licenses list --json` report.
 * The report is `{ [licence]: [{ name, versions, license, ... }] }`.
 * @param {Record<string, Array<{name: string, versions?: string[], license?: string}>>} report
 * @param {{allowed: Set<string>, exceptions?: typeof EXCEPTIONS, scope: 'prod' | 'dev'}} policy
 */
export function classify(report, { allowed, exceptions = {}, scope }) {
  validateExceptions(exceptions);
  const violations = [];
  const excepted = [];
  const usedExceptions = new Set();
  let checked = 0;

  for (const [group, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      checked++;
      const licence = pkg.license ?? group;
      const versions = (pkg.versions ?? []).join(', ');
      if (expressionAllowed(licence, allowed)) continue;

      const exception = exceptions[pkg.name];
      const applies =
        exception &&
        exception.licence === licence &&
        (exception.scope === 'both' || exception.scope === scope);
      if (applies && !FORBIDDEN.test(licence)) {
        usedExceptions.add(pkg.name);
        excepted.push({ name: pkg.name, versions, licence, reason: exception.reason });
      } else {
        violations.push({ name: pkg.name, versions, licence });
      }
    }
  }

  const unused = Object.entries(exceptions)
    .filter(([name, e]) => (e.scope === 'both' || e.scope === scope) && !usedExceptions.has(name))
    .map(([name]) => name);

  return { checked, violations, excepted, unused };
}

function pnpmReport(flag) {
  const out = execFileSync('pnpm', ['licenses', 'list', '--json', flag], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // pnpm prints nothing (not `{}`) when there are no dependencies in scope.
  return out.trim() === '' ? {} : JSON.parse(out);
}

function run(scopes) {
  let failed = false;
  for (const scope of scopes) {
    const allowed = scope === 'prod' ? RUNTIME_ALLOWED : DEV_ALLOWED;
    const label = scope === 'prod' ? 'runtime (--prod)' : 'dev (--dev)';
    const result = classify(pnpmReport(`--${scope}`), { allowed, exceptions: EXCEPTIONS, scope });

    for (const e of result.excepted) {
      console.log(`  excepted  ${e.name}@${e.versions}  ${e.licence}: ${e.reason}`);
    }
    for (const name of result.unused) {
      console.log(`  note: exception for ${name} matched nothing in ${label}; remove it?`);
    }
    if (result.violations.length > 0) {
      failed = true;
      console.error(`licences: ${result.violations.length} ${label} package(s) not allowed:`);
      for (const v of result.violations) {
        console.error(`  ${v.name}@${v.versions}  ${v.licence}`);
      }
    } else {
      console.log(`licences: ${label}: ${result.checked} packages, all allowed`);
    }
  }
  if (failed) {
    console.error(
      'Fix: replace the package, or add it to EXCEPTIONS in scripts/check-licences.mjs with a reason (D151, D187).',
    );
  }
  return failed ? 1 : 0;
}

function isEntrypoint() {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--prod' && a !== '--dev');
  if (unknown.length > 0) {
    console.error(`usage: check-licences.mjs [--prod] [--dev]  (unknown: ${unknown.join(' ')})`);
    process.exit(2);
  }
  const scopes = args.length === 0 ? ['prod', 'dev'] : args.map((a) => a.slice(2));
  process.exitCode = run(scopes);
}
