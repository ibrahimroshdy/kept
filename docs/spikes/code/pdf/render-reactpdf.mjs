// Engine 1: @react-pdf/renderer (pdfkit + fontkit + its own textkit, bidi via bidi-js).
// No JSX, so no build step: React.createElement as `h`. Two passes for the table of contents:
// pass 1 records the page of each place heading through a `render` callback.
// Usage: node render-reactpdf.mjs [en|ar|all]
import { createElement as h } from 'react';
import { Document, Page, View, Text, Image, Font, Svg, Rect, Circle, renderToBuffer } from '@react-pdf/renderer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildReport } from './lib/data.mjs';

const here = new URL('.', import.meta.url).pathname;
mkdirSync(`${here}out`, { recursive: true });
const f = (n) => `${here}fonts/${n}.ttf`;
Font.register({ family: 'Plex Sans', fonts: [
  { src: f('IBMPlexSans-Regular'), fontWeight: 400 }, { src: f('IBMPlexSans-Medium'), fontWeight: 500 }, { src: f('IBMPlexSans-SemiBold'), fontWeight: 600 }] });
Font.register({ family: 'Plex Arabic', fonts: [
  { src: f('IBMPlexSansArabic-Regular'), fontWeight: 400 }, { src: f('IBMPlexSansArabic-Medium'), fontWeight: 500 }, { src: f('IBMPlexSansArabic-SemiBold'), fontWeight: 600 }] });
Font.register({ family: 'Plex Mono', fonts: [
  { src: f('IBMPlexMono-Regular'), fontWeight: 400 }, { src: f('IBMPlexMono-SemiBold'), fontWeight: 600 }] });
Font.registerHyphenationCallback((w) => [w]);

const C = { paper: '#F2F1EC', surface: '#FBFAF7', sunken: '#ECEAE4', line: '#DEDBD3', ink: '#1C1B19', ink2: '#55524C', ink3: '#6B675F', amber: '#F0B03A', amberInk: '#2E2100' };
const mm = (n) => n * 2.8346;

function Report(r, pages) {
  const L = r.labels;
  const rtl = r.dir === 'rtl';
  const row = rtl ? 'row-reverse' : 'row';
  const align = rtl ? 'right' : 'left';
  const alignEnd = rtl ? 'left' : 'right';
  const font = rtl ? ['Plex Arabic', 'Plex Sans'] : ['Plex Sans', 'Plex Arabic'];
  // Intl puts U+200F (RLM) before Arabic money; neither Plex font has a glyph for it, so react-pdf
  // falls back to an unembedded Helvetica. react-pdf runs its own bidi, so the marks are dropped.
  const clean = (s) => (typeof s === 'string' ? s.replace(/[\u200e\u200f\u061c]/g, '') : s);
  const T = (style, text, extra = {}) => h(Text, { style: { direction: r.dir, textAlign: align, ...style }, ...extra }, clean(text));

  const cover = h(Page, { size: 'A4', style: { backgroundColor: C.paper, padding: mm(24), fontFamily: font, color: C.ink } },
    h(View, { style: { flexDirection: row } },
      h(Svg, { width: 170, height: 63, viewBox: '0 0 150 56' },
        h(Rect, { x: 2, y: 8, width: 146, height: 40, rx: 4, fill: C.amber }),
        h(Circle, { cx: 12, cy: 28, r: 3, fill: C.surface }),
        // Inside <Svg>, font props are SVG presentation props, not `style` (layout/lib: BASE_SVG_INHERITED_PROPS).
        h(Text, { x: 80, y: 37, textAnchor: 'middle', fontFamily: 'Plex Mono', fontWeight: 600, fontSize: 24, letterSpacing: 5, fill: C.amberInk }, 'KEPT'))),
    T({ fontSize: 30, fontWeight: 600, marginTop: mm(18), marginBottom: mm(4) }, L.title),
    T({ fontSize: 15, fontWeight: 500, color: C.ink2 }, L.location),
    T({ fontSize: 9, color: C.ink3, marginTop: mm(3) }, `${L.account} · ${L.generated} ${r.date}`),
    h(View, { style: { flexDirection: row, gap: mm(4), marginTop: mm(14) } },
      ...[[r.counts.things, L.things], [r.counts.places, L.places], [r.counts.photos, L.photos]].map(([n, l]) =>
        h(View, { key: l, style: { flex: 1, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: mm(5) } },
          T({ fontSize: 20, fontWeight: 600 }, n), T({ fontSize: 8.5, color: C.ink3 }, l)))),
    h(View, { style: { marginTop: mm(10), backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: mm(5) } },
      T({ fontSize: 11, fontWeight: 600, marginBottom: mm(3) }, L.totals),
      ...r.totals.map((t) => T({ fontSize: 13, fontWeight: 600, lineHeight: 1.6 }, t, { key: t }))),
    h(View, { style: { marginTop: 'auto', borderTopWidth: 1, borderColor: C.line, paddingTop: mm(4) } }, T({ fontSize: 8, color: C.ink3 }, L.confidential)));

  const footer = h(View, { fixed: true, style: { position: 'absolute', bottom: mm(8), left: mm(14), right: mm(14), flexDirection: row, justifyContent: 'space-between' } },
    T({ fontSize: 7.5, color: C.ink3 }, L.footer),
    // A `render` text has no content at layout time, so it needs a fixed width or it overlaps its sibling.
    h(Text, { style: { width: mm(40), textAlign: alignEnd, fontSize: 7.5, fontWeight: 500, color: C.ink2, direction: r.dir }, render: ({ pageNumber, totalPages }) => `${L.page} ${r.nf(pageNumber)} ${L.of} ${r.nf(totalPages)}` }));

  const toc = h(View, { break: false },
    T({ fontSize: 16, fontWeight: 600, marginBottom: mm(6) }, L.contents),
    ...r.places.map((p) => h(View, { key: p.id, style: { flexDirection: row, alignItems: 'flex-end', paddingVertical: mm(2.2), borderBottomWidth: 1, borderColor: C.line } },
      T({ fontSize: 10.5 }, p.pathText), T({ fontSize: 8.5, color: C.ink3, marginHorizontal: mm(2) }, `(${p.count})`),
      h(View, { style: { flex: 1, borderBottomWidth: 1, borderStyle: 'dotted', borderColor: '#A8A399', marginBottom: 3 } }),
      T({ fontSize: 10.5, fontWeight: 600, minWidth: mm(8), textAlign: alignEnd }, pages[p.id] ? r.nf(pages[p.id]) : '00'))));

  const thingRow = (t) => h(View, { key: t.shortId, wrap: false, style: { flexDirection: row, alignItems: 'center', gap: mm(3), paddingVertical: mm(2), borderBottomWidth: 1, borderColor: C.line } },
      // react-pdf reads JPEG and PNG only: a WebP src logs "Not valid image extension" and the
      // image is silently left out. Kept would transcode (sharp); here the JPEG sibling is used.
      t.photo ? h(Image, { src: t.photo.replace(/\.webp$/, '.jpg'), style: { width: mm(15), height: mm(15), borderRadius: 4, objectFit: 'cover' } })
        : h(View, { style: { width: mm(15), height: mm(15), borderRadius: 4, backgroundColor: C.sunken } }),
      h(View, { style: { flex: 1 } },
        T({ fontSize: 9.5, fontWeight: 600 }, t.name),
        T({ fontSize: 7.8, color: C.ink2 }, [t.type, [t.brand, t.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')),
        t.serial ? h(View, { style: { flexDirection: row, gap: 3 } }, T({ fontSize: 7.5, color: C.ink2 }, `${L.serial}:`), h(Text, { style: { fontFamily: 'Plex Mono', fontSize: 7.5, color: C.ink3 } }, t.serial)) : null,
        h(View, { style: { flexDirection: row } }, T({ fontSize: 7.5, color: C.ink2, backgroundColor: C.sunken, borderRadius: 10, paddingHorizontal: mm(2), paddingVertical: 1.5, marginTop: 2 }, t.condition))),
      h(View, { style: { width: mm(20), flexDirection: row } }, h(Text, { style: { fontFamily: 'Plex Mono', fontWeight: 600, fontSize: 8, letterSpacing: 0.6, backgroundColor: C.amber, color: C.amberInk, paddingHorizontal: 4, paddingVertical: 3, borderRadius: 3 } }, t.shortId)),
      t.qrPng ? h(Image, { src: t.qrPng, style: { width: mm(12), height: mm(12) } }) : h(View, { style: { width: mm(12) } }),
      T({ width: mm(10), fontSize: 9, textAlign: 'center' }, t.qty),
      T({ width: mm(30), fontSize: 9, fontWeight: 500, textAlign: alignEnd }, t.value));

  // minPresenceAhead on the heading did not stop an orphaned heading (seen in the EN render), so
  // the heading and the first row are one unbreakable block, the usual react-pdf idiom.
  const places = r.places.map((p, pi) => h(View, { key: p.id, break: pi === 0, style: { marginBottom: mm(6) } },
    h(View, { wrap: false },
      h(Text, { style: { fontSize: 1, color: '#fff' }, render: ({ pageNumber }) => { pages.__seen[p.id] = pageNumber; return ' '; } }),
      T({ fontSize: 12.5, fontWeight: 600, paddingTop: mm(2) }, p.pathText),
      T({ fontSize: 8, color: C.ink3, marginBottom: mm(2) }, `${p.count} ${L.things}`),
      thingRow(p.things[0])),
    ...p.things.slice(1).map(thingRow),
    h(View, { wrap: false, style: { flexDirection: row, justifyContent: 'flex-end', gap: mm(5), paddingVertical: mm(2) } },
      T({ fontSize: 9, color: C.ink3, fontWeight: 500 }, L.subtotal),
      ...p.subtotals.map((s) => T({ fontSize: 9, fontWeight: 600 }, s, { key: s })))));

  return h(Document, { title: `${L.title} — ${L.location}`, language: r.lang },
    cover,
    h(Page, { size: 'A4', wrap: true, style: { paddingTop: mm(16), paddingHorizontal: mm(14), paddingBottom: mm(20), fontFamily: font, color: C.ink, fontSize: 9 } },
      toc, ...places,
      h(View, { break: true },
        T({ fontSize: 12.5, fontWeight: 600, marginBottom: mm(3) }, L.stress),
        // Each line gets the paragraph direction of its first strong character, like dir="auto".
        ...r.stress.map((x) => { const d = /^[^A-Za-z\u0600-\u06ff]*[\u0600-\u06ff]/.test(x) ? 'rtl' : 'ltr';
          return h(Text, { key: x, style: { direction: d, textAlign: d === 'rtl' ? 'right' : 'left', fontSize: 11, paddingBottom: mm(2), marginBottom: mm(3), borderBottomWidth: 1, borderColor: C.line } }, x); })),
      footer));
}

// Env: SCALE (things, default 60), DIGITS (latn|arab, default by language), TAG (output suffix).
const runOpts = { qr: true, scale: Number(process.env.SCALE || 60), digits: process.env.DIGITS || undefined };
const tag = process.env.TAG || '';
const langs = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : ['en', 'ar'];
for (const lang of langs) {
  const t1 = performance.now();
  const r = await buildReport(lang, runOpts);
  const seen = {};
  await renderToBuffer(Report(r, { __seen: seen }));
  // `render` gets the document-wide page number (the cover is page 1).
  const pages = { ...seen };
  const pdf = await renderToBuffer(Report(r, { ...pages, __seen: {} }));
  writeFileSync(`${here}out/reactpdf-${lang}${tag}.pdf`, pdf);
  console.log(JSON.stringify({ engine: 'react-pdf', lang, tag, things: runOpts.scale, ms: Math.round(performance.now() - t1), bytes: pdf.length, toc: pages }));
}
