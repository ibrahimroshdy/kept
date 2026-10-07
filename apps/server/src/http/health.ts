import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { opsGauges } from '../backup/metrics.js';
import type { Pools } from '../db/pools.js';
import { unauthenticated } from './errors.js';

// Liveness, readiness, version (D147) and metrics (D181). None of these needs a session.

export type BuildInfo = {
  version: string;
  /** The commit the image was built from; stamped by the image build (task 29). */
  revision: string | null;
};

export type HealthOptions = {
  pools: Pools;
  build: BuildInfo;
  sourceUrl: string | null;
  /** When set, `/metrics` is served and requires `Authorization: Bearer <token>`. */
  metricsToken?: string | undefined;
  /** The image's third-party notices (D151; /app/THIRD-PARTY-NOTICES.txt, scripts/
   * third-party-notices.mjs). Served at `/notices.txt` and named by `/version` when the file is
   * there at boot; a development tree has none. */
  noticesPath?: string | null | undefined;
};

/** Where `/version` says the notices are, when they are served. */
export const NOTICES_PATH = '/notices.txt';

const digest = (value: string) => createHash('sha256').update(value).digest();

function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  // Compared as fixed-length digests, so neither the length nor the prefix leaks by timing.
  return !!match && timingSafeEqual(digest(match[1] as string), digest(token));
}

function gauge(name: string, help: string, samples: [string, number][]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
  return lines.join('\n');
}

const label = (value: string) => value.replace(/["\\\n]/g, '_');

export async function healthRoutes(app: FastifyInstance, opts: HealthOptions): Promise<void> {
  // Public: probes and the build line need no session (/metrics has its own bearer token).
  const hide = { schema: { hide: true }, config: { auth: 'none' as const } };

  app.get('/healthz', hide, async () => ({ ok: true }));

  app.get('/readyz', hide, async (req, reply) => {
    const checks = await Promise.allSettled([
      opts.pools.app.query('SELECT 1'),
      opts.pools.system.query('SELECT 1'),
    ]);
    const [appOk, systemOk] = checks.map((c) => c.status === 'fulfilled');
    if (appOk && systemOk) return { ok: true };
    req.log.warn({ app: appOk, system: systemOk }, 'readiness check failed');
    return reply.code(503).send({ ok: false, app: appOk, system: systemOk });
  });

  const notices = opts.noticesPath && existsSync(opts.noticesPath) ? opts.noticesPath : null;

  app.get('/version', hide, async () => ({
    version: opts.build.version,
    revision: opts.build.revision,
    source: opts.sourceUrl,
    // The version footer's "Third-party notices" link (D151), when the image carries them.
    notices: notices ? NOTICES_PATH : null,
  }));

  if (notices) {
    app.get(NOTICES_PATH, hide, async (_req, reply) =>
      reply
        .type('text/plain; charset=utf-8')
        .header('cache-control', 'public, max-age=3600')
        .send(createReadStream(notices)),
    );
  }

  const token = opts.metricsToken;
  if (!token) return;
  app.get('/metrics', hide, async (req, reply) => {
    if (!bearerMatches(req.headers.authorization, token)) throw unauthenticated();
    const pools = Object.entries(opts.pools) as [string, Pools[keyof Pools]][];
    const text = [
      gauge('kept_build_info', 'Build of the running Kept.', [
        [
          `{version="${label(opts.build.version)}",revision="${label(opts.build.revision ?? '')}"}`,
          1,
        ],
      ]),
      gauge('kept_process_uptime_seconds', 'Seconds since the process started.', [
        ['', Math.round(process.uptime())],
      ]),
      gauge('kept_process_resident_memory_bytes', 'Resident set size.', [
        ['', process.memoryUsage().rss],
      ]),
      gauge(
        'kept_db_pool_connections',
        'Connections per database pool, by state.',
        pools.flatMap(([name, pool]) => [
          [`{pool="${name}",state="total"}`, pool.totalCount],
          [`{pool="${name}",state="idle"}`, pool.idleCount],
          [`{pool="${name}",state="waiting"}`, pool.waitingCount],
        ]),
      ),
      // Step 8 (T10): the backup's age and status, the disks, the update check. A database that
      // can't answer leaves them out; the scrape itself still succeeds.
      ...(
        await opsGauges(opts.pools.system).catch((err: unknown) => {
          req.log.warn({ err }, 'metrics: operations gauges unavailable');
          return [];
        })
      ).map((g) => gauge(g.name, g.help, g.samples)),
    ].join('\n');
    return reply.type('text/plain; version=0.0.4').send(`${text}\n`);
  });
}
