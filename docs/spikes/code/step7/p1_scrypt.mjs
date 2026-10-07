/**
 * P1: node:crypto scrypt timings for the export passphrase (plan Q7).
 *   node p1_scrypt.mjs                      # laptop
 *   taskpolicy -b node p1_scrypt.mjs        # the slower-core proxy (efficiency cores, as bench:pi-speed)
 */
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
const scryptP = promisify(scrypt);
const r = 8, p = 1, RUNS = 7;
const out = [];
for (const logN of (process.env.P1_LOGN || "14,15,16,17").split(",").map(Number)) {
  const N = 2 ** logN;
  const maxmem = 256 * N * r; // Node refuses unless maxmem > 128 * N * r (plus a little)
  const times = [];
  let peak = 0;
  for (let i = 0; i < RUNS; i++) {
    const salt = randomBytes(16);
    const t0 = performance.now();
    await scryptP('correct horse battery staple', salt, 32, { N, r, p, maxmem });
    times.push(performance.now() - t0);
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  times.sort((a, b) => a - b);
  out.push({ N: `2^${logN}`, memMiB: (128 * N * r) / 1048576, medianMs: Math.round(times[RUNS >> 1]), maxMs: Math.round(times.at(-1)), peakRssMiB: Math.round(peak / 1048576) });
}
console.log(JSON.stringify({ node: process.version, runs: RUNS, results: out }, null, 1));
