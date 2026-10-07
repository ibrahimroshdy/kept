/**
 * Step 4's household journeys against the real server (plan T30, finished in step 5's T25), on the
 * `households` seed (the `household` instance, e2e/instances.ts), whose step-4 records (seed/
 * records.ts) the tests use where it has them. The plan's numbers:
 *
 * 1. Bruce sees the seed's overdue loan (Catan, with Murdock) after the reminder scan; the
 *    notification centre shows it overdue; Mark returned from the centre; Undo from the toast
 *    re-opens the loan. Then the centre's read state: one read by its action, the rest by Mark all
 *    read.
 * 2. Lending part of a quantity: 2 of the 3 HDMI cables (the plan's "2 of 5"; the seed has 3),
 *    returned and merged back.
 * 3. The TV's two warranties (the seed's maker's, and an extended one) with their coverage bars;
 *    the seed's claim in repair: "At Samsung Service Centre", Lend hidden; resolved at no cost:
 *    "Warranty saved you"; Undo puts it back in repair.
 * 4. A boiler service on the Kitchen, due in five days: Complete from Home's Due row (through
 *    Expiring, the seed's warranties and documents sharing the count); the next due moves by the
 *    interval; Undo puts it back; Snooze from the row.
 * 5. A lease on Alfred's بيت العائلة, running out: Renew from the Expiring screen, in Arabic (RTL,
 *    Eastern digits); the old term stays in its history.
 * 6. Louis turns on warranties by email and sets his digest time; the digest reaches Mailpit at the
 *    faked time with the thing, path, location and date (see MAIL below: the instance has no SMTP,
 *    and the seed's members have unverified addresses, so the pass confirms Louis's first);
 *    a push delivered to the registered worker over CDP shows its notification (the instance can't
 *    offer Enable: no HTTPS and no VAPID subject, and Playwright's Chromium has no push service).
 * 7. A calendar feed made in Settings, fetched without a session (iCal with the seed's
 *    schedules), then revoked: 404.
 * 8. An incident of two things, stolen; a claim pack for it; its link downloads the ZIP without a
 *    session; revoked, the link answers 410. And the seed's flood: its insurance report PDF
 *    downloads (its text read with poppler's pdftotext where installed).
 * 9. Talia, a viewer: the TV's warranties and claims and Catan's loan with no actions and no money;
 *    her notification settings list only Membership.
 * 10. Lending off in the Garage: Lend reads "Off in this location", the overdue loan's reminder is
 *    cancelled by the scan, the nav entry stays while Lending is on elsewhere and goes when it is
 *    off everywhere; back on, the one reminder reopens.
 *
 * Every page a test visits is checked with axe (nothing above "minor"): journey 11. Tests leave
 * the seed's rows as they found them (Undo, or a return or delete through the API), because they
 * share the instance. Each runs in one project: tests that write what another reads run in order
 * in the desktop project (one worker); the phone project's only touch rows of their own.
 *
 * The scan: `reminder-scan` runs every 15 minutes in the instance's worker. The tests don't wait
 * for it: scanNow() runs one pass of the same function (apps/server/dist/reminders/scan.js
 * `runScan`) against the instance's database, as kept_system, in a child process with the
 * `kept-dist` condition, so it reads what the server wrote. That pass writes the occurrences and
 * the centre's notifications; with no channel senders, the mail and push deliveries it queues
 * stay queued. The worker's own pass can run in between; the tests allow for it.
 *
 *   KEPT_E2E_INSTANCES=household pnpm --filter @kept/web exec playwright test step4.spec.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  expect as baseExpect,
  type Locator,
  type Page,
  request,
  test,
} from '@playwright/test';
import { INSTANCES, stateDirOf, urlOf } from './instances';

const HOUSEHOLD = INSTANCES.household;
const BASE = urlOf(HOUSEHOLD);
const PASSWORD = 'kept-seed-password';
const CATAN = 'Catan';
const TV = 'Samsung TV, 55″';
const HDMI = 'HDMI cable, 2 m';
const LOUIS = 'louis@kept.test';
/** How long a wait allows (see `expect` below). */
const SLOW_WRITE = 30_000;

test.use({ baseURL: BASE });

/**
 * Every wait in this file allows 30 s, not the config's 10: with a dozen agents on the machine,
 * the dev Postgres stalls on checkpoints and a write's toast, a sheet closing or a polled row has
 * been seen to take 10 s and more. The test timeouts are sized for it.
 */
const expect = baseExpect.configure({ timeout: SLOW_WRITE });

const onlyOn = (project: 'phone' | 'desktop') =>
  test.skip(test.info().project.name !== project, `runs in the ${project} project`);

// ---------------------------------------------------------------------------------------------
// Days, in the people's zone (the seed's cast lives in Africa/Cairo).

const ZONE = 'Africa/Cairo';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
/** `day` moved by months and days, as a calendar date (YYYY-MM-DD). */
function shift(day: string, { months = 0, days = 0 }: { months?: number; days?: number }) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 + months, d + days)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Sessions: sign-in is limited to 5 a minute, so each person signs in once per run and every
// later context reuses the cookie (as step3.spec.ts).

const stateDir = path.join(stateDirOf(HOUSEHOLD), 'sessions');

async function storageFor(browser: Browser, login: string): Promise<string> {
  const file = path.join(stateDir, `${login}.json`);
  if (existsSync(file)) return file;
  mkdirSync(stateDir, { recursive: true });
  const ctx = await browser.newContext({ baseURL: BASE });
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

/** A signed-in context shaped like the running project, optionally in Arabic. */
async function person(
  browser: Browser,
  login: string,
  opts: { locale?: 'ar' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const use = test.info().project.use;
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: await storageFor(browser, login),
    viewport: use.viewport ?? { width: 1280, height: 800 },
    isMobile: use.isMobile ?? false,
    hasTouch: use.hasTouch ?? false,
    timezoneId: ZONE,
    locale: 'en-GB',
  });
  if (opts.locale) {
    await context.addInitScript((l) => {
      try {
        localStorage.setItem('kept.locale', l);
      } catch {}
    }, opts.locale);
  }
  const page = await context.newPage();
  return { context, page };
}

/** The page's API with the page's own cookie and origin (the CSRF check wants the origin). */
function api(page: Page) {
  const send = async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown) =>
    page.request.fetch(url, {
      method,
      ...(data === undefined ? {} : { data }),
      headers: { origin: BASE },
    });
  const json = async <T>(res: Awaited<ReturnType<Page['request']['get']>>): Promise<T> => {
    expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  };
  return {
    get: async <T>(url: string) => json<T>(await page.request.get(url)),
    post: async <T>(url: string, data?: unknown) => json<T>(await send('POST', url, data ?? {})),
  };
}

/** Nothing above "minor" on this page (WCAG 2.2 A/AA and axe's best practices), as step 3. */
async function axe(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations
    .filter((v) => v.impact && v.impact !== 'minor')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} × ${v.nodes[0]?.target.join(' ')}`);
  // Soft: a violation fails the test, but the flow goes on, so one finding doesn't hide the rest.
  expect.soft(serious, `axe on ${where}`).toEqual([]);
}

/** The newest toast's Undo (the toasts' region is named Notifications, like the centre). */
const toastUndo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true }).last();

/** Types `day` into a React Aria date field, segment by segment, whatever the locale's order. */
async function setDate(
  scope: Page | Locator,
  label: string,
  day: string,
  digits: 'western' | 'eastern' = 'western',
) {
  // Segments in Eastern digits take only Eastern digits from the keyboard.
  const typed =
    digits === 'eastern' ? day.replace(/[0-9]/g, (c) => '٠١٢٣٤٥٦٧٨٩'[Number(c)] as string) : day;
  const [y, m, d] = typed.split('-') as [string, string, string];
  const group = scope.getByRole('group', { name: label, exact: true });
  for (const [segment, value] of [
    ['day', d],
    ['month', m],
    ['year', y],
  ] as const) {
    // By the segment's type, not its accessible name, which is in the page's language.
    const input = group.locator(`[role="spinbutton"][data-type="${segment}"]`);
    await input.click();
    await input.pressSequentially(value);
  }
}

// ---------------------------------------------------------------------------------------------
// Lookups

type Located = { id: string; name: string };

async function locationNamed(page: Page, name: string): Promise<Located> {
  const body = await api(page).get<{ locations?: Located[] } | Located[]>('/api/v1/locations');
  const list = Array.isArray(body) ? body : (body.locations ?? []);
  const found = list.find((l) => l.name === name);
  if (!found) throw new Error(`no location ${name}`);
  return found;
}

async function thingNamed(page: Page, locationId: string, name: string): Promise<Located> {
  const { items } = await api(page).get<{ items: Located[] }>(
    `/api/v1/things?locationId=${locationId}&q=${encodeURIComponent(name)}`,
  );
  const found = items.find((t) => t.name === name);
  if (!found) throw new Error(`no thing ${name}`);
  return found;
}

type PlaceNode = Located & { children?: PlaceNode[] };
async function placeNamed(page: Page, locationId: string, name: string): Promise<Located> {
  const { places } = await api(page).get<{ places: PlaceNode[] }>(
    `/api/v1/locations/${locationId}/places`,
  );
  const walk = (nodes: PlaceNode[]): PlaceNode | undefined => {
    for (const n of nodes) {
      if (n.name === name) return n;
      const deeper = walk(n.children ?? []);
      if (deeper) return deeper;
    }
    return undefined;
  };
  const found = walk(places);
  if (!found) throw new Error(`no place ${name}`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// The scan (see the header)

const serverDir = fileURLToPath(new URL('../../server/', import.meta.url));

const SCAN = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const dir = process.env.KEPT_SERVER_DIR;
const pg = createRequire(dir + 'package.json')('pg');
const { runScan } = await import(pathToFileURL(dir + 'dist/reminders/scan.js').href);
const url = (role) => 'postgres://' + role + ':' + role + '@localhost:5452/' + process.env.KEPT_E2E_DB;
const pools = {
  system: new pg.Pool({ connectionString: url('kept_system'), max: 2 }),
  auth: new pg.Pool({ connectionString: url('kept_auth'), max: 2 }),
};
try {
  const done = await runScan({ pools });
  process.stdout.write(JSON.stringify(done));
} finally {
  await pools.system.end();
  await pools.auth.end();
}
`;

type ScanResult = {
  occurrences: number;
  reopened: number;
  notifications: number;
  closed: { done: number; superseded: number; cancelled: number };
};

/** Runs `script` against this instance's database in a child process (see the header). */
function inInstance(script: string, env: Record<string, string> = {}): string {
  const log = readFileSync(path.join(stateDirOf(HOUSEHOLD), 'server.log'), 'utf8');
  const db = /database (kept_e2e_household_\d+) migrated/.exec(log)?.[1];
  if (!db) throw new Error('the household instance logged no database name');
  return execFileSync(
    process.execPath,
    ['--conditions=kept-dist', '--input-type=module', '-e', script],
    {
      env: {
        PATH: process.env.PATH,
        KEPT_SERVER_DIR: serverDir,
        KEPT_E2E_DB: db,
        TZ: 'UTC',
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
}

/** One pass of the reminder scan on this instance's database. Answers its result. */
function scanNow(): ScanResult {
  return JSON.parse(inInstance(SCAN));
}

// The digest by email (journey 6). The e2e instance runs without KEPT_SMTP_URL (e2e/serve.mjs), so
// its worker has no `email` sender and makes no email deliveries. This pass is the worker as it
// runs with SMTP set to Mailpit (localhost:1025, compose.dev.yaml): the server's own SMTP mailer
// (mail/transport.js `smtpMailer`) and email sender (notify/senders.js `createChannelSenders`),
// handed to one scan (KEPT_SCAN=1) and then to the digest pass at each faked time in KEPT_AT
// (reminders/digest.js `runDigests`'s `now`).
const MAIL = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const dir = process.env.KEPT_SERVER_DIR;
const pg = createRequire(dir + 'package.json')('pg');
const load = (p) => import(pathToFileURL(dir + 'dist/' + p).href);
const { runScan } = await load('reminders/scan.js');
const { runDigests } = await load('reminders/digest.js');
const { smtpMailer, defaultFrom } = await load('mail/transport.js');
const { createChannelSenders } = await load('notify/senders.js');
const url = (role) => 'postgres://' + role + ':' + role + '@localhost:5452/' + process.env.KEPT_E2E_DB;
const pools = {
  system: new pg.Pool({ connectionString: url('kept_system'), max: 2 }),
  auth: new pg.Pool({ connectionString: url('kept_auth'), max: 2 }),
};
const publicUrl = process.env.KEPT_PUBLIC_URL;
const mailer = smtpMailer({ url: 'smtp://localhost:1025', from: defaultFrom(publicUrl), publicUrl });
const senders = createChannelSenders({
  pools,
  mailer,
  push: null,
  keyring: () => {
    throw new Error('no keyring in this pass');
  },
  publicUrl,
  enqueue: async () => {},
});
const channels = { email: senders.email };
try {
  // KEPT_VERIFY: an address whose owner confirms it first. The seed's members joined by link
  // invites, which don't verify an address (invites/accept.ts verifies only an email-bound one),
  // and confirming takes a mail this instance can't send; this is what the confirmation does.
  if (process.env.KEPT_VERIFY) {
    await pools.auth.query('UPDATE auth."user" SET email_verified = true WHERE email = $1', [
      process.env.KEPT_VERIFY,
    ]);
  }
  const scan = process.env.KEPT_SCAN === '1' ? await runScan({ pools, channels }) : null;
  const digests = [];
  for (const at of (process.env.KEPT_AT ?? '').split(',').filter(Boolean)) {
    digests.push(await runDigests({ pools, channels, publicUrl }, { now: new Date(at) }));
  }
  // What waits for KEPT_WHO (an address) on email: the assertions' context when one fails.
  const who = process.env.KEPT_WHO;
  let waiting = null;
  if (who) {
    const { rows: users } = await pools.auth.query(
      'SELECT id, email_verified FROM auth."user" WHERE email = $1',
      [who],
    );
    const user = users[0];
    const { rows } = user
      ? await pools.system.query(
          \`SELECT c.kind, d.status, d.error FROM public.reminder_deliveries d
             JOIN public.notification_channels c ON c.id = d.channel_id
            WHERE d.user_id = $1 ORDER BY 1, 2\`,
          [user.id],
        )
      : { rows: [] };
    waiting = { verified: user?.email_verified ?? null, deliveries: rows };
  }
  process.stdout.write(JSON.stringify({ scan, digests, waiting }));
} finally {
  mailer.close();
  await pools.system.end();
  await pools.auth.end();
}
`;

type Digests = { sent: number; skipped: number; failed: number };

/** The scan with email on (when `scan`), then a digest pass at each of `at`. */
function mailPass(opts: { scan: boolean; at: Date[]; who?: string; verify?: string }): {
  scan: ScanResult | null;
  digests: Digests[];
  waiting: {
    verified: boolean | null;
    deliveries: { kind: string; status: string; error: string | null }[];
  } | null;
} {
  return JSON.parse(
    inInstance(MAIL, {
      KEPT_SCAN: opts.scan ? '1' : '0',
      KEPT_AT: opts.at.map((d) => d.toISOString()).join(','),
      KEPT_PUBLIC_URL: BASE,
      ...(opts.who ? { KEPT_WHO: opts.who } : {}),
      ...(opts.verify ? { KEPT_VERIFY: opts.verify } : {}),
    }),
  );
}

/** `hhmm` on `day` in the people's zone, as an instant (Cairo is UTC+2 or UTC+3). */
function inZone(day: string, hhmm: string): Date {
  for (const offset of ['+02:00', '+03:00']) {
    const at = new Date(`${day}T${hhmm}:00${offset}`);
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    if (local === hhmm) return at;
  }
  throw new Error(`no ${hhmm} on ${day} in ${ZONE}`);
}

// ---------------------------------------------------------------------------------------------
// Mailpit (compose.dev.yaml: its API on localhost:8025), shared with every other run: messages are
// told apart by recipient and by when they arrived.

const MAILPIT = 'http://localhost:8025/api/v1';
type MailSummary = { ID: string; Subject: string; Created: string; To: { Address: string }[] };

async function mailTo(address: string, since: Date): Promise<MailSummary[]> {
  const ctx = await request.newContext();
  try {
    const res = await ctx.get(`${MAILPIT}/search`, {
      params: { query: `to:${address}`, limit: '50' },
    });
    expect(res.ok(), `Mailpit search: ${res.status()}`).toBe(true);
    const { messages } = (await res.json()) as { messages: MailSummary[] };
    return messages.filter((m) => new Date(m.Created).getTime() >= since.getTime());
  } finally {
    await ctx.dispose();
  }
}

async function mailText(id: string): Promise<string> {
  const ctx = await request.newContext();
  try {
    const res = await ctx.get(`${MAILPIT}/message/${id}`);
    expect(res.ok(), `Mailpit message: ${res.status()}`).toBe(true);
    return ((await res.json()) as { Text: string }).Text;
  } finally {
    await ctx.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Small UI helpers

/** A React Aria switch is a visually hidden input in a label: press the label, as a person does. */
async function setSwitch(sw: Locator, on: boolean) {
  if ((await sw.isChecked()) === on) return;
  await sw.locator('xpath=ancestor::label[1]').click();
  await expect(sw).toBeChecked({ checked: on });
}

/** The page's own conditional request (If-Match), for a write the UI isn't the subject of. */
async function sendIfMatch(
  page: Page,
  method: 'POST' | 'DELETE',
  url: string,
  rowVersion: number,
  data?: unknown,
) {
  const res = await page.request.fetch(url, {
    method,
    ...(data === undefined ? {} : { data }),
    headers: { origin: BASE, 'if-match': String(rowVersion) },
  });
  expect(res.ok(), `${method} ${url}: ${res.status()} ${await res.text()}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------

type Loan = { id: string; returnedAt: string | null; dueOn: string | null; rowVersion: number };

test('lending: an overdue loan reaches the centre, is marked returned there and undone from the toast; the centre marks read', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'bruce@kept.test');
  const home = await locationNamed(page, 'Home');
  const catan = await thingNamed(page, home.id, CATAN);

  // The seed's Catan, lent by Ibrahim to Murdock twenty days ago and due three days ago.
  const openLoan = async () => {
    const { items } = await api(page).get<{ items: Loan[] }>(`/api/v1/things/${catan.id}/loans`);
    return items.find((l) => !l.returnedAt) ?? null;
  };
  const loan = await openLoan();
  expect(loan, 'the seed lends Catan to Murdock').not.toBeNull();
  expect(loan?.dueOn ?? '').toBe(shift(today(), { days: -3 }));

  // The scan (or the worker's own pass before it) has made the occurrence and Bruce's notification.
  scanNow();

  // The bell counts it, and the centre shows Catan as overdue.
  const before = await api(page).get<{ unread: number }>('/api/v1/notifications/count');
  expect(before.unread).toBeGreaterThan(0);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  const markReturned = page.getByRole('button', { name: `Mark ${CATAN} returned` });
  await expect(markReturned).toBeVisible();
  await expect(page.getByText(/^Was due back /).first()).toBeVisible();
  await axe(page, 'Notifications');

  // Mark returned from the centre: the loan closes, and the row is read.
  await markReturned.click();
  await expect(page.getByText(`${CATAN} is back`).first()).toBeVisible();
  await expect.poll(async () => (await openLoan())?.id ?? null).toBeNull();
  await expect
    .poll(
      async () => (await api(page).get<{ unread: number }>('/api/v1/notifications/count')).unread,
    )
    .toBe(before.unread - 1);

  // Undo from the toast re-opens it: Catan is with Murdock again, as the seed left it.
  await toastUndo(page).click();
  await expect.poll(async () => (await openLoan())?.id ?? null).toBe(loan?.id);

  // The rest by Mark all read: the bell is clear.
  if (before.unread - 1 > 0) {
    await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
  }
  await expect
    .poll(
      async () => (await api(page).get<{ unread: number }>('/api/v1/notifications/count')).unread,
    )
    .toBe(0);
  await axe(page, 'Notifications, all read');
  await context.close();
});

type Schedule = {
  id: string;
  name: string;
  next: { dueOn: string | null; state: string };
  snoozedUntil: string | null;
};

test("schedules: Complete from Home's Due row moves the next due by the interval, Undo puts it back, and Snooze holds it", async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const home = await locationNamed(page, 'Home');
  const kitchen = await placeNamed(page, home.id, 'Kitchen');

  // Serviced a year ago less five days, every 12 months: due in five days (lead 14).
  const day = today();
  const name = 'Boiler service';
  const made = await api(page).post<Schedule>('/api/v1/schedules', {
    subject: { placeId: kitchen.id },
    name,
    everyMonths: 12,
    anchorOn: shift(day, { months: -12, days: 5 }),
  });
  expect(made.next.state).toBe('due');
  const wasDue = made.next.dueOn;
  const read = async () => {
    const { items } = await api(page).get<{ items: Schedule[] }>(
      `/api/v1/places/${kitchen.id}/schedules`,
    );
    const found = items.find((s) => s.id === made.id);
    if (!found) throw new Error(`schedule ${made.id} is gone`);
    return found;
  };

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await axe(page, 'Home');
  // The seed's warranties and documents share the Due count, so the row opens Expiring, whose
  // schedule rows hand over to Schedules (components/home/attention.tsx).
  await page.getByRole('link', { name: /^Due\b/ }).click();
  await expect(page).toHaveURL(/\/expiring/);
  const listed = page.getByRole('article').filter({ hasText: name });
  await expect(listed).toBeVisible();
  await axe(page, 'Expiring, due');
  await listed.getByRole('link', { name: 'Open Schedules', exact: true }).click();
  await expect(page).toHaveURL(/\/schedules/);
  const row = page.getByRole('article', { name });
  await expect(row).toBeVisible();
  await axe(page, 'Schedules, due');

  // Complete: the sheet, done today, and the next due is a year on.
  await row.getByRole('button', { name: `Complete ${name}` }).click();
  const sheet = page.getByRole('dialog', { name: `Complete ${name}` });
  await expect(sheet).toBeVisible();
  await axe(page, 'Complete sheet');
  await sheet.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(page.getByText(`Done: ${name}`).first()).toBeVisible();
  await expect.poll(async () => (await read()).next.dueOn).toBe(shift(day, { months: 12 }));

  // Undo: due again, on the day it was.
  await toastUndo(page).click();
  await expect.poll(async () => (await read()).next.dueOn).toBe(wasDue);

  // Snooze from the row, on the sheet's default day.
  await page.reload();
  const again = page.getByRole('article', { name });
  await expect(again).toBeVisible();
  await again.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Snooze', exact: true }).click();
  const snooze = page.getByRole('dialog', { name: `Snooze ${name}` });
  await expect(snooze).toBeVisible();
  await axe(page, 'Snooze sheet');
  await snooze.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(page.getByText(/^Snoozed until /).first()).toBeVisible();
  await expect.poll(async () => (await read()).snoozedUntil).not.toBeNull();
  await context.close();
});

type Doc = {
  id: string;
  expiresOn: string;
  supersededById: string | null;
  history: { id: string; expiresOn: string }[];
};

test('documents: a lease on بيت العائلة is renewed from Expiring in Arabic, and the old term stays in its history', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'alfred@kept.test', { locale: 'ar' });
  const family = await locationNamed(page, 'بيت العائلة');
  const day = today();
  const title = 'عقد إيجار الشقة';
  const lease = await api(page).post<Doc>('/api/v1/documents', {
    subject: { locationId: family.id },
    kind: 'lease',
    title,
    expiresOn: shift(day, { days: 20 }),
  });

  await page.goto('/expiring');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const row = page.getByRole('article', { name: title });
  await expect(row).toBeVisible();
  await axe(page, 'Expiring (ar)');

  await row.getByRole('button', { name: `تجديد ${title}` }).click();
  const sheet = page.getByRole('dialog', { name: `تجديد ${title}` });
  await expect(sheet).toBeVisible();
  const renewed = shift(day, { months: 12, days: 20 });
  await setDate(sheet, 'تنتهي المدة الجديدة في', renewed, 'eastern');
  await axe(page, 'Renew sheet (ar)');
  await sheet.getByRole('button', { name: 'تجديد', exact: true }).click();
  await expect(page.getByText(`جُدِّد ${title}`).first()).toBeVisible();

  // The server: the old term superseded by the new one, which lists it in its history.
  await expect
    .poll(async () => (await api(page).get<Doc>(`/api/v1/documents/${lease.id}`)).supersededById)
    .not.toBeNull();
  const old = await api(page).get<Doc>(`/api/v1/documents/${lease.id}`);
  const current = await api(page).get<Doc>(`/api/v1/documents/${old.supersededById}`);
  expect(current.expiresOn).toBe(renewed);
  expect(current.history.map((h) => h.id)).toContain(lease.id);

  // The Expiring screen now shows the new term's row only, its date in Eastern digits.
  await page.reload();
  const rows = page.getByRole('article', { name: title });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(/[٠-٩]/);
  await expect(rows.first()).not.toContainText(/[0-9]/);
  await axe(page, 'Expiring after renewing (ar)');
  await context.close();
});

type Warranty = {
  id: string;
  kind: string;
  provider: string | null;
  effectiveEndsOn: string | null;
  rowVersion: number;
};
type Claim = { id: string; status: string };

test('warranties: the TV\'s two warranties with their coverage bars; its claim in repair reads "At" the service centre with Lend hidden; resolved at no cost, "Warranty saved you"', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const home = await locationNamed(page, 'Home');
  const tv = await thingNamed(page, home.id, TV);

  // The seed's maker's warranty (24 months from 400 days ago), and an extended one bought with it
  // for three years: two warranties, the extended one covering longest.
  const listed = await api(page).get<{ items: Warranty[] }>(`/api/v1/things/${tv.id}/warranties`);
  if (!listed.items.some((w) => w.kind === 'extended')) {
    await api(page).post(`/api/v1/things/${tv.id}/warranties`, {
      kind: 'extended',
      provider: 'B.TECH',
      startsOn: shift(today(), { days: -400 }),
      termMonths: 36,
    });
  }

  await page.goto(`/t/${tv.id}?tab=paperwork`);
  await expect(page.getByRole('heading', { name: TV, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Warranties · 2' })).toBeVisible();
  await expect(
    page.getByRole('img', { name: /(^Bought .+, c|^C)overed from .+ of the way$/ }),
  ).toHaveCount(2);
  await expect(page.getByText('Longest cover', { exact: true })).toBeVisible();
  await axe(page, 'TV, paperwork and warranties');

  // The seed's claim has it in repair at Samsung Service Centre: the header says where it is, and
  // Lend is gone from its actions (screens §8: what doesn't apply is hidden).
  await expect(page.getByText(/^At Samsung Service Centre/).first()).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Move to Trash' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Lend/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Resolved at no cost, with what the repair would have cost: "Warranty saved you".
  await page.getByRole('tab', { name: /^Claims/ }).click();
  const card = page.getByRole('article').filter({ hasText: 'SSC-48213' });
  await expect(card).toBeVisible();
  await expect(card.getByText('In repair').first()).toBeVisible();
  await axe(page, 'TV, claims');
  await card.getByRole('button', { name: 'Update', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Update the claim' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('combobox', { name: 'Status' }).fill('Resolved');
  await page.getByRole('option', { name: 'Resolved', exact: true }).click();
  await sheet.getByRole('textbox', { name: 'What it would have cost' }).fill('3200');
  await axe(page, 'Update the claim');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText(/^Warranty saved you /)).toBeVisible();
  const claims = async () =>
    (await api(page).get<{ items: Claim[] }>(`/api/v1/things/${tv.id}/claims`)).items;
  expect((await claims()).map((c) => c.status)).toEqual(['resolved']);
  await axe(page, 'TV, claim resolved');

  // Undo from the toast: back in repair, as the seed left it for the other tests.
  await toastUndo(page).click();
  await expect.poll(async () => (await claims()).map((c) => c.status)).toEqual(['in_repair']);
  await context.close();
});

test('lending part of a quantity: 2 of the 3 HDMI cables lent, returned and merged back', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const home = await locationNamed(page, 'Home');
  const hdmi = await thingNamed(page, home.id, HDMI);
  const quantity = async (id: string) =>
    (await api(page).get<{ quantity: number }>(`/api/v1/things/${id}`)).quantity;
  // The plan says "2 of 5"; the seed's cable box holds 3 of these, and the journey is the same.
  expect(await quantity(hdmi.id)).toBe(3);

  await page.goto(`/t/${hdmi.id}`);
  await expect(page.getByRole('heading', { name: HDMI, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^Lend/ }).click();
  const lend = page.getByRole('dialog', { name: `Lend ${HDMI}` });
  await expect(lend).toBeVisible();
  await lend.getByRole('combobox', { name: 'Lend to' }).fill('Murdock');
  await page
    .getByRole('option', { name: /^Murdock/ })
    .first()
    .click();
  await lend.getByRole('textbox', { name: 'How many' }).fill('2');
  await axe(page, 'Lend sheet');
  await lend.getByRole('button', { name: 'Lend', exact: true }).click();
  await expect(lend).toBeHidden();
  await expect(page.getByText(/^Lent to /).first()).toBeVisible();

  // The two lent are a row of their own, split from the three (D10); one stays home.
  await expect.poll(() => quantity(hdmi.id)).toBe(1);
  const { items } = await api(page).get<{
    items: (Loan & { quantity: string; splitFromThingId: string | null; thing: Located })[];
  }>('/api/v1/loans?state=open&q=HDMI');
  const lent = items.find((l) => l.splitFromThingId === hdmi.id);
  if (!lent) throw new Error('no open loan split from the HDMI cables');
  expect(lent.quantity).toBe('2');

  // Back from Murdock: they merge into the row they came from, which the page then shows.
  await page.goto(`/t/${lent.thing.id}?tab=loans`);
  await expect(page.getByText('On loan', { exact: true })).toBeVisible();
  await axe(page, 'Lent cables, loans');
  await page.getByRole('button', { name: 'Mark returned', exact: true }).click();
  const back = page.getByRole('dialog', { name: /^Back from / });
  await expect(back).toBeVisible();
  await expect(back.getByRole('switch', { name: 'Put them back with the rest' })).toBeChecked();
  await axe(page, 'Return sheet');
  await back.getByRole('button', { name: 'Mark returned', exact: true }).click();
  await expect(back).toBeHidden();
  // The page it lands on is the row they joined (its address may be its short code, 7KQ‑4MZ).
  await expect(page).not.toHaveURL(new RegExp(lent.thing.id));
  await expect(page.getByRole('heading', { name: HDMI, level: 1 })).toBeVisible();
  await expect.poll(() => quantity(hdmi.id)).toBe(3);
  await axe(page, 'HDMI cables, merged back');
  await context.close();
});

type LocationRow = { id: string; name: string; role: string; modules: string[] };

test('lending off in Garage: "Off in this location" on Lend, the overdue loan reminder stops, the nav entry goes only when Lending is off everywhere; back on, the one reminder reopens', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(240_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const garage = await locationNamed(page, 'Garage');
  const pump = await thingNamed(page, garage.id, 'Tyre pump');
  const roller = await thingNamed(page, garage.id, 'Paint roller set');
  const day = today();

  // An overdue loan in the Garage, and its reminder.
  const { loan } = await api(page).post<{ loan: Loan }>(`/api/v1/things/${pump.id}/lend`, {
    person: { name: 'Murdock' },
    startedAt: new Date(`${shift(day, { days: -7 })}T09:00:00+03:00`).toISOString(),
    dueOn: shift(day, { days: -2 }),
  });
  expect(scanNow().occurrences).toBeGreaterThan(0);

  // The sidebar's entry (the phone's bar, hidden at this width, has its own).
  const nav = page.locator('[data-nav="lending"]');
  const shownNav = nav.filter({ visible: true });
  const lendingSwitch = page.getByRole('switch', { name: /^Lending/ });
  const track = async (on: boolean) => {
    await page.goto(`/settings/location/${garage.id}/track`);
    await setSwitch(lendingSwitch, on);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible();
  };

  // Off in the Garage, from What to track.
  await page.goto(`/settings/location/${garage.id}/track`);
  await expect(lendingSwitch).toBeChecked();
  await axe(page, 'What to track, Garage');
  await track(false);

  // Lend on a Garage thing says so, and its sheet says it instead of the form.
  await page.goto(`/t/${roller.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  const item = page.getByRole('menuitem', { name: /^Lend/ });
  await expect(item).toContainText('Off in this location');
  await axe(page, 'Actions with Lending off');
  await item.click();
  const sheet = page.getByRole('dialog', { name: 'Lend Paint roller set' });
  await expect(sheet.getByText('Off in this location')).toBeVisible();
  await expect(sheet.getByRole('combobox', { name: 'Lend to' })).toHaveCount(0);
  await axe(page, 'Lend sheet, Lending off');
  // The footer's Close (the sheet's corner × is named Close too).
  await sheet.getByRole('button', { name: 'Close', exact: true }).first().click();

  // The reminder stops: the scan cancels the open occurrence of a module that is off (§7.13).
  expect(scanNow().closed.cancelled).toBeGreaterThan(0);

  // The nav entry stays while Lending is on in another of Ibrahim's locations (Home), and goes
  // when it is off in every one of them (screens §1). The others are switched through the API.
  await expect(shownNav.first()).toBeVisible();
  const { locations } = await api(page).get<{ locations: LocationRow[] }>('/api/v1/locations');
  const others = locations.filter(
    (l) =>
      l.id !== garage.id && l.modules.includes('lending') && ['owner', 'admin'].includes(l.role),
  );
  expect(others.length, 'every location with Lending on is one Ibrahim can switch').toBe(
    locations.filter((l) => l.id !== garage.id && l.modules.includes('lending')).length,
  );
  const lendingIn = (l: LocationRow, enabled: boolean) =>
    api(page).post(`/api/v1/locations/${l.id}/modules`, { module: 'lending', enabled });
  try {
    for (const l of others) await lendingIn(l, false);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
    await expect(nav).toHaveCount(0);
    await axe(page, 'Home, Lending off everywhere');
  } finally {
    for (const l of others) await lendingIn(l, true);
  }
  await page.goto('/');
  await expect(shownNav.first()).toBeVisible();

  // Back on in the Garage: the same reminder reopens, once, and nothing floods (§7.6).
  await track(true);
  const again = scanNow();
  expect(again.reopened).toBeGreaterThan(0);

  // Leave the pump home for the other tests.
  await sendIfMatch(page, 'POST', `/api/v1/loans/${loan.id}/return`, loan.rowVersion, {});
  await context.close();
});

test("Talia, a viewer: the TV's warranties and claims, and Catan's loan, with no actions and no money; her notification settings list only Membership", async ({
  browser,
}) => {
  // Desktop, after the lending test: that one returns Catan and undoes it, which a test in the
  // other project would race.
  onlyOn('desktop');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'talia@kept.test');
  const home = await locationNamed(page, 'Home');
  const tv = await thingNamed(page, home.id, TV);
  const catan = await thingNamed(page, home.id, CATAN);
  const noActions = async (names: string[]) => {
    for (const action of names) {
      await expect(page.getByRole('button', { name: action, exact: true })).toHaveCount(0);
    }
  };

  await page.goto(`/t/${tv.id}?tab=paperwork`);
  await expect(page.getByRole('heading', { name: TV, level: 1 })).toBeVisible();
  await expect(page.getByText("You're a viewer here", { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Warranties · / })).toBeVisible();
  await expect(page.getByRole('img', { name: /overed from / }).first()).toBeVisible();
  await noActions(['More actions', 'Edit', 'Move', 'Add']);
  await axe(page, 'TV as a viewer, warranties');
  await page.getByRole('tab', { name: /^Claims/ }).click();
  await expect(page.getByText('SSC-48213').first()).toBeVisible();
  await noActions(['New claim', 'Update']);
  await axe(page, 'TV as a viewer, claims');
  // No money: the Value tab says it's hidden, and no amount in EGP shows.
  await page.getByRole('tab', { name: 'Value', exact: true }).click();
  await expect(page.getByText('Hidden in this location').first()).toBeVisible();
  await expect(page.getByText(/EGP\s?[\d,]+/)).toHaveCount(0);
  await axe(page, 'TV as a viewer, value');

  await page.goto(`/t/${catan.id}?tab=loans`);
  await expect(page.getByRole('heading', { name: CATAN, level: 1 })).toBeVisible();
  await expect(page.getByText('On loan', { exact: true })).toBeVisible();
  await expect(page.getByText('Murdock').first()).toBeVisible();
  await noActions(['More actions', 'Mark returned', 'More', 'Lend']);
  await axe(page, 'Catan as a viewer, loans');

  // Me → Notifications: in Home, where she is a viewer, only Membership (Q8).
  await page.goto('/settings/me/notifications');
  const card = page.getByRole('region', { name: 'Home' });
  await expect(card).toBeVisible();
  await expect
    .poll(async () =>
      (await card.getByRole('rowheader').allTextContents()).map((r) => r.replace('Default', '')),
    )
    .toEqual(['Members joining and leaving']);
  await axe(page, 'Notifications settings as a viewer');
  await context.close();
});

test('calendar feed: a link fetched without a session is iCal with the schedules; revoked, it answers 404', async ({
  browser,
}) => {
  onlyOn('phone');
  test.setTimeout(180_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  await page.goto('/settings/me/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await axe(page, 'Notifications settings');

  await page.getByRole('button', { name: 'Create a link', exact: true }).click();
  const shown = page.locator('code').filter({ hasText: '/cal/' });
  await expect(shown).toBeVisible();
  const url = (await shown.textContent())?.trim() ?? '';
  expect(url).toMatch(new RegExp(`^${BASE}/cal/.+\\.ics$`));
  await axe(page, 'Calendar link shown once');

  // Nobody's session: a calendar, with the seed's schedules among its events.
  const anon = await request.newContext();
  const res = await anon.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/calendar');
  const ics = (await res.text()).replace(/\r\n[ \t]/g, '');
  expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
  expect(ics).toContain('BEGIN:VEVENT');
  expect(ics).toContain('Replace the water filter');

  // Revoked from the list: the same link is gone.
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page
    .getByRole('button', { name: /^Revoke the link made / })
    .first()
    .click();
  const confirm = page.getByRole('alertdialog', { name: 'Revoke this calendar link?' });
  await axe(page, 'Revoke the calendar link?');
  await confirm.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true }).first()).toBeVisible();
  expect((await anon.get(url)).status()).toBe(404);
  await anon.dispose();
  await context.close();
});

type NotificationSettingsBody = {
  push: { available: boolean; reason?: string };
  locations: { locationId: string; kinds: Record<string, Record<string, boolean>> }[];
};

test('email and push: Louis turns on warranties by email, the digest reaches Mailpit at his faked digest time; a push delivered to the worker shows its notification', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(240_000);
  const startedAt = new Date(Date.now() - 1000);
  const { context, page } = await person(browser, LOUIS);
  const home = await locationNamed(page, 'Home');
  const alarm = await thingNamed(page, home.id, 'Smoke alarm');

  // Settings → Me → Notifications: warranties in Home, in Kept and by email (a member's default is
  // off, Q8), and the digest at 23:30, after the worker's own passes have run for the day.
  await page.goto('/settings/me/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await axe(page, 'Notifications settings (Louis)');
  const card = page.getByRole('region', { name: 'Home' });
  for (const how of ['In Kept', 'Email']) {
    await setSwitch(
      card.getByRole('switch', { name: `Warranties running out by ${how} in Home` }),
      true,
    );
  }
  await expect
    .poll(async () => {
      const s = await api(page).get<NotificationSettingsBody>('/api/v1/me/notification-settings');
      return s.locations.find((l) => l.locationId === home.id)?.kinds.warranty?.email;
    })
    .toBe(true);
  await page.getByRole('button', { name: /Daily digest/ }).click();
  await page.getByRole('option', { name: '23:30' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible();
  await axe(page, 'Notifications settings, saved');

  // A shop warranty on the smoke alarm that ends in ten days: expiring, so it waits for the digest.
  const provider = `E2E Shop ${Date.now()}`;
  const warranty = await api(page).post<Warranty>(`/api/v1/things/${alarm.id}/warranties`, {
    kind: 'store',
    provider,
    startsOn: shift(today(), { months: -12, days: 10 }),
    termMonths: 12,
  });
  const ends = warranty.effectiveEndsOn ?? '';
  expect(ends > today()).toBe(true);

  try {
    // The scan with email on, and the digest pass a minute before his time: nothing for him yet.
    // Louis confirms his address first (MAIL's KEPT_VERIFY): email goes only to a verified one.
    const day = today();
    const first = mailPass({
      scan: true,
      at: [inZone(day, '23:29')],
      who: LOUIS,
      verify: LOUIS,
    });
    expect(first.scan?.occurrences).toBeGreaterThan(0);
    expect(first.waiting?.verified, "Louis's address is verified").toBe(true);
    expect(first.waiting?.deliveries, JSON.stringify(first.waiting)).toContainEqual({
      kind: 'email',
      status: 'digest',
      error: null,
    });
    expect(await mailTo(LOUIS, startedAt)).toEqual([]);

    // At 23:31 his digest goes, once: the thing, its path, the location and the local date.
    const second = mailPass({ scan: false, at: [inZone(day, '23:31'), inZone(day, '23:46')] });
    expect(second.digests[0]?.sent).toBeGreaterThan(0);
    await expect.poll(async () => (await mailTo(LOUIS, startedAt)).length).toBe(1);
    const [mail] = await mailTo(LOUIS, startedAt);
    if (!mail) throw new Error('no digest for Louis');
    expect(mail.Subject).toMatch(/^Kept: /);
    const text = await mailText(mail.ID);
    const longDay = new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(
      new Date(`${ends}T00:00:00Z`),
    );
    expect(text).toContain(`The warranty on Smoke alarm from ${provider} ends on ${longDay}`);
    expect(text).toContain('Hallway · Home');
    expect(text).toContain(`/t/${alarm.id}`);
  } finally {
    const all = await api(page).get<{ items: Warranty[] }>(`/api/v1/things/${alarm.id}/warranties`);
    const mine = all.items.find((w) => w.id === warranty.id);
    if (mine) await sendIfMatch(page, 'DELETE', `/api/v1/warranties/${mine.id}`, mine.rowVersion);
  }

  // Push. This instance runs on plain http://localhost with no SMTP sender address, so the server
  // has no VAPID subject and Settings offers no Enable (env.ts vapidSubject; pwa/push.ts
  // pushBlocker); Chromium in Playwright has no push service to subscribe to anyway (the spike).
  // What can run: a push delivered to the registered worker over CDP, as the spike did, which
  // must show its notification with the payload's words and link.
  const settings = await api(page).get<NotificationSettingsBody>(
    '/api/v1/me/notification-settings',
  );
  if (!settings.push.available) {
    await expect(
      page.getByText(/^Push (isn't set up on this server|needs HTTPS)\./).first(),
    ).toBeVisible();
  }
  await context.grantPermissions(['notifications'], { origin: BASE });
  const browserCdp = await browser.newBrowserCDPSession();
  await browserCdp.send('Browser.setPermission', {
    permission: { name: 'push', userVisibleOnly: true },
    setting: 'granted',
    origin: BASE,
  });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  const cdp = await context.newCDPSession(page);
  const registered = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
      const ours = e.registrations.find((r) => !r.isDeleted && r.scopeURL.startsWith(BASE));
      if (ours) resolve(ours.registrationId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  const registrationId = await registered;
  const payload = {
    title: 'Warranty ends',
    body: `The warranty on Smoke alarm from ${provider} ends soon`,
    url: `/t/${alarm.id}`,
    tag: `r${alarm.id.replaceAll('-', '')}`,
  };
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: BASE,
    registrationId,
    data: JSON.stringify(payload),
  });
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({
          title: n.title,
          body: n.body,
          tag: n.tag,
          url: (n.data as { url?: string } | null)?.url ?? null,
        })),
      ),
    )
    .toEqual([{ title: payload.title, body: payload.body, tag: payload.tag, url: payload.url }]);
  // Nothing in this CDP version taps a notification: the tap's URL logic is unit-tested
  // (pwa/push-worker.ts clickTarget), and the real tap is on the device checklist.
  await cdp.detach();
  await browserCdp.detach();
  await context.close();
});

test('the insurance report for an incident: the PDF downloads', async ({ browser }) => {
  onlyOn('desktop');
  test.setTimeout(240_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const home = await locationNamed(page, 'Home');
  const { items } = await api(page).get<{
    items: { id: string; insurerReference: string | null }[];
  }>(`/api/v1/incidents?locationId=${home.id}`);
  // The seed's flood in the bathroom, which took the hair dryer.
  const flood = items.find((i) => i.insurerReference === 'HC-2026-0412');
  if (!flood) throw new Error('no seeded incident HC-2026-0412');

  await page.goto(`/incidents/${flood.id}`);
  await expect(page.getByText('HC-2026-0412').first()).toBeVisible();
  await axe(page, 'Incident (flood)');
  await page.getByRole('link', { name: 'Insurance report', exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/insurance/);
  await expect(page.getByRole('heading', { name: 'Insurance report', level: 1 })).toBeVisible();
  await axe(page, 'Insurance report');

  // Where downloads work, the finished PDF downloads by itself (components/reports/progress.tsx).
  const downloaded = page.waitForEvent('download', { timeout: 180_000 });
  await page.getByRole('button', { name: 'Make the PDF', exact: true }).click();
  await expect(page.getByText('Your PDF is ready').first()).toBeVisible({ timeout: 180_000 });
  await axe(page, 'Insurance report, ready');
  const download = await downloaded;
  const file = await download.path();
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // Its text, where poppler's pdftotext is installed (it is on the maintainer's Mac).
  let text: string | null = null;
  try {
    text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (text !== null) expect(text).toContain('Hair dryer');
  await context.close();
});

test('incidents: two things stolen, a claim pack whose link downloads without a session, then revoked (410)', async ({
  browser,
}) => {
  onlyOn('desktop');
  test.setTimeout(240_000);
  const { context, page } = await person(browser, 'ibrahim@kept.test');
  const home = await locationNamed(page, 'Home');
  const tv = await thingNamed(page, home.id, TV);
  const router = await thingNamed(page, home.id, 'Wi-Fi router');
  const incident = await api(page).post<{ id: string }>(`/api/v1/locations/${home.id}/incidents`, {
    kind: 'burglary',
    occurredOn: today(),
    policeReference: 'E2E-4471',
    thingIds: [tv.id, router.id],
    lifecycle: 'stolen',
  });

  await page.goto(`/incidents/${incident.id}`);
  await expect(page.getByText('E2E-4471').first()).toBeVisible();
  await axe(page, 'Incident');
  await page.getByRole('link', { name: 'Claim pack', exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/claim-pack/);
  await axe(page, 'Claim pack');

  // The warning must be accepted before anything is made (D158).
  const make = page.getByRole('button', { name: 'Make the claim pack', exact: true });
  await page.getByText('I understand the link shares prices and documents').click();
  await make.click();
  await expect(page.getByText('Your claim pack is ready').first()).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole('button', { name: 'Create link', exact: true }).click();
  const shown = page.getByRole('region', { name: 'Your link' }).locator('p[dir="ltr"]');
  await expect(shown).toHaveText(/\/x\//);
  const url = (await shown.textContent())?.trim() ?? '';
  await axe(page, 'Claim pack, link made');

  // Nobody's session: the ZIP downloads (and the page counts it).
  const anon = await request.newContext();
  const zip = await anon.get(url);
  expect(zip.status()).toBe(200);
  const bytes = await zip.body();
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

  // Revoked: the same link is refused.
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Revoke the link?' })
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await expect(page.getByText('Link revoked').first()).toBeVisible();
  expect((await anon.get(url)).status()).toBe(410);
  await anon.dispose();
  await context.close();
});
