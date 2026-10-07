// Engine 3: Typst through @myriaddreamin/typst-ts-node-compiler (a napi-rs addon, in-process).
// Data, photos and QR SVGs go into the compiler's virtual file system with mapShadow(); fonts are
// the TTFs converted from @ibm/plex-* by prepare.mjs (Typst reads TTF/OTF only, not WOFF/WOFF2).
// Usage: node render-typst.mjs [en|ar|all]
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildReport } from './lib/data.mjs';

const here = new URL('.', import.meta.url).pathname;
mkdirSync(`${here}out`, { recursive: true });
// Env: SCALE (things, default 60), DIGITS (latn|arab, default by language), TAG (output suffix).
const runOpts = { qr: true, scale: Number(process.env.SCALE || 60), digits: process.env.DIGITS || undefined };
const tag = process.env.TAG || '';
const langs = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : ['en', 'ar'];

const t0 = performance.now();
const compiler = NodeCompiler.create({ workspace: '/', fontArgs: [{ fontPaths: [`${here}fonts`] }] });
const tInit = performance.now();
const template = readFileSync(`${here}report.typ`, 'utf8');
for (const lang of langs) {
  const t1 = performance.now();
  const r = await buildReport(lang, runOpts);
  compiler.resetShadow();
  const data = { ...r, nf: undefined, places: r.places.map((p) => ({ ...p, things: p.things.map((t) => {
    const photo = t.photo ? `/thumbs/${t.photo.split('/').pop()}` : null;
    if (photo) compiler.mapShadow(photo, readFileSync(t.photo));
    const qr = t.qrSvg ? `/qr/${p.id}-${t.shortId}.svg` : null;
    if (qr) compiler.mapShadow(qr, Buffer.from(t.qrSvg));
    return { ...t, photo, qr, qrSvg: undefined, qrPng: undefined };
  }) })) };
  compiler.mapShadow('/data.json', Buffer.from(JSON.stringify(data)));
  const res = compiler.compile({ mainFileContent: template });
  if (res.hasError()) { res.printDiagnostics(); process.exit(1); }
  const warnings = res.takeWarnings();
  if (warnings) console.error(JSON.stringify(compiler.fetchDiagnostics(warnings)));
  const pdf = compiler.pdf(res.result, { creationTimestamp: 1790000000 });
  writeFileSync(`${here}out/typst-${lang}${tag}.pdf`, pdf);
  console.log(JSON.stringify({ engine: 'typst', lang, tag, things: runOpts.scale, ms: Math.round(performance.now() - t1), bytes: pdf.length }));
  compiler.evictCache(10);
}
console.log(JSON.stringify({ engine: 'typst', initMs: Math.round(tInit - t0), totalMs: Math.round(performance.now() - t0) }));
