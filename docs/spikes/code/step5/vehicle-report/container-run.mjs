// SPIKE (step 5, T0, V39). The same render inside Kept's own image (linux, the image's child.mjs,
// its addon and its fonts), under a hard memory limit, so the figure is Linux resident memory and
// not macOS's (which compresses pages under load and moves RSS around). Run from the host:
//
//   DOCKER_CONFIG=/tmp/kept-docker-config docker run --rm --memory 512m --memory-swap 512m \
//     --cpus 2 -v "$PWD:/spike:ro" --entrypoint node kept:ci-arm64 \
//     /spike/container-run.mjs /spike/.tmp/ar-200
//
// It copies the job to /tmp (the image runs as a non-root user), starts child.mjs the way
// render.ts does, and reads the child's VmHWM (true peak RSS) from /proc every 50 ms, plus the
// container's memory.peak (cgroup v2).
import { spawn } from 'node:child_process';
import { cpSync, readFileSync, statSync } from 'node:fs';

const [src] = process.argv.slice(2);
const job = '/tmp/job';
cpSync(src, job, { recursive: true });
const started = performance.now();
const child = spawn(
  process.execPath,
  [
    '--max-old-space-size=64',
    '/app/apps/server/dist/reports/render/child.mjs',
    job,
    '/spike/vehicle.typ',
    '/app/apps/server/assets/fonts',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } },
);
let err = '';
child.stderr.on('data', (c) => {
  err += c;
});
let hwm = 0;
const poll = setInterval(() => {
  try {
    const s = readFileSync(`/proc/${child.pid}/status`, 'utf8');
    const kb = Number(/^VmHWM:\s+(\d+)/m.exec(s)?.[1] ?? 0);
    hwm = Math.max(hwm, kb);
  } catch {}
}, 50);
const [code, signal] = await new Promise((r) => child.once('exit', (c, s) => r([c, s])));
clearInterval(poll);
const ms = Math.round(performance.now() - started);
let cgroupPeak = null;
try {
  cgroupPeak = Math.round(Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8')) / 1024 / 1024);
} catch {}
console.log(
  JSON.stringify({
    job: src.split('/').pop(),
    code,
    signal,
    ms,
    childPeakRssMb: Math.round(hwm / 1024),
    containerPeakMb: cgroupPeak,
    pdfMb: code === 0 ? +(statSync(`${job}/out.pdf`).size / 1024 / 1024).toFixed(1) : null,
    err: err.slice(0, 300),
  }),
);
