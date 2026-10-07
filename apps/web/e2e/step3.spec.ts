/**
 * Step 3's flows against the real server (plan T32), on the `households` seed with every AI call
 * answered by the mock provider (the `capture` instance, e2e/camera.ts), in Chromium with a fake
 * camera (playwright.config.ts: e2e/fixtures/camera-thing.y4m; the scan test launches its own
 * browser on camera-qr.y4m, a QR of the seeded Bosch drill's label).
 *
 * One instance for both projects, so each test runs in one project and writes to its own things:
 * the phone (375×780) runs capture, scan, the claim race, the viewer and Arabic; the desktop
 * (1280×800) prints labels. Every page a test visits is checked with axe (nothing above "minor").
 *
 *   KEPT_E2E_INSTANCES=capture pnpm --filter @kept/web exec playwright test step3.spec.ts
 *
 * A cold reload while offline starts the frame from the phone's last-known copy (offline/
 * shell.ts); the offline capture flow goes offline with the app open, as a phone that loses
 * signal does.
 *
 * Offline, the Search screen searches the phone's copy (components/search/offline-results.tsx):
 * a queued capture ("ID pending") and a synced thing are both found.
 *
 * The receipt flow picks e2e/fixtures/receipt-usd.jpg from the Gallery in Receipt mode; the mock
 * provider (KEPT_AI_MOCK=1) answers by the hash of the image it is sent, and e2e/serve.mjs keys
 * e2e/fixtures/mock-answers.json to that hash, so the running server reads it as a `$` receipt.
 *
 * The update prompt (two builds) is e2e/step3-update.spec.ts, run on its own.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { CAPTURE_INSTANCE, fakeCameraArgs, fixtureFile, fixtureVideo } from './camera';
import { stateDirOf, urlOf } from './instances';

const BASE = urlOf(CAPTURE_INSTANCE);
const PASSWORD = 'kept-seed-password';
/** A made-up key for the mock provider: KEPT_AI_MOCK=1 never sends it anywhere (D202 kind: groq). */
const MOCK_KEY = 'gsk_e2e-mock-provider-not-a-real-key';
/** The seeded Bosch drill (camera-qr.y4m) and HDMI cable (Home; Talia is a viewer there). */
const DRILL = { code: '2HX9RB', name: 'Bosch drill, 18 V' };
const CABLE = { code: '7KQ4MZ', name: 'HDMI cable, 2 m' };
/** Codes in no location (32⁶ possible; the seed's are random). */
const NOWHERE = ['ZX9ZX9', 'ZX9ZX8'];

// Not serial: each test stands alone, so one failure doesn't hide the others.
test.use({ baseURL: BASE });

const onlyOn = (project: 'phone' | 'desktop') =>
  test.skip(test.info().project.name !== project, `runs in the ${project} project`);

// ---------------------------------------------------------------------------------------------
// Sessions: sign-in is limited to 5 a minute, so each person signs in once per run and every
// later context reuses the cookie (Playwright storage state; the phone's own store is per
// context, as on a new phone).

const stateDir = path.join(stateDirOf(CAPTURE_INSTANCE), 'sessions');

async function storageFor(browser: Browser, login: string): Promise<string> {
  const file = path.join(stateDir, `${login}.json`);
  if (existsSync(file)) return file;
  mkdirSync(stateDir, { recursive: true });
  const ctx = await browser.newContext({ baseURL: BASE });
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

/** A signed-in context shaped like the running project, optionally in Arabic. */
async function person(
  browser: Browser,
  login: string,
  opts: { locale?: 'ar' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const use = test.info().project.use;
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: await storageFor(browser, login),
    viewport: use.viewport ?? { width: 1280, height: 800 },
    isMobile: use.isMobile ?? false,
    hasTouch: use.hasTouch ?? false,
    timezoneId: 'Africa/Cairo',
    locale: 'en-GB',
  });
  if (opts.locale) {
    await context.addInitScript((l) => {
      try {
        localStorage.setItem('kept.locale', l);
      } catch {}
    }, opts.locale);
  }
  const page = await context.newPage();
  return { context, page };
}

/** The page's API with the page's own cookie and origin (the CSRF check wants the origin). */
const api = (page: Page) => ({
  get: (url: string) => page.request.get(url),
  send: (method: 'POST' | 'PUT', url: string, data: unknown) =>
    page.request.fetch(url, { method, data, headers: { origin: BASE } }),
});

/** Nothing above "minor" on this page (WCAG 2.2 A/AA and axe's best practices), as T31b. */
async function axe(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations
    .filter((v) => v.impact && v.impact !== 'minor')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')}`);
  // Soft: a violation fails the test, but the flow goes on, so one finding doesn't hide the rest.
  expect.soft(serious, `axe on ${where}`).toEqual([]);
}

async function controlled(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

/** Garage's id, from the locations list. */
async function garageId(page: Page): Promise<string> {
  const res = await api(page).get('/api/v1/locations');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { locations?: { id: string; name: string }[] } | unknown[];
  const list = (Array.isArray(body) ? body : (body.locations ?? [])) as {
    id: string;
    name: string;
  }[];
  const garage = list.find((l) => l.name === 'Garage');
  if (!garage) throw new Error('no Garage location');
  return garage.id;
}

/** The account's AI provider, set up once with the mock key (Garage is paid by the account). */
async function ensureMockProvider(page: Page) {
  const res = await api(page).get('/api/v1/ai/providers');
  expect(res.ok()).toBe(true);
  const { providers } = (await res.json()) as { providers: { scope: string }[] };
  if (providers.some((p) => p.scope === 'account')) return;
  const put = await api(page).send('PUT', '/api/v1/ai/providers/account', { apiKey: MOCK_KEY });
  expect(put.status(), await put.text()).toBe(200);
}

/**
 * Capture into Garage › Shelf A in Receipt mode, the fixture receipt picked from the Gallery (as
 * on an iPhone, which can't share into Kept: V9), then Done twice.
 */
async function receiptFromGallery(page: Page) {
  await page.goto('/capture');
  await page.getByRole('button', { name: /^Capturing into / }).click();
  await page
    .getByRole('dialog', { name: 'Capture into' })
    .getByText('Shelf A', { exact: true })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Capture mode' })
    .getByRole('radio', { name: 'Receipt' })
    .check({ force: true });
  await expect(page.getByRole('button', { name: 'Take photo: receipt' })).toBeVisible();
  // The Gallery's input: many files, no `capture` (the system camera's has one).
  await page
    .locator('input[type="file"][multiple]:not([capture])')
    .setInputFiles(fixtureFile('receipt-usd.jpg'));
  await expect(page.getByText('1 captured', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capture done', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  // Uploaded and sent before anything navigates away (a page never unloads mid-upload: D148).
  await expect(page.getByText(/waiting to sync/)).toHaveCount(0, { timeout: 60_000 });
}

// ---------------------------------------------------------------------------------------------

test('offline capture: three things into Garage › Shelf A, found offline, named by AI once online, accepted with the keyboard and undone', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(240_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  await ensureMockProvider(page);

  // Online once: the worker installs and the snapshot syncs.
  await page.goto('/');
  await controlled(page);
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await axe(page, 'Home');

  // The connection drops with the app open: Home says what it shows is as of the last sync.
  await context.setOffline(true);
  await expect(page.getByText(/^Offline · as of last sync, /).first()).toBeVisible({
    timeout: 30_000,
  });

  await nav(page, 'Capture').click();
  await page.getByRole('button', { name: /^Capturing into / }).click();
  await page
    .getByRole('dialog', { name: 'Capture into' })
    .getByText('Shelf A', { exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /^Capturing into Garage › Shelf A/ }),
  ).toBeVisible();
  await axe(page, 'Capture');
  // One named on the spot, two left for AI.
  await page.getByRole('textbox', { name: 'Name' }).fill('E2E orbital sander');
  for (let i = 1; i <= 3; i++) {
    await page.getByRole('button', { name: /^Take photo/ }).click();
    await expect(page.getByText(`${i} captured`, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Offline · 3 waiting to sync').first()).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Capture done', level: 1 })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Waiting · ID pending' })).toHaveCount(3);
  await axe(page, 'Capture done');
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // Findable offline: the Search screen searches the phone, the capture still "ID pending".
  await nav(page, 'Search').click();
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('orbital sander');
  const found = page.getByRole('link', { name: /E2E orbital sander/ }).first();
  await expect(found).toBeVisible({ timeout: 15_000 });
  await expect(found.getByText('ID pending')).toBeVisible();
  await expect(page.getByText(/^On this phone · as of last sync, /)).toBeVisible();
  await axe(page, 'Search (offline)');
  await nav(page, 'Home').click();

  // Back online: the queue syncs, the mock names the two photos, and the Inbox groups the batch.
  await context.setOffline(false);
  await expect(page.getByText(/waiting to sync/)).toHaveCount(0, { timeout: 60_000 });
  await expect(async () => {
    await page.goto('/inbox');
    await expect(page.getByText(/· 3 captured · Garage › Shelf A/).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByRole('article', { name: 'Thing', exact: true })).toHaveCount(2, {
      timeout: 5_000,
    });
  }).toPass({ timeout: 120_000, intervals: [3_000] });
  // Each has its short ID now.
  for (const a of await page.getByRole('article', { name: 'Thing', exact: true }).all()) {
    await expect(a.getByRole('img', { name: /^[0-9A-Z]{6}$/ })).toBeVisible();
  }
  await axe(page, 'Inbox');

  // Keyboard: select both (x, next, x) and accept the selected names (Shift+A).
  await page.getByRole('heading', { name: 'Inbox', level: 1 }).click();
  await page.keyboard.press('x');
  await page.keyboard.press('j');
  await page.keyboard.press('x');
  await expect(page.getByRole('toolbar', { name: 'Selected drafts' })).toContainText('2 selected');
  await page.keyboard.press('Shift+A');
  const toast = page.getByRole('region', { name: 'Notifications' });
  await expect(toast.getByText('Accepted 2 names').first()).toBeVisible();
  await expect(page.getByRole('article', { name: 'Thing', exact: true })).toHaveCount(0);
  await toast.getByRole('button', { name: 'Undo' }).last().click();
  await expect(page.getByRole('article', { name: 'Thing', exact: true })).toHaveCount(2, {
    timeout: 20_000,
  });
  await context.close();
});

test('a cold reload while offline opens the signed-in app from the phone', async ({ browser }) => {
  onlyOn('phone');
  // The shell comes from the service worker; the frame starts from the phone's last-known `/me`
  // and locations, kept in the person's own database, never the Cache API (offline/shell.ts).
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  await page.goto('/');
  await controlled(page);
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Garage/ }).first()).toBeVisible();
  // The snapshot syncs once (so there is an "as of") and the frame's copy is saved.
  await page.waitForTimeout(3_000);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/^Offline · as of last sync, /).first()).toBeVisible();
  await expect(page.getByText("Couldn't load this")).toHaveCount(0);
  // The frame is whole: the main navigation, and the locations from the last sync.
  await expect(nav(page, 'Search')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Garage/ }).first()).toBeVisible();
  await axe(page, 'Home (cold start offline)');

  // A 401 once back online still locks the phone (D210): the session is gone, so sign-in.
  await context.clearCookies();
  await context.setOffline(false);
  await expect(page).toHaveURL(/\/signin/, { timeout: 30_000 });
  await context.close();
});

test('offline, the Search screen finds things kept on the phone', async ({ browser }) => {
  onlyOn('phone');
  // The Things group answers from the phone's copy (components/search/offline-results.tsx);
  // documents say they need a connection.
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  await page.goto('/');
  await controlled(page);
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText(/^Offline · as of last sync, /).first()).toBeVisible({
    timeout: 30_000,
  });
  await nav(page, 'Search').click();
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('bosch drill');
  const drill = page.getByRole('link', { name: new RegExp(DRILL.name) }).first();
  await expect(drill).toBeVisible({ timeout: 15_000 });
  await expect(drill.getByRole('img', { name: DRILL.code })).toBeVisible();
  await expect(page.getByText(/^On this phone · as of last sync, /)).toBeVisible();
  await expect(page.getByText('Documents need a connection')).toBeVisible();
  // By its short ID too, like the server.
  await page.getByRole('searchbox', { name: 'Search everything' }).fill(DRILL.code.toLowerCase());
  await expect(page.getByRole('link', { name: new RegExp(DRILL.name) }).first()).toBeVisible();
  await context.close();
});

test('scan: the camera reads a seeded label and opens it (seen now); a random code is not in your Kept; offline, an unknown one waits', async ({
  browser,
}) => {
  onlyOn('phone');
  // A browser of its own, whose camera shows the drill's label.
  const use = test.info().project.use;
  const qrBrowser = await chromium.launch({
    ...(use.channel ? { channel: use.channel } : {}),
    args: fakeCameraArgs(fixtureVideo('camera-qr')),
  });
  try {
    const context = await qrBrowser.newContext({
      baseURL: BASE,
      storageState: await storageFor(browser, 'ibrahim@kept.test'),
      viewport: use.viewport ?? { width: 375, height: 780 },
      isMobile: true,
      hasTouch: true,
      timezoneId: 'Africa/Cairo',
      locale: 'en-GB',
    });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Scan' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/t/${DRILL.code}`), { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: DRILL.name, level: 1 })).toBeVisible();
    // Marked seen by this scan (D40): today's history says so.
    await expect(page.getByRole('article', { name: `Saw ${DRILL.name}` }).first()).toBeVisible();
    await axe(page, 'Thing page after a scan');
    await context.close();
  } finally {
    await qrBrowser.close();
  }

  // Typed codes on the phone's own camera (no label in view).
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  await page.goto('/scan');
  const typeCode = async (code: string) => {
    await page.getByRole('button', { name: 'Type the code' }).click();
    await page.getByRole('textbox', { name: 'Code on the label' }).fill(code);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
  };
  await typeCode(NOWHERE[0] as string);
  const result = page.getByRole('region', { name: 'Scan result' });
  await expect(result.getByRole('heading', { name: 'Not in your Kept' })).toBeVisible();
  await axe(page, 'Scan: not in your Kept');
  await result.getByRole('button', { name: 'Scan again' }).click();

  await context.setOffline(true);
  await typeCode(NOWHERE[1] as string);
  await expect(result.getByRole('heading', { name: 'Not on this phone' })).toBeVisible();
  await expect(result).toContainText("It will check when you're online.");
  await context.setOffline(false);
  await context.close();
});

test('the claim race: two phones claim one blank label offline; the first to sync wins, the other is told in its Inbox', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(180_000);
  const a = await person(browser, 'ibrahim@kept.test');
  const b = await person(browser, 'bruce@kept.test');
  await a.page.goto('/');
  const created = await api(a.page).send('POST', '/api/v1/labels/batches', {
    locationId: await garageId(a.page),
    kind: 'blank',
    blankCount: 1,
    stock: 'a4_24_70x37',
  });
  expect(created.status(), await created.text()).toBe(201);
  const code = ((await created.json()) as { batch: { labels: { code: string }[] } }).batch.labels[0]
    ?.code as string;

  for (const [who, x] of [
    ['Ibrahim', a],
    ['Bruce', b],
  ] as const) {
    // Online once, so the blank is in the phone's snapshot; then offline, claim it for a box.
    await x.page.goto('/');
    await controlled(x.page);
    await x.page.waitForTimeout(3_000);
    await x.page.goto('/scan');
    await expect(x.page.getByRole('heading', { name: 'Scan', level: 1 })).toBeVisible();
    await x.context.setOffline(true);
    await x.page.getByRole('button', { name: 'Type the code' }).click();
    await x.page.getByRole('textbox', { name: 'Code on the label' }).fill(code);
    await x.page.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(x.page.getByRole('heading', { name: 'Claim this label' })).toBeVisible({
      timeout: 15_000,
    });
    await x.page.getByRole('button', { name: 'New box here' }).click();
    await x.page.getByRole('textbox', { name: 'Name' }).fill(`${who}'s camping box`);
    await x.page.getByRole('button', { name: 'Claim', exact: true }).click();
    await expect(
      x.page.getByText(`Label claimed for ${who}'s camping box on this phone`).first(),
    ).toBeVisible();
  }

  // Ibrahim syncs first and wins (his box is on the server); then Bruce.
  await a.context.setOffline(false);
  await expect(async () => {
    const res = await api(a.page).get(
      `/api/v1/search?q=${encodeURIComponent("Ibrahim's camping box")}&kind=things`,
    );
    const body = (await res.json()) as { things: { items: { name: string }[] } };
    expect(body.things.items.map((t) => t.name)).toContain("Ibrahim's camping box");
  }).toPass({ timeout: 60_000, intervals: [2_000] });
  await b.context.setOffline(false);
  await expect(async () => {
    await b.page.goto('/inbox');
    const item = b.page.getByRole('article', { name: `Label ${code}` });
    await expect(item).toContainText('Label already claimed', { timeout: 5_000 });
    await expect(item).toContainText("Ibrahim's camping box");
  }).toPass({ timeout: 90_000, intervals: [3_000] });
  await axe(b.page, 'Inbox: label claim');
  await a.context.close();
  await b.context.close();
});

test('receipt: a `$` receipt picked from the Gallery in Receipt mode asks USD or CAD, and its review creates the things', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(180_000);
  // Gallery follows the mode strip (found in T32: it made THING drafts whatever the strip said).
  // The mock reads the fixture as CORNER HARDWARE, `$20.50`, two lines: e2e/fixtures/
  // mock-answers.json, keyed by e2e/serve.mjs to the image the server sends.
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  await ensureMockProvider(page);
  await receiptFromGallery(page);

  // Synced and read: a receipt, never a Thing draft, and a bare `$` waits for the person.
  const ask = page.getByRole('article').filter({ hasText: 'Needs a currency' });
  // Exact: the question is "CORNER HARDWARE receipt · Needs a currency".
  const review = page.getByRole('article', { name: 'CORNER HARDWARE receipt', exact: true });
  await expect(async () => {
    await page.goto('/inbox');
    await expect(ask).toBeVisible({ timeout: 5_000 });
    await expect(review).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000, intervals: [3_000] });
  await expect(ask).toContainText('“$” alone can mean US or Canadian dollars. Which was it?');
  // Both offered, neither chosen for them (D189), here and in the review.
  const currency = ask.getByRole('group', { name: 'Currency' });
  await expect(currency.getByRole('button')).toHaveText([/· USD$/, /· CAD$/]);
  await expect(review.getByRole('combobox', { name: 'Currency' })).toHaveValue('');
  // Both items, the question and the review, are on the page.
  await axe(page, 'Inbox: needs a currency, and the receipt review');
  await currency.getByRole('button', { name: /· USD$/ }).click();
  await expect(ask).toHaveCount(0, { timeout: 20_000 });

  // The review takes the answer: shop, date and total as read, in USD, each line a new thing.
  await expect(review.getByRole('combobox', { name: 'Currency' })).toHaveValue('USD');
  await expect(review.getByRole('textbox', { name: 'Total' })).toHaveValue(/^20\.50*$/);
  await review.getByRole('button', { name: 'Accept the receipt' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Accepted the receipt').first(),
  ).toBeVisible();
  await expect(review).toHaveCount(0, { timeout: 20_000 });

  // Two things now exist, one per line.
  for (const name of ['Tape measure 5 m', 'Utility knife']) {
    await expect(async () => {
      const res = await api(page).get(`/api/v1/search?q=${encodeURIComponent(name)}&kind=things`);
      const body = (await res.json()) as { things: { items: { name: string }[] } };
      expect(body.things.items.map((t) => t.name)).toContain(name);
    }).toPass({ timeout: 30_000, intervals: [2_000] });
  }
  await context.close();
});

test('labels: three things on an A4 sheet from cell 5, printed to PDF at the sheet size, Printed OK ticks Home', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(120_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  // The print dialog is the browser's; record the call instead of opening it.
  await context.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints += 1;
    };
  });
  await page.goto('/p/7SH2AA');
  await page
    .getByRole('navigation', { name: 'Path' })
    .getByRole('link', { name: 'Garage' })
    .click();
  await page
    .getByRole('link', { name: /^Tool wall/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Tool wall', level: 1 })).toBeVisible();
  // Select sits beside the contents' search (UI audit L5, 128585b); the Selection toolbar
  // appears once it is on.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const n of [DRILL.name, 'Bosch impact driver, 18 V', 'Claw hammer']) {
    await page.getByRole('checkbox', { name: `Select ${n}` }).check({ force: true });
  }
  await page
    .getByRole('toolbar', { name: 'Selection' })
    .getByRole('button', { name: 'Print labels' })
    .click();
  await expect(page.getByRole('heading', { name: 'Print labels', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Printing 3' })).toBeVisible();
  await page
    .getByRole('radiogroup', { name: 'Label stock' })
    .getByRole('radio', { name: /^A4 sheet · 24 labels/ })
    .check({ force: true });
  await page.getByRole('radio', { name: 'Label 5, row 2, column 2' }).check({ force: true });
  await axe(page, 'Print labels');
  await page.getByRole('button', { name: 'Print 3 labels' }).click();

  // The print view: one sheet, the three labels in cells 5, 6 and 7.
  const sheet = page.getByRole('region', { name: 'Sheet 1 of 1' });
  await expect(sheet).toBeVisible();
  expect(
    await sheet
      .locator('[data-cell]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-cell'))),
  ).toEqual(['5', '6', '7']);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
    .toBeGreaterThan(0);
  // Chromium honours the @page rule: an A4 page (595 × 842 pt).
  const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString(
    'latin1',
  );
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf);
  expect(box, 'a MediaBox in the PDF').not.toBeNull();
  expect(Math.round(Number(box?.[1]))).toBe(595);
  expect(Math.round(Number(box?.[2]))).toBe(842);
  expect(pdf.match(/\/Type\s*\/Page\b/g)?.length).toBe(1);

  const dialog = page.getByRole('dialog', { name: 'Printed OK?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Yes, printed OK' }).click();
  await expect(dialog).toBeHidden();

  // Home's checklist: the label step is done (it joins the done row as "Printed a label").
  await page.goto('/');
  const started = page.getByRole('region', { name: 'Get started' });
  await expect(started.getByRole('listitem').filter({ hasText: 'Printed a label' })).toContainText(
    /^Done/,
  );
  await expect(started.getByText('Print your first label')).toHaveCount(0);
  await axe(page, 'Home (desktop)');
  await context.close();
});

test('a viewer: captures only where they write, and a scanned label opens read-only', async ({
  browser,
}) => {
  onlyOn('phone');
  // Talia is a viewer of Home. Every account has its own Personal location (ensure_account), so
  // a viewer always has Capture and an Inbox for that; what they must not get is Home.
  const { context, page } = await person(browser, 'talia@kept.test');
  await page.goto('/capture');
  await page.getByRole('button', { name: /^Capturing into / }).click();
  const into = page.getByRole('dialog', { name: 'Capture into' });
  await expect(into.getByText('Personal', { exact: true })).toBeVisible();
  await expect(into.getByText('Living room', { exact: true })).toHaveCount(0);
  await into.getByRole('button', { name: 'Close' }).click();

  await page.goto('/scan');
  await page.getByRole('button', { name: 'Type the code' }).click();
  await page.getByRole('textbox', { name: 'Code on the label' }).fill(CABLE.code);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${CABLE.code}`), { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: CABLE.name, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a photo' })).toHaveCount(0);
  await axe(page, 'Thing page as a viewer');
  await context.close();
});

test('Arabic: capture and the inbox mirror, and short IDs stay left to right', async ({
  browser,
}) => {
  onlyOn('phone');
  const { context, page } = await person(browser, 'alfred@kept.test', { locale: 'ar' });
  await page.goto('/capture');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  // The mode strip ("وضع الالتقاط", Capture mode) runs right to left: its first mode is the
  // rightmost.
  const strip = page.getByRole('radiogroup', { name: 'وضع الالتقاط' });
  await expect(strip.getByRole('radio')).toHaveCount(4);
  const xs = await strip
    .getByRole('radio')
    .evaluateAll((els) =>
      els.map((e) => ((e.closest('label') ?? e) as HTMLElement).getBoundingClientRect().x),
    );
  expect(xs.length).toBeGreaterThanOrEqual(4);
  expect([...xs].sort((p, q) => q - p)).toEqual(xs);
  await axe(page, 'Capture (Arabic)');

  await page.goto('/inbox');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/[؀-ۿ]/);
  await axe(page, 'Inbox (Arabic)');

  // A short ID in an Arabic page reads left to right.
  await page.goto(`/t/${CABLE.code}`);
  const chip = page.getByRole('img', { name: CABLE.code }).first();
  await expect(chip).toBeVisible();
  expect(await chip.evaluate((e) => getComputedStyle(e).direction)).toBe('ltr');
  await context.close();
});
