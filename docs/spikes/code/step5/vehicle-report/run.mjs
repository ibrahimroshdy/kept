// SPIKE (step 5, T0, V39). Renders one job directory with the report engine's own child process
// (apps/server/src/reports/render/child.mjs), started the way render.ts starts it: its own 64 MB
// V8 heap, no inherited environment, the fonts from apps/server/assets/fonts. The watch is
// render.ts's too (resident size every 100 ms through `ps`), and macOS's /usr/bin/time -l adds
// the true maximum resident size, which sampling can miss.
//
//   node run.mjs <jobDir>     → one JSON line: ms, peak (sampled), maxRss, bytes, pages
import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../../..');
const CHILD = path.join(root, 'apps/server/src/reports/render/child.mjs');
const FONTS = path.join(root, 'apps/server/assets/fonts');
const TEMPLATE = path.join(here, 'vehicle.typ');
/** render.ts: RENDER_MEMORY_MB, RENDER_TIMEOUT_MS, CHILD_HEAP_MB, POLL_MS. */
const LIMIT_MB = 512;
const TIMEOUT_MS = 60_000;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node run.mjs <jobDir>');
  process.exit(2);
}

const started = performance.now();
const timeProc = spawn(
  '/usr/bin/time',
  ['-l', process.execPath, '--max-old-space-size=64', CHILD, dir, TEMPLATE, FONTS],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } },
);
let stderr = '';
timeProc.stderr.setEncoding('utf8');
timeProc.stderr.on('data', (c) => {
  stderr += c;
});
let stdout = '';
timeProc.stdout.setEncoding('utf8');
timeProc.stdout.on('data', (c) => {
  stdout += c;
});

let childPid = null;
let peakMb = 0;
let polling = false;
const poll = setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    if (!childPid) {
      const { stdout: p } = await run('pgrep', ['-P', String(timeProc.pid)]);
      childPid = Number(p.trim().split('\n')[0]) || null;
    }
    if (childPid) {
      const { stdout: rss } = await run('ps', ['-o', 'rss=', '-p', String(childPid)]);
      const kb = Number(rss.trim());
      if (Number.isFinite(kb) && kb > 0) peakMb = Math.max(peakMb, kb / 1024);
    }
  } catch {
    // Gone.
  }
  polling = false;
}, 100);
const timer = setTimeout(() => timeProc.kill('SIGKILL'), TIMEOUT_MS);
const code = await new Promise((r) => timeProc.once('exit', r));
clearInterval(poll);
clearTimeout(timer);
const ms = Math.round(performance.now() - started);

const maxRss = Number(/(\d+)\s+maximum resident set size/.exec(stderr)?.[1] ?? 0) / 1024 / 1024;
const footprint = Number(/(\d+)\s+peak memory footprint/.exec(stderr)?.[1] ?? 0) / 1024 / 1024;
if (code !== 0) {
  console.error(stderr.slice(0, 3000));
  process.exit(1);
}
const pdf = path.join(dir, 'out.pdf');
const { stdout: info } = await run('pdfinfo', [pdf]);
const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1]);
const child = JSON.parse(stdout.trim().split('\n').pop());
console.log(
  JSON.stringify({
    dir: path.basename(dir),
    wallMs: ms,
    compileMs: child.ms,
    sampledPeakMb: Math.round(peakMb),
    maxRssMb: Math.round(maxRss),
    peakFootprintMb: Math.round(footprint),
    limitMb: LIMIT_MB,
    underLimit: maxRss < LIMIT_MB,
    under60s: ms < 60_000,
    pdfMb: +(statSync(pdf).size / 1024 / 1024).toFixed(1),
    pages,
  }),
);
