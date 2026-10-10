/**
 * End-to-end tests against the real server (plan task 28): the built server and web bundle, on
 * scratch databases migrated for the run (e2e/serve.mjs). Nothing is mocked.
 *
 *   pnpm --filter '@kept/server...' build && pnpm --filter @kept/web build
 *   pnpm --filter @kept/web e2e
 *
 * Needs the dev Postgres (compose.dev.yaml on 5452) and a browser: the installed Google Chrome
 * (the `chrome` channel) when there is one, else Playwright's bundled Chromium
 * (`pnpm --filter @kept/web exec playwright install chromium`), which is also what runs in CI
 * (`CI` set). scripts/ci-local.sh's e2e step does all of it, and installs Chromium only when
 * Chrome isn't there.
 *
 * Two projects, phone (375×780) and desktop (1280×800). Each runs the step-1 flow on its own
 * fresh instance, because first-run setup happens once per instance, and the sign-in tests on its
 * own seeded instance (e2e/instances.ts).
 *
 * Step 3 (T32): Chromium runs with a fake camera playing e2e/fixtures/camera-thing.y4m
 * (e2e/camera.ts), and step3.spec.ts runs on the `capture` instance, whose AI is the mock.
 * KEPT_E2E_INSTANCES=capture (a comma list of instance keys) starts only those servers: the full
 * list is nine, and under load they didn't all start within the old 120 s.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { CAPTURE_INSTANCE, fakeCameraArgs } from './e2e/camera';
import {
  ASSISTANT_INSTANCE,
  INSTANCES,
  type Instance,
  OPERATIONS_INSTANCE,
  PORTABILITY_INSTANCE,
  urlOf,
  VEHICLES_INSTANCE,
} from './e2e/instances';

/**
 * Whether Google Chrome is installed where Playwright's `chrome` channel looks for it (the paths
 * in playwright-core's browser registry). scripts/ci-local.sh checks the same places.
 */
function chromeInstalled(): boolean {
  if (process.platform === 'darwin')
    return existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  if (process.platform === 'linux') return existsSync('/opt/google/chrome/chrome');
  if (process.platform === 'win32') {
    const drive = process.env.HOMEDRIVE;
    return [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      drive ? `${drive}\\Program Files` : undefined,
      drive ? `${drive}\\Program Files (x86)` : undefined,
    ].some((dir) => !!dir && existsSync(path.join(dir, 'Google\\Chrome\\Application\\chrome.exe')));
  }
  return false;
}

/**
 * The installed Chrome outside CI; elsewhere Playwright's bundled Chromium through the `chromium`
 * channel: the real browser in its new headless mode, not the default headless shell, which
 * lacks features the push spec needs (notifications from a service worker; Playwright's
 * "Browsers" guide, read 2026-10-09).
 */
const browser =
  !process.env.CI && chromeInstalled() ? { channel: 'chrome' } : { channel: 'chromium' };

type Served = Instance & { aiMock?: boolean; https?: boolean; owner?: boolean };

/** Every instance, by key: step 1–2's, step 3's capture instance, step 5's vehicles and steps
 * 6–8's three behind HTTPS. */
const ALL: Record<string, Served> = {
  ...INSTANCES,
  capture: CAPTURE_INSTANCE,
  vehicles: VEHICLES_INSTANCE,
  assistant: ASSISTANT_INSTANCE,
  portability: PORTABILITY_INSTANCE,
  operations: OPERATIONS_INSTANCE,
};

/** The instances to start: all, or those KEPT_E2E_INSTANCES names (e.g. `capture`). */
function selected(): Served[] {
  const only = (process.env.KEPT_E2E_INSTANCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (only.length === 0) return Object.values(ALL);
  const unknown = only.filter((k) => !(k in ALL));
  if (unknown.length > 0) throw new Error(`KEPT_E2E_INSTANCES: no instance ${unknown.join(', ')}`);
  return only.map((k) => ALL[k] as Served);
}

const server = (i: Served) => ({
  command: `node --conditions=kept-dist e2e/serve.mjs ${i.name} ${i.port}${i.seed ? ' --seed' : ''}${i.aiMock ? ' --ai-mock' : ''}${i.https ? ' --https' : ''}${i.owner ? ' --owner' : ''}`,
  url: `${urlOf(i)}/readyz`,
  // The --https instances' certificate is self-signed, made for the run.
  ignoreHTTPSErrors: !!i.https,
  // A server already on the port would not be this run's fresh database: fail instead.
  reuseExistingServer: false,
  // Each migrates and seeds a database of its own; several at once under load took over 120 s.
  timeout: 300_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  // SIGTERM, so serve.mjs stops the server and drops its database.
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 15_000 },
});

export default defineConfig({
  testDir: './e2e',
  outputDir: '../../.tmp/e2e/results',
  fullyParallel: false,
  forbidOnly: true,
  // One retry on CI's shared runners (Playwright's own recommendation): a transient stall
  // fails the shard once and passes on retry, reported as flaky rather than red. Local runs
  // stay at zero so a flake is still caught here.
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The server's time zone header (x-kept-timezone) and Accept-Language come from these.
    timezoneId: 'Africa/Cairo',
    locale: 'en-GB',
  },
  projects: [
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        ...browser,
        viewport: { width: 375, height: 780 },
        isMobile: true,
        hasTouch: true,
        baseURL: urlOf(INSTANCES.phone),
        launchOptions: { args: fakeCameraArgs() },
      },
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        ...browser,
        viewport: { width: 1280, height: 800 },
        baseURL: urlOf(INSTANCES.desktop),
        launchOptions: { args: fakeCameraArgs() },
      },
    },
  ],
  webServer: selected().map(server),
});
