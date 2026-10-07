/**
 * Step 7's journeys against the real server (plan T25; the final check for steps 5–8), on the
 * `households` seed, behind HTTPS (the `portability` instance, e2e/instances.ts):
 *
 * 1. The Homebox import: the committed v0.26.2 `home` export (apps/server/test/fixtures/homebox)
 *    uploaded in Settings → Import into a new location, checked and imported; its things are
 *    listed there, and an old Homebox label (/a/000-005) opens the Espresso machine.
 * 2. A Kept export of Home with its secrets (a passphrase), downloaded, and imported back into a
 *    new location with that passphrase: the things are there, and the Wi-Fi router's password
 *    reveals.
 * 3. Consumables: switched on in Home, a minimum of 5 on the HDMI cable (3 of them) makes it low
 *    (Home's "Low stock", the Consumables list's Low group); Adjust to 6 makes it enough.
 *
 * Every page a test visits is checked with axe (nothing above "minor"). Each journey runs in one
 * project only: an import twice would make the old label ambiguous, and an export is limited per
 * location.
 *
 *   KEPT_E2E_INSTANCES=portability pnpm --filter @kept/web exec playwright test step7.spec.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, test } from '@playwright/test';
import { PORTABILITY_INSTANCE, stateDirOf } from './instances';
import { axe, expect, IBRAHIM, onlyOn, people } from './tls-people';

const { BASE, person, api, locationId, thingId, moduleOn } = people(PORTABILITY_INSTANCE);

test.use({ baseURL: BASE, ignoreHTTPSErrors: true });

const HOMEBOX_ZIP = fileURLToPath(
  new URL('../../server/test/fixtures/homebox/homebox-0.26.2-home.zip', import.meta.url),
);
const PASSPHRASE = 'e2e passphrase for the export';

/** From the upload's summary to "Imported into <name>": Next, the name, Next, check, import. */
async function finishImport(page: Page, name: string) {
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const target = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(target).toBeVisible();
  await target.fill(name);
  await axe(page, `the import's "Where it goes" (${name})`);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Check the import', exact: true }).click();
  const go = page.getByRole('button', { name: /^Import \d+ things?$/ });
  await expect(go).toBeVisible({ timeout: 60_000 });
  await axe(page, `the import's check (${name})`);
  await go.click();
  await expect(page.getByRole('heading', { name: `Imported into ${name}` })).toBeVisible({
    timeout: 180_000,
  });
  await axe(page, `the import's done (${name})`);
}

test('a Homebox export imports into a new location, and its old label opens the thing', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(300_000);
  const { context, page } = await person(browser, IBRAHIM);
  await page.goto('/settings/import?source=homebox_zip');
  await expect(page.getByRole('heading', { name: 'The Homebox export' })).toBeVisible();
  await axe(page, 'Import: the Homebox export');
  await page.locator('input[type="file"]').setInputFiles(HOMEBOX_ZIP);
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await finishImport(page, 'Homebox home');

  await page.getByRole('link', { name: 'See what was imported' }).click();
  await expect(page.getByRole('link', { name: 'Espresso machine' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Cordless drill' }).first()).toBeVisible();
  await axe(page, 'what the Homebox import made');

  // The old printed label: Homebox's asset id 000-005 is the Espresso machine.
  await page.goto('/a/000-005');
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  await expect(page.getByRole('heading', { name: 'Espresso machine', level: 1 })).toBeVisible();
  await axe(page, 'the thing an old label opened');
  await context.close();
});

test('a Kept export of Home with its secrets imports into a new location, secrets and all', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(420_000);
  const { context, page } = await person(browser, IBRAHIM);
  await page.goto('/settings/export?sheet=location');
  const sheet = page.getByRole('dialog', { name: 'Export a location' });
  await expect(sheet).toBeVisible();
  const location = sheet.getByRole('combobox', { name: 'Location' });
  if ((await location.inputValue()) !== 'Home') {
    await location.fill('Home');
    await page.getByRole('option', { name: 'Home', exact: true }).click();
  }
  await sheet.getByRole('switch', { name: 'Include secrets' }).check({ force: true });
  await sheet.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await sheet.getByLabel('The passphrase again', { exact: true }).fill(PASSPHRASE);
  await axe(page, 'the export sheet');
  await sheet.getByRole('button', { name: 'Export Home', exact: true }).click();

  const download = page.getByRole('button', { name: 'Download the export of Home' });
  await expect(download).toBeEnabled({ timeout: 240_000 });
  await axe(page, 'Export with a ready export');
  const waiting = page.waitForEvent('download');
  await download.click();
  const zip = path.join(stateDirOf(PORTABILITY_INSTANCE), 'home-export.zip');
  await (await waiting).saveAs(zip);

  await page.goto('/settings/import?source=kept_zip');
  await expect(page.getByRole('heading', { name: 'The Kept export' })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(zip);
  await expect(page.getByRole('heading', { name: 'It holds encrypted secrets' })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Open the secrets', exact: true }).click();
  await expect(page.getByText('The secrets will be imported')).toBeVisible();
  await axe(page, 'the Kept import with its secrets opened');
  await finishImport(page, 'Home copy');

  // The things and a secret, in the new location.
  const copy = await locationId(page, 'Home copy');
  const { items } = await api(page).get<{ items: { id: string; name: string }[] }>(
    `/api/v1/things?locationId=${copy}&limit=200`,
  );
  expect(items.map((x) => x.name)).toEqual(
    expect.arrayContaining(['HDMI cable, 2 m', 'Wi-Fi router']),
  );
  const router = items.find((x) => x.name === 'Wi-Fi router')?.id as string;
  await page.goto(`/t/${router}`);
  const secret = page.locator('li[aria-label="Wi-Fi password"]');
  await expect(secret).toBeVisible();
  await secret.getByRole('button', { name: 'Reveal' }).click();
  await expect(secret).toContainText('olive-kettle-42');
  await axe(page, 'the imported thing with its secret revealed');
  await context.close();
});

test('a consumable below its minimum is low on Home and in Consumables, and Adjust fixes it', async ({
  browser,
}) => {
  onlyOn('phone');
  const { context, page } = await person(browser, IBRAHIM);
  await page.goto('/');
  const home = await locationId(page, 'Home');
  await moduleOn(page, home, 'consumables');
  const cable = await thingId(page, 'HDMI cable, 2 m');
  await api(page).put(`/api/v1/things/${cable}/stock-rule`, { minQuantity: 5 });

  await page.goto('/');
  const low = page.getByRole('link', { name: /Low stock/ });
  await expect(low).toBeVisible();
  await axe(page, 'Home with low stock');
  await low.click();
  await expect(page).toHaveURL(/\/consumables/);
  const row = page.getByRole('article', { name: 'HDMI cable, 2 m' });
  await expect(row).toContainText('Low');
  await expect(row).toContainText('keep at least 5');
  await axe(page, 'Consumables, low');

  await page.goto('/consumables');
  await row.getByRole('button', { name: 'Adjust HDMI cable, 2 m' }).click();
  // The name inside the title is isolated (U+2068 … U+2069), as every name in a sentence is.
  const sheet = page.getByRole('dialog', { name: /^Adjust .?HDMI cable, 2 m.?$/ });
  await expect(sheet).toBeVisible();
  await axe(page, 'the Adjust sheet');
  await sheet.getByRole('textbox', { name: 'How many are left' }).fill('6');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    /Adjusted .?HDMI cable, 2 m/,
  );
  await expect(row).toContainText('6 left');
  await expect(row).not.toContainText('Low');
  await context.close();
});
