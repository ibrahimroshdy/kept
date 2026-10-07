// Engine 2: headless Chromium via playwright-core, HTML + @page CSS.
// Two passes: pass 1 renders with outline:true and reads each place heading's page from the PDF
// outline; pass 2 renders again with those numbers in the table of contents.
// Usage: node render-chromium.mjs [en|ar|all]   (CHROMIUM_PATH overrides the browser binary)
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildReport } from './lib/data.mjs';
import { renderHtml } from './lib/html.mjs';
import { outlinePages } from './lib/pdf-outline.mjs';

const here = new URL('.', import.meta.url).pathname;
mkdirSync(`${here}out`, { recursive: true });
// Env: SCALE (things, default 60), DIGITS (latn|arab, default by language), TAG (output suffix).
const runOpts = { qr: true, scale: Number(process.env.SCALE || 60), digits: process.env.DIGITS || undefined };
const tag = process.env.TAG || '';
const langs = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : ['en', 'ar'];

const t0 = performance.now();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-zygote', '--single-process'].filter(
    (a) => process.env.CHROMIUM_SINGLE === '1' || !['--no-zygote', '--single-process'].includes(a),
  ),
});
const tLaunch = performance.now();
for (const lang of langs) {
  const t1 = performance.now();
  const report = await buildReport(lang, runOpts);
  const page = await browser.newPage();
  const opts = { preferCSSPageSize: true, printBackground: true, outline: true, tagged: true };
  await page.setContent(renderHtml(report), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const pass1 = await page.pdf(opts);
  const pages = outlinePages(pass1, report.places.map((p) => p.pathText));
  const toc = Object.fromEntries(report.places.map((p, i) => [p.id, pages[i]]));
  await page.setContent(renderHtml(report, toc), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const pdf = await page.pdf(opts);
  await page.close();
  writeFileSync(`${here}out/chromium-${lang}${tag}.pdf`, pdf);
  console.log(JSON.stringify({ engine: 'chromium', lang, tag, things: runOpts.scale, ms: Math.round(performance.now() - t1), bytes: pdf.length, toc }));
}
await browser.close();
console.log(JSON.stringify({ engine: 'chromium', launchMs: Math.round(tLaunch - t0), totalMs: Math.round(performance.now() - t0) }));
