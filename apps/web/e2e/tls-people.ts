/**
 * Shared by steps 6–8's specs (step6.spec.ts, step7.spec.ts, step8.spec.ts), whose instances run
 * behind HTTPS with a self-signed certificate (e2e/instances.ts `TlsInstance`): signing a seeded
 * person in once per run, a browser context for them that accepts the certificate, the page's API
 * with its cookie, origin and an Idempotency-Key, and the axe check every page gets (nothing above
 * "minor"), as step4.spec.ts and step5.spec.ts do for theirs.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {
  type APIResponse,
  type Browser,
  type BrowserContext,
  expect as baseExpect,
  type Page,
  test,
} from '@playwright/test';
import { stateDirOf, type TlsInstance, urlOf } from './instances';

// The instances share their Postgres with every other test run on the machine: 30 s, not 10.
export const expect = baseExpect.configure({ timeout: 30_000 });

export const PASSWORD = 'kept-seed-password';
export const ZONE = 'Africa/Cairo';

/** The seed's people (src/seed/cast.ts): they sign in with their email. */
export const IBRAHIM = 'ibrahim@kept.test';
export const LOUIS = 'louis@kept.test';

/** A made-up key for the mock provider: KEPT_AI_MOCK=1 never sends it anywhere (as step3.spec.ts). */
export const MOCK_KEY = 'gsk_e2e-mock-provider-not-a-real-key';

export const onlyOn = (project: 'phone' | 'desktop') =>
  test.skip(test.info().project.name !== project, `runs in the ${project} project`);

export function people(instance: TlsInstance) {
  const BASE = urlOf(instance);
  const stateDir = path.join(stateDirOf(instance), 'sessions');

  async function storageFor(browser: Browser, login: string): Promise<string> {
    const file = path.join(stateDir, `${login}.json`);
    if (existsSync(file)) return file;
    mkdirSync(stateDir, { recursive: true });
    const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
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

  /** A context for `login` in this project's viewport; `init` runs before the app loads. */
  async function person(
    browser: Browser,
    login: string,
    init?: () => void,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const use = test.info().project.use;
    const context = await browser.newContext({
      baseURL: BASE,
      ignoreHTTPSErrors: true,
      storageState: await storageFor(browser, login),
      viewport: use.viewport ?? { width: 1280, height: 800 },
      isMobile: use.isMobile ?? false,
      hasTouch: use.hasTouch ?? false,
      timezoneId: ZONE,
      locale: 'en-GB',
    });
    if (init) await context.addInitScript(init);
    return { context, page: await context.newPage() };
  }

  /** The page's API with its cookie, origin and an Idempotency-Key on every write. */
  function api(page: Page) {
    const json = async <T>(res: APIResponse): Promise<T> => {
      expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true);
      return (await res.json().catch(() => ({}))) as T;
    };
    const write =
      (method: string) =>
      async <T>(url: string, data: unknown = {}) =>
        json<T>(
          await page.request.fetch(url, {
            method,
            data,
            headers: { origin: BASE, 'idempotency-key': crypto.randomUUID() },
          }),
        );
    return {
      get: async <T>(url: string) => json<T>(await page.request.get(url)),
      post: write('POST'),
      put: write('PUT'),
    };
  }

  /** A location of the person's, by name. */
  async function locationId(page: Page, name: string): Promise<string> {
    const { locations } = await api(page).get<{ locations: { id: string; name: string }[] }>(
      '/api/v1/locations',
    );
    const loc = locations.find((l) => l.name === name);
    if (!loc) throw new Error(`no location ${name}: ${locations.map((l) => l.name).join(', ')}`);
    return loc.id;
  }

  /** A thing by its exact name, through search. */
  async function thingId(page: Page, name: string): Promise<string> {
    const res = await api(page).get<{ things: { items: { id: string; name: string }[] } }>(
      `/api/v1/search?kind=things&limit=50&q=${encodeURIComponent(name)}`,
    );
    const hit = res.things.items.find((x) => x.name === name);
    if (!hit) throw new Error(`no thing ${name}`);
    return hit.id;
  }

  /** Turns a module on in a location (POST /api/v1/locations/:id/modules), as an admin would. */
  async function moduleOn(page: Page, locId: string, module: string) {
    await api(page).post(`/api/v1/locations/${locId}/modules`, { module, enabled: true });
  }

  return { BASE, storageFor, person, api, locationId, thingId, moduleOn };
}

export async function axe(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations
    .filter((v) => v.impact && v.impact !== 'minor')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')}`);
  expect.soft(serious, `axe on ${where}`).toEqual([]);
}
