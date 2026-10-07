import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from '../test/db.js';
import { own } from '../test/things.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './http/logger.js';
import { startKept } from './main.js';

// Task 16: KEPT_ROLE decides what the process runs (§7.11).

const db = await testDb();
let configDir: string;

beforeAll(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'kept-main-'));
});
afterAll(async () => {
  await rm(configDir, { recursive: true, force: true });
});

const envFor = (role: string) =>
  loadEnv(
    {
      KEPT_DATABASE_URL: db.urls.app,
      KEPT_AUTH_DATABASE_URL: db.urls.auth,
      KEPT_SYSTEM_DATABASE_URL: db.urls.system,
      KEPT_PUBLIC_URL: 'http://kept.test',
      KEPT_ROLE: role,
      KEPT_LOG_LEVEL: 'silent',
    },
    { configDir },
  );

const silent = () => createLogger({ KEPT_LOG_LEVEL: 'silent', KEPT_LOG_FORMAT: 'json' });

describe('startKept()', () => {
  it('web: serves HTTP, sends jobs, and runs no worker or schedule', async () => {
    const kept = await startKept(await envFor('web'), {
      port: 0,
      host: '127.0.0.1',
      logger: silent(),
    });
    try {
      // A send-only instance: the request queues exist, nothing is scheduled.
      expect(kept.boss).not.toBeNull();
      expect(await kept.boss?.getSchedules()).toEqual([]);
      expect(await kept.boss?.getQueue('notify-owner-new-member')).toEqual(
        expect.objectContaining({ name: 'notify-owner-new-member' }),
      );
      const res = await fetch(`${kept.address}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await kept.stop();
    }
  });

  it('web: listens on KEPT_PORT (step-8 T13)', async () => {
    // A port that was free a moment ago.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const env = await loadEnv(
      {
        KEPT_DATABASE_URL: db.urls.app,
        KEPT_AUTH_DATABASE_URL: db.urls.auth,
        KEPT_SYSTEM_DATABASE_URL: db.urls.system,
        KEPT_PUBLIC_URL: 'http://kept.test',
        KEPT_ROLE: 'web',
        KEPT_LOG_LEVEL: 'silent',
        KEPT_PORT: String(port),
      },
      { configDir },
    );
    const kept = await startKept(env, { host: '127.0.0.1', logger: silent() });
    try {
      expect(kept.address).toBe(`http://127.0.0.1:${port}`);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    } finally {
      await kept.stop();
    }
  });

  it('worker: starts pg-boss as kept_system and serves no HTTP', async () => {
    const kept = await startKept(await envFor('worker'), { logger: silent() });
    try {
      expect(kept.app).toBeNull();
      expect(kept.address).toBeNull();
      expect(kept.boss).not.toBeNull();
      // Started: sending to a queue works through its pool.
      await kept.boss?.createQueue('main-test');
      expect(await kept.boss?.send('main-test', {})).toEqual(expect.any(String));
    } finally {
      await kept.stop();
    }
  });

  it('worker: gives the purge job file storage, so it purges blobs instead of skipping them', async () => {
    const lines: { msg?: string }[] = [];
    const logger = createLogger(
      { KEPT_LOG_LEVEL: 'info', KEPT_LOG_FORMAT: 'json' },
      { write: (line: string) => void lines.push(JSON.parse(line)) },
    );
    const env = await loadEnv(
      {
        KEPT_DATABASE_URL: db.urls.app,
        KEPT_AUTH_DATABASE_URL: db.urls.auth,
        KEPT_SYSTEM_DATABASE_URL: db.urls.system,
        KEPT_PUBLIC_URL: 'http://kept.test',
        KEPT_ROLE: 'worker',
        KEPT_LOG_LEVEL: 'info',
        KEPT_DATA_DIR: configDir,
      },
      { configDir },
    );
    const kept = await startKept(env, { logger });
    try {
      const id = await kept.boss?.send('purge', {});
      expect(id).toEqual(expect.any(String));
      let state: string | undefined;
      for (let i = 0; i < 60 && state !== 'completed' && state !== 'failed'; i++) {
        state = (await kept.boss?.getJobById('purge', id as string))?.state;
        if (state !== 'completed') await new Promise((r) => setTimeout(r, 250));
      }
      expect(state).toBe('completed');
      const messages = lines.map((l) => l.msg);
      expect(messages).toContain('purge done');
      expect(messages.filter((m) => m?.includes('no file storage configured'))).toEqual([]);
    } finally {
      await kept.stop();
    }
  });

  it('poolMax caps every pool and pg-boss (the e2e run starts nine servers on one Postgres)', async () => {
    const kept = await startKept(await envFor('all'), {
      port: 0,
      host: '127.0.0.1',
      logger: silent(),
      poolMax: 2,
    });
    try {
      // Twenty readiness checks at once want twenty app and system connections each.
      const codes = await Promise.all(
        Array.from({ length: 20 }, async () => (await fetch(`${kept.address}/readyz`)).status),
      );
      expect(codes.every((c) => c === 200)).toBe(true);
      const rows = await own<{ name: string; n: number }>(
        db,
        `SELECT application_name AS name, count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND application_name LIKE 'kept-%'
          GROUP BY 1 ORDER BY 1`,
      );
      expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(['kept-app', 'kept-jobs']));
      for (const r of rows) expect(r.n, r.name).toBeLessThanOrEqual(2);
    } finally {
      await kept.stop();
    }
  });

  it('all: both', async () => {
    const kept = await startKept(await envFor('all'), {
      port: 0,
      host: '127.0.0.1',
      logger: silent(),
    });
    try {
      expect(kept.boss).not.toBeNull();
      expect((await fetch(`${kept.address}/readyz`)).status).toBe(200);
    } finally {
      await kept.stop();
    }
  });
});
