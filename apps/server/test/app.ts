import type { LightMyRequestResponse } from 'fastify';
import type { AuthDeps } from '../src/auth/auth.js';
import type { Pools } from '../src/db/pools.js';
import { buildApp, type KeptApp } from '../src/http/app.js';
import type { Mail } from '../src/mail/mailer.js';
import { cookieHeader, PUBLIC_URL, type TestAuth, testAuth } from './auth.js';
import type { TestDb } from './db.js';

// The whole HTTP app with Better Auth mounted, on the worker's database, for tests that go
// through the front door (app.inject) the way a browser would.

export type TestApp = {
  app: KeptApp;
  auth: TestAuth;
  /** Kept's own mail (email change), in order. Better Auth's is on `auth.mails` / `auth.resets`. */
  mail: Mail[];
  publicUrl: string;
};

export type TestAppOptions = {
  publicUrl?: string;
  rateLimitEnabled?: boolean;
  onScope?: Parameters<typeof buildApp>[0]['onScope'];
  onUserCreated?: AuthDeps['onUserCreated'];
  jobs?: Parameters<typeof buildApp>[0]['jobs'];
  jobAdmin?: Parameters<typeof buildApp>[0]['jobAdmin'];
  /** Whether mail goes out: the status page says so, and D197's enrolment gate applies. */
  mailConfigured?: boolean;
  /** Whether a backup target is set, for the status page's backup line (T31c). */
  backupConfigured?: boolean;
  isSignupOpen?: Parameters<typeof buildApp>[0]['isSignupOpen'];
  /** KEPT_SIGNUP_OPEN, as the environment would set it. */
  signupOpenEnv?: boolean;
  /** Adds routes before the app is readied. */
  routes?: (app: KeptApp) => void | Promise<void>;
  /** Sees every route as it is added (the route-catalogue test). */
  onRoute?: Parameters<typeof buildApp>[0]['onRoute'];
  /** File storage for the file routes (T17); omitted, they answer 503. */
  files?: Parameters<typeof buildApp>[0]['files'];
  /** The keyring for the secret routes (T19); omitted, they answer 503. */
  secretKeys?: Parameters<typeof buildApp>[0]['secretKeys'];
  /** Step 3's AI layer (ai/routes.ts AiDeps); omitted, the AI routes answer as with no layer. */
  ai?: Parameters<typeof buildApp>[0]['ai'];
  /** A pino logger (http/logger.ts createLogger) to capture what the app logs; default silent. */
  logger?: Parameters<typeof buildApp>[0]['logger'];
  /** Step 4 (T15): web push's setup and the test transports (notify/). */
  notify?: Parameters<typeof buildApp>[0]['notify'];
  /** Step 6 (T12): the OAuth provider for MCP connectors (oauth/plugin.ts); off when omitted. */
  oauth?: AuthDeps['oauth'];
};

export async function testApp(db: TestDb, opts: TestAppOptions = {}): Promise<TestApp> {
  const publicUrl = opts.publicUrl ?? PUBLIC_URL;
  const auth = testAuth(db, {
    env: { KEPT_PUBLIC_URL: publicUrl } as AuthDeps['env'],
    ...(opts.rateLimitEnabled !== undefined ? { rateLimitEnabled: opts.rateLimitEnabled } : {}),
    ...(opts.onUserCreated ? { onUserCreated: opts.onUserCreated } : {}),
    ...(opts.mailConfigured ? { enrolmentNeedsVerifiedEmail: true } : {}),
    ...(opts.oauth ? { oauth: opts.oauth } : {}),
  });
  const mail: Mail[] = [];
  const app = await buildApp({
    env: {
      KEPT_PUBLIC_URL: publicUrl,
      KEPT_TRUSTED_PROXIES: [],
      ...(opts.signupOpenEnv !== undefined ? { KEPT_SIGNUP_OPEN: opts.signupOpenEnv } : {}),
    },
    pools: db.pools as Pools,
    auth,
    mailer: {
      send: async (m) => {
        mail.push(m);
      },
    },
    ...(opts.onScope ? { onScope: opts.onScope } : {}),
    ...(opts.jobs ? { jobs: opts.jobs } : {}),
    ...(opts.jobAdmin ? { jobAdmin: opts.jobAdmin } : {}),
    ...(opts.mailConfigured !== undefined ? { mailConfigured: opts.mailConfigured } : {}),
    ...(opts.backupConfigured !== undefined ? { backupConfigured: opts.backupConfigured } : {}),
    ...(opts.isSignupOpen ? { isSignupOpen: opts.isSignupOpen } : {}),
    ...(opts.onRoute ? { onRoute: opts.onRoute } : {}),
    ...(opts.files ? { files: opts.files } : {}),
    ...(opts.secretKeys ? { secretKeys: opts.secretKeys } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.ai ? { ai: opts.ai } : {}),
    ...(opts.notify ? { notify: opts.notify } : {}),
  });
  await opts.routes?.(app);
  await app.ready();
  return { app, auth, mail, publicUrl };
}

/** The Set-Cookie lines of an injected response. */
export function setCookies(res: LightMyRequestResponse): string[] {
  const raw = res.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** The Cookie header a browser would send after this response. */
export function jar(res: LightMyRequestResponse, previous = ''): string {
  const headers = new Headers();
  for (const line of setCookies(res)) headers.append('set-cookie', line);
  return cookieHeader(headers, previous);
}

/** The #fragment token of a mailed link. */
export function fragmentToken(url: string): string {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('token') ?? '';
}
