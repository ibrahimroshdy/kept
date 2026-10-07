#!/usr/bin/env node
// Every screenshot of the app that the docs site and the README show, from the web app's demo
// build (the in-memory mock API, `?demo=owner`), so they follow the app when its look changes:
//
//   apps/docs/src/assets/screens/{home,thing,phone}-{light,dark}.webp       English, Ibrahim's Home
//   apps/docs/src/assets/screens/{home,thing,phone}-ar-{light,dark}.webp    Arabic, Eastern digits,
//                                                                          Alfred's بيت العائلة
//   apps/docs/src/assets/screens/<GALLERY name>[-ar]-{light,dark}.webp      the docs home page's
//                                              gallery (apps/docs/src/components/landing/Gallery.astro):
//                                              a room, search, capture, the Inbox, labels and more;
//                                              the Arabic ones in بيت العائلة where it has the data
//   docs/assets/kept-hero-{light,dark}.webp    the README hero: the desktop home screen in a window
//                                              frame with the phone in front (the docs site's hero
//                                              art, apps/docs/src/components/Hero.astro), on a
//                                              transparent background
//
// Desktop captures are a 1280×800 viewport, phones 390×844 (touch, mobile), both at 2× and then
// stored at 1344 and 420 px wide: twice the largest size the docs site shows them at.
//
// Dev only: it builds the demo bundle (`pnpm --filter @kept/web build:demo`, into the git-ignored
// apps/web/dist-demo), serves it on a free local port, and drives headless Chromium from apps/web's
// @playwright/test. No camera or microphone is ever opened: every page gets a painted stand-in for
// the camera (stubCamera below) in place of getUserMedia, and Chromium's own fake devices behind
// it. Run it after a visible change to the app's shell, and commit the outputs
// (`node scripts/capture-screens.mjs`; `--skip-build` reuses dist-demo).
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = createRequire(`${root}apps/web/package.json`);
const { chromium } = web('@playwright/test');

const dist = `${root}apps/web/dist-demo/`;
const SCREENS = 'apps/docs/src/assets/screens';
const HERO = 'docs/assets';
/** Ids from the mock fixtures (apps/web/src/api/mock/fixtures.ts, api/inventory/mock/fixtures.ts,
 * api/assistant/mock/state.ts). */
const ID = {
  /** Ibrahim's Home and Alfred's بيت العائلة. */
  home: '01926f00-0000-7000-8000-00000000b002',
  family: '01926f00-0000-7000-8000-00000000b005',
  kitchen: '01926f00-0000-7000-8000-0000000c0003',
  shelves: '01926f00-0000-7000-8000-0000000c0012',
  familyLiving: '01926f00-0000-7000-8000-0000000c0031',
  threadFound: '01926f00-0000-7000-8000-000000060001',
  threadArabic: '01926f00-0000-7000-8000-000000060003',
};
const FAMILY = `/loc/${ID.family}`;

/**
 * The docs home page's gallery, in its order: each screen's English and Arabic path. The Arabic
 * captures stay in بيت العائلة where it has the data, and use the arabised demo otherwise (the
 * same page, Arabic interface, Eastern digits). `top` scrolls the page back to its start (the
 * assistant opens at its newest message).
 */
const GALLERY = [
  { name: 'place', en: `/p/${ID.kitchen}`, ar: `/p/${ID.familyLiving}` },
  { name: 'search-phone', en: '/search?q=cable', ar: '/search?q=كابل', phone: true },
  {
    name: 'capture-phone',
    en: `/capture?place=${ID.shelves}`,
    ar: `/capture?place=${ID.familyLiving}`,
    phone: true,
  },
  { name: 'inbox', en: '/inbox', ar: '/inbox' },
  {
    name: 'labels',
    en: `/labels?loc=${ID.home}&unprinted=1`,
    ar: `/labels?loc=${ID.family}&unprinted=1`,
  },
  { name: 'expiring', en: '/expiring', ar: '/expiring' },
  { name: 'vehicles', en: '/vehicles', ar: '/vehicles' },
  { name: 'lending', en: '/lending', ar: '/lending' },
  {
    name: 'assistant',
    en: `/assistant/${ID.threadFound}`,
    ar: `/assistant/${ID.threadArabic}`,
    top: true,
  },
  { name: 'connections', en: '/settings/connections', ar: '/settings/connections' },
  // Ibrahim is only a member of بيت العائلة, so its modules are read-only to him: Home in Arabic.
  {
    name: 'track',
    en: `/settings/location/${ID.home}/track`,
    ar: `/settings/location/${ID.home}/track`,
  },
];

if (!process.argv.includes('--skip-build')) {
  const r = spawnSync('pnpm', ['--filter', '@kept/web', 'build:demo'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(`${dist}index.html`)) {
  console.error('apps/web/dist-demo is missing: run without --skip-build');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** The demo build as a single-page app: a file if there is one, otherwise index.html. */
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  let file = join(dist, decodeURIComponent(pathname));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory())
    file = `${dist}index.html`;
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

/** Writes beside the target and renames, so a tracked file is never half-written. */
async function writeWebp(image, path, options) {
  const tmp = `${root}${path}.tmp.webp`;
  await image.webp(options).toFile(tmp);
  renameSync(tmp, `${root}${path}`);
  const { size } = statSync(`${root}${path}`);
  console.log(`wrote ${path} (${Math.round(size / 1024)} KB)`);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

/**
 * Runs in every page before the app: getUserMedia returns a canvas stream of a painted shelf with
 * a labelled box on it (B0X-3QF is the fixtures' cable box), so the capture screen has a picture
 * and no camera, real or fake, is ever asked for.
 */
function stubCamera() {
  const paint = (ctx, w, h) => {
    const wall = ctx.createLinearGradient(0, 0, 0, h);
    wall.addColorStop(0, '#b9ab98');
    wall.addColorStop(1, '#8f8170');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, w, h);
    const shelf = h * 0.7;
    ctx.fillStyle = '#7a5a3c';
    ctx.fillRect(0, shelf, w, h * 0.05);
    ctx.fillStyle = '#5b412a';
    ctx.fillRect(0, shelf + h * 0.05, w, h * 0.02);
    ctx.fillStyle = 'rgb(40 28 18 / 35%)';
    ctx.fillRect(0, shelf + h * 0.07, w, h);
    const bw = w * 0.5;
    const bh = h * 0.36;
    const bx = (w - bw) / 2;
    const by = shelf - bh;
    ctx.fillStyle = 'rgb(30 20 10 / 25%)';
    ctx.fillRect(bx + 14, by + 14, bw, bh);
    ctx.fillStyle = '#c99d6b';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#b5895a';
    ctx.fillRect(bx, by, bw, bh * 0.16);
    ctx.fillStyle = 'rgb(0 0 0 / 8%)';
    ctx.fillRect(bx + bw * 0.48, by, bw * 0.04, bh * 0.16);
    const size = Math.round(bw * 0.085);
    ctx.font = `700 ${size}px ui-monospace, Menlo, monospace`;
    const text = 'B0X-3QF';
    const lw = ctx.measureText(text).width + size * 1.4;
    const lh = size * 1.9;
    const lx = bx + (bw - lw) / 2;
    const ly = by + bh * 0.48;
    ctx.fillStyle = '#F0B03A';
    ctx.fillRect(lx, ly, lw, lh);
    ctx.fillStyle = '#2E2100';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + lw / 2, ly + lh / 2 + 1);
    const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.95);
    v.addColorStop(0, 'rgb(0 0 0 / 0%)');
    v.addColorStop(1, 'rgb(0 0 0 / 35%)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  };
  const getUserMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 1280;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      paint(ctx, canvas.width, canvas.height);
      requestAnimationFrame(draw);
    };
    draw();
    return canvas.captureStream(30);
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  });
}

async function shot(name, path, { theme, lang, phone = false, top = false }) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: theme,
    serviceWorkers: 'block',
  });
  await ctx.addInitScript(stubCamera);
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const digits = lang === 'ar' ? '&digits=eastern' : '';
    const query = `demo=owner&lang=${lang}&theme=${theme}${digits}`;
    await page.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}${query}`);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    // Let entrance transitions and lazily loaded screens settle.
    await page.waitForTimeout(2000);
    if (top) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0;
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(300);
    }
    if (errors.length) throw new Error(`${name} ${theme}: ${errors.join('; ')}`);
    const dir = await page.evaluate(() => getComputedStyle(document.documentElement).direction);
    if ((lang === 'ar') !== (dir === 'rtl'))
      throw new Error(`${name} ${theme}: direction is ${dir}`);
    const png = await page.screenshot({ type: 'png' });
    const file = `${SCREENS}/${name}-${theme}.webp`;
    await writeWebp(sharp(png).resize({ width: phone ? 420 : 1344 }), file, {
      quality: 78,
      effort: 6,
    });
  } finally {
    await ctx.close();
  }
}

/** The docs hero's art (Hero.astro, kept.css): the kit's tokens, a window frame and a phone. */
function heroHtml(theme) {
  const src = (name) =>
    `data:image/webp;base64,${readFileSync(`${root}${SCREENS}/${name}-${theme}.webp`).toString('base64')}`;
  const t =
    theme === 'light'
      ? '--surface:#FBFAF7;--sunken:#ECEAE4;--line:#DEDBD3;--bezel:#1E1C19'
      : '--surface:#1E1C19;--sunken:#26231F;--line:#34302A;--bezel:#3A3631';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${t}}
html,body{margin:0;background:transparent}
.stage{display:inline-block;padding:20px 24px 36px}
.art{position:relative;inline-size:672px;padding-block-end:40px;padding-inline-end:56px}
.frame{border:1px solid var(--line);background:var(--surface);overflow:hidden;
  box-shadow:0 1px 2px rgb(0 0 0 / .06),0 18px 40px -18px rgb(0 0 0 / .28)}
.frame img{display:block;inline-size:100%;block-size:auto}
.desktop{border-radius:12px}
.bar{display:flex;gap:6px;padding:9px 12px;border-block-end:1px solid var(--line);background:var(--sunken)}
.bar i{inline-size:9px;block-size:9px;border-radius:50%;background:var(--line)}
.phone{position:absolute;inset-block-end:0;inset-inline-end:0;inline-size:184px;border-radius:22px;
  border:5px solid var(--bezel)}
.phone img{border-radius:16px}
</style></head><body><div class="stage" id="stage"><div class="art">
<div class="frame desktop"><div class="bar"><i></i><i></i><i></i></div><img src="${src('home')}" alt=""></div>
<div class="frame phone"><img src="${src('phone')}" alt=""></div>
</div></div></body></html>`;
}

async function hero(theme) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 700 },
    deviceScaleFactor: 2,
  });
  try {
    await page.setContent(heroHtml(theme));
    await page.waitForFunction(() =>
      [...document.images].every((i) => i.complete && i.naturalWidth > 0),
    );
    const png = await page.locator('#stage').screenshot({ type: 'png', omitBackground: true });
    await writeWebp(sharp(png), `${HERO}/kept-hero-${theme}.webp`, {
      quality: 80,
      alphaQuality: 90,
      effort: 6,
    });
  } finally {
    await page.close();
  }
}

try {
  for (const theme of ['light', 'dark']) {
    await shot('home', '/', { theme, lang: 'en' });
    await shot('thing', '/t/7KQ4MZ', { theme, lang: 'en' });
    await shot('phone', '/', { theme, lang: 'en', phone: true });
    await shot('home-ar', FAMILY, { theme, lang: 'ar' });
    await shot('thing-ar', '/t/AR7HDM', { theme, lang: 'ar' });
    await shot('phone-ar', FAMILY, { theme, lang: 'ar', phone: true });
    await hero(theme);
    for (const { name, en, ar, phone = false, top = false } of GALLERY) {
      await shot(name, en, { theme, lang: 'en', phone, top });
      await shot(`${name}-ar`, ar, { theme, lang: 'ar', phone, top });
    }
  }
} finally {
  await browser.close();
  server.close();
}
