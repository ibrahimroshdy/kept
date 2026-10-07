/**
 * The step-1 flow (plan task 28, definition of done): a fresh Kept goes from first-run setup to a
 * home that someone else joins. Runs once per project (phone, desktop), each on its own fresh
 * instance (e2e/instances.ts).
 */
import { type Browser, expect, type Page, test } from '@playwright/test';
import { INSTANCES, printedSetupCode } from './instances';

const OWNER = { name: 'Ibrahim', email: 'ibrahim@kept.test', password: 'correct horse battery' };
const INVITEE = { name: 'Talia', email: 'talia@kept.test', password: 'blue whale lamp' };
const HOME = 'Beach house';

const heading = (page: Page, name: string | RegExp) =>
  page.getByRole('heading', { name, level: 1 }).or(page.getByRole('heading', { name })).first();

/** The phone layout and the desktop one render different navigation; take what is on screen. */
const visibleLink = (page: Page, name: RegExp) =>
  page.getByRole('link', { name }).filter({ visible: true }).first();

async function secondContext(browser: Browser, use: Record<string, unknown>) {
  // A new context shares nothing with the first (cookies, storage): another person's browser.
  return browser.newContext({
    baseURL: use.baseURL as string,
    viewport: use.viewport as { width: number; height: number },
    isMobile: use.isMobile as boolean | undefined,
    hasTouch: use.hasTouch as boolean | undefined,
    timezoneId: use.timezoneId as string,
    locale: use.locale as string,
  });
}

test('setup → create a home → invite by link → the invitee joins as a viewer', async ({
  page,
  browser,
}, testInfo) => {
  const instance = INSTANCES[testInfo.project.name as 'phone' | 'desktop'];

  // First run: a fresh server sends every page to setup.
  await page.goto('/');
  await expect(heading(page, 'Enter the setup code')).toBeVisible();
  await page.getByLabel('Setup code', { exact: true }).fill(printedSetupCode(instance));
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(heading(page, 'Create the first account')).toBeVisible();
  await page.getByLabel('Your name', { exact: true }).fill(OWNER.name);
  await page.getByLabel('Email', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(heading(page, 'How should this Kept work?')).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(heading(page, `Welcome, ${OWNER.name}`)).toBeVisible();
  // The Personal location exists from the start (D114).
  await expect(visibleLink(page, /^Personal/)).toBeVisible();

  // The new-location wizard (D194): name and kind → rooms → what to track.
  await page.getByRole('link', { name: 'Create your first home' }).click();
  await expect(heading(page, 'New location')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(HOME);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(heading(page, `Rooms in ${HOME}`)).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(heading(page, `What should ${HOME} track?`)).toBeVisible();
  await page.getByRole('button', { name: `Create ${HOME}` }).click();

  // Home shows it, with its Invite card.
  await expect(page.getByText(`Invite people to ${HOME}`)).toBeVisible();
  await page
    .getByRole('link', { name: 'Invite', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(heading(page, `Invite to ${HOME}`)).toBeVisible();
  await page.getByRole('radio', { name: 'Viewer' }).check({ force: true });
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await expect(page.getByRole('img', { name: 'QR code for the invite link' })).toBeVisible();
  const link =
    (
      await page
        .getByText(/\/invite#\S+$/)
        .first()
        .textContent()
    )?.trim() ?? '';
  expect(link).toMatch(new RegExp(`^http://localhost:${instance.port}/invite#\\S+$`));

  // The invitee, in their own browser, with no account yet.
  const other = await secondContext(browser, testInfo.project.use as Record<string, unknown>);
  try {
    const invitee = await other.newPage();
    await invitee.goto(link);
    await expect(invitee.getByText(`${OWNER.name} invites you to`)).toBeVisible();
    await expect(invitee.getByText(HOME, { exact: true }).first()).toBeVisible();
    await invitee.getByRole('button', { name: 'Create an account and join' }).click();
    await invitee.getByLabel('Your name', { exact: true }).fill(INVITEE.name);
    await invitee.getByLabel('Email', { exact: true }).fill(INVITEE.email);
    await invitee.getByLabel('Password', { exact: true }).fill(INVITEE.password);
    await invitee.getByRole('button', { name: 'Create account and join' }).click();

    // Signed in and joined: the page opens the home.
    await expect(invitee).toHaveURL(/\/loc\/[0-9a-f-]{36}$/);
    await expect(heading(invitee, HOME)).toBeVisible();

    // As a viewer: the server says so, and Home lists the location.
    const me = await (await invitee.request.get('/api/v1/me')).json();
    expect(me.user.displayName).toBe(INVITEE.name);
    expect(me.memberships).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: HOME, role: 'viewer' })]),
    );
    await invitee.goto('/');
    await expect(visibleLink(invitee, new RegExp(HOME))).toBeVisible();
  } finally {
    await other.close();
  }

  // The owner sees the new member.
  const locations = await (await page.request.get('/api/v1/locations')).json();
  const home = locations.locations.find((l: { name: string }) => l.name === HOME);
  expect(home?.memberCount).toBe(2);
});
