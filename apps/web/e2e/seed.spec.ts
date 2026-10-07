/**
 * Sign-in against a seeded instance (`kept admin seed --scenario households`, tasks 26 and 23):
 * the seed's people exist with their roles, their households hold things since task 23, and
 * each signs in through the real page. Every seeded password is `kept-seed-password` (apps/server/src/seed/cast.ts). Each project has its own
 * seeded instance: Better Auth allows 5 sign-ins a minute per IP and path (auth/auth.ts), and
 * both projects together would pass that from 127.0.0.1.
 */
import { expect, type Page, test } from '@playwright/test';
import { INSTANCES, urlOf } from './instances';

const seedOf = (project: string) =>
  project === 'phone' ? INSTANCES.seedPhone : INSTANCES.seedDesktop;

const PASSWORD = 'kept-seed-password';

test.use({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first argument.
  baseURL: async ({}, use, testInfo) => use(urlOf(seedOf(testInfo.project.name))),
});

async function signIn(page: Page, login: string) {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in to Kept' })).toBeVisible();
  await page.getByLabel('Email or username', { exact: true }).fill(login);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

const locationLink = (page: Page, name: string) =>
  page
    .getByRole('link', { name: new RegExp(name) })
    .filter({ visible: true })
    .first();

test('the instance admin signs in and sees the households', async ({ page }) => {
  await signIn(page, 'ibrahim@kept.test');
  await expect(locationLink(page, 'بيت العائلة')).toBeVisible();
  const me = await (await page.request.get('/api/v1/me')).json();
  expect(me.user.instanceAdmin).toBe(true);
  expect(me.memberships.map((m: { name: string; role: string }) => `${m.name}:${m.role}`)).toEqual(
    expect.arrayContaining(['Home:owner', 'Garage:owner', 'بيت العائلة:admin']),
  );
});

test('a viewer signs in and sees Home', async ({ page }) => {
  await signIn(page, 'talia@kept.test');
  await expect(locationLink(page, 'Home')).toBeVisible();
  const me = await (await page.request.get('/api/v1/me')).json();
  expect(me.user.instanceAdmin).toBe(false);
  expect(me.memberships).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'Home', role: 'viewer' })]),
  );
});

test('a managed account signs in with its username (D47)', async ({ page }) => {
  await signIn(page, 'peter');
  const me = await (await page.request.get('/api/v1/me')).json();
  expect(me.user.managed).toBe(true);
  expect(me.user.email).toBeNull();
  await expect(locationLink(page, 'Home')).toBeVisible();
});

test('a wrong password is refused plainly', async ({ page }) => {
  await page.goto('/signin');
  await page.getByLabel('Email or username', { exact: true }).fill('bruce@kept.test');
  await page.getByLabel('Password', { exact: true }).fill('not the password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText("That email or username and password don't match.")).toBeVisible();
  // The production bundle shows only what the compiled catalogue holds: a string missing from it
  // renders as its message id. This one is among the newest on the page.
  await expect(page.getByRole('button', { name: 'Forgot your password?' })).toBeVisible();
});
