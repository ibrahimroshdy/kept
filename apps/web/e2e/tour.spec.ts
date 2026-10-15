/**
 * The guided tour against the real server (D242), on its own seeded `tour` instance
 * (e2e/instances.ts): one person per project, because where the tour stopped is remembered per
 * person on the server.
 *
 * 1. Help → Show me around walks every stop in order, each pointing at its control
 *    (`data-tour`), the start of that control in view and clear of the popover (on a phone, a
 *    sheet docked above the tab bar, or at the top on Capture), and finishes on Help.
 * 2. In Arabic the popover stays on screen and counts in Eastern digits.
 * 3. A tap outside the highlight reaches the page: it follows the link, and the tour ends there.
 * 4. Closed part-way, it resumes at the same stop after a reload (the server's hints), and Start
 *    over goes back to Home.
 *
 * No real device is touched: before any page script, getUserMedia and getDisplayMedia reject
 * with NotAllowedError, SpeechRecognition is gone and geolocation refuses (Capture opens with the
 * camera "off"). No permission is granted.
 *
 *   KEPT_E2E_INSTANCES=tour pnpm --filter @kept/web exec playwright test tour.spec.ts
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { INSTANCES, stateDirOf, urlOf } from './instances';

const TOUR = INSTANCES.tour;
const BASE = urlOf(TOUR);
const PASSWORD = 'kept-seed-password';
/** The seed's people (apps/server/src/seed/cast.ts): the owner on desktop, an admin on the phone. */
const PERSON = { desktop: 'ibrahim@kept.test', phone: 'bruce@kept.test' } as const;

test.use({ baseURL: BASE });
test.describe.configure({ mode: 'serial' });

/** Every device API stubbed before the app's own scripts run. */
function stubDevices() {
  const deny = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  const media = {
    getUserMedia: deny,
    getDisplayMedia: deny,
    enumerateDevices: () => Promise.resolve([]),
    getSupportedConstraints: () => ({}),
    addEventListener() {},
    removeEventListener() {},
    ondevicechange: null,
  };
  Object.defineProperty(Navigator.prototype, 'mediaDevices', {
    configurable: true,
    get: () => media,
  });
  const w = window as unknown as Record<string, unknown>;
  for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    delete w[name];
    Object.defineProperty(window, name, { configurable: true, writable: true, value: undefined });
  }
  const geo = {
    getCurrentPosition: (_ok: unknown, err?: (e: { code: number; message: string }) => void) =>
      err?.({ code: 1, message: 'denied' }),
    watchPosition: (_ok: unknown, err?: (e: { code: number; message: string }) => void) => {
      err?.({ code: 1, message: 'denied' });
      return 0;
    },
    clearWatch() {},
  };
  Object.defineProperty(Navigator.prototype, 'geolocation', { configurable: true, get: () => geo });
}

const project = () => test.info().project.name as 'phone' | 'desktop';

/** Sign-in is limited to 5 a minute: each person signs in once per run and reuses the cookie. */
async function storageFor(browser: Browser, login: string): Promise<string> {
  const dir = path.join(stateDirOf(TOUR), 'sessions');
  const file = path.join(dir, `${login}.json`);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ baseURL: BASE });
  await ctx.addInitScript(stubDevices);
  const page = await ctx.newPage();
  await page.goto('/signin');
  await page.getByLabel('Email or username', { exact: true }).fill(login);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await ctx.storageState({ path: file });
  await ctx.close();
  return file;
}

/** This project's person, signed in, shaped like the project, optionally in Arabic. */
async function person(
  browser: Browser,
  locale: 'en' | 'ar' = 'en',
): Promise<{ context: BrowserContext; page: Page }> {
  const use = test.info().project.use;
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: await storageFor(browser, PERSON[project()]),
    viewport: use.viewport ?? { width: 1280, height: 800 },
    isMobile: use.isMobile ?? false,
    hasTouch: use.hasTouch ?? false,
    timezoneId: 'Africa/Cairo',
    locale: 'en-GB',
  });
  await context.addInitScript(stubDevices);
  await context.addInitScript((l) => {
    try {
      localStorage.setItem('kept.locale', l);
    } catch {}
  }, locale);
  return { context, page: await context.newPage() };
}

const popover = (page: Page) => page.locator('.driver-popover');

/** The stop on screen: its title, its progress, and what it highlights. */
async function stopOf(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    const pop = document.querySelector('.driver-popover');
    const target = document.querySelector('.driver-active-element');
    return {
      title: pop?.querySelector('.driver-popover-title')?.textContent ?? '',
      progress: pop?.querySelector('.driver-popover-progress-text')?.textContent ?? '',
      anchor: target?.getAttribute('data-tour') ?? null,
      target: box(target),
      popover: box(pop),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });
}

/** The walk this project's person gets (components/hints/tour.ts GUIDED_SECTIONS). */
const WALK = (layout: 'phone' | 'desktop') => [
  { title: 'Home', anchor: 'home-needs', path: /\/$/ },
  { title: 'Capture', anchor: 'capture-shutter', path: /\/capture$/ },
  { title: 'Inbox', anchor: 'inbox-whose', path: /\/inbox$/ },
  { title: 'Location', anchor: 'location-layout', path: /\/loc\/[^/]+$/ },
  { title: 'Search', anchor: 'search-field', path: /\/search$/ },
  { title: 'Labels', anchor: 'labels-print', path: /\/labels/ },
  layout === 'phone'
    ? { title: 'More', anchor: 'more-entries', path: /\/more$/ }
    : // A desktop points at the sidebar where it is: still on Labels.
      { title: 'Everything else', anchor: 'nav-entries', path: /\/labels/ },
  { title: 'Notifications', anchor: 'settings-notifications', path: /\/settings$/ },
  { title: "That's the tour", anchor: 'help-tour', path: /\/help$/ },
];

/** Start (or Resume, or Start over) from Help's "Show me around" row. */
async function fromHelp(page: Page, button: string) {
  await page.goto('/help');
  const row = page.locator('[data-tour="help-tour"]');
  await row.getByRole('button', { name: button, exact: true }).click();
  await expect(popover(page)).toBeVisible();
}

test('walks every stop, each pointing at its control, and finishes on Help', async ({
  browser,
}) => {
  const { context, page } = await person(browser);
  const walk = WALK(project());
  await fromHelp(page, 'Start');
  for (const [k, leg] of walk.entries()) {
    await expect(popover(page).locator('.driver-popover-title')).toHaveText(leg.title);
    await expect(popover(page)).toContainText(`${k + 1} of ${walk.length}`);
    await expect(page).toHaveURL(leg.path);
    // Let driver.js and the sheet's scroll settle before measuring.
    await expect
      .poll(async () => (await stopOf(page)).anchor, { message: leg.title })
      .toBe(leg.anchor);
    await page.waitForTimeout(500);
    const s = await stopOf(page);
    expect(s.target, leg.title).not.toBeNull();
    expect(s.popover, leg.title).not.toBeNull();
    if (!s.target || !s.popover) continue;
    // The popover is on screen.
    expect(s.popover.left, `${leg.title}: popover left`).toBeGreaterThanOrEqual(0);
    expect(s.popover.right, `${leg.title}: popover right`).toBeLessThanOrEqual(s.vw);
    expect(s.popover.top, `${leg.title}: popover top`).toBeGreaterThanOrEqual(0);
    expect(s.popover.bottom, `${leg.title}: popover bottom`).toBeLessThanOrEqual(s.vh);
    // The start of what it points at is in view and not under the popover.
    expect(s.target.top, `${leg.title}: target in view`).toBeGreaterThanOrEqual(0);
    expect(s.target.top, `${leg.title}: target in view`).toBeLessThan(s.vh);
    const under =
      s.target.top >= s.popover.top - 1 &&
      s.target.top < s.popover.bottom &&
      s.target.left < s.popover.right &&
      s.target.right > s.popover.left;
    expect(under, `${leg.title}: target's top under the popover`).toBe(false);
    if (k > 0) await expect(popover(page).getByRole('button', { name: 'Back' })).toBeVisible();
    await popover(page)
      .getByRole('button', { name: k === walk.length - 1 ? 'Done' : 'Next', exact: true })
      .click();
  }
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator('[data-tour="help-tour"]')).toContainText(
    'Seen it all. Replay it any time.',
  );
  await context.close();
});

test('stays on screen in Arabic, counting in its digits', async ({ browser }) => {
  const { context, page } = await person(browser, 'ar');
  await page.goto('/help');
  await page.locator('[data-tour="help-tour"]').getByRole('button', { name: 'ابدأ' }).click();
  await expect(popover(page).locator('.driver-popover-title')).toHaveText('الرئيسية');
  await expect(popover(page)).toContainText('١ من ٩');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const s = await stopOf(page);
  expect(s.popover?.left ?? -1).toBeGreaterThanOrEqual(0);
  expect(s.popover?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(s.vw);
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await context.close();
});

test('lets a tap outside the highlight through to the page', async ({ browser }) => {
  const { context, page } = await person(browser);
  await fromHelp(page, 'Start');
  await expect(popover(page).locator('.driver-popover-title')).toHaveText('Home');
  // Outside the highlight: the tab bar's Search on a phone, the sidebar's Activity on a desktop.
  const [name, url] = project() === 'phone' ? ['Search', /\/search$/] : ['Activity', /\/activity$/];
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name, exact: true })
    .click();
  await expect(page).toHaveURL(url);
  // Going somewhere the tour didn't take you ends it, where it was.
  await expect(popover(page)).toHaveCount(0);
  await context.close();
});

test('resumes where it stopped after a reload, or starts over', async ({ browser }) => {
  const { context, page } = await person(browser);
  // The last two runs ended on Home before passing it: nothing to resume yet.
  await fromHelp(page, 'Start');
  for (const title of ['Home', 'Capture']) {
    await expect(popover(page).locator('.driver-popover-title')).toHaveText(title);
    await popover(page).getByRole('button', { name: 'Next', exact: true }).click();
  }
  await expect(popover(page).locator('.driver-popover-title')).toHaveText('Inbox');
  await popover(page).getByRole('button', { name: 'Close' }).click();
  await expect(popover(page)).toHaveCount(0);
  // The server has it: a fresh load of Help still knows.
  await page.goto('/help');
  await page.reload();
  await expect(page.locator('[data-tour="help-tour"]')).toContainText('Stopped at Inbox.');
  await page.locator('[data-tour="help-tour"]').getByRole('button', { name: 'Resume' }).click();
  await expect(popover(page).locator('.driver-popover-title')).toHaveText('Inbox');
  await expect(popover(page)).toContainText('3 of 9');
  await expect(page).toHaveURL(/\/inbox$/);
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await fromHelp(page, 'Start over');
  await expect(popover(page).locator('.driver-popover-title')).toHaveText('Home');
  await expect(popover(page)).toContainText('1 of 9');
  await page.keyboard.press('Escape');
  await context.close();
});
