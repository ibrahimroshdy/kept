/**
 * The spreadsheet view against the real server (D250), on its own seeded `sheet` instance
 * (e2e/instances.ts): the owner opens Garage as a Table, edits a cell in place by keyboard and
 * saves it, then selects two rows, moves them to a bay and saves; the changes are on the server
 * after a reload; a save of two cells is taken back by one Undo. On a phone the Table isn't
 * offered.
 *
 * No real device is touched: getUserMedia and getDisplayMedia reject, SpeechRecognition is gone
 * and geolocation refuses, before any page script. No permission is granted.
 *
 *   KEPT_E2E_INSTANCES=sheet pnpm --filter @kept/web exec playwright test sheet.spec.ts
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { INSTANCES, stateDirOf, urlOf } from './instances';

const SHEET = INSTANCES.sheet;
const PASSWORD = 'kept-seed-password';

test.use({ baseURL: urlOf(SHEET) });
test.describe.configure({ mode: 'serial' });

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
 * its cookie (serve.mjs wipes the instance's state each run) and later tests and retries reuse
 * it, as tour.spec.ts does.
 */
async function signIn(page: Page) {
  const context = page.context();
  await context.addInitScript(stubDevices);
  const file = path.join(stateDirOf(SHEET), 'sessions', 'ibrahim.json');
  if (existsSync(file)) {
    const state = JSON.parse(readFileSync(file, 'utf8')) as {
      cookies: Parameters<BrowserContext['addCookies']>[0];
    };
    await context.addCookies(state.cookies);
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
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

/** Garage, from the sidebar. */
async function openGarage(page: Page) {
  await page
    .getByRole('link', { name: 'Garage', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Garage', level: 1 })).toBeVisible();
}

/**
 * The cell of a row (by the thing's name) under a column header (Model is a default column,
 * D250). Waits for that row first: right after a reload the grid is still loading, and reading
 * the headers then finds none.
 */
async function cell(page: Page, rowName: string, header: string) {
  const grid = page.getByRole('grid');
  const row = grid.getByRole('row').filter({ hasText: rowName }).first();
  await expect(row).toBeVisible();
  const headers = await grid.getByRole('columnheader').allTextContents();
  const index = headers.findIndex((h) => h.trim().toLowerCase().startsWith(header.toLowerCase()));
  expect(index, `column ${header} in ${headers.join(' | ')}`).toBeGreaterThanOrEqual(0);
  return row.getByRole('gridcell').nth(index);
}

test('edit in place, then a bulk move, saved and read back after a reload', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the Table is a desktop layout');
  // A retry (or --repeat-each) runs on the same instance, where an earlier attempt may have
  // saved already: each attempt writes values of its own, so its change is always a change.
  const attempt = test.info().retry + test.info().repeatEachIndex;
  const model = `CH-16-${attempt}`;
  const bay = attempt % 2 === 0 ? 'Bay 1' : 'Bay 2';
  await signIn(page);
  await openGarage(page);
  await page
    .getByRole('radiogroup', { name: 'Layout' })
    .getByText('Table', { exact: true })
    .click();
  const grid = page.getByRole('grid');
  await expect(grid).toBeVisible();
  await expect(grid.getByText('Claw hammer')).toBeVisible();

  // A cell by keyboard: Enter opens it, Enter stages it, Save sends it.
  await (await cell(page, 'Claw hammer', 'Model')).click();
  await page.keyboard.press('Enter');
  await page.keyboard.type(model);
  await page.keyboard.press('Enter');
  const bar = page.getByRole('region', { name: 'Changes' });
  await expect(bar).toContainText('1 change');
  await bar.getByRole('button', { name: 'Save 1 change' }).click();
  await expect(bar).toBeHidden();
  await expect(page.getByText('Saved 1 change').first()).toBeVisible();
  await page.reload();
  await expect(await cell(page, 'Claw hammer', 'Model')).toHaveText(model);

  // Two rows selected, moved to a bay together, saved.
  await (await cell(page, 'Claw hammer', '')).click();
  await (await cell(page, 'Garden hose, 15 m', '')).click();
  const toolbar = page.getByRole('toolbar', { name: 'Selection' });
  await expect(toolbar).toContainText('2 selected');
  await toolbar.getByRole('button', { name: 'Move to…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move 2 things' });
  await dialog.getByRole('combobox').first().fill(bay);
  await page
    .getByRole('option', { name: new RegExp(`^${bay}`) })
    .first()
    .click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(bar).toContainText('2 changes');
  await bar.getByRole('button', { name: 'Save 2 changes' }).click();
  await expect(bar).toBeHidden();
  await page.reload();
  await expect(await cell(page, 'Claw hammer', 'Where')).toHaveText(bay);
  await expect(await cell(page, 'Garden hose, 15 m', 'Where')).toHaveText(bay);
});

test('one Undo takes a whole save back', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'the Table is a desktop layout');
  await signIn(page);
  await openGarage(page);
  await page
    .getByRole('radiogroup', { name: 'Layout' })
    .getByText('Table', { exact: true })
    .click();
  // Two cells of one row: typing opens a cell, Tab saves it and moves across.
  await (await cell(page, 'Tyre pump', 'Model')).click();
  await page.keyboard.type('TP-M');
  await page.keyboard.press('Tab');
  await page.keyboard.type('TP-1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Changes' })).toContainText(
    '2 changes · on 1 thing',
  );
  await page.getByRole('button', { name: 'Save 2 changes' }).click();
  await page.getByRole('button', { name: 'Undo' }).first().click();
  await expect(page.getByText('Undone').first()).toBeVisible();
  await page.reload();
  await expect(await cell(page, 'Tyre pump', 'Model')).toHaveText('');
  await expect(await cell(page, 'Tyre pump', 'Serial')).toHaveText('');
});

test('a phone keeps the lists', async ({ page }) => {
  test.skip(test.info().project.name !== 'phone', 'the phone layout');
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Garage' }).filter({ visible: true }).first().click();
  const layouts = page.getByRole('radiogroup', { name: 'Layout' });
  await expect(layouts.getByText('Map', { exact: true })).toBeVisible();
  await expect(layouts.getByText('Table', { exact: true })).toHaveCount(0);
});
