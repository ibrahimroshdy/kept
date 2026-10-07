import path from 'node:path';
import { KEPT_VERSION } from '@kept/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { accountEnsurer } from './accounts/ensure-account.js';
import { configureBackupRoutes } from './admin/backup-routes.js';
import { aiNoticeHooks } from './ai/notices.js';
import { createAiDeps } from './ai/routes.js';
import { allowPrivateAddresses } from './ai/runtime.js';
import { createAuth } from './auth/auth.js';
import { bootOidc, oidcConfigOf } from './auth/oidc.js';
import { resticOf } from './backup/config.js';
import { pgTools } from './backup/pg-tools.js';
import { readableCopy } from './backup/readable/run.js';
import { openRepo } from './backup/restic/repo.js';
import { isEntrypoint } from './cli/index.js';
import { backupTargetSet, type Env, EnvError, loadEnv } from './config/env.js';
import { secretKeysOf } from './crypto/keyring.js';
import { retryAtBoot } from './db/boot-retry.js';
import { closePools, createPools, type Pools } from './db/pools.js';
import { bootReleaseGuard } from './db/release-guard.js';
import { withSystem } from './db/scope.js';
import { mirrorEmbeddingsSource } from './embeddings/provider.js';
import { buildApp, type KeptApp } from './http/app.js';
import type { BuildInfo } from './http/health.js';
import { createLogger } from './http/logger.js';
import { loadWebBundle } from './http/web.js';
import { createBoss, registerJobs, sendInTx, sendTenantJob } from './jobs/boss.js';
import { jobAdmin } from './jobs/failed.js';
import { startWorkerHeartbeat } from './jobs/liveness.js';
import { bossQueue, createRequestQueues } from './jobs/queue.js';
import { nightlyBackupTime, systemJobs } from './jobs/system.js';
import { authMail } from './mail/mailer.js';
import { createMailer, defaultFrom, profileLocaleLookup } from './mail/transport.js';
import { guardedFetch } from './net/ssrf.js';
import { checkConfigNotices, smtpFacts } from './notices/transparency.js';
import { createChannelSenders } from './notify/senders.js';
import { createPushSource } from './notify/vapid.js';
import { packageRoot } from './package-root.js';
import { ensureSetupCode, setupCodeLine } from './setup/setup-code.js';
import { createFileStorage } from './storage/create.js';
import { syncCursorKey } from './sync/cursor.js';
import { tokenHashKey } from './tokens/verify.js';
import { setWebhookFanout } from './webhooks/fanout.js';

// The server process (engineering spec §7.11, D81): one image, `KEPT_ROLE` = web · worker · all.
//
// Migrations are not run here: the one-shot `kept migrate` job does that, as kept_owner, before
// the serving process starts (§7.12, §7.14). This process holds the owner login only when a
// backup target is set (T31c): the nightly backup dumps as kept_owner, on its own connection per
// run, never in a pool and never for a request.

/** The port when KEPT_PORT doesn't say (step-1 carry-over, step-8 T13). */
export const PORT = 8080;

/** Where the built web bundle sits relative to this package, in the repo and in the image
 * (/app/apps/server → /app/apps/web/dist). Absent in dev, where Vite serves the web. */
export const DEFAULT_WEB_ROOT = path.join(packageRoot(import.meta.url), '..', 'web', 'dist');

export type StartOptions = {
  logger?: FastifyBaseLogger;
  /** 0 picks a free port (tests). Default: KEPT_PORT (8080). */
  port?: number;
  host?: string;
  build?: BuildInfo;
  /** The built web bundle to serve; null serves the API only. Defaults to DEFAULT_WEB_ROOT,
   * served only when it holds an index.html. */
  webRoot?: string | null;
  /** Where the setup code line goes. Defaults to stdout, so it is in `docker logs`. */
  print?: (line: string) => void;
  /**
   * KEPT_AI_MOCK only: the mock's answers file (ai/mock.ts `loadMockAnswers`, keyed by the sent
   * image's hash) instead of T11's evaluation fixtures. The e2e run's receipts (apps/web/e2e/
   * serve.mjs). Ignored without the mock.
   */
  aiMockAnswersFile?: string;
  /**
   * The most connections each database pool, and pg-boss's own, may open (default 10 each).
   * The e2e run starts nine servers on one Postgres (apps/web/e2e/serve.mjs) and passes 3: at
   * the defaults, pg-boss alone held 88 of max_connections' 100 with every server idle (T32).
   */
  poolMax?: number;
};

export type RunningKept = {
  app: KeptApp | null;
  boss: PgBoss | null;
  /** The process's database pools (tests reach a connection through them). */
  pools: Pools;
  /** The bound address when serving HTTP. */
  address: string | null;
  stop: () => Promise<void>;
};

export async function startKept(env: Env, opts: StartOptions = {}): Promise<RunningKept> {
  const logger = opts.logger ?? createLogger(env);
  const pools = createPools(env, {
    ...(opts.poolMax !== undefined ? { max: opts.poolMax } : {}),
    onError: (err, pool, inUse) =>
      logger.warn(
        { err, pool },
        inUse ? 'database connection lost while in use' : 'idle database connection failed',
      ),
  });
  const serves = env.KEPT_ROLE === 'web' || env.KEPT_ROLE === 'all';
  const works = env.KEPT_ROLE === 'worker' || env.KEPT_ROLE === 'all';

  let app: KeptApp | null = null;
  let boss: PgBoss | null = null;
  let address: string | null = null;
  // SMTP when KEPT_SMTP_URL is set (mail/transport.ts), each mail in its recipient's language;
  // otherwise mail is logged as due and the admin status page says mail isn't configured.
  const mail = createMailer(env, { localeOf: profileLocaleLookup(pools.system), logger });

  let stopHeartbeat: (() => void) | null = null;
  const stop = async () => {
    // Stop taking requests and let in-flight ones finish, then let running jobs finish, then
    // close the pools both were using.
    stopHeartbeat?.();
    await app?.close();
    setWebhookFanout(null);
    await boss?.stop({ graceful: true, timeout: 30_000 });
    mail.close();
    await closePools(pools);
  };

  try {
    // Step 8 (T8, Q9): the downgrade guard, before anything runs on the database. A database
    // more than one recorded release ahead stops the start (downgrade_refused) unless
    // KEPT_ALLOW_DOWNGRADE=1; one release ahead logs the rollback; this release's last_booted_at
    // is stamped.
    // The first contact with the database waits for it (db/boot-retry.ts, T24): a Postgres that
    // is still starting or too loaded to connect in time is retried for about two minutes.
    await retryAtBoot(
      'release guard',
      () =>
        withSystem(pools.system, (_tx, client) =>
          bootReleaseGuard(client, {
            imageVersion: opts.build?.version ?? KEPT_VERSION,
            allowDowngrade: env.KEPT_ALLOW_DOWNGRADE,
            log: logger,
          }),
        ),
      { log: logger },
    );
    // A worker runs the jobs; a web-only process still needs an instance to send from (requests
    // enqueue inside their own transaction, jobs/queue.ts), without maintenance or cron. Task 24
    // completes the registry.
    // pg-boss gives up on a connection after 10 s; under load that ended the start (T24). A
    // failed start is stopped and a fresh instance tried again, as the release guard is.
    boss = await retryAtBoot(
      'job queue',
      async () => {
        const started = createBoss({
          connectionString: env.KEPT_SYSTEM_DATABASE_URL,
          supervise: works,
          schedule: works,
          ...(opts.poolMax !== undefined ? { max: opts.poolMax } : {}),
        });
        started.on('error', (err) => logger.error({ err }, 'pg-boss error'));
        try {
          await started.start();
          await createRequestQueues(started);
          return started;
        } catch (err) {
          await started.stop({ graceful: false }).catch(() => {});
          throw err;
        }
      },
      { log: logger },
    );
    // Step 6 (T14, D207): KEPT_EMBEDDINGS becomes the stored source; the admin's switch changes it
    // until the next boot.
    await mirrorEmbeddingsSource(pools, env.KEPT_EMBEDDINGS);
    // Step 6 (T15, Q18): audited() sends a write's webhook fan-out on the write's transaction.
    setWebhookFanout(bossQueue(boss).send);
    const mailer = mail.mailer;
    // File storage (T17, T18): the blob store KEPT_STORAGE names (the S3 bucket is created when
    // missing, so a bad store fails the start), the /f/<token> signer, and the upload limits. The
    // web serves files with it; the worker's purge deletes blobs with it (T21), and without it
    // would skip purging deleted locations and unattached files.
    const files = await createFileStorage(env);
    // The AI provider layer on the database (ai/runtime.ts): the extraction job's (T10) and the
    // AI routes'. KEPT_AI_MOCK answers every model call from the mock (refused in production).
    const secretKeys = secretKeysOf(env);
    // Its hooks queue the cap and rejected-key notices (ai/notices.ts, T9).
    const ai = createAiDeps({
      pools,
      keyring: () => secretKeys.get().keyring,
      log: logger,
      mock: env.KEPT_AI_MOCK,
      ...(opts.aiMockAnswersFile ? { mockAnswersFile: opts.aiMockAnswersFile } : {}),
      ...aiNoticeHooks(pools, bossQueue(boss), logger),
    });
    // Web push's VAPID keys (step 4, T15, Q11): the environment's, else the stored pair, else a
    // new one made under an advisory lock. The web makes it at boot; a worker on first send.
    const push = createPushSource(pools.system, env, () => secretKeys.get(), logger);
    if (works) {
      await registerJobs(
        boss,
        systemJobs({
          pools,
          log: logger,
          mailer,
          publicUrl: env.KEPT_PUBLIC_URL,
          files,
          ai,
          sendTenant: async (client, name, data, options) => {
            await sendTenantJob(boss as PgBoss, client, name, data, options);
          },
          // Step 4 (T14): the reminder scan's deliveries, sent in the transaction that writes them.
          send: async (client, name, data, options) => {
            await sendInTx(boss as PgBoss, client, name, data, options ?? {});
          },
          // Step 4 (T15): the email, web-push and webhook senders; email only when mail goes out.
          channels: createChannelSenders({
            pools,
            mailer: mail.configured ? mailer : null,
            push,
            keyring: () => secretKeys.get().keyring,
            publicUrl: env.KEPT_PUBLIC_URL,
            enqueue: async (name, data) => {
              await (boss as PgBoss).send(name, data);
            },
          }),
          secretKeys,
          // Step 8 (T11, D65): the opt-in update check asks about KEPT_SOURCE_URL's repository.
          updates: { sourceUrl: env.KEPT_SOURCE_URL ?? null, updateCheck: env.KEPT_UPDATE_CHECK },
          // Step 8 (T5): restic snapshots; the settings are read at each run, over process.env.
          backup: {
            // KEPT_BACKUP_TIME if set, else the time saved in Admin → Backups (a save later
            // reschedules at once, admin/backup-routes.ts).
            time: await nightlyBackupTime(env.KEPT_OWNER_DATABASE_URL ?? null, process.env, (err) =>
              logger.warn({ err }, 'backup: the saved nightly time was not read'),
            ),
            ownerUrl: env.KEPT_OWNER_DATABASE_URL ?? null,
            storage: env.KEPT_STORAGE,
            dataDir: env.KEPT_DATA_DIR,
            pgTools: pgTools(),
            restic: resticOf(env, (line, command) =>
              logger.warn({ restic: command }, `restic: ${line.slice(0, 300)}`),
            ),
            rawEnv: process.env,
            // T6 (D159): every location's readable copy, as its owner sees it, in each snapshot.
            readable: env.KEPT_OWNER_DATABASE_URL
              ? readableCopy({
                  ownerUrl: env.KEPT_OWNER_DATABASE_URL,
                  pools,
                  files,
                  storage: env.KEPT_STORAGE,
                  publicUrl: env.KEPT_PUBLIC_URL,
                  log: logger,
                })
              : null,
          },
        }),
        { pools },
      );
      // Step 8 (T13): a worker-only process serves no /readyz; its liveness is a heartbeat file
      // the image's healthcheck reads (jobs/liveness.ts, docker/healthcheck.mjs).
      if (env.KEPT_ROLE === 'worker') {
        stopHeartbeat = startWorkerHeartbeat(boss, {
          onError: (err) => logger.warn({ err }, 'worker heartbeat not written'),
        });
      }
    }
    if (serves) {
      // The first-run setup code (§7.10, §7.14): made as kept_system under an advisory lock,
      // before listening, and printed only by the process that stored it.
      const code = await ensureSetupCode(pools.system, { preset: env.KEPT_SETUP_CODE });
      if (code) (opts.print ?? ((line) => process.stdout.write(`${line}\n`)))(setupCodeLine(code));
      // The VAPID pair exists before anyone subscribes (T15). Push trouble never stops the web.
      await push().catch((err: unknown) => logger.error({ err }, 'web push keys unavailable'));
      const webRoot = opts.webRoot === undefined ? DEFAULT_WEB_ROOT : opts.webRoot;
      const web = webRoot ? await loadWebBundle(webRoot) : null;
      // ensureAccount() from the sign-up hook and, cached, on every signed-in request (task 18).
      const accounts = accountEnsurer(pools);
      // Step 6 (T16, Q16): generic OIDC, discovered once at boot through the SSRF guard. A failed
      // discovery leaves it off until a restart; Admin → Status says why (auth/oidc.ts).
      const oidc = await bootOidc({
        env,
        app: pools.app,
        fetch: guardedFetch({ allowPrivate: await allowPrivateAddresses(pools) }),
        log: logger,
      });
      // D180 (T16, Q16, Q24): a changed OIDC or SMTP configuration is told to every active user,
      // once, whichever replica boots first (notices/transparency.ts).
      await checkConfigNotices({
        pools,
        send: async (client, name, data) => {
          await sendInTx(boss as PgBoss, client, name, data);
        },
        oidc: oidcConfigOf(env),
        smtp: smtpFacts(env.KEPT_SMTP_URL, env.KEPT_SMTP_FROM ?? defaultFrom(env.KEPT_PUBLIC_URL)),
      }).catch((err: unknown) => logger.error({ err }, 'configuration notices failed'));
      const auth = createAuth({
        oidc,
        pool: pools.auth,
        env,
        mail: authMail(mailer),
        onUserCreated: accounts.onUserCreated,
        enrolmentNeedsVerifiedEmail: mail.configured,
        onBackgroundError: (err, what) =>
          logger.error({ err, what }, 'auth background task failed'),
      });
      // Step 8 (T10): Admin → Backups' Test and snapshot list reach restic through this engine;
      // the settings' locks are read from process.env (backup/settings.ts).
      configureBackupRoutes({
        engine: {
          restic: resticOf(env),
          open: (settings) =>
            openRepo(settings.target, settings.password, {
              tmpDir: path.join(env.KEPT_DATA_DIR, 'tmp'),
            }),
        },
      });
      app = await buildApp({
        env,
        pools,
        logger,
        build: opts.build ?? { version: KEPT_VERSION, revision: process.env.KEPT_REVISION ?? null },
        web,
        auth,
        mailer,
        onScope: accounts.onScope,
        jobs: bossQueue(boss),
        jobAdmin: jobAdmin(boss, pools.system),
        mailConfigured: mail.configured,
        backupConfigured: backupTargetSet(env),
        files,
        secretKeys,
        ai,
        syncKey: syncCursorKey(env.authSecret),
        tokenKey: tokenHashKey(env.authSecret),
        notify: { push },
      });
      address = await app.listen({
        port: opts.port ?? env.KEPT_PORT ?? PORT,
        host: opts.host ?? '0.0.0.0',
      });
    }
  } catch (err) {
    await stop().catch(() => {});
    throw err;
  }
  logger.info({ role: env.KEPT_ROLE, address }, 'kept started');
  return { app, boss, pools, address, stop };
}

// Only when this file is the process entrypoint (`node dist/main.js`, `tsx src/main.ts`).
if (isEntrypoint(import.meta.url)) {
  try {
    const env = await loadEnv(process.env, { logger: (line) => console.log(line) });
    const running = await startKept(env);
    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) return;
      stopping = true;
      running.app?.log.info({ signal }, 'shutting down');
      running.stop().then(
        () => process.exit(0),
        (err: unknown) => {
          console.error(err);
          process.exit(1);
        },
      );
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error(err instanceof EnvError ? `kept: ${err.message}` : err);
    process.exit(1);
  }
}
