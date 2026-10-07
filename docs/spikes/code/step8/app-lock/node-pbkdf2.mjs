// Spike L1: PBKDF2-SHA-256 timing in node, for comparison with the browser.
// Usage: node node-pbkdf2.mjs <iterations> [runs]   (the driver also runs it under `taskpolicy -b`)
import { pbkdf2Sync, randomBytes, webcrypto } from 'node:crypto';

const n = Number(process.argv[2] ?? 600000);
const runs = Number(process.argv[3] ?? 5);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const sub = [];
const sync = [];
for (let i = 0; i < runs; i++) {
  const base = await webcrypto.subtle.importKey('raw', Buffer.from('482913'), 'PBKDF2', false, ['deriveBits']);
  let t0 = performance.now();
  await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt: randomBytes(16), iterations: n, hash: 'SHA-256' }, base, 256);
  sub.push(performance.now() - t0);
  t0 = performance.now();
  pbkdf2Sync('482913', randomBytes(16), n, 32, 'sha256');
  sync.push(performance.now() - t0);
}
console.log(JSON.stringify({ node: process.version, iterations: n, runs, subtleMedianMs: +med(sub).toFixed(1), pbkdf2SyncMedianMs: +med(sync).toFixed(1) }));
