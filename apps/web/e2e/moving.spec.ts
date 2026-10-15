/**
 * Moving mode against the real server (D251), on its own seeded `moving` instance
 * (e2e/instances.ts): the owner turns Moving mode on in the Garage, starts a move to Home, adds a
 * numbered box going to Home's kitchen, packs a thing into it, prints the contents sheets (the
 * PDF is made by the server's job), then unpacks the box by its label from Scan to unpack: the
 * box is in Home's kitchen afterwards, with the thing still inside it.
 *
 * No real device is touched: getUserMedia and getDisplayMedia reject (so the scanner leads with
 * "Type the code", which reads the label's code the way the camera would), SpeechRecognition is
 * gone and geolocation refuses, before any page script. No permission is granted.
 *
 *   KEPT_E2E_INSTANCES=moving pnpm --filter @kept/web exec playwright test moving.spec.ts
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { INSTANCES, stateDirOf, urlOf } from './instances';

const MOVING = INSTANCES.moving;
const BASE = urlOf(MOVING);
const PASSWORD = 'kept-seed-password';
const SLOW = 30_000;

test.use({ baseURL: BASE });

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

/**
 * The owner, signed in. Sign-in is limited to 5 a minute, so the first sign-in of the run keeps
 * its cookie (serve.mjs wipes the instance's state each run) and later tests and retries reuse it.
 */
async function signIn(page: Page) {
  const context = page.context();
  await context.addInitScript(stubDevices);
  const file = path.join(stateDirOf(MOVING), 'sessions', 'ibrahim.json');
  if (existsSync(file)) {
    const state = JSON.parse(readFileSync(file, 'utf8')) as {
      cookies: Parameters<BrowserContext['addCookies']>[0];
    };
    await context.addCookies(state.cookies);
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    return;
  }
  await page.goto('/signin');
  await page.getByLabel('Email or username', { exact: true }).fill('ibrahim@kept.test');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  mkdirSync(path.dirname(file), { recursive: true });
  await context.storageState({ path: file });
}

const api = (page: Page) => ({
  get: async <T>(url: string): Promise<T> => {
    const res = await page.request.get(url);
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  },
  post: async <T>(url: string, data: unknown): Promise<T> => {
    const res = await page.request.post(url, { data, headers: { origin: BASE } });
    expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  },
});

type Box = {
  containerId: string;
  number: number;
  state: string;
  shortCode: string | null;
  locationId: string | null;
  placeId: string | null;
  destination: { name: string } | null;
};

async function locationsByName(page: Page): Promise<Map<string, string>> {
  const body = await api(page).get<{ locations?: { id: string; name: string }[] } | unknown[]>(
    '/api/v1/locations',
  );
  const list = (Array.isArray(body) ? body : (body.locations ?? [])) as {
    id: string;
    name: string;
  }[];
  return new Map(list.map((l) => [l.name, l.id]));
}

test('pack a box, print its contents sheet, and unpack it by its label into the new home', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // A retry (or --repeat-each) runs on the same instance: each attempt makes a move of its own.
  const attempt = test.info().retry + test.info().repeatEachIndex;
  const project = test.info().project.name;
  const moveName = `Garage to Home ${project} ${attempt}`;
  const thingName = `Camping stove ${project} ${attempt}`;
  await signIn(page);
  const ids = await locationsByName(page);
  const garage = ids.get('Garage') as string;
  const home = ids.get('Home') as string;
  expect(garage && home).toBeTruthy();
  await api(page).post(`/api/v1/locations/${garage}/modules`, {
    module: 'moving',
    enabled: true,
  });

  // Start a move from the Moving page, to Home.
  await page.goto('/moving');
  await expect(page.getByRole('heading', { name: 'Moving', level: 1 })).toBeVisible({
    timeout: SLOW,
  });
  await page.getByRole('button', { name: 'Start a move' }).first().click();
  const start = page.getByRole('dialog');
  await start.getByRole('textbox', { name: 'Name' }).fill(moveName);
  await start.getByRole('button', { name: /Going to/ }).click();
  await page.getByRole('option', { name: 'Home', exact: true }).click();
  await start.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('heading', { name: moveName, level: 1 })).toBeVisible({
    timeout: SLOW,
  });
  const moveId = new URL(page.url()).pathname.split('/').pop() as string;

  // Pack: a numbered box going to Home's kitchen, and a thing in it.
  await page.getByRole('button', { name: 'Add a box' }).first().click();
  const add = page.getByRole('dialog');
  await add.getByRole('radio', { name: 'Kitchen', exact: true }).first().check({ force: true });
  await add.getByRole('button', { name: 'Add the box' }).click();
  await expect(page.getByRole('article', { name: 'Box 1' })).toBeVisible({ timeout: SLOW });
  await expect(page.getByRole('article', { name: 'Box 1' })).toContainText('Goes to Kitchen');
  const [box] = (await api(page).get<{ boxes: Box[] }>(`/api/v1/moves/${moveId}`)).boxes as [Box];
  expect(box.shortCode).toMatch(/^[0-9A-Z]{6}$/);
  await api(page).post('/api/v1/things', {
    locationId: garage,
    containerId: box.containerId,
    name: thingName,
  });

  // Print: the box's label sheet opens, and the contents sheets PDF is made.
  await expect(page.getByRole('link', { name: 'Print labels' })).toHaveAttribute(
    'href',
    new RegExp(`things=${box.containerId}`),
  );
  await page.getByRole('button', { name: 'Contents sheets' }).click();
  const sheets = page.getByRole('dialog');
  await sheets.getByRole('button', { name: 'Make the PDF' }).click();
  await expect(sheets.getByText('Your PDF is ready')).toBeVisible({ timeout: 90_000 });
  await sheets.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(sheets).toBeHidden();

  // Unpack by scan: the label's code, typed as the scanner would read it.
  await page.getByRole('button', { name: 'Scan to unpack' }).click();
  await expect(page.getByRole('heading', { name: 'Scan to unpack' })).toBeVisible({
    timeout: SLOW,
  });
  await page.getByRole('button', { name: 'Type the code' }).click();
  await page.getByRole('textbox', { name: 'Code on the label' }).fill(box.shortCode as string);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  const answer = page.getByRole('region', { name: 'Scan result' });
  await expect(answer.getByText('Box 1', { exact: true })).toBeVisible({ timeout: SLOW });
  await answer.getByRole('button', { name: 'Unpack into Kitchen' }).click();
  await expect(page.getByText('Box 1 unpacked into Kitchen').first()).toBeVisible({
    timeout: SLOW,
  });

  // The box is in Home's kitchen now, with the stove still inside it.
  await expect(async () => {
    const after = await api(page).get<{ boxes: Box[]; counts: { unpacked: number } }>(
      `/api/v1/moves/${moveId}`,
    );
    expect(after.boxes[0]).toMatchObject({ state: 'unpacked', locationId: home });
    expect(after.boxes[0]?.destination?.name).toBe('Kitchen');
    expect(after.counts.unpacked).toBe(1);
  }).toPass({ timeout: SLOW, intervals: [1_000] });
  const found = await api(page).get<{ things: { items: { name: string; path?: unknown }[] } }>(
    `/api/v1/search?q=${encodeURIComponent(thingName)}&kind=things`,
  );
  expect(found.things.items.map((t) => t.name)).toContain(thingName);
  const inside = await api(page).get<{ items: { name: string; locationId: string }[] }>(
    `/api/v1/things?containerId=${box.containerId}`,
  );
  expect(inside.items.map((t) => [t.name, t.locationId])).toEqual([[thingName, home]]);
});
