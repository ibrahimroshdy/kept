/**
 * Step 6's journeys against the real server (plan T26; the final check for steps 5–8), on the
 * `households` seed with the AI mock and its scripted cases (src/ai/mock-script.ts, the questions
 * in apps/server/test/fixtures/assistant/cases.json), behind HTTPS (the `assistant` instance,
 * e2e/instances.ts):
 *
 * 1. Ibrahim asks the assistant to move the HDMI cable to Box 3: one confirmation card, Confirm
 *    moves it, Undo from the toast puts it back in the Cable box.
 * 2. A spoken list: the composer's mic with a STUB recogniser (never a real one; both
 *    SpeechRecognition globals are replaced before the app loads) hears three things; one card
 *    adds a drill, a ladder and two paint cans on a new shelf; Confirm, then Undo.
 * 3. A token: made in Settings → Connections (read only, Home), it reads the public API and
 *    /mcp (tools/list, where_is), is revoked there, and then gets 401 on both.
 *
 * Every page a test visits is checked with axe (nothing above "minor"). The journeys that write
 * run in one project each, so the phone and desktop projects never move the same thing.
 *
 *   KEPT_E2E_INSTANCES=assistant pnpm --filter @kept/web exec playwright test step6.spec.ts
 */
import { request as apiRequest, type Page, test } from '@playwright/test';
import { ASSISTANT_INSTANCE } from './instances';
import { axe, expect, IBRAHIM, MOCK_KEY, onlyOn, people } from './tls-people';

const { BASE, person, api, locationId, moduleOn } = people(ASSISTANT_INSTANCE);

test.use({ baseURL: BASE, ignoreHTTPSErrors: true });

/** The account's AI provider, once, with the mock key: Home is paid by Ibrahim's account. */
async function ensureMockProvider(page: Page) {
  const { providers } = await api(page).get<{ providers: { scope: string }[] }>(
    '/api/v1/ai/providers',
  );
  if (providers.some((p) => p.scope === 'account')) return;
  const res = await page.request.fetch('/api/v1/ai/providers/account', {
    method: 'PUT',
    data: { apiKey: MOCK_KEY },
    headers: { origin: BASE, 'idempotency-key': crypto.randomUUID() },
  });
  // 409 or 428: the other project's test set it at the same moment; it is there either way.
  expect([200, 409, 428], await res.text()).toContain(res.status());
  await expect
    .poll(async () =>
      (
        await api(page).get<{ providers: { scope: string }[] }>('/api/v1/ai/providers')
      ).providers.some((p) => p.scope === 'account'),
    )
    .toBe(true);
}

/** Opens the assistant from the header: a panel at desktop width, a sheet on a phone. */
async function openAssistant(page: Page) {
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const box = page.getByRole(test.info().project.name === 'phone' ? 'dialog' : 'complementary', {
    name: 'Assistant',
  });
  await expect(box).toBeVisible();
  return box;
}

type Path = { path: { name: string }[] };
const where = async (page: Page, id: string) =>
  (await api(page).get<Path>(`/api/v1/things/${id}`)).path.map((s) => s.name);

test('the assistant proposes a move, Confirm moves the cable and Undo puts it back', async ({
  browser,
}) => {
  onlyOn('desktop');
  const { context, page } = await person(browser, IBRAHIM);
  await page.goto('/');
  await ensureMockProvider(page);
  const box = await openAssistant(page);
  await axe(page, 'the assistant panel');

  await box
    .getByRole('textbox', { name: 'Ask about your things' })
    .fill('Move the HDMI cable to Box 3');
  await box.getByRole('button', { name: 'Send', exact: true }).click();

  const card = box.getByRole('group', { name: 'Changes for you to confirm, drawn by Kept' });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole('checkbox', { name: /Include: Move/ })).toBeChecked();
  const link = card.getByRole('link', { name: 'HDMI cable, 2 m' });
  await expect(link).toBeVisible();
  await expect(card).toContainText('Box 3');
  await axe(page, 'the confirmation card');
  const id = ((await link.getAttribute('href')) ?? '').split('/').pop() as string;
  expect(await where(page, id)).toContain('Cable box');

  await card.getByRole('button', { name: 'Confirm 1', exact: true }).click();
  const toast = page.getByRole('region', { name: 'Notifications' });
  await expect(toast).toContainText(/Moved .*HDMI cable, 2 m.* to .*Box 3/);
  expect((await where(page, id)).at(-1)).toBe('Box 3');

  await toast.getByRole('button', { name: 'Undo', exact: true }).last().click();
  await expect(toast).toContainText('Undone');
  await expect.poll(async () => (await where(page, id)).at(-1)).toBe('Cable box');
  await context.close();
});

test('a spoken list (stub recogniser) becomes one card adding three things; Confirm, then Undo', async ({
  browser,
}) => {
  onlyOn('phone');
  const { context, page } = await person(browser, IBRAHIM, () => {
    // A STUB recogniser, never a real one (agent rules: Chrome's opens the real microphone).
    class StubRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      started = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        (window as unknown as { __rec: StubRecognition }).__rec = this;
      }
      start() {
        this.started = true;
      }
      stop() {
        this.started = false;
        this.onend?.();
      }
      abort() {
        this.stop();
      }
      hear(phrases: string[]) {
        this.onresult?.({
          resultIndex: 0,
          results: phrases.map((p) => ({ isFinal: true, length: 1, 0: { transcript: p } })),
        });
      }
    }
    for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
      Object.defineProperty(window, name, {
        value: StubRecognition,
        configurable: true,
        writable: true,
      });
    }
  });
  await page.goto('/');
  // Refuse to touch the mic unless both globals are the stub.
  expect(
    await page.evaluate(() => {
      const w = window as unknown as Record<string, { name?: string }>;
      return [w.SpeechRecognition?.name, w.webkitSpeechRecognition?.name];
    }),
  ).toEqual(['StubRecognition', 'StubRecognition']);
  await ensureMockProvider(page);
  const box = await openAssistant(page);

  await box.getByRole('button', { name: 'Dictate', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { __rec: { hear(p: string[]): void } }).__rec.hear([
      'In the storage room I have a drill,',
      ' a ladder and two paint cans',
    ]),
  );
  const field = box.getByRole('textbox', { name: 'Ask about your things' });
  await expect(field).toHaveValue(
    'In the storage room I have a drill, a ladder and two paint cans',
  );
  const stop = box.getByRole('button', { name: 'Stop dictation', exact: true });
  if (await stop.isVisible()) await stop.click();
  await box.getByRole('button', { name: 'Send', exact: true }).click();

  const card = box.getByRole('group', { name: 'Changes for you to confirm, drawn by Kept' });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole('checkbox', { name: /Include: Add/ })).toHaveCount(3);
  await expect(card).toContainText('New place');
  await axe(page, 'the spoken list card');
  await card.getByRole('button', { name: 'Confirm 3', exact: true }).click();
  const toast = page.getByRole('region', { name: 'Notifications' });
  await expect(toast).toContainText(/Added .*Drill.*Ladder.*Paint can/);
  await toast.getByRole('button', { name: 'Undo', exact: true }).last().click();
  await expect(toast).toContainText('Undone');
  await context.close();
});

/** One JSON-RPC message to /mcp; the answer is JSON or a one-message event stream. */
async function mcp(
  base: string,
  secret: string,
  body: Record<string, unknown>,
): Promise<{ status: number; message?: Record<string, unknown> }> {
  const ctx = await apiRequest.newContext({ baseURL: base, ignoreHTTPSErrors: true });
  try {
    const res = await ctx.post('/mcp', {
      data: { jsonrpc: '2.0', ...body },
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
    });
    const text = await res.text();
    if (!text.trim()) return { status: res.status() };
    const type = res.headers()['content-type'] ?? '';
    const raw = type.includes('text/event-stream')
      ? (text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .at(-1)
          ?.slice(5) ?? '{}')
      : text;
    return { status: res.status(), message: JSON.parse(raw) as Record<string, unknown> };
  } finally {
    await ctx.dispose();
  }
}

test('a read token reads the API and /mcp, and once revoked gets 401 on both', async ({
  browser,
}) => {
  onlyOn('desktop');
  const { context, page } = await person(browser, IBRAHIM);
  await page.goto('/');
  const home = await locationId(page, 'Home');
  // The seed's Home is a Household: MCP ("Connect ChatGPT or Claude") is a Complete module.
  await moduleOn(page, home, 'mcp');

  await page.goto('/settings/connections');
  await expect(page.getByRole('heading', { name: 'Connections', level: 1 })).toBeVisible();
  await axe(page, 'Connections');
  await page.getByRole('button', { name: 'New token', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New token' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Name' }).fill('E2E reader');
  // Home only (one location is ticked to begin with).
  await sheet.getByRole('checkbox', { name: /^Home\b/ }).check({ force: true });
  for (const other of [/^Garage\b/, /^بيت العائلة/]) {
    const box = sheet.getByRole('checkbox', { name: other });
    if ((await box.count()) > 0 && (await box.isChecked())) await box.uncheck({ force: true });
  }
  await expect(sheet.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(sheet.getByRole('radio', { name: 'Read only' })).toBeChecked();
  await axe(page, 'the new token sheet');
  await sheet.getByRole('button', { name: 'Make token', exact: true }).click();
  const made = page.getByRole('dialog', { name: 'Your new token' });
  await expect(made).toBeVisible();
  const secret = ((await made.locator('[data-token-secret]').textContent()) ?? '').trim();
  expect(secret).toMatch(/^kpt_/);
  await made.getByRole('button', { name: 'Done', exact: true }).click();

  // The public API with the token alone: no cookie.
  const bearer = await apiRequest.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { authorization: `Bearer ${secret}` },
  });
  const locs = await bearer.get('/api/v1/locations');
  expect(locs.status(), await locs.text()).toBe(200);
  const things = await bearer.get(`/api/v1/things?locationId=${home}`);
  expect(things.status()).toBe(200);
  const items = ((await things.json()) as { items: { locationId: string }[] }).items;
  expect(items.length).toBeGreaterThan(0);
  expect(new Set(items.map((x) => x.locationId))).toEqual(new Set([home]));

  // /mcp: the 2025 handshake, the tools, and where_is.
  const init = await mcp(BASE, secret, {
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'kept-e2e', version: '0.0.0' },
    },
  });
  expect(init.status).toBe(200);
  expect(init.message?.result).toBeTruthy();
  const tools = await mcp(BASE, secret, { id: 2, method: 'tools/list', params: {} });
  expect(tools.status).toBe(200);
  const listed = tools.message?.result as { tools?: { name: string }[] } | undefined;
  const names = (listed?.tools ?? []).map((x) => x.name);
  expect(names).toContain('where_is');
  expect(names).not.toContain('create_place');
  const found = await mcp(BASE, secret, {
    id: 3,
    method: 'tools/call',
    params: { name: 'where_is', arguments: { query: 'HDMI' } },
  });
  expect(found.status).toBe(200);
  expect(JSON.stringify(found.message?.result)).toContain('HDMI cable');

  // Revoke it in Connections.
  await page.getByRole('button', { name: 'Revoke: E2E reader' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    "can't reach your Kept any more",
  );

  const after = await bearer.get('/api/v1/locations');
  expect(after.status()).toBe(401);
  expect(((await after.json()) as { code: string }).code).toBe('token_revoked');
  expect((await mcp(BASE, secret, { id: 4, method: 'tools/list', params: {} })).status).toBe(401);
  await bearer.dispose();
  await context.close();
});
