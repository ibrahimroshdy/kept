/**
 * Step 2's flows against the real server (plan task 30), on the `households` seed
 * (`kept admin seed --scenario households`, apps/server/src/seed): browse Home down to the Cable
 * box and the HDMI cable in it, search in English and Arabic, edit with a field-level conflict
 * from a second browser (D156), move, trash and restore with Undo, see it in Activity, and a
 * viewer's thing page without money or edit actions (D13, D110). Runs once per project (phone
 * 375×780, desktop 1280×800), each on its own seeded instance (e2e/instances.ts), in order: the
 * later tests read what the earlier ones did.
 *
 * Also the contract check (plan T30): every path the web calls (src/api/inventory/paths.ts) is
 * in the server's /api/v1/openapi.json with the methods the web uses.
 */
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { inventoryPaths, METHODS } from '../src/api/inventory/paths';
import { INSTANCES, urlOf } from './instances';

const instanceOf = (project: string) =>
  project === 'phone' ? INSTANCES.step2Phone : INSTANCES.step2Desktop;

const PASSWORD = 'kept-seed-password';
const CABLE = 'HDMI cable, 2 m';

test.describe.configure({ mode: 'serial' });
test.use({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first argument.
  baseURL: async ({}, use, testInfo) => use(urlOf(instanceOf(testInfo.project.name))),
});

async function signIn(page: Page, login: string) {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in to Kept' })).toBeVisible();
  await page.getByLabel('Email or username', { exact: true }).fill(login);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Another person's browser: shares nothing with the first (cookies, storage). */
async function otherBrowser(browser: Browser, page: Page): Promise<BrowserContext> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  return browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport,
    timezoneId: 'Africa/Cairo',
    locale: 'en-GB',
  });
}

const heading = (page: Page, name: string | RegExp) =>
  page.getByRole('heading', { name, level: 1 }).filter({ visible: true }).first();

const visible = (page: Page, role: 'link' | 'button', name: string | RegExp) =>
  page.getByRole(role, { name }).filter({ visible: true }).first();

/** A thing's id, by name, through the search the page itself uses. */
async function thingId(page: Page, q: string, name: string): Promise<string> {
  const res = await page.request.get(`/api/v1/search?q=${encodeURIComponent(q)}&kind=things`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { things: { items: { id: string; name: string }[] } };
  const found = body.things.items.find((x) => x.name === name);
  if (!found) throw new Error(`no thing named ${name}`);
  return found.id;
}

/**
 * A thing page action: a header button on desktop, or the Actions menu (the phone has no room
 * for the buttons, and less common actions live there on both).
 */
async function thingAction(page: Page, name: string) {
  const direct = page.getByRole('button', { name, exact: true }).filter({ visible: true });
  if (await direct.count()) {
    await direct.first().click();
    return;
  }
  await visible(page, 'button', /^(Actions|More actions)$/).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

/** The one Undo in the newest toast. */
const toastUndo = (page: Page) =>
  page.getByRole('region', { name: 'Notifications' }).getByRole('button', { name: 'Undo' }).last();

test('the contract: every web path is a server route with its methods', async ({ request }) => {
  const res = await request.get('/api/v1/openapi.json');
  expect(res.ok()).toBe(true);
  const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
  // `/api/v1/things/{id}` → `/api/v1/things/:x`, so a path's parameter names don't matter.
  const norm = (path: string) => path.replace(/\{[^}]+\}|:[^/]+/g, ':x');
  const server = new Map<string, Set<string>>();
  for (const [path, ops] of Object.entries(spec.paths)) {
    // `/files/{fileId}` (PUT) and `/files/{id}` (DELETE) are one path here.
    const have = server.get(norm(path)) ?? new Set<string>();
    for (const m of Object.keys(ops)) have.add(m.toUpperCase());
    server.set(norm(path), have);
  }
  const missing: string[] = [];
  for (const [key, methods] of Object.entries(METHODS)) {
    const entry = inventoryPaths[key as keyof typeof inventoryPaths];
    const paths =
      typeof entry === 'string'
        ? [entry]
        : key === 'accountRegistry' || key === 'registryItem' || key === 'registryMergeInto'
          ? (['brands', 'vendors', 'people', 'tags'] as const).map((kind) =>
              key === 'accountRegistry'
                ? (entry as (a: string, k: string) => string)(':a', kind)
                : (entry as (k: string, id: string) => string)(kind, ':id'),
            )
          : [(entry as (...args: string[]) => string)(':a', ':b')];
    for (const path of paths) {
      const have = server.get(norm(decodeURIComponent(path)));
      for (const m of methods) if (!have?.has(m)) missing.push(`${m} ${path} (${key})`);
    }
  }
  expect(missing).toEqual([]);
});

test('browse Home down to the Cable box and the HDMI cable; search in English and Arabic', async ({
  page,
}) => {
  await signIn(page, 'ibrahim@kept.test');
  // Home's location card, then down the places.
  await visible(page, 'link', /^Home\b.*things/).click();
  await expect(heading(page, 'Home')).toBeVisible();
  await visible(page, 'link', /^Office\b/).click();
  await expect(heading(page, 'Office')).toBeVisible();
  await visible(page, 'link', /^Desk drawer\b/).click();
  await expect(heading(page, 'Desk drawer')).toBeVisible();
  await visible(page, 'link', /^Cable box\b/).click();
  await expect(heading(page, 'Cable box')).toBeVisible();
  // A container opens on its contents (T25).
  await visible(page, 'link', new RegExp(CABLE)).click();
  await expect(heading(page, CABLE)).toBeVisible();
  // Its short ID chip (D120) and its path, ending in the box.
  await expect(page.getByRole('img', { name: /^[0-9A-Z]{6}$/ }).first()).toBeVisible();
  await expect(visible(page, 'link', 'Cable box')).toBeVisible();

  await page.goto('/search');
  const box = page.getByRole('searchbox').first();
  await box.fill('hdmi');
  await expect(visible(page, 'link', new RegExp(CABLE))).toBeVisible();
  await box.fill('كابل');
  await expect(visible(page, 'link', /كابل HDMI/)).toBeVisible();
});

test('an edit that meets another person’s edit opens the conflict sheet (D156)', async ({
  page,
  browser,
}) => {
  await signIn(page, 'ibrahim@kept.test');
  const id = await thingId(page, 'hdmi', CABLE);
  await page.goto(`/t/${id}`);
  await expect(heading(page, CABLE)).toBeVisible();
  await thingAction(page, 'Edit');
  const form = page.getByRole('form', { name: `Edit ${CABLE}` });
  await form.getByLabel('Model', { exact: true }).fill('IBRAHIM-2M');

  // Alfred, a member of Home, changes the same field in his own browser meanwhile.
  const alfred = await otherBrowser(browser, page);
  const alfredPage = await alfred.newPage();
  await signIn(alfredPage, 'alfred@kept.test');
  const current = await (await alfredPage.request.get(`/api/v1/things/${id}`)).json();
  const patched = await alfredPage.request.patch(`/api/v1/things/${id}`, {
    data: { model: 'ALFRED-2M' },
    // The server refuses a write whose Origin isn't this site.
    headers: { 'if-match': String(current.rowVersion), origin: new URL(page.url()).origin },
  });
  expect(patched.ok()).toBe(true);
  await alfred.close();

  await form.getByRole('button', { name: 'Save' }).click();
  const sheet = page.getByRole('dialog', { name: /Alfred changed this since you opened it/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('IBRAHIM-2M')).toBeVisible();
  await expect(sheet.getByText('ALFRED-2M')).toBeVisible();
  await sheet.getByText('Keep mine', { exact: true }).click();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText('IBRAHIM-2M').first()).toBeVisible();
  const after = await (await page.request.get(`/api/v1/things/${id}`)).json();
  expect(after.model).toBe('IBRAHIM-2M');
});

test('move it, trash it, restore it; Activity shows it and filters by person (D205)', async ({
  page,
}) => {
  await signIn(page, 'ibrahim@kept.test');
  const id = await thingId(page, 'hdmi', CABLE);
  await page.goto(`/t/${id}`);
  await expect(heading(page, CABLE)).toBeVisible();

  // Move into the Living room (D45), with Undo on the toast (D150).
  await thingAction(page, 'Move');
  const move = page.getByRole('dialog', { name: `Move ${CABLE}` });
  const where = move.getByRole('combobox', { name: 'Room, spot or box' });
  await where.fill('Living');
  await page.getByRole('option', { name: /^Living room/ }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await expect(move).toBeHidden();
  await expect(toastUndo(page)).toBeVisible();
  await expect(visible(page, 'link', 'Living room')).toBeVisible();
  let row = await (await page.request.get(`/api/v1/things/${id}`)).json();
  expect(row.path.map((s: { name: string }) => s.name)).toEqual(['Living room']);

  // Undo puts it back in the Cable box.
  await toastUndo(page).click();
  await expect
    .poll(
      async () => {
        row = await (await page.request.get(`/api/v1/things/${id}`)).json();
        return row?.path?.at(-1)?.name;
      },
      // A bare poll inherits 10 s; a loaded machine's Postgres can stall past it (step 4).
      { timeout: 30_000 },
    )
    .toBe('Cable box');

  // Trash (D162), then restore from Trash.
  await page.reload();
  await expect(heading(page, CABLE)).toBeVisible();
  await thingAction(page, 'Move to Trash');
  await page
    .getByRole('alertdialog', { name: `Move ${CABLE} to Trash?` })
    .getByRole('button', { name: 'Move to Trash' })
    .click();
  await expect(page.getByText(`${CABLE} is in Trash`)).toBeVisible();
  await page.goto('/trash');
  const item = page.getByRole('listitem').filter({ hasText: CABLE }).first();
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: CABLE })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/things/${id}`)).ok()).toBe(true);

  // Activity: the move, its undo, the trash and the restore, found by the activity search.
  await page.goto('/activity');
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('HDMI cable, 2');
  const feed = page.getByRole('list', { name: 'Activity' });
  await expect(feed.getByRole('article', { name: `Trashed ${CABLE}` })).toBeVisible();
  await expect(feed.getByRole('article', { name: `Restored ${CABLE}` })).toBeVisible();
  await expect(feed.getByRole('article', { name: `Moved ${CABLE}` })).toBeVisible();

  // The filter strip (D205): filter by person, save it as a view that opens by default. Here
  // rather than in a test of its own, which would sign in once more and meet the sign-in limit.
  await page.goto('/activity');
  await expect(feed).toBeVisible();

  // + Filter on desktop, Filters (n) on a phone: the same fields either way.
  await visible(page, 'button', /^(Filter|Filters)$/).click();
  const panel = page.getByRole('dialog', { name: /^(Filter by|Filters)$/ });
  await panel.getByRole('option', { name: 'Person' }).click();
  await page.getByRole('row', { name: /^You/ }).click();
  await expect(page).toHaveURL(/f\.actor=/);
  const done = page.getByRole('button', { name: 'Done' });
  if (await done.count()) await done.click();
  else await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Person: You' })).toBeVisible();
  // Only what you did: the restore from the flow above is yours.
  await expect(feed.getByRole('article', { name: `Restored ${CABLE}` })).toBeVisible();

  // Save it: pinned as a tab, and the list opens with it from now on.
  await visible(page, 'button', 'Views').click();
  await page
    .getByRole('dialog', { name: 'Saved views' })
    .getByRole('button', { name: 'Save view' })
    .click();
  const save = page.getByRole('dialog', { name: 'Save view' });
  await save.getByLabel('Name').fill('My changes');
  await save.getByText('Open this list with it').click();
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(save).toBeHidden();
  const tabs = page.getByRole('group', { name: 'Pinned views' });
  await expect(tabs.getByRole('button', { name: 'My changes' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page).toHaveURL(/saved=/);

  // "All" clears it; coming back to the list opens the default again.
  await tabs.getByRole('button', { name: 'All' }).click();
  await expect(page).not.toHaveURL(/f\.actor=/);
  await page.goto('/');
  await page.goto('/activity');
  await expect(page).toHaveURL(/f\.actor=.*saved=|saved=.*f\.actor=/);
  await expect(page.getByRole('button', { name: 'Person: You' })).toBeVisible();

  // The server kept it for this list, with its default.
  const views = await (await page.request.get('/api/v1/saved-views?surface=activity')).json();
  const mine = views.views.find((v: { name: string }) => v.name === 'My changes');
  expect(mine?.query.filters.actor).toHaveLength(1);
  expect(views.prefs.defaultViewId).toBe(mine?.id);
});

test('a viewer sees no money and no edit actions (D13, D110)', async ({ page }) => {
  await signIn(page, 'talia@kept.test');
  const id = await thingId(page, 'hdmi', CABLE);
  const raw = await (await page.request.get(`/api/v1/things/${id}`)).json();
  expect(raw.moneyHidden).toBe(true);
  expect(raw.purchase?.unitPrice).toBeUndefined();
  await page.goto(`/t/${id}`);
  await expect(heading(page, CABLE)).toBeVisible();
  for (const name of ['Edit', 'Move'])
    await expect(
      page.getByRole('button', { name, exact: true }).filter({ visible: true }),
    ).toHaveCount(0);
  // The purchase is there, its price is not (the seed paid EGP 150 each).
  await expect(page.getByText('Not shown to viewers here')).toBeVisible();
  await expect(page.getByText(/150/)).toHaveCount(0);
  // Copy link only (screens §5, a viewer's thing detail): the phone shows it as the one button;
  // on desktop the Actions menu holds nothing else.
  const actions = page
    .getByRole('button', { name: /^(Actions|More actions)$/ })
    .filter({ visible: true });
  if (await actions.count()) {
    await actions.first().click();
    const items = page.getByRole('menuitem');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveText(/Copy link/);
    await page.keyboard.press('Escape');
  } else {
    await expect(visible(page, 'button', 'Copy link')).toBeVisible();
  }
});
