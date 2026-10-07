#!/usr/bin/env node
// THIRD-PARTY-NOTICES.txt (D151; step-8 plan T15; spike R3, docs/spikes/2026-10-06-step8-image.md).
//
// Run by the Dockerfile's `notices` stage, once per architecture, against the image's own pruned
// node_modules: `pnpm licenses list` on a laptop names the laptop's platform binaries and the
// tooling the prune removes, so it is the wrong list (spike R3). The file names every npm package
// the image ships with its licence and the licence's full text (the package's own LICENSE/NOTICE
// files; for a package that ships none, the standard text of the licence its package.json names),
// then Node.js, restic and the Debian packages with theirs. The build copies it to
// /app/THIRD-PARTY-NOTICES.txt; the release attaches it (T17).
//
// It is also the image's licence scan: a shipped package whose licence is off the runtime
// allowlist in scripts/check-licences.mjs (D151, D187) fails the build, with the same rules and
// exceptions as `node scripts/check-licences.mjs --prod`.
//
//   node third-party-notices.mjs --store <node_modules/.pnpm> --out <file>
//     [--version <kept version>] [--arch <amd64|arm64>]
//     [--texts <dir>]...                          standard licence texts, <dir>/<SPDX id>[.txt]
//     [--node-licence <file> --node-version <v>]  Node.js's LICENSE (not in the base image)
//     [--restic-licence <file> --restic-version <v>]
//     [--dpkg <tsv>] [--dpkg-docs <dir>]          `dpkg-query -W -f '${Package}\t${Version}\n'`,
//                                                 and /usr/share/doc for each one's copyright
//     [--extra <name>|<licence>|<file>]...        anything else shipped (the report's fonts)
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classify, EXCEPTIONS, RUNTIME_ALLOWED } from './check-licences.mjs';

const RULE = '='.repeat(100);
const THIN = '-'.repeat(100);

/** `name@version_peers` → the package name (`@scope+name@…` → `@scope/name`). */
export function nameOfEntry(entry) {
  const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0);
  if (at <= 0) return null;
  return entry.slice(0, at).replace('+', '/');
}

/** The SPDX expression a package.json declares; the old `licenses` array is an OR. */
export function licenceOf(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim() !== '') return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) return `(${ids.join(' OR ')})`;
  }
  return 'UNKNOWN';
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(?:[._-].*)?$/i;

/** A package's licence and notice files, LICENSE/COPYING before NOTICE, then by name. */
export function licenceFilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f) && lstatSync(join(dir, f)).isFile())
    .sort((a, b) => {
      const rank = (f) => (/^notice/i.test(f) ? 1 : 0);
      return rank(a) - rank(b) || a.localeCompare(b);
    })
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
}

const repoOf = (pkg) => {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return r ? r.replace(/^git\+/, '').replace(/\.git$/, '') : (pkg.homepage ?? null);
};

/**
 * Every package in a pnpm virtual store, once per name@version (pnpm keeps one entry per peer
 * set, all with the same files), sorted.
 */
export function readStore(store) {
  const byId = new Map();
  for (const entry of readdirSync(store)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const name = nameOfEntry(entry);
    if (!name) continue;
    const dir = join(store, entry, 'node_modules', ...name.split('/'));
    if (!existsSync(join(dir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const id = `${pkg.name ?? name}@${pkg.version}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      name: pkg.name ?? name,
      version: pkg.version,
      licence: licenceOf(pkg),
      repository: repoOf(pkg),
      files: licenceFilesIn(dir),
      dir,
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/** The scan: the packages as the `pnpm licenses list --json` report classify() expects. */
export function scan(packages) {
  const report = {};
  for (const p of packages) {
    report[p.licence] ??= [];
    report[p.licence].push({ name: p.name, versions: [p.version], license: p.licence });
  }
  return classify(report, { allowed: RUNTIME_ALLOWED, exceptions: EXCEPTIONS, scope: 'prod' });
}

/** The SPDX identifiers in an expression (`(MIT OR Apache-2.0)` → MIT, Apache-2.0). */
export function idsOf(expression) {
  return expression
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '' && !/^(AND|OR|WITH)$/i.test(t));
}

/** Debian's /usr/share/common-licenses names for SPDX identifiers it holds under another name. */
const DEBIAN_NAMES = {
  'LGPL-3.0-only': 'LGPL-3',
  'LGPL-3.0-or-later': 'LGPL-3',
  'GPL-3.0-only': 'GPL-3',
  'GPL-3.0-or-later': 'GPL-3',
  'LGPL-2.1-only': 'LGPL-2.1',
  'LGPL-2.1-or-later': 'LGPL-2.1',
};

/** The standard text of an SPDX licence from the first texts directory that has it. The LGPL
 * v3 is a set of additional permissions on the GPL v3, so its text comes with the GPL's. */
export function standardText(id, textDirs) {
  const names = [id, `${id}.txt`, ...(DEBIAN_NAMES[id] ? [DEBIAN_NAMES[id]] : [])];
  for (const dir of textDirs) {
    for (const name of names) {
      const file = join(dir, name);
      if (existsSync(file) && lstatSync(file).isFile()) {
        const text = readFileSync(file, 'utf8');
        if (!/^LGPL-3\.0/.test(id)) return text;
        const gpl = standardText('GPL-3.0-only', textDirs);
        return gpl ? `${text}\n\n[GPL-3.0, which the LGPL-3.0 incorporates]\n\n${gpl}` : null;
      }
    }
  }
  return null;
}

const norm = (text) => text.replace(/\r\n?/g, '\n').trim();
const key = (text) => norm(text).replace(/\s+/g, ' ');

/**
 * The notices file. Packages whose licence files are identical share one copy of the text;
 * packages with no file share the licence's standard text, one copy per licence.
 */
export function render(opts) {
  const {
    packages,
    version = '0.0.0-dev',
    arch = 'unknown',
    node = null,
    restic = null,
    dpkg = [],
    dpkgDocs = null,
    extras = [],
    textDirs = [],
  } = opts;
  const out = [];
  const line = (s = '') => out.push(s);
  const section = (title) => {
    line();
    line(RULE);
    line(title);
    line(RULE);
  };

  line(`Third-party software in the Kept ${version} image (linux/${arch})`);
  line();
  line('Kept itself is licensed under the GNU Affero General Public License v3.0 only');
  line('(/app/LICENSE). This file lists the third-party software the image ships beside it, each');
  line("with its licence's full text. It is generated at build time from the image's own files");
  line('(scripts/third-party-notices.mjs), so it lists exactly what this architecture ships.');
  line();
  line('Contents');
  if (node) line('  1. Node.js');
  if (restic) line('  2. restic');
  line(`  3. npm packages (${packages.length})`);
  if (extras.length > 0) line(`  4. Other files (${extras.length})`);
  if (dpkg.length > 0) line(`  5. Debian packages (${dpkg.length})`);

  if (node) {
    section(`1. Node.js ${node.version}`);
    line('The runtime. Licence: MIT, plus the licences of the libraries it bundles, all below.');
    line(`Source: https://github.com/nodejs/node/tree/v${node.version}`);
    line();
    line(norm(node.text));
  }
  if (restic) {
    section(`2. restic ${restic.version}`);
    line('The backup engine, at /usr/local/bin/restic. Licence: BSD-2-Clause.');
    line(`Source: https://github.com/restic/restic/tree/v${restic.version}`);
    line();
    line(norm(restic.text));
  }

  section(`3. npm packages (${packages.length})`);
  line('In /app/node_modules. Each is shipped unmodified, as published to the npm registry.');
  line();
  for (const p of packages) line(`  ${p.name}@${p.version}  ${p.licence}`);

  const notes = specialNotes(packages);
  if (notes.length > 0) {
    line();
    line('Notes on particular packages:');
    for (const n of notes) {
      line();
      for (const l of n) line(`  ${l}`);
    }
  }

  // Identical licence files → one text for the group.
  const groups = new Map();
  const bare = new Map();
  for (const p of packages) {
    if (p.files.length > 0) {
      const k = p.files.map((f) => key(f.text)).join('\u0001');
      if (!groups.has(k)) groups.set(k, { files: p.files, members: [] });
      groups.get(k).members.push(p);
    } else {
      if (!bare.has(p.licence)) bare.set(p.licence, []);
      bare.get(p.licence).push(p);
    }
  }
  for (const g of groups.values()) {
    line();
    line(THIN);
    for (const p of g.members) line(`${p.name}@${p.version}  (${p.licence})`);
    for (const f of g.files) {
      line();
      if (g.files.length > 1) line(`[${f.name}]`);
      line(norm(f.text));
    }
  }
  for (const [licence, members] of [...bare.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    line();
    line(THIN);
    for (const p of members) {
      line(`${p.name}@${p.version}  (${licence})${p.repository ? `  ${p.repository}` : ''}`);
    }
    line();
    line(
      `These packages ship no licence file; their package.json names ${licence}, whose standard text follows.`,
    );
    for (const id of idsOf(licence)) {
      const text = standardText(id, textDirs);
      line();
      line(`[${id}]`);
      line(text ? norm(text) : `(the standard text: https://spdx.org/licenses/${id}.html)`);
    }
  }

  if (extras.length > 0) {
    section(`4. Other files (${extras.length})`);
    for (const e of extras) {
      line();
      line(THIN);
      line(`${e.name}  (${e.licence})`);
      line();
      line(norm(e.text));
    }
  }

  if (dpkg.length > 0) {
    section(`5. Debian packages (${dpkg.length})`);
    line('The operating system: Debian 12 (bookworm) from the Node.js base image, with');
    line('postgresql-client-18 and libpq5 from apt.postgresql.org and openssh-client from Debian.');
    line("Each package's copyright and licence file is /usr/share/doc/<package>/copyright in the");
    line('image; their texts follow the list. Debian source packages: https://sources.debian.org/');
    line();
    for (const d of dpkg) line(`  ${d.name}  ${d.version}`);
    if (dpkgDocs) {
      for (const d of dpkg) {
        const file = join(dpkgDocs, d.name, 'copyright');
        if (!existsSync(file)) continue;
        line();
        line(THIN);
        line(`${d.name} ${d.version}  (/usr/share/doc/${d.name}/copyright)`);
        line();
        line(norm(readFileSync(file, 'utf8')));
      }
    }
  }
  line();
  return out.join('\n');
}

/** The packages whose licence asks more than a notice (spike R3), and the one with no file. */
export function specialNotes(packages) {
  const notes = [];
  for (const p of packages) {
    if (/^@img\/sharp-libvips-/.test(p.name)) {
      notes.push([
        `${p.name}@${p.version} (${p.licence}): libvips and the libraries it is built with,`,
        'prebuilt shared libraries that sharp loads at run time. They ship unmodified, as',
        'published, in their own package, and can be replaced with a build of your own.',
        `Source: ${p.repository ?? 'https://github.com/lovell/sharp-libvips'} (its build scripts`,
        'name the version of every library) and https://github.com/libvips/libvips.',
      ]);
    } else if (p.name === 'web-push') {
      notes.push([
        `web-push@${p.version} (${p.licence}): shipped unmodified, as published to npm; its`,
        `source is the package itself (in /app/node_modules) and ${p.repository}.`,
      ]);
    } else if (/^@myriaddreamin\/typst-ts-node-compiler-/.test(p.name) && p.files.length === 0) {
      notes.push([
        `${p.name}@${p.version} (${p.licence}): the Typst compiler, a native binary. The package`,
        "ships no licence file, so the licence's standard text is given below. The Rust crates",
        'compiled into it carry their own licences, listed by its upstream projects:',
        `${p.repository ?? 'https://github.com/Myriad-Dreamin/typst.ts'} and https://github.com/typst/typst.`,
      ]);
    }
  }
  return notes;
}

function parseArgs(argv) {
  const opts = { texts: [], extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const name = a.slice(2);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${a} needs a value`);
    if (name === 'texts' || name === 'extra') opts[name].push(value);
    else opts[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return opts;
}

function main(argv) {
  const o = parseArgs(argv);
  if (!o.store || !o.out) throw new Error('--store and --out are required');
  const packages = readStore(o.store);
  const result = scan(packages);
  for (const e of result.excepted) {
    console.log(`  excepted  ${e.name}@${e.versions}  ${e.licence}: ${e.reason}`);
  }
  if (result.violations.length > 0) {
    console.error(`notices: ${result.violations.length} shipped package(s) not allowed (D151):`);
    for (const v of result.violations) console.error(`  ${v.name}@${v.versions}  ${v.licence}`);
    return 1;
  }
  const dpkg = o.dpkg
    ? readFileSync(o.dpkg, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [name, version] = l.split('\t');
          return { name, version };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const text = render({
    packages,
    version: o.version,
    arch: o.arch,
    node: o.nodeLicence
      ? { version: o.nodeVersion ?? '?', text: readFileSync(o.nodeLicence, 'utf8') }
      : null,
    restic: o.resticLicence
      ? { version: o.resticVersion ?? '?', text: readFileSync(o.resticLicence, 'utf8') }
      : null,
    dpkg,
    dpkgDocs: o.dpkgDocs ?? null,
    extras: o.extra.map((spec) => {
      const [name, licence, file] = spec.split('|');
      return { name, licence, text: readFileSync(file, 'utf8') };
    }),
    textDirs: o.texts,
  });
  const tmp = join(dirname(o.out), `.${Date.now()}.notices.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, o.out);
  const missing = [...new Set(packages.filter((p) => p.files.length === 0).map((p) => p.licence))]
    .flatMap(idsOf)
    .filter((id) => !standardText(id, o.texts));
  console.log(
    `notices: ${packages.length} npm packages, all allowed; ${dpkg.length} Debian packages; ${(text.length / 1024).toFixed(0)} KiB → ${o.out}`,
  );
  if (missing.length > 0) {
    console.error(`notices: no standard text for ${[...new Set(missing)].join(', ')} (--texts)`);
    return 1;
  }
  return 0;
}

function isEntrypoint() {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`notices: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 2;
  }
}
