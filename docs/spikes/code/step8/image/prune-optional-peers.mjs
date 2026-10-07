// Step-8 spike R3: drop what better-auth's *optional* peers drag into the production install.
//
// pnpm links an optional peer whenever the workspace has it (vitest, drizzle-kit), and none of
// resolvePeersFromWorkspaceRoot: false, dedupePeerDependents: false, an override to '-', or a
// packageExtensions narrowing changed that in the lockfile (pnpm 11.23.0; see the spike note).
// So the prod-deps stage prunes after `pnpm install --prod`: walk the pnpm virtual store from the
// shipped packages' own node_modules, refuse to follow better-auth → {vitest, drizzle-kit}, and
// delete every store entry the walk never reached, plus the symlinks left pointing at them.
//
//   node prune-optional-peers.mjs <workspace root> [--dry-run]
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const store = join(root, 'node_modules', '.pnpm');
const CUT_FROM = /^(better-auth|@better-auth\+[^@]+)@/;
const CUT_TO = /^(vitest|drizzle-kit)@/;

const entryOf = (p) => {
  const rel = relative(store, p);
  return rel.startsWith('..') ? null : rel.split(sep)[0];
};
const linksIn = (dir) => {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name.startsWith('@') && lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink()) {
      for (const n of readdirSync(p)) out.push(join(p, n));
    } else out.push(p);
  }
  return out;
};
const depsOf = (entry) => {
  const out = new Set();
  for (const p of linksIn(join(store, entry, 'node_modules'))) {
    try {
      const e = entryOf(realpathSync(p));
      if (e && e !== entry) out.add(e);
    } catch {}
  }
  return out;
};

const roots = new Set();
for (const pkg of ['apps/server', 'packages/shared', 'packages/mcp']) {
  for (const p of linksIn(join(root, pkg, 'node_modules'))) {
    try {
      const e = entryOf(realpathSync(p));
      if (e) roots.add(e);
    } catch {}
  }
}
const seen = new Set();
const queue = [...roots];
while (queue.length) {
  const e = queue.pop();
  if (seen.has(e)) continue;
  seen.add(e);
  for (const d of depsOf(e)) if (!(CUT_FROM.test(e) && CUT_TO.test(d))) queue.push(d);
}
const all = readdirSync(store).filter((n) => n !== 'node_modules' && !n.startsWith('.') && lstatSync(join(store, n)).isDirectory());
const drop = all.filter((e) => !seen.has(e));
const size = (p) => {
  let n = 0;
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return 0;
  if (st.isDirectory()) for (const c of readdirSync(p)) n += size(join(p, c));
  else n += st.size;
  return n;
};
let bytes = 0;
for (const e of drop) bytes += size(join(store, e));
console.log(JSON.stringify({ entries: all.length, reachable: seen.size, dropped: drop.length, droppedMiB: +(bytes / 2 ** 20).toFixed(1), drop: drop.sort() }, null, 1));
if (!dryRun) {
  for (const e of drop) rmSync(join(store, e), { recursive: true, force: true });
  // Symlinks now pointing nowhere: the hoisted ones and better-auth's links to the cut peers.
  const dirs = [join(store, 'node_modules'), join(root, 'node_modules'), ...[...seen].map((e) => join(store, e, 'node_modules'))];
  for (const d of dirs) for (const p of linksIn(d)) {
    try { statSync(p); } catch { if (lstatSync(p).isSymbolicLink()) rmSync(p); }
  }
}
