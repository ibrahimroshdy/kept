/**
 * The update prompt (plan T32 flow 6; T23): a new service worker waits while a capture session
 * is open (an upload may be under way), and only after it does Kept offer "A new version is
 * ready · Reload".
 *
 * A second release is made by changing the served worker: the built apps/web/dist/sw.js gets one
 * more line (the server reads the bundle from disk per request, http/web.ts), which makes the
 * browser install it as a new worker, exactly as a new build's worker. The file is restored
 * afterwards. Because it edits the shared bundle, this runs only on its own:
 *
 *   KEPT_E2E_UPDATE=1 KEPT_E2E_INSTANCES=capture \
 *     pnpm --filter @kept/web exec playwright test step3-update.spec.ts --project phone
 *
 * scripts/ci-local.sh's e2e step runs the rest of the suite without it (KEPT_E2E_UPDATE unset),
 * then this file alone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CAPTURE_INSTANCE } from './camera';
import { stateDirOf, urlOf } from './instances';

const BASE = urlOf(CAPTURE_INSTANCE);
const SW = fileURLToPath(new URL('../dist/sw.js', import.meta.url));

test.use({ baseURL: BASE });

test('a new version waits while a capture is open, then offers Reload', async ({ page }) => {
  test.skip(!process.env.KEPT_E2E_UPDATE, 'edits the served bundle: run with KEPT_E2E_UPDATE=1');
  test.skip(test.info().project.name !== 'phone', 'runs in the phone project');
  test.setTimeout(120_000);

  // Its own sign-in (this file runs alone, so the limit of 5 a minute isn't shared).
  await page.goto('/signin');
  await page.getByLabel('Email or username', { exact: true }).fill('ibrahim@kept.test');
  await page.getByLabel('Password', { exact: true }).fill('kept-seed-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  // A capture session is open (useHoldUpdates), with a capture queued.
  await page.goto('/capture');
  // The fake camera is playing before the shutter is pressed.
  await expect
    .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: /^Take photo/ }).click();
  await expect(page.getByText('1 captured', { exact: true })).toBeVisible();

  const original = readFileSync(SW, 'utf8');
  try {
    writeFileSync(SW, `${original}\n// e2e: the next release (${stateDirOf(CAPTURE_INSTANCE)})\n`);
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    await expect
      .poll(() =>
        page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r?.waiting)),
      )
      .toBe(true);
    // Waiting, and not offered while the capture is open.
    await page.waitForTimeout(2_000);
    await expect(page.getByText('A new version is ready')).toHaveCount(0);

    // The session ends: now it's offered, and Reload hands over to the new worker.
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByText('A new version is ready').first()).toBeVisible({ timeout: 30_000 });
    const before = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    await Promise.all([
      page.waitForEvent('load'),
      page.getByRole('button', { name: 'Reload', exact: true }).click(),
    ]);
    // The new worker took over: nothing is waiting any more.
    await expect
      .poll(() =>
        page
          .evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !r?.waiting))
          .catch(() => false),
      )
      .toBe(true);
    expect(before).toBeTruthy();
  } finally {
    writeFileSync(SW, original);
  }
});
