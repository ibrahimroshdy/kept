/**
 * Step 5's vehicle journeys against the real server (plan T25), on the `households` seed with the
 * AI mock (the `vehicles` instance, e2e/instances.ts):
 *
 * 1. Offline reading: a car opened online; offline, Home → Log a reading → a value with a photo →
 *    "Saved on this phone"; online, it syncs and shows in Readings with its proof photo.
 * 2. A reading online on the vehicle page fits, saves, and moves the odometer's estimate.
 * 3. A misfit by sync: offline, a reading below the latest; online, it waits in the Inbox.
 * 4. Service from an invoice: Log a service, the fixture invoice read by AI into three suggested
 *    lines (a draft), Confirm all, Save confirms it, Undo from the toast makes it a draft again.
 * 5. Fuel: two full fills and a partial between them give the car's consumption.
 * 6. Starter schedules on a new car: four, and their distance due points read as estimated dates
 *    once the odometer has two readings.
 * 7. The history report of the Corolla, in English and in Arabic: made, downloaded, a PDF.
 * 8. Talia as a viewer of the Garage (invited by Ibrahim here; the seed has her in Home only): the
 *    Corolla with no Log buttons and no amounts.
 * 9. The vehicle page in Arabic: right to left, Eastern digits.
 *
 * Every page a test visits is checked with axe (nothing above "minor"). Each journey that writes
 * works on a car of its own, made through the API as the person would, so the phone and desktop
 * projects (which run at the same time on this one instance) never share a car's readings.
 *
 * Imperial units (mpg) aren't driven here: no route or screen sets a person's units yet (step-5
 * carry-over); components/fuel/fuel.test.tsx covers the mpg reading.
 *
 *   KEPT_E2E_INSTANCES=vehicles pnpm --filter @kept/web exec playwright test step5.spec.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  expect as baseExpect,
  type Page,
  test,
} from '@playwright/test';
import { stateDirOf, urlOf, VEHICLES_INSTANCE } from './instances';

// The instance shares its Postgres with every other test run on the machine: 30 s, not 10.
const expect = baseExpect.configure({ timeout: 30_000 });

const VEHICLES = VEHICLES_INSTANCE;
const BASE = urlOf(VEHICLES);
const PASSWORD = 'kept-seed-password';
const ZONE = 'Africa/Cairo';
const INVOICE = fileURLToPath(new URL('./fixtures/invoice-service.jpg', import.meta.url));
const PHOTO = fileURLToPath(new URL('./fixtures/receipt-usd.jpg', import.meta.url));

test.use({ baseURL: BASE });

const onlyOn = (project: 'phone' | 'desktop') =>
  test.skip(test.info().project.name !== project, `runs in the ${project} project`);

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
const daysAgo = (n: number, hour = 9) => {
  const d = new Date(`${today()}T${String(hour).padStart(2, '0')}:00:00+03:00`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
};

// ---------------------------------------------------------------------------------------------
// Sessions (as step4.spec.ts): each person signs in once per run, every later context reuses it.

const stateDir = path.join(stateDirOf(VEHICLES), 'sessions');

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
    timezoneId: ZONE,
    locale: 'en-GB',
  });
  if (opts.locale) {
    await context.addInitScript((l) => {
      try {
        localStorage.setItem('kept.locale', l);
      } catch {}
    }, opts.locale);
  }
  return { context, page: await context.newPage() };
}

/** The page's API with its cookie, origin and an Idempotency-Key on every write. */
function api(page: Page) {
  const json = async <T>(res: Awaited<ReturnType<Page['request']['get']>>): Promise<T> => {
    expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  };
  return {
    get: async <T>(url: string) => json<T>(await page.request.get(url)),
    post: async <T>(url: string, data: unknown = {}) =>
      json<T>(
        await page.request.fetch(url, {
          method: 'POST',
          data,
          headers: { origin: BASE, 'idempotency-key': crypto.randomUUID() },
        }),
      ),
  };
}

async function axe(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations
    .filter((v) => v.impact && v.impact !== 'minor')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')}`);
  expect.soft(serious, `axe on ${where}`).toEqual([]);
}

const toastUndo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true }).last();

/** A UUIDv7 (the server takes client ids only as current v7s): the time, then random bits. */
function uuidv7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256;
  b[6] = ((b[6] as number) & 0x0f) | 0x70;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A made-up key for the mock provider: KEPT_AI_MOCK=1 never sends it anywhere (as step3.spec.ts). */
const MOCK_KEY = 'gsk_e2e-mock-provider-not-a-real-key';

/** The account's AI provider, once, with the mock key: the Garage is paid by Ibrahim's account. */
async function ensureMockProvider(page: Page) {
  const res = await page.request.get('/api/v1/ai/providers');
  expect(res.ok()).toBe(true);
  const { providers } = (await res.json()) as { providers: { scope: string }[] };
  if (providers.some((p) => p.scope === 'account')) return;
  const put = await page.request.fetch('/api/v1/ai/providers/account', {
    method: 'PUT',
    data: { apiKey: MOCK_KEY },
    headers: { origin: BASE, 'idempotency-key': crypto.randomUUID() },
  });
  expect(put.status(), await put.text()).toBe(200);
}

// ---------------------------------------------------------------------------------------------
// Lookups and fixtures

type Located = { id: string; name: string };
type Meter = { id: string; unit: string; estimate: { perDay: string | null; advice: string } };
type Thing = Located & {
  type: { id: string } | null;
  placeId: string | null;
  meters: Meter[];
};

async function locationNamed(page: Page, name: string): Promise<Located> {
  const body = await api(page).get<{ locations?: Located[] } | Located[]>('/api/v1/locations');
  const list = Array.isArray(body) ? body : (body.locations ?? []);
  const found = list.find((l) => l.name === name);
  if (!found) throw new Error(`no location ${name}`);
  return found;
}

async function thingNamed(page: Page, locationId: string, name: string): Promise<Thing> {
  const { items } = await api(page).get<{ items: Located[] }>(
    `/api/v1/things?locationId=${locationId}&q=${encodeURIComponent(name)}`,
  );
  const found = items.find((t) => t.name === name);
  if (!found) throw new Error(`no thing ${name}`);
  return api(page).get<Thing>(`/api/v1/things/${found.id}`);
}

const thing = (page: Page, id: string) => api(page).get<Thing>(`/api/v1/things/${id}`);

/** A new car in the Garage, of the Corolla's type and place, with `readings` on its odometer. */
async function newCar(page: Page, name: string, readings: [number, string][] = []) {
  const garage = await locationNamed(page, 'Garage');
  const corolla = await thingNamed(page, garage.id, 'Toyota Corolla');
  const made = await api(page).post<Thing>('/api/v1/things', {
    locationId: garage.id,
    placeId: corolla.placeId,
    name,
    typeId: corolla.type?.id,
  });
  const meter = made.meters[0];
  if (!meter) throw new Error(`${name} has no odometer`);
  for (const [value, takenAt] of readings) {
    await api(page).post(`/api/v1/meters/${meter.id}/readings`, { value: String(value), takenAt });
  }
  return { id: made.id, meterId: meter.id };
}

type Reading = { id: string; value: string; proof?: { fileId: string } };
const readingsOf = async (page: Page, meterId: string) =>
  (await api(page).get<{ items: Reading[] }>(`/api/v1/meters/${meterId}/readings`)).items;

const hasPoppler = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();
const pdfText = (pdf: Buffer) =>
  execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], {
    input: pdf,
    timeout: 30_000,
  }).toString('utf8');

// ---------------------------------------------------------------------------------------------

test('an offline reading with a photo from Home is saved on the phone, then syncs into Readings with its proof', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(240_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const car = await newCar(page, 'Hyundai Elantra', [
    [30_000, daysAgo(20)],
    [30_600, daysAgo(10)],
  ]);

  // Online first, until the phone's copy has the car (Home's quick log picks from it).
  await page.goto(`/t/${car.id}`);
  await expect(page.getByRole('heading', { name: 'Hyundai Elantra', level: 1 })).toBeVisible();
  await expect
    .poll(
      async () => {
        await page.goto('/');
        await page.getByRole('button', { name: 'Log a reading' }).first().click();
        const listed = page
          .getByRole('dialog', { name: 'What did you read?' })
          .getByRole('button', { name: /Hyundai Elantra/ });
        const found = await listed
          .waitFor({ timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        await page.keyboard.press('Escape');
        return found;
      },
      { timeout: 90_000, intervals: [2_000, 5_000] },
    )
    .toBe(true);
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await axe(page, 'Home');

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Log a reading' }).first().click();
  const pick = page.getByRole('dialog', { name: 'What did you read?' });
  await expect(pick).toBeVisible();
  await axe(page, 'What did you read? (offline)');
  await pick.getByRole('button', { name: /Hyundai Elantra/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Log a reading' });
  await sheet.getByRole('textbox', { name: 'Reading (km)' }).fill('31200');
  await sheet.locator('input[type="file"]').first().setInputFiles(PHOTO);
  await expect(sheet.getByText('Kept as proof')).toBeVisible();
  await axe(page, 'Log a reading (offline)');
  await sheet.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.getByText('Saved on this phone').first()).toBeVisible();

  // Online: the queue syncs; the reading is on the server with its proof photo.
  await context.setOffline(false);
  await expect
    .poll(async () => (await readingsOf(page, car.meterId)).find((r) => r.value === '31200'), {
      timeout: 60_000,
    })
    .toBeTruthy();
  await expect
    .poll(
      async () =>
        (await readingsOf(page, car.meterId)).find((r) => r.value === '31200')?.proof?.fileId,
      { timeout: 60_000 },
    )
    .toBeTruthy();
  await page.goto(`/t/${car.id}?tab=readings`);
  await expect(page.getByRole('list', { name: 'Readings' })).toContainText('31,200');
  await expect(page.getByRole('list', { name: 'Proof photos' })).toBeVisible();
  await axe(page, 'Readings with the proof strip');
  await context.close();
});

test('a reading on the vehicle page fits, saves, and moves the estimate', async ({ browser }) => {
  onlyOn('desktop');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const car = await newCar(page, 'Nissan Sunny', [
    [10_000, daysAgo(30)],
    [10_900, daysAgo(15)],
  ]);
  const before = (await thing(page, car.id)).meters[0]?.estimate;
  expect(before?.perDay).toBe('60');

  await page.goto(`/t/${car.id}?tab=overview`);
  await expect(page.getByRole('heading', { name: 'Nissan Sunny', level: 1 })).toBeVisible();
  await axe(page, 'Vehicle overview');
  await page.getByRole('button', { name: 'Log a reading' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Log a reading' });
  await sheet.getByRole('textbox', { name: 'Reading (km)' }).fill('12400');
  await expect(sheet.getByText(/^Fits: /)).toBeVisible();
  await axe(page, 'Log a reading');
  await sheet.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.getByText('Reading logged').first()).toBeVisible();

  // 2,400 km over the 30 days since the first: about 79 a day now (the first was read at 09:00).
  await expect
    .poll(async () => Number((await thing(page, car.id)).meters[0]?.estimate.perDay))
    .toBeGreaterThan(75);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Odometer' }).getByText(/About (7[5-9]|80) km a day/),
  ).toBeVisible();
  await context.close();
});

test('a reading below the latest, logged offline, waits in the Inbox after it syncs', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(240_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const car = await newCar(page, 'Renault Logan', [
    [60_000, daysAgo(20)],
    [60_500, daysAgo(5)],
  ]);
  await page.goto(`/t/${car.id}`);
  await expect(page.getByRole('heading', { name: 'Renault Logan', level: 1 })).toBeVisible();
  // The vehicle's sections load on demand: offline before they have, they say "Needs a
  // connection" (household-lazy.tsx). Opened online means loaded.
  await expect(page.getByRole('button', { name: 'Log a reading' }).first()).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Log a reading' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Log a reading' });
  await sheet.getByRole('textbox', { name: 'Reading (km)' }).fill('25000');
  await sheet.getByRole('button', { name: 'Save reading' }).click();
  await expect(page.getByText('Saved on this phone').first()).toBeVisible();
  await context.setOffline(false);

  // By sync, a reading that doesn't fit is kept for review, not refused (D112).
  await expect
    .poll(async () => (await readingsOf(page, car.meterId)).some((r) => r.value === '25000'), {
      timeout: 60_000,
    })
    .toBe(true);
  await page.goto('/inbox');
  await expect(page.getByText(/25,000 km is lower than 60,500/).first()).toBeVisible({
    timeout: 30_000,
  });
  await axe(page, 'Inbox with a reading to review');
  await context.close();
});

test('Log a service from an invoice: AI suggests the lines on a draft, Save confirms it, Undo makes it a draft again', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(240_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  await ensureMockProvider(page);
  const car = await newCar(page, 'Kia Cerato', [[40_000, daysAgo(3)]]);

  await page.goto(`/t/${car.id}?tab=services`);
  await expect(page.getByRole('heading', { name: 'Kia Cerato', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Log a service' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Log a service' });
  await expect(sheet).toBeVisible();
  // The invoice's picker is the one that takes PDFs.
  await sheet.locator('input[type="file"][accept*="application/pdf"]').setInputFiles(INVOICE);
  await expect(sheet.getByText('Read by AI: 3 lines, total matches')).toBeVisible({
    timeout: 60_000,
  });
  const suggested = sheet.getByRole('group', { name: 'Suggested line items from the invoice' });
  await expect(suggested.getByText('Oil filter')).toBeVisible();
  await axe(page, 'Log a service, read by AI');
  await suggested.getByRole('button', { name: 'Confirm all' }).click();
  await expect(sheet.getByRole('textbox', { name: 'What' })).toHaveCount(3);
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Service logged').first()).toBeVisible();

  type Service = {
    id: string;
    reviewState: 'draft' | 'confirmed';
    total: { amount: string; currency: string } | null;
  };
  const services = async () =>
    (await api(page).get<{ items: Service[] }>(`/api/v1/things/${car.id}/service-records`)).items;
  await expect
    .poll(async () => (await services()).map((s) => [s.reviewState, s.total?.amount]))
    .toEqual([['confirmed', '2250']]);

  // Within the toast's 10 s: Undo takes the confirm back, so the service is the draft the
  // invoice made again (services/drafts.ts undoConfirm), not a logged service.
  await toastUndo(page).click();
  await expect(page.getByText('Undone').first()).toBeVisible();
  await expect.poll(async () => (await services()).map((s) => s.reviewState)).toEqual(['draft']);
  await axe(page, 'Services tab');
  await context.close();
});

test('fuel: two full fills with a partial between give the consumption', async ({ browser }) => {
  onlyOn('desktop');
  test.setTimeout(240_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const car = await newCar(page, 'Skoda Octavia');

  type Fill = { amount: string; isFull: boolean; odometer: string; at: string };
  const fills: Fill[] = [
    { amount: '40', isFull: true, odometer: '20000', at: daysAgo(10) },
    { amount: '15', isFull: false, odometer: '20300', at: daysAgo(5) },
    { amount: '30', isFull: true, odometer: '20600', at: daysAgo(1) },
  ];
  // The first two through the API, the last through the sheet.
  for (const f of fills.slice(0, 2)) {
    await api(page).post(`/api/v1/things/${car.id}/fuel`, {
      id: uuidv7(),
      takenAt: f.at,
      amount: f.amount,
      unit: 'L',
      isFull: f.isFull,
      cost: String(Number(f.amount) * 23),
      currency: 'EGP',
      reading: { meterId: car.meterId, value: f.odometer },
    });
  }
  await page.goto(`/t/${car.id}?tab=fuel`);
  await expect(page.getByRole('heading', { name: 'Skoda Octavia', level: 1 })).toBeVisible();
  const card = page.getByRole('region', { name: 'Fuel' });
  await card.getByRole('button', { name: 'Log fuel' }).click();
  const sheet = page.getByRole('dialog', { name: 'Log fuel' });
  await sheet.getByRole('textbox', { name: 'Amount, Litres' }).fill('30');
  await sheet.getByRole('textbox', { name: 'Cost' }).fill('690');
  await sheet.getByRole('textbox', { name: 'Odometer, km' }).fill('20600');
  await axe(page, 'Log fuel');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Fuel logged').first()).toBeVisible();

  // 45 L (the partial and the closing full) over 600 km.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Fuel' }).getByText('7.5 L/100 km')).toBeVisible({
    timeout: 30_000,
  });
  await axe(page, 'Fuel tab');
  await context.close();
});

test('starter schedules on a new car, with estimated dates once the odometer has two readings', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const car = await newCar(page, 'Toyota Yaris');
  await page.goto(`/t/${car.id}?tab=schedules`);
  await expect(page.getByRole('heading', { name: 'Toyota Yaris', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add starter schedules' }).click();
  const dialog = page.getByRole('dialog', { name: 'Starter schedules' });
  await expect(dialog).toBeVisible();
  await axe(page, 'Starter schedules');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Added 4 schedules').first()).toBeVisible({ timeout: 30_000 });
  const { items } = await api(page).get<{ items: { name: string }[] }>(
    `/api/v1/things/${car.id}/schedules`,
  );
  expect(items.map((x) => x.name).sort()).toEqual([
    'Air filter',
    'Brake fluid',
    'Oil change',
    'Tyre rotation',
  ]);

  for (const [value, at] of [
    [15_000, daysAgo(20)],
    [16_000, daysAgo(2)],
  ] as const) {
    await api(page).post(`/api/v1/meters/${car.meterId}/readings`, {
      value: String(value),
      takenAt: at,
    });
  }
  await page.reload();
  // The visible one: the meter chart's data table (visually hidden) says it too.
  await expect(
    page
      .getByText(/estimated ~/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await axe(page, 'Schedules with estimated dates');
  await context.close();
});

test('the history report of the Corolla downloads as a PDF in English and in Arabic', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(300_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const garage = await locationNamed(page, 'Garage');
  const corolla = await thingNamed(page, garage.id, 'Toyota Corolla');

  for (const [language, words] of [
    ['English', 'Vehicle history'],
    ['العربية', 'سجل المركبة'],
  ] as const) {
    await page.goto(`/t/${corolla.id}`);
    await expect(page.getByRole('heading', { name: 'Toyota Corolla', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'History report' }).click();
    const sheet = page.getByRole('dialog', { name: 'History report' });
    await expect(sheet).toBeVisible();
    await sheet
      .getByRole('radiogroup', { name: 'Language' })
      .getByText(language, { exact: true })
      .click();
    await axe(page, `History report sheet (${language})`);
    await sheet.getByRole('button', { name: 'Make the PDF' }).click();
    await expect(sheet.getByText('Your PDF is ready')).toBeVisible({ timeout: 120_000 });
    const href = await sheet.getByRole('link', { name: 'Download' }).getAttribute('href');
    expect(href).toBeTruthy();
    const res = await page.request.get(href as string);
    expect(res.status()).toBe(200);
    const pdf = await res.body();
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    if (hasPoppler) {
      const text = pdfText(pdf);
      expect(text).toContain('Toyota Corolla');
      expect(text).toContain(words);
    }
    await page.keyboard.press('Escape');
  }
  await context.close();
});

test('Talia, a viewer of the Garage, sees the Corolla with no Log buttons and no amounts', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(240_000);
  const owner = await person(browser, 'ibrahim@kept.test');
  const garage = await locationNamed(owner.page, 'Garage');
  const corolla = await thingNamed(owner.page, garage.id, 'Toyota Corolla');
  const invite = await api(owner.page).post<{ url: string }>(
    `/api/v1/locations/${garage.id}/invites`,
    { role: 'viewer' },
  );
  const token = new URL(invite.url, BASE).hash.slice(1);
  await owner.context.close();

  const { context, page } = await person(browser, 'talia@kept.test');
  await api(page).post(`/api/v1/invites/${token}/accept`);
  // A phone shows every section on one page: the Costs section says why it has no amounts.
  await page.goto(`/t/${corolla.id}`);
  await expect(page.getByRole('heading', { name: 'Toyota Corolla', level: 1 })).toBeVisible();
  await expect(page.getByText('Costs are hidden in this location').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: /^Log (a reading|a service|fuel)$/ })).toHaveCount(
    0,
  );
  // No amount anywhere: a currency's code may show (History says a cost's currency changed), a
  // figure in it never does.
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  expect(text).not.toMatch(/EGP ?[0-9٠-٩]|[0-9٠-٩] ?EGP|ج\.م/);
  await axe(page, 'Corolla as a viewer');
  // The server agrees: no money in the costs or the fuel summary.
  const costs = JSON.stringify(await api(page).get(`/api/v1/things/${corolla.id}/costs`));
  expect(costs).toContain('moneyHidden');
  expect(costs).not.toMatch(/"(fuel|service|fees|total)":/);
  const fuel = JSON.stringify(await api(page).get(`/api/v1/things/${corolla.id}/fuel/summary`));
  expect(fuel).not.toContain('EGP');
  await context.close();
});

test('the vehicle page in Arabic reads right to left, in Eastern digits', async ({ browser }) => {
  onlyOn('phone');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'alfred@kept.test', { locale: 'ar' });
  const garage = await locationNamed(page, 'Garage');
  const corolla = await thingNamed(page, garage.id, 'Toyota Corolla');
  await page.goto(`/t/${corolla.id}`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'Toyota Corolla', level: 1 })).toBeVisible();
  const odometer = page.getByRole('region', { name: 'عدّاد المسافة' });
  await expect(odometer).toContainText(/[٠-٩]/);
  await expect(odometer).not.toContainText(/[0-9]/);
  await axe(page, 'Vehicle overview (ar)');
  await page.goto('/vehicles');
  await expect(page.getByText('Toyota Corolla').first()).toBeVisible();
  await axe(page, 'Vehicles (ar)');
  await context.close();
});
