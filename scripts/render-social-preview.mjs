#!/usr/bin/env node
// The share cards, on the kit's paper with the lockup and the mark from scripts/render-icons.mjs
// and the tagline in IBM Plex Sans:
//
//   docs/assets/social-preview.png        GitHub's social preview (1280×640): the lockup, the
//                                         tagline and a big tilted mark. GitHub doesn't read it
//                                         from the repo: the maintainer uploads it in the
//                                         repository's settings (Settings → General → Social
//                                         preview).
//   apps/docs/public/social-card.png      the docs site's og:image (1200×630), what a link to
//                                         the site shows in Slack, WhatsApp, X, LinkedIn or
//                                         iMessage: the lockup and the tagline beside the app
//                                         itself, the desktop home screen with the phone in
//                                         front (the docs hero's composition)
//   apps/docs/public/social-card-ar.png   the same in Arabic, right to left, with the Arabic
//                                         captures (بيت العائلة); the Arabic pages use it
//
// The docs site's route middleware (apps/docs/src/route-data.ts) points og:image at the cards.
// The captures are apps/docs/src/assets/screens/{home,phone}[-ar]-light.webp, from
// scripts/capture-screens.mjs: run that first when the app's look changes. Dev only: headless
// Chromium from apps/web's @playwright/test, the fonts from its @fontsource packages. Run it after
// changing the lockup, the tagline or the captures, and commit the outputs
// (`node scripts/render-social-preview.mjs`).
import { readFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { lockupSvg, markSvg } from './render-icons.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(`${root}apps/web/package.json`);
const { chromium } = web('@playwright/test');

/** A @fontsource face as a data URL, so the page needs no file or network access. */
function face(pkg, file) {
  const dir = web.resolve(`@fontsource/${pkg}/package.json`).replace(/package\.json$/, 'files/');
  return `data:font/woff2;base64,${readFileSync(dir + file).toString('base64')}`;
}

/** A light capture from the docs site's screens, as a data URL. */
function screen(name) {
  const file = `${root}apps/docs/src/assets/screens/${name}-light.webp`;
  return `data:image/webp;base64,${readFileSync(file).toString('base64')}`;
}

const COPY = {
  en: {
    tagline: 'Everything you own, where it is, and what it needs.',
    tape: 'Self-hosted · Open source',
  },
  ar: {
    tagline: 'كل ما تملكه، وأين هو، وما يحتاجه.',
    tape: 'مستضاف ذاتيًا · مفتوح المصدر',
  },
};

/** The kit's paper and ink, the fonts and the tape: shared by every card. */
const BASE = `
@font-face{font-family:Plex Sans;font-weight:400;src:url(${face('ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2')})}
@font-face{font-family:Plex Sans;font-weight:600;src:url(${face('ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2')})}
@font-face{font-family:Plex Sans Arabic;font-weight:600;src:url(${face('ibm-plex-sans-arabic', 'ibm-plex-sans-arabic-arabic-600-normal.woff2')})}
@font-face{font-family:Plex Mono;font-weight:600;src:url(${face('ibm-plex-mono', 'ibm-plex-mono-latin-600-normal.woff2')})}
html,body{margin:0}
body{background:#F2F1EC;color:#1C1B19;box-sizing:border-box;font-family:Plex Sans}
:lang(ar) body{font-family:Plex Sans Arabic,Plex Sans}
main{display:grid}
h1{margin:0;font-weight:600;letter-spacing:-.01em;text-wrap:balance}
:lang(ar) h1{letter-spacing:0;line-height:1.35}
.tape{justify-self:start;display:inline-flex;align-items:center;gap:12px;background:#F0B03A;color:#2E2100;
  font:600 18px/1 Plex Mono;letter-spacing:.12em;text-transform:uppercase;padding:11px 16px 10px;border-radius:4px}
:lang(ar) .tape{font-family:Plex Sans Arabic,Plex Mono;letter-spacing:0}
.tape i{width:8px;height:8px;border-radius:50%;background:#F2F1EC}
`;

/** GitHub's preview: the copy beside a big tilted mark. */
const GITHUB = {
  file: 'docs/assets/social-preview.png',
  width: 1280,
  height: 640,
  lang: 'en',
  css: `
body{display:grid;grid-template-columns:1fr auto;align-items:center;gap:48px;padding-inline:96px 120px}
main{gap:40px}
h1{font-size:56px;line-height:1.14;max-width:20ch}
.big{transform:rotate(-6deg);filter:drop-shadow(0 18px 30px rgb(46 33 0 / .18))}`,
  body: (copy) => `
<main>
${lockupSvg({ ink: '#1C1B19', height: 96 })}
<h1>${copy.tagline}</h1>
<span class="tape"><i></i>${copy.tape}</span>
</main>
<div class="big">${markSvg({ size: 280 })}</div>`,
};

/** The docs site's og:image: the copy beside the desktop home screen with the phone in front. */
const card = (lang, file) => ({
  file,
  width: 1200,
  height: 630,
  lang,
  css: `
body{display:grid;grid-template-columns:420px 1fr;align-items:center;gap:36px;padding-inline-start:72px;overflow:hidden}
main{gap:30px}
h1{font-size:44px;line-height:1.16;max-width:12ch}
.tape{font-size:14px;letter-spacing:.1em;padding:10px 14px 9px;gap:10px;white-space:nowrap}
:lang(ar) .tape{font-size:17px}
.art{position:relative;padding-block:24px 56px}
.frame{border:1px solid #DEDBD3;background:#FBFAF7;overflow:hidden;
  box-shadow:0 1px 2px rgb(0 0 0 / .06),0 22px 48px -20px rgb(46 33 0 / .3)}
.frame img{display:block;width:100%;height:auto}
.desktop{width:700px;border-radius:12px}
.bar{display:flex;gap:7px;padding:10px 13px;border-block-end:1px solid #DEDBD3;background:#ECEAE4}
.bar i{width:10px;height:10px;border-radius:50%;background:#DEDBD3}
.phone{position:absolute;inset-block-end:20px;inset-inline-start:300px;width:170px;border-radius:24px;border:6px solid #1E1C19}
.phone img{border-radius:17px}`,
  body: (copy) => `
<main>
${lockupSvg({ ink: '#1C1B19', height: 72 })}
<h1>${copy.tagline}</h1>
<span class="tape"><i></i>${copy.tape}</span>
</main>
<div class="art">
<div class="frame desktop"><div class="bar"><i></i><i></i><i></i></div><img src="${screen(lang === 'ar' ? 'home-ar' : 'home')}" alt=""></div>
<div class="frame phone"><img src="${screen(lang === 'ar' ? 'phone-ar' : 'phone')}" alt=""></div>
</div>`,
});

const CARDS = [
  GITHUB,
  card('en', 'apps/docs/public/social-card.png'),
  card('ar', 'apps/docs/public/social-card-ar.png'),
];

const browser = await chromium.launch();
try {
  for (const { file, width, height, lang, css, body } of CARDS) {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const html = `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><style>${BASE}
body{width:${width}px;height:${height}px}${css}
</style></head><body>${body(COPY[lang])}</body></html>`;
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() =>
      [...document.images].every((i) => i.complete && i.naturalWidth > 0),
    );
    const out = `${root}${file}`;
    await page.screenshot({ path: `${out}.tmp.png`, type: 'png' });
    renameSync(`${out}.tmp.png`, out);
    console.log(`wrote ${file} (${width}×${height})`);
    await page.close();
  }
} finally {
  await browser.close();
}
