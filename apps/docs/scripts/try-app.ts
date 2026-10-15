// Try Kept (D246): builds the web app's demo for the docs site (`pnpm --filter @kept/web
// build:try`, apps/web/src/try/flag.ts) with its base under this site's base, and copies it into
// public/try/kept/app/ (git-ignored), which Astro serves in dev and copies into dist/ as it is.
// Run by `build` before `astro build`; run it once by hand for `dev`.
//
//   pnpm --filter @kept/docs gen:try
//
// The web app's manifest is left out: the Try build links none (no install, no worker).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRY_APP_PATH, tryAppBase } from '../src/try-kept.js';

const docs = fileURLToPath(new URL('../', import.meta.url));
const built = fileURLToPath(new URL('../../web/dist-try/', import.meta.url));
const target = `${docs}public/${TRY_APP_PATH}`;
const base = tryAppBase(process.env.KEPT_DOCS_BASE || '/');

const r = spawnSync('pnpm', ['--filter', '@kept/web', 'build:try'], {
  stdio: 'inherit',
  env: { ...process.env, KEPT_TRY_BASE: base },
});
if (r.status !== 0) process.exit(r.status ?? 1);
if (!existsSync(`${built}index.html`)) throw new Error('apps/web/dist-try/index.html is missing');

rmSync(target, { recursive: true, force: true });
cpSync(built, target, {
  recursive: true,
  filter: (src) => !src.endsWith('/manifest.webmanifest'),
});
console.log(`Try Kept: apps/web/dist-try → public/${TRY_APP_PATH} (base ${base})`);
