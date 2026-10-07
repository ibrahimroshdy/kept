/**
 * The UI audit's automated checks (step-3 plan T31b, master plan "UI audits"), against the real
 * server on the `households` seed, once per project (phone 375×780, desktop 1280×800), each on its
 * own seeded instance (e2e/instances.ts):
 *
 * 1. axe on every route a signed-in owner can reach by following links from Home, one page per
 *    route pattern, plus the pages outside the app (sign in, a missing page) and the Arabic pages
 *    of a member whose Kept is in Arabic. Nothing above "minor" passes (WCAG 2.2 A and AA, and
 *    axe's best practices).
 * 2. A keyboard walk (desktop): capture → inbox → search → thing, and the label print flow, with
 *    no mouse at all.
 *
 * Findings and fixes: docs/audits/ui-2026-09-29.md.
 */
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { INSTANCES, urlOf } from './instances';

const instanceOf = (project: string) =>
  project === 'phone' ? INSTANCES.auditPhone : INSTANCES.auditDesktop;

const PASSWORD = 'kept-seed-password';

test.describe.configure({ mode: 'serial' });
test.use({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first argument.
  baseURL: async ({}, use, testInfo) => use(urlOf(instanceOf(testInfo.project.name))),
  // Capture's camera: Chromium's fake device, granted without a prompt.
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

/** One signed-in browser per person and project, reused: sign-in is rate-limited (5 a minute). */
const sessions = new Map<string, BrowserContext>();

async function session(browser: Browser, baseURL: string, login: string, lang = 'en') {
  const key = `${test.info().project.name}:${login}`;
  const known = sessions.get(key);
  if (known) return known;
  const use = test.info().project.use;
  const ctx = await browser.newContext({
    baseURL,
    viewport: use.viewport ?? { width: 1280, height: 800 },
    isMobile: use.isMobile ?? false,
    hasTouch: use.hasTouch ?? false,
    timezoneId: 'Africa/Cairo',
    locale: 'en-GB',
    permissions: ['camera'],
  });
  const p = await ctx.newPage();
  await p.goto('/signin');
  await p.getByLabel('Email or username', { exact: true }).fill(login);
  await p.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(p).toHaveURL(/\/$/);
  await p.close();
  // The language for every page from here on (the display preference, D204).
  await ctx.addInitScript((l) => {
    try {
      localStorage.setItem('kept.locale', l);
    } catch {
      // The page falls back to the browser's language.
    }
  }, lang);
  sessions.set(key, ctx);
  return ctx;
}

test.afterAll(async () => {
  for (const ctx of sessions.values()) await ctx.close();
  sessions.clear();
});

/** "/t/<id>" and "/t/<other id>" are one route: the path with its IDs replaced. */
function routeOf(path: string): string {
  const withId = new Set([
    'loc',
    'p',
    't',
    'l',
    'people',
    'vendors',
    'brands',
    'types',
    'location',
  ]);
  const segs = path.split('/').filter(Boolean);
  return `/${segs.map((s, i) => (i > 0 && withId.has(segs[i - 1] ?? '') ? ':id' : s)).join('/')}`;
}

/** Every violation above "minor", in a form that reads well in a failed expectation. */
async function serious(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return result.violations
    .filter((v) => v.impact && v.impact !== 'minor')
    .map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  // Skeletons give way to content, and dialogs finish opening.
  await page.waitForTimeout(300);
}

/** Follow links from Home, one page per route, and check each with axe. */
async function crawl(page: Page, limit: number) {
  const seen = new Set<string>();
  const queue = ['/'];
  const failures: string[] = [];
  while (queue.length && seen.size < limit) {
    const path = queue.shift() as string;
    const route = routeOf(path.split('?')[0] ?? path);
    if (seen.has(route)) continue;
    seen.add(route);
    await page.goto(path);
    await settle(page);
    for (const v of await serious(page)) failures.push(`${route}: ${v}`);
    const hrefs = await page
      .locator('a[href^="/"]')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
    for (const h of hrefs) {
      const clean = h.split('#')[0] ?? '';
      if (!clean || clean.startsWith('/api') || clean.startsWith('/f/')) continue;
      if (!seen.has(routeOf(clean.split('?')[0] ?? clean))) queue.push(clean);
    }
  }
  return { failures, routes: [...seen] };
}

test('axe: every route an owner reaches from Home, nothing above minor', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(900_000);
  const ctx = await session(browser, baseURL as string, 'ibrahim@kept.test');
  const p = await ctx.newPage();
  const { failures, routes } = await crawl(p, 80);
  expect(routes.length).toBeGreaterThan(30);
  expect(failures).toEqual([]);
  await p.close();
});

test('axe: the Arabic pages of a member, nothing above minor', async ({ browser, baseURL }) => {
  test.setTimeout(600_000);
  const ctx = await session(browser, baseURL as string, 'alfred@kept.test', 'ar');
  const p = await ctx.newPage();
  const { failures } = await crawl(p, 25);
  expect(failures).toEqual([]);
  await p.close();
});

test('axe: sign in and a missing page, nothing above minor', async ({ page }) => {
  for (const path of ['/signin', '/no-such-page']) {
    await page.goto(path);
    await settle(page);
    expect(await serious(page), path).toEqual([]);
  }
});

/**
 * The phone's filter strip keeps Filters · Views · Display on one row in all five languages, with
 * the longest Display words a list can show (UI audit L11: in Arabic it sat at its limit, and a
 * longer sort word would wrap it). A location's contents carry every sort, grouping and layout.
 */
test('the filter strip keeps one row at 375 px in every language', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'phone', 'the strip wraps only on a phone');
  test.setTimeout(180_000);
  const ctx = await session(browser, baseURL as string, 'ibrahim@kept.test');
  const p = await ctx.newPage();
  await p.goto('/');
  await settle(p);
  const location = await p.locator('a[href^="/loc/"]').first().getAttribute('href');
  expect(location).toBeTruthy();
  const rows: string[] = [];
  for (const lang of ['en', 'ar', 'fr', 'de', 'it']) {
    // The page-level script runs after the session's, so this language wins for this page.
    const page = await ctx.newPage();
    await page.addInitScript((l) => localStorage.setItem('kept.locale', l), lang);
    for (const q of ['sort=lastSeen&group=type', 'sort=updated&group=type']) {
      await page.goto(`${location}?${q}`);
      await settle(page);
      await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${lang}`));
      const strip = page
        .locator('[role=group]')
        .filter({ has: page.locator('input[type=search]') });
      await expect(strip).toBeVisible();
      const buttons = await strip.evaluate((g) =>
        [...g.children]
          .filter((c) => c.matches('button, [role=button]'))
          .map((c) => {
            const r = c.getBoundingClientRect();
            return { top: Math.round(r.top), left: r.left, right: r.right };
          }),
      );
      expect(buttons.length, `${lang} ${q}`).toBeGreaterThanOrEqual(2);
      const tops = new Set(buttons.map((b) => b.top));
      const inside = buttons.every((b) => b.left >= 0 && b.right <= 375);
      if (tops.size !== 1 || !inside) rows.push(`${lang} ${q}: ${JSON.stringify(buttons)}`);
    }
    await page.close();
  }
  expect(rows).toEqual([]);
  await p.close();
});

/** The focused element's accessible name, roughly: enough to tell where the keyboard is. */
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return '';
    const labelled = el.getAttribute('aria-labelledby');
    const byId = labelled ? document.getElementById(labelled)?.textContent : null;
    return (el.getAttribute('aria-label') ?? byId ?? el.textContent ?? '').trim();
  });

/** Tab (or Shift+Tab) until the focused element's name matches, as a keyboard user would. */
async function tabTo(page: Page, name: RegExp, { back = false, max = 60 } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    if (name.test(await focusedName(page))) return;
  }
  throw new Error(`Tab never reached ${name}`);
}

test('keyboard: capture → inbox → search → thing, with no mouse', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'desktop', 'the keyboard walk is a desktop path');
  test.setTimeout(180_000);
  const ctx = await session(browser, baseURL as string, 'ibrahim@kept.test');
  const p = await ctx.newPage();
  await p.goto('/');
  await settle(p);

  // Capture, from the top bar.
  await tabTo(p, /^Capture$/);
  await p.keyboard.press('Enter');
  await expect(p).toHaveURL(/\/capture$/);
  // The shutter is off until the camera shows its first frame (a disabled button isn't a tab stop).
  await expect(p.getByRole('button', { name: /^Take photo/ })).toBeEnabled({ timeout: 20_000 });
  await tabTo(p, /^Take photo/);
  await p.keyboard.press('Enter');
  await expect(p.getByText('1 captured')).toBeVisible();
  await tabTo(p, /^Done$/, { back: true });
  await p.keyboard.press('Enter');
  await expect(p.getByRole('heading', { name: 'Capture done' })).toBeVisible();
  // Saved on this browser first; the Inbox is the server's, so wait for the sync.
  await expect(p.getByText('1 synced')).toBeVisible({ timeout: 30_000 });

  // The Inbox, from the sidebar: the unnamed draft waits there for a name.
  await tabTo(p, /^Inbox/);
  await p.keyboard.press('Enter');
  await expect(p).toHaveURL(/\/inbox/);
  await expect(p.getByText('Needs a name').first()).toBeVisible();
  await p.keyboard.press('j');
  await p.keyboard.press('e');
  const name = p.getByRole('textbox', { name: 'Name' }).filter({ visible: true }).first();
  await expect(name).toBeFocused();
  await p.keyboard.type('Keyboard lamp');
  await tabTo(p, /^Save$/);
  await p.keyboard.press('Enter');
  await expect(p.getByText('Keyboard lamp').first()).toBeVisible();

  // Search with ⌘K, and open the thing.
  await p.keyboard.press('ControlOrMeta+k');
  const palette = p.getByRole('combobox', { name: 'Search or jump to' });
  await expect(palette).toBeFocused();
  await p.keyboard.type('Keyboard lamp');
  await expect(p.getByRole('option', { name: /^Keyboard lamp/ }).first()).toBeVisible();
  // The arrows move the active option (aria-activedescendant); Enter opens the thing.
  const active = () =>
    palette.evaluate((input) => {
      const id = input.getAttribute('aria-activedescendant');
      return (id && document.getElementById(id)?.textContent?.trim()) || '';
    });
  for (let i = 0; i < 10 && !(await active()).startsWith('Keyboard lamp'); i++)
    await p.keyboard.press('ArrowDown');
  expect(await active()).toMatch(/^Keyboard lamp/);
  await p.keyboard.press('Enter');
  await expect(p.getByRole('heading', { name: 'Keyboard lamp', level: 1 })).toBeVisible();
  await expect(p).toHaveURL(/\/t\//);
  await p.close();
});

test('keyboard: print labels from a start cell, then "Printed OK"', async ({
  browser,
  baseURL,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'the keyboard walk is a desktop path');
  test.setTimeout(120_000);
  const ctx = await session(browser, baseURL as string, 'ibrahim@kept.test');
  const p = await ctx.newPage();
  // The browser's print dialog can't be driven; count the calls instead.
  await p.addInitScript(() => {
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
  await p.goto('/labels');
  await settle(p);
  await tabTo(p, /^Label everything unprinted/);
  await p.keyboard.press('Enter');
  const print = p.getByRole('button', { name: /^Print \d+ labels?$/ });
  await expect(print).toBeVisible({ timeout: 20_000 });

  // A partly used sheet: start at the third cell, with the arrow keys.
  await tabTo(p, /^Label 1, row 1, column 1$/);
  await p.keyboard.press('ArrowRight');
  await p.keyboard.press('ArrowRight');
  await expect(p.getByText(/^Start at label 3 /)).toBeVisible();
  await tabTo(p, /^Print \d+ labels?$/, { back: true });
  await p.keyboard.press('Enter');

  await expect(p).toHaveURL(/\/labels\/[0-9a-f-]+$/);
  await expect
    .poll(() => p.evaluate(() => (window as unknown as { printed: number }).printed))
    .toBe(1);
  const printed = p.getByRole('dialog', { name: 'Printed OK?' });
  await expect(printed).toBeVisible();
  await tabTo(p, /^Yes, printed OK$/);
  await p.keyboard.press('Enter');
  await expect(printed).toBeHidden();
  await p.close();
});
