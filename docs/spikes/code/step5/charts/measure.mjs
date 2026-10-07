// SPIKE (step 5, T0, V38). The lazy charts' weight, as check-bundle.mjs measures the entry: gzip
// level 9 of each chunk. A lazy import's cost is its chunk plus every chunk it imports statically
// that the entry doesn't already load (read from Vite's manifest).
//   npx vite build && node measure.mjs
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const dist = new URL('./dist/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', dist), 'utf8'));
const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
const entryChunks = new Set();
const walk = (k, into) => {
  if (into.has(k)) return;
  into.add(k);
  for (const i of manifest[k].imports ?? []) walk(i, into);
};
walk(entryKey, entryChunks);
const gz = (file) => {
  const b = readFileSync(new URL(file, dist));
  return { raw: b.length, gzip: gzipSync(b, { level: 9 }).length };
};
const out = {};
for (const lazy of ['src/charts.tsx', 'src/scale-only.tsx']) {
  const chunks = new Set();
  walk(lazy, chunks);
  let raw = 0;
  let gzip = 0;
  const parts = [];
  for (const k of chunks) {
    if (entryChunks.has(k)) continue;
    const s = gz(manifest[k].file);
    raw += s.raw;
    gzip += s.gzip;
    parts.push({ chunk: manifest[k].file, ...s });
  }
  out[lazy] = { raw, gzip, gzipKB: +(gzip / 1024).toFixed(1), parts };
}
out.entry = { file: manifest[entryKey].file, ...gz(manifest[entryKey].file) };
console.log(JSON.stringify(out, null, 2));
