import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import { KEPT_VERSION, newId } from '@kept/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type RouteOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { meRoutes } from '../accounts/me.js';
import { signUpRoutes } from '../accounts/sign-up.js';
import { adminRoutes } from '../admin/routes.js';
import type { AiDeps } from '../ai/routes.js';
import type { Auth } from '../auth/auth.js';
import { emailChangeRoutes } from '../auth/email-change.js';
import {
  authMode,
  authRoutes,
  csrfHook,
  type SessionHookOptions,
  sessionHook,
} from '../auth/http.js';
import { meSessionRoutes } from '../auth/me.js';
import type { Env } from '../config/env.js';
import type { SecretKeys } from '../crypto/keyring.js';
import type { Pools } from '../db/pools.js';
import { inviteRoutes } from '../invites/routes.js';
import type { JobAdmin } from '../jobs/failed.js';
import type { JobQueue } from '../jobs/queue.js';
import { memberRoutes } from '../locations/members.js';
import { locationRoutes } from '../locations/routes.js';
import { logMailer, type Mailer } from '../mail/mailer.js';
import { managedRoutes } from '../managed/routes.js';
import type { NotifyDeps } from '../notify/channels.js';
import {
  errorReportingActive,
  reportError,
  startErrorReporting,
  stopErrorReporting,
} from '../observability/errors.js';
import { activeTracing } from '../observability/state.js';
import { setupRoutes } from '../setup/routes.js';
import { derivativeKey, type FileStorage } from '../storage/blob-store.js';
import { TOKEN_SECURITY_SCHEMES, tokenSecurityTransform } from '../tokens/openapi.js';
import { bearerHook } from '../tokens/verify.js';
import { LIBRARY_STYLE_HASHES } from './csp-styles.js';
import { toErrorReply } from './errors.js';
import { type BuildInfo, healthRoutes } from './health.js';
import { dbModuleLoader, type ModuleLoader, modulePreHandler } from './modules.js';
import { registerInventoryRoutes } from './routes.js';
import { shareGuard, shareRoutes } from './share.js';
import { spaFallback, type WebBundle, webRoutes } from './web.js';

// The HTTP skeleton (engineering spec §7.6, §7.7; D81, D147, D181).
//
// buildApp() assembles everything that is the same for every route: the zod type provider,
// request ids, security headers, the one error shape, module gating, health and the OpenAPI
// document. Routes are added by the caller (or by later tasks, registered below), always after
// buildApp() resolves, so they inherit all of it.

/** The environment the HTTP layer reads. Env satisfies it; tests pass a plain object. */
export type AppEnv = Pick<Env, 'KEPT_PUBLIC_URL'> &
  Partial<
    Pick<
      Env,
      | 'KEPT_METRICS_TOKEN'
      | 'KEPT_SOURCE_URL'
      | 'KEPT_TRUSTED_PROXIES'
      | 'KEPT_SIGNUP_OPEN'
      | 'KEPT_BARCODE_LOOKUP'
      | 'KEPT_BARCODE_CONTACT'
      | 'KEPT_UPDATE_CHECK'
      | 'KEPT_ERROR_DSN'
    >
  >;

export type AppOptions = {
  env: AppEnv;
  pools: Pools;
  /** A pino logger from createLogger() (http/logger.ts). Omit for a silent app (tests). */
  logger?: FastifyBaseLogger;
  build?: BuildInfo;
  /** The third-party notices file (http/health.ts); defaults to the image's
   * /app/THIRD-PARTY-NOTICES.txt, found from this module (dist/http/ → /app). Null: none. */
  noticesPath?: string | null;
  /** Resolves a location's effective modules; defaults to reading the database. */
  moduleLoader?: ModuleLoader;
  /** The built web bundle to serve (http/web.ts, loadWebBundle). Omit for an API-only app. */
  web?: WebBundle | null;
  /** Better Auth (auth/auth.ts), mounted at /api/v1/auth/*. Without it no request has a
   * session, so every 'required' route answers 401 (tests of the bare skeleton). */
  auth?: Auth | null;
  /** Outgoing mail for Kept's own flows (email change). Defaults to logging that it is due. */
  mailer?: Mailer;
  /** Called for every request that got a scope: ensureAccount's cached check (task 18). */
  onScope?: SessionHookOptions['onScope'];
  /** Where requests enqueue jobs inside their own transaction (jobs/queue.ts). Without one, a
   * job a route would send is logged as not sent (tests of routes that don't need it). */
  jobs?: JobQueue | null;
  /** Failed-job administration for the instance admin (jobs/failed.ts). */
  jobAdmin?: JobAdmin | null;
  /** Whether mail goes out (KEPT_SMTP_URL set), for the admin status page. Default false. */
  mailConfigured?: boolean;
  /** Whether a backup target is set (KEPT_BACKUP_DIR or KEPT_BACKUP_S3_BUCKET), for the status
   * page's backup line (T31c). Default false. */
  backupConfigured?: boolean;
  /** Whether anyone may sign up without an invite. Defaults to KEPT_SIGNUP_OPEN when it is set,
   * else instance_settings `signup_open` (accounts/sign-up.ts readSignupOpen), which instance
   * admins set through PUT /api/v1/admin/settings (task 23). */
  isSignupOpen?: () => Promise<boolean>;
  /** File storage for step 2's file routes (storage/). Omit for an app that serves no files. */
  files?: FileStorage | null;
  /** The keyring for secret values (crypto/keyring.ts). Omit for an app that stores none. */
  secretKeys?: SecretKeys | null;
  /** Step 3's AI layer (ai/routes.ts). Omit for an app without AI (the routes say no provider). */
  ai?: AiDeps | null;
  /** The key that signs sync cursors (sync/cursor.ts syncCursorKey); omit for a key of the
   * app's own (tests). */
  syncKey?: Buffer | null;
  /** Called for every route as it is added, before any other hook (the route-catalogue test). */
  onRoute?: (route: RouteOptions) => void;
  /** The key personal tokens' secrets are HMAC'd with (tokens/verify.ts tokenHashKey of
   * KEPT_AUTH_SECRET, step 6); omit for a key of the app's own (tests). */
  tokenKey?: Buffer | null;
  /** Step 4 (T15): web push's setup (notify/vapid.ts createPushSource), and in tests how a push
   * or a webhook leaves the process. Omitted: push reports unavailable. */
  notify?: Pick<NotifyDeps, 'push' | 'transport'> | null;
};

export type KeptApp = FastifyInstance<
  import('node:http').Server,
  import('node:http').IncomingMessage,
  import('node:http').ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

declare module 'fastify' {
  interface FastifyInstance {
    pools: Pools;
    env: AppEnv;
  }
}

export const OPENAPI_PATH = '/api/v1/openapi.json';

/**
 * The origin the browser loads files from, when it isn't ours: S3's presigned URLs (D157). It is
 * read off a URL the store actually signs, so it is right for a public endpoint, a path-style
 * endpoint, a virtual-hosted bucket or AWS itself, without re-deriving the SDK's rules. Local
 * storage serves `/f/<token>` from this origin: null.
 */
export async function fileOrigin(
  files: FileStorage | null,
  publicUrl: string,
): Promise<string | null> {
  if (!files) return null;
  const sample = await files.blobs.signedUrl(
    derivativeKey('00000000-0000-0000-0000-000000000000', 'thumb'),
    { expiresIn: 60, disposition: 'inline', filename: 'x.jpg', contentType: 'image/jpeg' },
  );
  const origin = new URL(sample, publicUrl).origin;
  return origin === new URL(publicUrl).origin ? null : origin;
}

export async function buildApp(opts: AppOptions): Promise<KeptApp> {
  const https = new URL(opts.env.KEPT_PUBLIC_URL).protocol === 'https:';
  const build = opts.build ?? { version: KEPT_VERSION, revision: null };

  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : {}),
    // Our ids, never the client's: a caller-chosen request id would let it forge log lines.
    genReqId: () => newId(),
    // Proxies are resolved per use from KEPT_TRUSTED_PROXIES (auth/client-ip.ts), not here.
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();

  if (opts.onRoute) {
    const onRoute = opts.onRoute;
    app.addHook('onRoute', (route) => onRoute(route as RouteOptions));
  }

  // Step 8 (T14, D84): optional tracing's route spans, first, when the preload started it; and
  // optional error reporting, loaded only with KEPT_ERROR_DSN. Both off by default.
  const tracing = activeTracing();
  if (tracing) await app.register(tracing.fastifyPlugin());
  if (opts.env.KEPT_ERROR_DSN && !errorReportingActive()) {
    await startErrorReporting({ dsn: opts.env.KEPT_ERROR_DSN, release: build.version });
  }
  app.addHook('onClose', async () => {
    await stopErrorReporting();
    await tracing?.shutdown();
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('pools', opts.pools);
  app.decorate('env', opts.env);
  app.decorateRequest('scope', null);
  app.decorateRequest('authSession', null);
  app.decorateRequest('token', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // A share-target POST the service worker didn't catch: redirected before the CSRF check and
  // before its body is read (http/share.ts).
  app.addHook('onRequest', shareGuard);

  // A cookie-bearing write from another site is refused before anything else (auth/http.ts).
  app.addHook('onRequest', csrfHook(opts.env.KEPT_PUBLIC_URL));

  // A personal token (`Authorization: Bearer kpt_…`, step 6): its scope, or 401/403/429, before
  // the session hook, which then leaves the request alone (tokens/verify.ts).
  const tokenKey = opts.tokenKey ?? randomBytes(32);
  app.addHook('onRequest', bearerHook({ pools: opts.pools, key: tokenKey, authMode }));

  // Who is calling (auth/http.ts): sets req.scope before body parsing, validation and module
  // gating, so an anonymous request to a protected route never gets past a 401.
  const trustedProxies = opts.env.KEPT_TRUSTED_PROXIES ?? [];
  const auth = opts.auth ?? null;
  app.addHook(
    'onRequest',
    sessionHook({
      auth,
      pools: opts.pools,
      trustedProxies,
      ...(opts.onScope ? { onScope: opts.onScope } : {}),
    }),
  );

  const filesFrom = await fileOrigin(opts.files ?? null, opts.env.KEPT_PUBLIC_URL);
  await app.register(helmet, {
    // CSP `self`: fonts and icons ship in the image (D188, L77); no framing anywhere (D181).
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // The barcode scanner's zxing wasm is compiled by WebAssembly.instantiateStreaming, which
        // needs 'wasm-unsafe-eval' (and only that: no 'unsafe-eval', T0's scanner spike). With the
        // web bundle, index.html's inline pre-paint script is allowed by hash only.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", ...(opts.web?.scriptHashes ?? [])],
        // Stylesheets from 'self', and React Aria's two static injected <style> elements by hash
        // (csp-styles.ts). No 'unsafe-inline'; style attributes stay blocked.
        styleSrc: ["'self'", ...LIBRARY_STYLE_HASHES],
        // The service worker (/sw.js, D181).
        workerSrc: ["'self'"],
        // Camera frames, phone-made thumbnails and label PNGs are blob: URLs (T25, T28); files
        // on S3 come from the store's own origin (presigned, D157).
        imgSrc: ["'self'", 'blob:', ...(filesFrom ? [filesFrom] : [])],
        mediaSrc: ["'self'", 'blob:', ...(filesFrom ? [filesFrom] : [])],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // HSTS only when the public URL is https (D181, D193): over plain HTTP it would lock
    // browsers out of an instance that has no certificate.
    strictTransportSecurity: https ? { maxAge: 31_536_000, includeSubDomains: false } : false,
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Kept API', version: build.version },
      // Step 6 (D60, D63): a personal token is an HTTP bearer; each route open to tokens says so
      // in its `security` (tokens/access.ts).
      components: { securitySchemes: TOKEN_SECURITY_SCHEMES },
    },
    transform: tokenSecurityTransform(jsonSchemaTransform),
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorReply(err);
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      reportError(err, { requestId: req.id, route: req.routeOptions?.url ?? null });
    } else req.log.info({ code: body.code, status }, 'request refused');
    return reply.code(status).send(body);
  });

  const web = opts.web ?? null;
  app.setNotFoundHandler((req, reply) => {
    // A client-side route (GET, not /api or /assets) gets the SPA; everything else the JSON 404.
    if (web && spaFallback(web, req, reply)) return reply;
    const { status, body } = toErrorReply({ statusCode: 404 });
    return reply.code(status).send(body);
  });

  app.addHook('preHandler', modulePreHandler(opts.moduleLoader ?? dbModuleLoader(opts.pools)));

  await app.register(healthRoutes, {
    pools: opts.pools,
    build,
    sourceUrl: opts.env.KEPT_SOURCE_URL ?? null,
    metricsToken: opts.env.KEPT_METRICS_TOKEN,
    noticesPath:
      opts.noticesPath === undefined
        ? fileURLToPath(new URL('../../../../THIRD-PARTY-NOTICES.txt', import.meta.url))
        : opts.noticesPath,
  });

  app.get(OPENAPI_PATH, { schema: { hide: true }, config: { auth: 'none' } }, async () =>
    app.swagger(),
  );

  if (web) await webRoutes(app, web);
  await shareRoutes(app);

  await meSessionRoutes(app, { pools: opts.pools });
  await meRoutes(app, { pools: opts.pools });
  await locationRoutes(app, { pools: opts.pools });
  await memberRoutes(app, { pools: opts.pools });
  // Step 2's inventory (http/routes.ts): places, things, registries, files, search, trash, home.
  await registerInventoryRoutes(app, {
    pools: opts.pools,
    env: opts.env,
    log: app.log,
    jobs: opts.jobs ?? null,
    files: opts.files ?? null,
    secretKeys: opts.secretKeys ?? null,
    ai: opts.ai ?? null,
    syncKey: opts.syncKey ?? null,
    tokenKey,
    auth,
    notify: {
      push: opts.notify?.push ?? null,
      mailer: opts.mailer ?? logMailer(app.log),
      mailConfigured: opts.mailConfigured ?? false,
      ...(opts.notify?.transport ? { transport: opts.notify.transport } : {}),
    },
  });
  if (auth) {
    const publicUrl = opts.env.KEPT_PUBLIC_URL;
    const mailer = opts.mailer ?? logMailer(app.log);
    const jobs = opts.jobs ?? null;
    await authRoutes(app, { auth, pools: opts.pools, publicUrl, trustedProxies });
    await emailChangeRoutes(app, {
      auth,
      pools: opts.pools,
      mailer,
      publicUrl,
      trustedProxies,
      onMailError: (err) => app.log.error({ err }, 'mail failed'),
    });
    const envSignup = opts.env.KEPT_SIGNUP_OPEN;
    const isSignupOpen =
      opts.isSignupOpen ?? (envSignup === undefined ? undefined : async () => envSignup);
    const people = {
      auth,
      pools: opts.pools,
      jobs,
      mailer,
      trustedProxies,
      log: app.log,
      ...(isSignupOpen ? { isSignupOpen } : {}),
    };
    await signUpRoutes(app, people);
    await inviteRoutes(app, { ...people, publicUrl });
    await managedRoutes(app, { auth, pools: opts.pools, jobs, trustedProxies });
    await setupRoutes(app, { auth, pools: opts.pools, trustedProxies, log: app.log });
    await adminRoutes(app, {
      pools: opts.pools,
      mailer,
      env: opts.env,
      jobs: opts.jobAdmin ?? null,
      version: build.version,
      mailConfigured: opts.mailConfigured ?? false,
      backupConfigured: opts.backupConfigured ?? false,
    });
  }

  return app;
}
