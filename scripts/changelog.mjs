#!/usr/bin/env node
// CHANGELOG.md from conventional commits (step 8 T17, plan Q12): the laptop release's changelog
// until release-please runs on GitHub (D187), which then starts from this file.
//
//   node scripts/changelog.mjs --version X.Y.Z [--from <ref>] [--to <ref>] [--date YYYY-MM-DD]
//                              [--write <CHANGELOG.md>]
//
// Commits in <from>..<to> (all of <to> without --from) are grouped: breaking changes (`type!:` or a
// `BREAKING CHANGE:` footer), features, fixes, performance, translations, documentation, and
// "Other" for a subject that isn't conventional. Tests, chores, CI, builds, style, refactors and
// spikes are left out: they change nothing a person running Kept sees. Without --write the section
// is printed; with it, the section goes in above the newest one (the file is made if missing).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CONVENTIONAL = /^(?<type>[a-z][a-z0-9]*)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: (?<subject>.+)$/;

export const GROUPS = [
  ['breaking', 'Breaking changes'],
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['i18n', 'Translations'],
  ['docs', 'Documentation'],
  ['other', 'Other'],
];

/** Conventional types that never reach the changelog. */
export const HIDDEN = new Set([
  'test',
  'chore',
  'ci',
  'build',
  'style',
  'refactor',
  'spike',
  'wip',
]);

export const HEADER = `# Changelog

Kept's releases, newest first. Written by \`scripts/changelog.mjs\` from the commits' conventional
subjects when a release is cut (\`scripts/release.sh\`).
`;

/** One commit → { group, scope, subject, hash }, or null when it is left out. */
export function classify({ hash, subject, body = '' }) {
  const m = CONVENTIONAL.exec(subject.trim());
  if (!m) return { group: 'other', scope: null, subject: subject.trim(), hash };
  const { type, scope, bang } = m.groups;
  const breaking = Boolean(bang) || /^BREAKING[ -]CHANGE: /m.test(body);
  if (breaking) return { group: 'breaking', scope: scope || null, subject: m.groups.subject, hash };
  if (HIDDEN.has(type)) return null;
  const group = GROUPS.some(([g]) => g === type) ? type : 'other';
  return {
    group,
    scope: scope || null,
    subject: group === 'other' ? subject.trim() : m.groups.subject,
    hash,
  };
}

/** The markdown section for one release. Commits are given newest first, as git log prints them. */
export function renderSection(version, date, commits) {
  const entries = commits.map(classify).filter(Boolean);
  const lines = [`## ${version} (${date})`, ''];
  if (!entries.length) lines.push('No user-facing changes.', '');
  for (const [group, title] of GROUPS) {
    const items = entries.filter((e) => e.group === group);
    if (!items.length) continue;
    lines.push(`### ${title}`, '');
    for (const e of items) {
      lines.push(`- ${e.scope ? `**${e.scope}:** ` : ''}${e.subject} (${e.hash.slice(0, 7)})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** `existing` with `section` placed above its newest release. */
export function insertSection(existing, section) {
  const text = existing?.trim() ? existing : HEADER;
  const at = text.search(/^## /m);
  const head = at === -1 ? `${text.trimEnd()}\n\n` : text.slice(0, at);
  const rest = at === -1 ? '' : text.slice(at);
  return `${head}${section.trimEnd()}\n${rest ? `\n${rest}` : ''}`;
}

/** Commits in the range, newest first. */
export function readCommits(from, to = 'HEAD', cwd = process.cwd()) {
  const range = from ? `${from}..${to}` : to;
  const out = execFileSync('git', ['log', '--format=%H%x1f%s%x1f%b%x1e', range], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [hash, subject, body] = r.split('\x1f');
      return { hash, subject, body };
    });
}

function args(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--') || i + 1 >= argv.length) throw new Error(`bad argument: ${k}`);
    opts[k.slice(2)] = argv[++i];
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = args(process.argv.slice(2));
    if (!opts.version) throw new Error('--version is required');
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date is YYYY-MM-DD');
    const section = renderSection(opts.version, date, readCommits(opts.from, opts.to ?? 'HEAD'));
    if (opts.write) {
      const existing = existsSync(opts.write) ? readFileSync(opts.write, 'utf8') : '';
      if (existing.includes(`\n## ${opts.version} (`)) {
        throw new Error(`${opts.write} already has a ${opts.version} section`);
      }
      const tmp = `${opts.write}.tmp-${process.pid}`;
      writeFileSync(tmp, insertSection(existing, section));
      renameSync(tmp, opts.write);
    } else {
      process.stdout.write(section);
    }
  } catch (err) {
    console.error(`changelog: ${err.message}`);
    process.exit(1);
  }
}
