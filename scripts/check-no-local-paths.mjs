#!/usr/bin/env node
// Fails when a tracked file holds something that is only true on one machine or one private
// network: a developer's home directory, a tool's temp directory, a tailnet host name, a private
// (RFC 1918) or shared (RFC 6598: carrier-grade NAT, and the range Tailscale hands out) IPv4
// address outside the files allowed to use one, or one of the developer's own private terms.
// Such values leak who built Kept and where, and break on every other machine.
//
// Usage: node scripts/check-no-local-paths.mjs   (part of `pnpm lint`)
// A file that genuinely needs a private address as an example (a test, a range definition, an
// install guide) goes on PRIVATE_IPV4_ALLOWED below, with the reason. Prefer the documentation
// ranges (RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) where any address will do.
//
// Private terms: words only one developer should never publish (their own host names, internal
// domain, other private projects) can't be written here, because this file is public and would
// publish them itself. They live in `.private-terms` at the repository root, which git ignores:
// one term per line, `#` starts a comment. KEPT_PRIVATE_TERMS adds more, comma-separated. Each is
// matched as a literal string, ignoring case. Without either, only the generic rules run.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SELF = ['scripts/check-no-local-paths.mjs', 'scripts/check-no-local-paths.test.mjs'];

/** Line rules: each `re` is global so every match on a line is reported. */
export const RULES = [
  {
    id: 'home-directory',
    // /Users/<name>/, /home/<name>/, C:\Users\<name>
    re: /\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g,
  },
  {
    id: 'temp-directory',
    // macOS's /private/tmp/<x> and /private/var/<x>, the per-user /var/folders/<x>/, and an AI
    // coding tool's /tmp/claude-<uid> scratch directories.
    re: /\/private\/(?:tmp|var)\/[A-Za-z0-9._-]+|\/var\/folders\/[A-Za-z0-9_+-]+\/|\/tmp\/claude-[0-9]+/g,
  },
  {
    id: 'dashed-home-path',
    // A home path flattened into one directory name (-Users-<name>-<project>).
    re: /-Users-[A-Za-z0-9._]+-/g,
  },
  {
    id: 'tailnet-host',
    // <machine>.<tailnet>.ts.net with real names; the placeholder form `<machine>.<tailnet>.ts.net`
    // and a bare `.ts.net` don't match.
    re: /[A-Za-z0-9-]+\.ts\.net\b/g,
  },
];

/** The git-ignored file of private terms, at the repository root. */
export const PRIVATE_TERMS_FILE = '.private-terms';

/**
 * The private terms for the repository at `cwd`: the lines of `.private-terms` (blank lines and
 * `#` comments skipped) and KEPT_PRIVATE_TERMS (comma-separated), trimmed and de-duplicated.
 */
export function loadPrivateTerms(cwd, env = process.env) {
  let lines = [];
  try {
    lines = readFileSync(path.join(cwd, PRIVATE_TERMS_FILE), 'utf8').split(/\r?\n/);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const fromFile = lines.map((l) => l.replace(/#.*/, '').trim());
  const fromEnv = (env.KEPT_PRIVATE_TERMS ?? '').split(',').map((t) => t.trim());
  return [...new Set([...fromFile, ...fromEnv].filter(Boolean))];
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Files that may hold a private IPv4 address. Tests and their fixtures by pattern; everything
// else by exact path, with the reason.
const TEST_FILE = [
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)(test|e2e|mock)\//,
  /^charts\/kept\/ci\//, // chart-testing values and their golden renders
];
export const PRIVATE_IPV4_ALLOWED = new Map([
  ['apps/server/src/net/ssrf.ts', 'defines the private ranges'],
  ['apps/server/src/auth/client-ip.ts', 'a doc-comment example of an IPv4-mapped address'],
  ['apps/web/src/components/import/inspect-step.tsx', 'a LAN address as an input placeholder'],
  ['compose.yaml', "Kept's own Compose network"],
  ['apps/docs/src/content/docs/install/https.md', "Kept's own Compose network"],
  ['apps/docs/src/content/docs/install/reverse-proxy.md', 'an example proxy address'],
  ['docs/design/kept-screens.html', 'sample data on the design board'],
  ['docs/design/screens/02-browse-things.html', 'sample data on the design board'],
  ['docs/design/screens/08-portability.html', 'sample data on the design board'],
  ['docs/plans/2026-09-26-step-3-capture.md', 'quotes a test value'],
  ['docs/plans/2026-09-30-step-4-household.md', 'quotes a test value'],
  ['docs/plans/2026-09-30-step-6-assistant-mcp.md', 'quotes a test value'],
  ['docs/spikes/2026-09-30-step6-oauth-cimd.md', "quotes the spike's test value"],
  ['docs/spikes/code/step6/oauth/run.ts', 'spike test code'],
  ['docs/spikes/code/step6/oauth/results.json', 'spike test output'],
  ['docs/release/go-public-audit.md', 'quotes the example values it checked'],
]);

export function privateIpv4Allowed(file) {
  return PRIVATE_IPV4_ALLOWED.has(file) || TEST_FILE.some((re) => re.test(file));
}

// RFC 1918 (10/8, 172.16/12, 192.168/16) and RFC 6598 (100.64/10).
function isPrivateIpv4([a, b]) {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The findings on one line of `file`: `[{ rule, match }]`. `terms`: the private terms. */
export function scanLine(file, text, terms = []) {
  const found = [];
  for (const { id, re } of RULES) {
    for (const m of text.matchAll(re)) found.push({ rule: id, match: m[0] });
  }
  for (const term of terms) {
    for (const m of text.matchAll(new RegExp(escapeRegExp(term), 'gi'))) {
      found.push({ rule: 'private-term', match: m[0] });
    }
  }
  if (!privateIpv4Allowed(file)) {
    for (const m of text.matchAll(
      /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g,
    )) {
      const octets = m.slice(1, 5).map(Number);
      if (octets.every((o) => o <= 255) && isPrivateIpv4(octets)) {
        found.push({ rule: 'private-ipv4', match: m[0] });
      }
    }
  }
  return found;
}

// A cheap superset of every generic rule, so only candidate lines reach scanLine.
const PREFILTER = String.raw`/Users/|/home/|:\\Users\\|/private/|/var/folders/|/tmp/claude-|-Users-|\.ts\.net|(^|[^0-9.])(10|100|172|192)\.[0-9]+\.[0-9]+\.[0-9]+`;

/** A private term as a literal in a POSIX extended regular expression (git grep -E). */
const escapeEre = (s) => s.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&');

/**
 * Every finding in the tracked files of the repository at `cwd`. `terms`: the private terms,
 * by default those of `cwd`'s `.private-terms` and KEPT_PRIVATE_TERMS.
 */
export function findLeaks(cwd, terms = loadPrivateTerms(cwd)) {
  const prefilter = [PREFILTER, ...terms.map(escapeEre)].join('|');
  let out = '';
  try {
    out = execFileSync(
      'git',
      ['grep', '-z', '-nIiE', prefilter, '--', '.', ...SELF.map((f) => `:!${f}`)],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    if (e.status === 1) return []; // no candidate lines
    throw e;
  }
  const findings = [];
  // -z: "<file>\0<line>\0<text>\n" per match.
  for (const record of out.split('\n')) {
    if (!record) continue;
    const [file, line, ...rest] = record.split('\0');
    for (const f of scanLine(file, rest.join('\0'), terms))
      findings.push({ file, line: Number(line), ...f });
  }
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const findings = findLeaks(repo);
  if (findings.length > 0) {
    console.error('Machine-local paths, private hosts or private addresses in tracked files:');
    for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}: ${f.match}`);
    console.error(
      'Use a placeholder (<name>, <machine>.<tailnet>.ts.net) or an RFC 5737 address; a file that ' +
        'needs a private address goes on PRIVATE_IPV4_ALLOWED in scripts/check-no-local-paths.mjs. ' +
        'A private-term finding matched your own .private-terms or KEPT_PRIVATE_TERMS: reword it.',
    );
    process.exit(1);
  }
}
