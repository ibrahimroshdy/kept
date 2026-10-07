// SPIKE (step 5, T0, V38). Checks the plan's pass conditions against the built spike in Chromium
// (Playwright 1.63.0, the version apps/web pins), and writes results/check.json plus screenshots.
//   npx vite build && node measure.mjs && node check.mjs
// Serves dist/ with `vite preview` on 4795 (nothing else of Kept's uses it).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PORT = 4795;
const BASE = `http://127.0.0.1:${PORT}/`;
const out = new URL('./results/', import.meta.url);
mkdirSync(out, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: new URL('.', import.meta.url),
  stdio: 'ignore',
});
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const results = { when: new Date().toISOString(), checks: [] };
const check = (name, pass, facts) => {
  results.checks.push({ name, pass, ...facts });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(facts)}`);
};

const browser = await chromium.launch();

/** Geometry of one chart: tick label boxes, the plot's extent, and the value-axis labels. */
const geometry = (page, svg) =>
  page.evaluate((svg) => {
    const root = document.querySelector(`[data-testid="${svg}"]`);
    const r0 = root.getBoundingClientRect();
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { l: b.left - r0.left, r: b.right - r0.left, t: b.top - r0.top, b: b.bottom - r0.top };
    };
    const bottom = [...root.querySelectorAll('.visx-axis-bottom .visx-axis-tick text')].map((t) => ({
      text: t.textContent,
      ...box(t),
    }));
    const value = [...root.querySelectorAll('.visx-axis-left .visx-axis-tick text, .visx-axis-right .visx-axis-tick text')].map(
      (t) => ({ text: t.textContent, ...box(t) }),
    );
    const marks = [...root.querySelectorAll('.mark')].map(box);
    const grid = [...root.querySelectorAll(':scope > g > line')].map(box);
    const plot = {
      l: Math.min(...grid.map((g) => g.l), ...marks.map((m) => m.l)),
      r: Math.max(...grid.map((g) => g.r), ...marks.map((m) => m.r)),
    };
    return { width: r0.width, bottom, value, plot, direction: getComputedStyle(root).direction };
  }, svg);

/** Tab to the first mark of `prefix`, then walk it with the arrows, collecting every stop. */
async function walk(page, prefix, rtl, keys) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.focus('body');
  let guard = 0;
  while (guard++ < 40) {
    await page.keyboard.press('Tab');
    const m = await page.evaluate(() => document.activeElement?.getAttribute('data-mark') ?? '');
    if (m.startsWith(prefix)) break;
  }
  const seen = new Map();
  const read = async () =>
    page.evaluate(() => ({
      mark: document.activeElement?.getAttribute('data-mark'),
      label: document.activeElement?.getAttribute('aria-label'),
      tip: document.querySelector('[data-testid="tip"]')?.innerText.replace(/\n/g, '. ') ?? null,
      tabStops: document.querySelectorAll(`[data-mark^="${document.activeElement?.getAttribute('data-mark')?.split(':')[0]}"][tabindex="0"]`).length,
    }));
  const record = async () => {
    const r = await read();
    if (r.mark) seen.set(r.mark, r);
    return r;
  };
  await record();
  for (const k of keys(rtl)) {
    await page.keyboard.press(k);
    await record();
  }
  // The next Tab leaves the chart (one tab stop per chart).
  await page.keyboard.press('Tab');
  const after = await page.evaluate(() => document.activeElement?.tagName + ':' + (document.activeElement?.textContent ?? ''));
  return { seen: [...seen.values()], after };
}

const later = (rtl) => (rtl ? 'ArrowLeft' : 'ArrowRight');
/** Costs: up the stack in each month, then one month later; six months. */
const costKeys = (rtl) =>
  ['Home', ...Array.from({ length: 6 }, () => ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', later(rtl)]).flat()];
const odoKeys = (rtl) => ['Home', ...Array.from({ length: 7 }, () => later(rtl))];

for (const lang of ['en', 'ar']) {
  const rtl = lang === 'ar';
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: rtl ? 'ar-EG' : 'en-GB' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?lang=${lang}`);
  await page.waitForSelector('[data-testid="odo-svg"] .mark');

  // 1. Direction of time, digits, and the value axis beside (not over) the plot.
  const g = await geometry(page, 'costs-svg');
  const xs = g.bottom.map((b) => (b.l + b.r) / 2);
  const rightToLeft = xs.every((x, i) => i === 0 || x < xs[i - 1]);
  const leftToRight = xs.every((x, i) => i === 0 || x > xs[i - 1]);
  check(`${lang}: time axis runs ${rtl ? 'right to left' : 'left to right'}`, rtl ? rightToLeft : leftToRight, {
    months: g.bottom.map((b) => b.text),
    centres: xs.map(Math.round),
  });
  const allTicks = [...g.value.map((v) => v.text), ...(await geometry(page, 'odo-svg')).value.map((v) => v.text)];
  const eastern = allTicks.every((t) => /[٠-٩]/.test(t) && !/[0-9]/.test(t));
  const western = allTicks.every((t) => /[0-9]/.test(t) && !/[٠-٩]/.test(t));
  check(`${lang}: value ticks use ${rtl ? 'Eastern' : 'Western'} digits`, rtl ? eastern : western, { ticks: allTicks });
  for (const svg of ['costs-svg', 'odo-svg']) {
    const gg = await geometry(page, svg);
    const clear = gg.value.every((v) => (rtl ? v.l >= gg.plot.r : v.r <= gg.plot.l));
    const inside = gg.value.every((v) => v.l >= 0 && v.r <= gg.width);
    check(`${lang}: ${svg} value labels sit outside the plot, inside the svg`, clear && inside, {
      plot: { l: Math.round(gg.plot.l), r: Math.round(gg.plot.r) },
      labels: gg.value.map((v) => [v.text, Math.round(v.l), Math.round(v.r)]),
      svgWidth: gg.width,
      direction: gg.direction,
    });
  }

  // 2. Keyboard: every bar and point, a tooltip on focus, one tab stop per chart.
  const costs = await walk(page, 'costs', rtl, costKeys);
  const markCount = await page.locator('[data-mark^="costs:"]').count();
  check(`${lang}: every costs bar reachable by keyboard with a tooltip`, costs.seen.length === markCount && costs.seen.every((s) => s.tip && s.label.includes(s.tip.split('. ')[0])), {
    marks: markCount,
    reached: costs.seen.length,
    oneTabStop: costs.seen.every((s) => s.tabStops === 1),
    nextTabGoesTo: costs.after,
    sample: costs.seen[0]?.tip,
  });
  // "Show as table" gives the same numbers.
  await page.getByRole('button', { name: rtl ? 'اعرض كجدول' : 'Show as table' }).first().click();
  const tableCosts = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="costs-table"] tbody tr')].map((tr) => ({
      month: tr.getAttribute('data-month'),
      cells: Object.fromEntries([...tr.querySelectorAll('td[data-key]')].map((td) => [td.getAttribute('data-key'), td.textContent])),
    })),
  );
  const KEYS = ['fuel', 'service', 'fees'];
  const mismatches = [];
  for (const s of costs.seen) {
    const [, m, k] = s.mark.split(':').map(Number);
    const row = tableCosts[m];
    const [seriesLine, totalLine] = s.tip.split('. ').slice(1);
    if (!seriesLine.endsWith(row.cells[KEYS[k]]) || !totalLine.endsWith(row.cells.total)) {
      mismatches.push({ mark: s.mark, tip: s.tip, table: row.cells });
    }
  }
  check(`${lang}: costs table shows the same numbers as the tooltips`, mismatches.length === 0, {
    compared: costs.seen.length,
    mismatches,
    row0: tableCosts[0],
  });

  const odo = await walk(page, 'odo', rtl, odoKeys);
  await page.getByRole('button', { name: rtl ? 'اعرض كجدول' : 'Show as table' }).last().click();
  const odoRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="odo-table"] tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
  );
  const odoMismatch = odo.seen.filter((s) => {
    const i = Number(s.mark.split(':')[1]);
    return s.tip !== `${odoRows[i][0]}. ${rtl ? 'القراءة' : 'Reading'}: ${odoRows[i][1]}`;
  });
  check(`${lang}: every odometer point reachable, tooltip equals the table`, odo.seen.length === 7 && odoMismatch.length === 0, {
    reached: odo.seen.length,
    oneTabStop: odo.seen.every((s) => s.tabStops === 1),
    mismatches: odoMismatch,
    estimateTip: odo.seen.find((s) => s.mark === 'odo:6')?.tip,
  });
  const dash = await page.evaluate(() => {
    const est = document.querySelector('[data-testid="odo-svg"] [stroke-dasharray]');
    const pts = [...document.querySelectorAll('[data-mark^="odo:"]')].map((c) => Number(c.getAttribute('cx')));
    return { dasharray: est?.getAttribute('stroke-dasharray'), lastActualX: pts[5], estimateX: pts[6] };
  });
  check(`${lang}: the estimate is a dashed segment after the last reading`, dash.dasharray === '5 4' && (rtl ? dash.estimateX < dash.lastActualX : dash.estimateX > dash.lastActualX), dash);

  await page.locator('[data-mark="costs:2:2"]').focus();
  await page.screenshot({ path: new URL(`${lang}-desktop.png`, out).pathname, fullPage: true });
  await ctx.close();
}

// 3. Reduced motion: no transitions or animations anywhere in the charts.
for (const motion of ['reduce', 'no-preference']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: motion });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?lang=ar`);
  await page.waitForSelector('[data-testid="odo-svg"] .mark');
  await page.locator('[data-mark="costs:0:0"]').focus();
  await page.locator('[data-mark="odo:3"]').hover();
  const m = await page.evaluate(() => {
    const moving = [];
    for (const el of document.querySelectorAll('section.card *, [data-testid="tip"]')) {
      const cs = getComputedStyle(el);
      const t = cs.transitionDuration.split(',').some((d) => Number.parseFloat(d) > 0);
      const a = cs.animationName !== 'none';
      if (t || a) moving.push(`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} ${cs.transitionDuration}`);
    }
    return { moving, animations: document.getAnimations().length };
  });
  if (motion === 'reduce') {
    check('reduced motion: no transitions, no animations', m.moving.length === 0 && m.animations === 0, m);
  } else {
    check('no-preference (control): only the tooltip fades', m.moving.every((x) => x.includes('tip')), m);
  }
  await ctx.close();
}

// 4. A phone: 375 px, touch. Fits without sideways scroll; a horizontal drag across the chart
// never arms pull to refresh; a vertical pull on the chart still does (the harness works); a tap
// on a bar opens its tooltip.
for (const lang of ['ar', 'en']) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?lang=${lang}`);
  await page.waitForSelector('[data-testid="odo-svg"] .mark');
  const fits = await page.evaluate(() => ({ scrollWidth: document.scrollingElement.scrollWidth, svg: document.querySelector('[data-testid="costs-svg"]').getBoundingClientRect().width }));
  check(`${lang} 375: no sideways scroll`, fits.scrollWidth <= 375, fits);
  const cdp = await ctx.newCDPSession(page);
  const box = await page.locator('[data-testid="costs-svg"]').boundingBox();
  const drag = async (x0, y0, x1, y1, steps = 12) => {
    await page.evaluate(() => {
      window.__pulls = [];
      window.__released = [];
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return page.evaluate(() => ({ pulls: window.__pulls.length, released: window.__released }));
  };
  const midY = box.y + box.height / 2;
  const flat = await drag(box.x + box.width - 20, midY, box.x + 20, midY + 3);
  const reverse = await drag(box.x + 20, midY, box.x + box.width - 20, midY + 3);
  const slanted = await drag(box.x + box.width - 20, midY, box.x + 40, midY + 40);
  const down = await drag(box.x + box.width / 2, box.y + 20, box.x + box.width / 2 + 4, box.y + 120);
  check(`${lang} 375: a horizontal drag across the chart doesn't arm pull to refresh`, flat.pulls === 0 && reverse.pulls === 0 && slanted.pulls === 0 && down.pulls > 0, {
    rightToLeft: flat,
    leftToRight: reverse,
    slanted40: slanted,
    verticalControl: down,
  });
  const bar = page.locator('[data-mark="costs:5:0"]');
  await bar.tap();
  const tip = await page.evaluate(() => document.querySelector('[data-testid="tip"]')?.innerText ?? null);
  check(`${lang} 375: a tap on a bar opens its tooltip`, !!tip, { tip });
  await page.screenshot({ path: new URL(`${lang}-375.png`, out).pathname, fullPage: false });
  await ctx.close();
}

// 5. For the record: RTL without the fix (the <svg> inheriting direction: rtl).
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?lang=ar&naive=1`);
  await page.waitForSelector('[data-testid="odo-svg"] .mark');
  const gg = await geometry(page, 'costs-svg');
  const over = gg.value.filter((v) => v.l < gg.plot.r);
  results.naive = { direction: gg.direction, plotRight: Math.round(gg.plot.r), labels: gg.value.map((v) => [v.text, Math.round(v.l), Math.round(v.r)]), overlapping: over.length };
  console.log('naive RTL (for the record):', JSON.stringify(results.naive));
  await page.screenshot({ path: new URL('ar-naive.png', out).pathname, clip: { x: 0, y: 0, width: 1280, height: 330 } });
  await ctx.close();
}

await browser.close();
server.kill();
results.pass = results.checks.every((c) => c.pass);
writeFileSync(new URL('check.json', out), `${JSON.stringify(results, null, 2)}\n`);
console.log(results.pass ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.pass ? 0 : 1);
