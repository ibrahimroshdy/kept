// The image trim (step-8 plan T15; spike R3, docs/spikes/2026-10-06-step8-image.md): drop what
// better-auth's *optional* peers drag into the production install.
//
// pnpm links an optional peer whenever the workspace has it (vitest, drizzle-kit), and none of
// resolvePeersFromWorkspaceRoot: false, dedupePeerDependents: false, an override to '-', or a
// packageExtensions narrowing changed that in the lockfile (pnpm 11.23.0; see the spike note).
// So the Dockerfile's prod-deps stage prunes right after `pnpm install --prod`: walk the pnpm
// virtual store from the shipped packages' own node_modules, refuse to follow better-auth →
// {vitest, drizzle-kit}, and delete every store entry the walk never reached, plus the symlinks
// left pointing at them. better-auth imports vitest only from dist/test-utils, which Kept never
// loads; scripts/smoke-image.sh is what proves the pruned image still runs.
//
//   node prune-optional-peers.mjs <workspace root> [--dry-run]
//
// Prints one JSON summary (entries, reachable, dropped, droppedMiB, drop[]) on stdout.
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: prune-optional-peers.mjs <workspace root> [--dry-run]');
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');
const store = join(root, 'node_modules', '.pnpm');
const SHIPPED = ['apps/server', 'packages/shared', 'packages/mcp'];
const CUT_FROM = /^(better-auth|@better-auth\+[^@]+)@/;
const CUT_TO = /^(vitest|drizzle-kit)@/;

/** The store entry (`name@version_peers`) a resolved path lies in, or null outside the store. */
const entryOf = (p) => {
  const rel = relative(store, p);
  return rel.startsWith('..') ? null : rel.split(sep)[0];
};

/** Every package link in a node_modules directory, scoped ones included. */
const linksIn = (dir) => {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (name.startsWith('@') && st.isDirectory() && !st.isSymbolicLink()) {
      for (const n of readdirSync(p)) out.push(join(p, n));
    } else out.push(p);
  }
  return out;
};

const entriesLinkedFrom = (dir, self) => {
  const out = new Set();
  for (const p of linksIn(dir)) {
    try {
      const e = entryOf(realpathSync(p));
      if (e && e !== self) out.add(e);
    } catch {
      // A dangling link: nothing to follow.
    }
  }
  return out;
};

const roots = new Set();
for (const pkg of SHIPPED) {
  for (const e of entriesLinkedFrom(join(root, pkg, 'node_modules'))) roots.add(e);
}
const seen = new Set();
const queue = [...roots];
while (queue.length > 0) {
  const e = queue.pop();
  if (seen.has(e)) continue;
  seen.add(e);
  for (const d of entriesLinkedFrom(join(store, e, 'node_modules'), e)) {
    if (!(CUT_FROM.test(e) && CUT_TO.test(d))) queue.push(d);
  }
}

const all = readdirSync(store).filter(
  (n) => n !== 'node_modules' && !n.startsWith('.') && lstatSync(join(store, n)).isDirectory(),
);
const drop = all.filter((e) => !seen.has(e)).sort();
const size = (p) => {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const c of readdirSync(p)) n += size(join(p, c));
  return n;
};
let bytes = 0;
for (const e of drop) bytes += size(join(store, e));
const summary = {
  entries: all.length,
  reachable: seen.size,
  dropped: drop.length,
  droppedMiB: +(bytes / 2 ** 20).toFixed(1),
  drop,
};
console.log(JSON.stringify(summary, null, 1));

if (!dryRun) {
  for (const e of drop) rmSync(join(store, e), { recursive: true, force: true });
  // Symlinks now pointing nowhere: the hoisted ones and better-auth's links to the cut peers.
  const dirs = [
    join(store, 'node_modules'),
    join(root, 'node_modules'),
    ...[...seen].map((e) => join(store, e, 'node_modules')),
  ];
  for (const d of dirs) {
    for (const p of linksIn(d)) {
      try {
        statSync(p);
      } catch {
        if (lstatSync(p).isSymbolicLink()) rmSync(p);
      }
    }
  }
}
