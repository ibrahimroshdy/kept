// The report as one self-contained HTML page for headless Chromium (Playwright page.pdf()).
// Fonts are the app's own @fontsource files, inlined as data: URIs; photos too. Page furniture
// (footer, "Page N of M") uses CSS @page margin boxes, which Chromium supports since 131, so
// the footer gets the web fonts and Eastern digits via counter(page, arabic-indic).
import { readFileSync } from 'node:fs';

const here = new URL('..', import.meta.url).pathname;
const fsDir = `${here}node_modules/@fontsource`;

function fontCss() {
  const pick = [
    ['ibm-plex-sans', [400, 500, 600], ['latin', 'latin-ext']],
    ['ibm-plex-sans-arabic', [400, 500, 600], ['arabic', 'latin', 'latin-ext']],
    ['ibm-plex-mono', [400, 600], ['latin', 'latin-ext']],
  ];
  let css = '';
  for (const [pkg, weights, subsets] of pick) {
    for (const w of weights) {
      const src = readFileSync(`${fsDir}/${pkg}/${w}.css`, 'utf8');
      for (const block of src.split('/* ').slice(1)) {
        const name = block.slice(0, block.indexOf(' */'));
        if (!subsets.some((s) => name === `${pkg}-${s}-${w}-normal`)) continue;
        css += block
          .slice(block.indexOf('@font-face'))
          .replace(/url\(\.\/files\/([^)]+\.woff2)\) format\('woff2'\), url\([^)]+\) format\('woff'\)/, (_, f) =>
            `url(data:font/woff2;base64,${readFileSync(`${fsDir}/${pkg}/files/${f}`).toString('base64')}) format('woff2')`);
      }
    }
  }
  return css;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const img = (p) => `data:image/${p.endsWith('.webp') ? 'webp' : 'jpeg'};base64,${readFileSync(p).toString('base64')}`;

export const TAPE_SVG = (w = 150) =>
  `<svg width="${w}" height="${(w * 56) / 150}" viewBox="0 0 150 56" role="img" aria-label="Kept"><rect x="2" y="8" width="146" height="40" rx="4" fill="#F0B03A"/><circle cx="12" cy="28" r="3" fill="#FBFAF7"/><text x="80" y="37" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="24" letter-spacing="5" fill="#2E2100">KEPT</text></svg>`;

/** @param {Awaited<ReturnType<import('./data.mjs').buildReport>>} r  @param {Record<string,number>} tocPages */
export function renderHtml(r, tocPages = {}) {
  const L = r.labels;
  const rtl = r.dir === 'rtl';
  const counterStyle = r.digits === 'arab' ? ', arabic-indic' : '';
  const start = rtl ? 'right' : 'left';
  const end = rtl ? 'left' : 'right';
  const body = rtl ? '"IBM Plex Sans Arabic", "IBM Plex Sans", sans-serif' : '"IBM Plex Sans", "IBM Plex Sans Arabic", sans-serif';
  const pageNo = (id) => (tocPages[id] === undefined ? '00' : r.nf(tocPages[id]));

  return `<!doctype html>
<html lang="${r.lang}" dir="${r.dir}">
<head><meta charset="utf-8"><title>${esc(L.title)} — ${esc(L.location)}</title>
<style>
${fontCss()}
:root{--paper:#F2F1EC;--surface:#FBFAF7;--sunken:#ECEAE4;--line:#DEDBD3;--ink:#1C1B19;--ink-2:#55524C;--ink-3:#6B675F;
  --amber:#F0B03A;--amber-ink:#2E2100;--amber-text:#8A5700;--ok:#1E7B3C;--warn:#A6480A;
  --sans:${body};--mono:"IBM Plex Mono",ui-monospace,monospace}
@page{size:A4;margin:16mm 14mm 18mm;
  @bottom-${start}{content:"${esc(L.footer)}";font:400 7.5pt/1 var(--sans);color:#6B675F;vertical-align:top;padding-top:4mm}
  @bottom-${end}{content:"${esc(L.page)} " counter(page${counterStyle}) " ${esc(L.of)} " counter(pages${counterStyle});font:500 7.5pt/1 var(--sans);color:#55524C;vertical-align:top;padding-top:4mm}}
@page cover{margin:0;@bottom-${start}{content:none}@bottom-${end}{content:none}}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font:400 9pt/1.4 var(--sans);color:var(--ink);background:#fff}
.cover{page:cover;height:297mm;background:var(--paper);padding:28mm 22mm;display:flex;flex-direction:column;break-after:page}
.cover h1{font:600 30pt/1.1 var(--sans);margin:18mm 0 4mm}
.cover .loc{font:500 15pt/1.3 var(--sans);color:var(--ink-2)}
.cover .meta{margin-top:3mm;color:var(--ink-3)}
.stats{display:flex;gap:4mm;margin-top:14mm}
.stat{flex:1;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:5mm}
.stat b{display:block;font:600 20pt/1 var(--sans)}
.stat span{color:var(--ink-3);font-size:8.5pt}
.totals{margin-top:10mm;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:5mm}
.totals h3,.toc h2{font:600 11pt/1.2 var(--sans);margin:0 0 3mm}
.money{font-variant-numeric:tabular-nums;unicode-bidi:isolate}
.totals .money{display:block;font:600 13pt/1.6 var(--sans)}
.cover .foot{margin-top:auto;color:var(--ink-3);font-size:8pt;border-top:1px solid var(--line);padding-top:4mm}
.toc{break-after:page}
.toc h2{font-size:16pt;margin-bottom:6mm}
.toc ol{list-style:none;margin:0;padding:0}
.toc li{display:flex;align-items:baseline;gap:2mm;padding:2.2mm 0;border-bottom:1px solid var(--line);font-size:10.5pt}
.toc li .n{color:var(--ink-3);font-size:8.5pt}
.toc li .dots{flex:1;border-bottom:1px dotted #A8A399;transform:translateY(-1mm)}
.toc li .pg{font-weight:600;min-width:8mm;text-align:${end}}
.place{margin-bottom:6mm}
.place h2{font:600 12.5pt/1.3 var(--sans);margin:0 0 1mm;break-after:avoid;padding-top:2mm}
.place .sub{color:var(--ink-3);font-size:8pt;margin-bottom:2mm;break-after:avoid}
.row{display:grid;grid-template-columns:15mm 1fr 20mm 13mm 10mm 30mm;gap:3mm;align-items:center;padding:2mm 0;border-bottom:1px solid var(--line);break-inside:avoid}
.row.head{font-size:7pt;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em;border-bottom:1.5px solid var(--ink);padding:1mm 0;break-after:avoid}
.thumb{width:15mm;height:15mm;border-radius:4px;object-fit:cover;background:var(--sunken);display:block}
.nothumb{width:15mm;height:15mm;border-radius:4px;background:var(--sunken);border:1px dashed var(--line)}
.name{font-weight:600;font-size:9.5pt}
.meta2{color:var(--ink-2);font-size:7.8pt}
.serial{font:400 7.5pt/1.3 var(--mono);color:var(--ink-3);unicode-bidi:isolate;direction:ltr;display:inline-block}
.sid{font:600 8pt/1 var(--mono);letter-spacing:.08em;background:var(--amber);color:var(--amber-ink);padding:1.2mm 1.4mm 1mm;border-radius:3px;direction:ltr;display:inline-block}
.cond{font-size:7.5pt;color:var(--ink-2);background:var(--sunken);border-radius:10px;padding:.6mm 2mm;display:inline-block;margin-top:.8mm}
.qr svg,.qr img{width:12mm;height:12mm;display:block}
.qty{text-align:center;font-variant-numeric:tabular-nums}
.val{text-align:${end};font-weight:500}
.subtotal{display:flex;justify-content:flex-end;gap:5mm;padding:2mm 0;font-weight:600;break-before:avoid}
.stress{break-before:page}.stress .h2{font:600 12.5pt/1.3 var(--sans)}.stress p{font-size:11pt;border-bottom:1px solid var(--line);padding-bottom:2mm}
.subtotal .lbl{color:var(--ink-3);font-weight:500}
</style></head>
<body>
<section class="cover">
  ${TAPE_SVG(170)}
  <h1>${esc(L.title)}</h1>
  <div class="loc">${esc(L.location)}</div>
  <div class="meta">${esc(L.account)} · ${esc(L.generated)} ${esc(r.date)}</div>
  <div class="stats">
    <div class="stat"><b>${r.counts.things}</b><span>${esc(L.things)}</span></div>
    <div class="stat"><b>${r.counts.places}</b><span>${esc(L.places)}</span></div>
    <div class="stat"><b>${r.counts.photos}</b><span>${esc(L.photos)}</span></div>
  </div>
  <div class="totals"><h3>${esc(L.totals)}</h3>${r.totals.map((t) => `<span class="money">${esc(t)}</span>`).join('')}</div>
  <div class="foot">${esc(L.confidential)}</div>
</section>
<section class="toc"><h2>${esc(L.contents)}</h2><ol>
${r.places.map((p) => `<li><span>${esc(p.pathText)}</span><span class="n">(${p.count})</span><span class="dots"></span><span class="pg">${pageNo(p.id)}</span></li>`).join('\n')}
</ol></section>
${r.places
  .map(
    (p) => `<section class="place" id="${p.id}">
<h2>${esc(p.pathText)}</h2><div class="sub">${p.count} ${esc(L.things)}</div>
<div class="row head"><span></span><span>${esc(L.things)}</span><span>ID</span><span></span><span class="qty">${esc(L.qty)}</span><span class="val">${esc(L.value)}</span></div>
${p.things
  .map(
    (t) => `<div class="row">
${t.photo ? `<img class="thumb" src="${img(t.photo)}" alt="">` : '<div class="nothumb"></div>'}
<div><div class="name">${esc(t.name)}</div>
<div class="meta2">${esc([t.type, [t.brand, t.model].filter(Boolean).join(' ')].filter(Boolean).join(' · '))}</div>
${t.serial ? `<span class="meta2">${esc(L.serial)}:</span> <span class="serial">${esc(t.serial)}</span><br>` : ''}<span class="cond">${esc(t.condition)}</span></div>
<div><span class="sid">${t.shortId}</span></div>
<div class="qr">${t.qrSvg ?? ''}</div>
<div class="qty">${t.qty}</div>
<div class="val money">${esc(t.value)}</div>
</div>`,
  )
  .join('\n')}
<div class="subtotal"><span class="lbl">${esc(L.subtotal)}</span>${p.subtotals.map((s) => `<span class="money">${esc(s)}</span>`).join('')}</div>
</section>`,
  )
  .join('\n')}
<section class="stress"><div class="h2">${esc(L.stress)}</div>${r.stress.map((x) => `<p dir="auto">${esc(x)}</p>`).join('')}</section>
</body></html>`;
}
