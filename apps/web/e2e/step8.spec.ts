/**
 * Step 8's journeys against the real server (plan T25; the final check for steps 5–8), on the
 * `households` seed, behind HTTPS and with the owner login a backup run needs (the `operations`
 * instance, e2e/instances.ts):
 *
 * 1. Admin → Backups: a directory target (outside the data directory) with a password, saved;
 *    Run now; the run is listed in "Backup runs" and finishes (OK, or Failed with its reason: the
 *    e2e server uses the machine's own pg_dump and restic, KEPT_RESTIC_BIN when set, so a laptop
 *    whose pg_dump is older than the database records `pg_version_mismatch`; the image ships
 *    matching tools, and the Compose check takes a real snapshot).
 * 2. The app lock with a STUBBED WebAuthn (never a real authenticator): a PIN set in This device,
 *    Face ID or fingerprint enrolled through the stub's PRF secret, then a reload asks for the PIN
 *    (a wrong one is refused, the right one opens Kept), and another reload opens with Face ID.
 *
 * Every page a test visits is checked with axe (nothing above "minor").
 *
 *   KEPT_E2E_INSTANCES=operations pnpm --filter @kept/web exec playwright test step8.spec.ts
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { OPERATIONS_INSTANCE, stateDirOf } from './instances';
import { axe, expect, IBRAHIM, onlyOn, people } from './tls-people';

const { BASE, person } = people(OPERATIONS_INSTANCE);

test.use({ baseURL: BASE, ignoreHTTPSErrors: true });

const PIN = '482913';

test('Admin → Backups: a directory target saved, Run now, and the run listed', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(240_000);
  // Beside the instance's data directory, never inside it (the server refuses that).
  const dir = path.join(stateDirOf(OPERATIONS_INSTANCE), 'backups');
  mkdirSync(dir, { recursive: true });
  const { context, page } = await person(browser, IBRAHIM);
  await page.goto('/admin/backups');
  await expect(page.getByText('No backup configured')).toBeVisible();
  await axe(page, 'Admin → Backups, not configured');

  await expect(page.getByRole('radio', { name: 'Directory' })).toBeChecked();
  await page.getByRole('textbox', { name: 'Folder' }).fill(dir);
  await page.getByLabel('Backup password', { exact: true }).fill('e2e-backup-password-2026');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Backup settings saved',
  );
  await expect(page.getByText('Configured', { exact: true })).toBeVisible();
  await axe(page, 'Admin → Backups, configured');

  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Backup started. It shows in the runs below.',
  );
  const runs = page.getByRole('list', { name: 'Backup runs' });
  // Listed as a Run now without a reload (the list polls after a press), and finished: OK, Needs
  // a look or Failed (with its reason).
  const run = runs.getByRole('listitem').first();
  await expect(run).toContainText('Run now', { timeout: 60_000 });
  await expect(run).toContainText(/OK|Needs a look|Failed/, { timeout: 120_000 });
  test.info().annotations.push({
    type: 'backup run',
    description: (await runs.getByRole('listitem').first().innerText()).replace(/\s+/g, ' '),
  });
  await axe(page, 'Admin → Backups with a run');
  await context.close();
});

test('the app lock: a PIN, Face ID through a stubbed WebAuthn, the lock screen after a reload', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(240_000);
  const { context, page } = await person(browser, IBRAHIM, () => {
    // A STUB authenticator with a fixed PRF secret (as src/offline/lock.test.ts): never a real one.
    const secret = new Uint8Array(32).fill(7).buffer;
    const rawId = new Uint8Array([1, 2, 3, 4]).buffer;
    const credential = (results: unknown) => ({
      id: 'AQIDBA',
      rawId,
      type: 'public-key',
      response: {},
      getClientExtensionResults: () => results,
    });
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: async () => credential({ prf: { enabled: true, results: { first: secret } } }),
        get: async () => credential({ prf: { results: { first: secret } } }),
      },
    });
    const pkc = (window as unknown as { PublicKeyCredential?: Record<string, unknown> })
      .PublicKeyCredential;
    if (pkc) {
      Object.defineProperty(pkc, 'isUserVerifyingPlatformAuthenticatorAvailable', {
        configurable: true,
        value: async () => true,
      });
    }
  });
  await page.goto('/settings/device');
  await expect(page.getByRole('heading', { name: 'This device', level: 1 })).toBeVisible();
  await axe(page, 'This device');

  await page.getByRole('switch', { name: 'Lock Kept on this device' }).click({ force: true });
  const sheet = page.getByRole('dialog', { name: 'Lock Kept on this device' });
  await expect(sheet).toContainText('Choose a PIN of 6 to 12 digits.');
  await axe(page, 'the PIN sheet');
  await page.keyboard.type(PIN);
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(sheet).toContainText('Type it again.');
  await page.keyboard.type(PIN);
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
  const toasts = page.getByRole('region', { name: 'Notifications' });
  await expect(toasts).toContainText('Kept locks on this device now', { timeout: 60_000 });

  await page.getByRole('switch', { name: 'Use Face ID or fingerprint' }).click({ force: true });
  await expect(toasts).toContainText('Face ID or fingerprint can unlock Kept now');

  // A cold start asks for the PIN: a wrong one is refused, the right one opens Kept.
  await page.reload();
  const lock = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Enter your PIN' }) });
  await expect(lock).toBeVisible();
  await axe(page, 'the lock screen');
  await page.keyboard.type('000000');
  await expect(lock).toContainText(/Wrong PIN\. 9 tries left/, { timeout: 60_000 });
  await page.keyboard.type(PIN);
  await expect(lock).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'This device', level: 1 })).toBeVisible();

  // Another cold start opens with Face ID (the stub's PRF secret).
  await page.reload();
  await expect(lock).toBeVisible();
  await lock.getByRole('button', { name: 'Face ID', exact: true }).click();
  await expect(lock).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'This device', level: 1 })).toBeVisible();
  await context.close();
});
