import { beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { ownerTx } from '../../test/tenancy.js';
import type { AlertDeps } from '../alerts/alerts.js';
import { withSystem } from '../db/scope.js';
import type { Mail } from '../mail/mailer.js';
import { opsGauges } from './metrics.js';
import { BACKUP_METRICS_KEY, DISK_STATUS_KEY, type DiskProbe, runOpsWatch } from './watch.js';

// Step-8 plan T10: the hourly operations watch raises and resolves each alert once, and keeps
// what the status page and /metrics read.

let db: TestDb;
let mail: Mail[];
let alerts: AlertDeps;

const NOW = new Date('2026-10-06T12:00:00Z');
const HOUR = 3_600_000;
const raw = {
  KEPT_DATA_DIR: '/data',
  KEPT_BACKUP_DIR: '/mnt/nas/kept',
  KEPT_BACKUP_PASSWORD: 'a long backup passphrase',
};

beforeEach(async () => {
  db = await testDb();
  await db.reset();
  mail = [];
  alerts = {
    pools: db.pools,
    mailer: {
      send: async (m) => {
        mail.push(m);
      },
    },
  };
});

const probe =
  (data: number, backup: number): DiskProbe =>
  async (dir) => ({
    usedRatio: dir === '/data' ? data : backup,
    freeBytes: 1024 ** 3,
  });

async function run(kind: string, status: string, finishedHoursAgo: number, extra = '') {
  await ownerTx(db, (c) =>
    c.query(
      `INSERT INTO public.backup_runs (kind, status, started_at, finished_at, storage_mode, target ${extra ? ', bucket_versioning_ok' : ''})
       VALUES ($1, $2, $3, $3, $4, 'directory /mnt/nas/kept' ${extra ? `, ${extra}` : ''})`,
      [kind, status, new Date(NOW.getTime() - finishedHoursAgo * HOUR), extra ? 's3' : 'local'],
    ),
  );
}

const openAlerts = () =>
  withSystem(db.pools.system, async (_tx, c) => {
    const { rows } = await c.query<{ dedupe_key: string }>(
      'SELECT dedupe_key FROM public.admin_alerts WHERE resolved_at IS NULL ORDER BY dedupe_key',
    );
    return rows.map((r) => r.dedupe_key);
  });

describe('runOpsWatch', () => {
  it('raises disk_space_low per volume at 85 % and resolves it when it clears', async () => {
    const first = await runOpsWatch({
      alerts,
      ownerUrl: db.urls.owner,
      raw,
      probe: probe(0.9, 0.5),
      now: NOW,
    });
    expect(first.raised).toContain('disk_space_low:data');
    expect(first.raised).not.toContain('disk_space_low:backup');
    expect(mail.some((m) => m.kind === 'admin-alert')).toBe(false); // no instance admin yet
    const second = await runOpsWatch({
      alerts,
      ownerUrl: db.urls.owner,
      raw,
      probe: probe(0.5, 0.86),
      now: NOW,
    });
    expect(second.resolved).toContain('disk_space_low:data');
    expect(second.raised).toContain('disk_space_low:backup');
    const stored = await withSystem(db.pools.system, async (_tx, c) => {
      const { rows } = await c.query<{ value: { data: { usedRatio: number } } }>(
        'SELECT value FROM public.instance_settings WHERE key = $1',
        [DISK_STATUS_KEY],
      );
      return rows[0]?.value;
    });
    expect(stored?.data.usedRatio).toBe(0.5);
  });

  it('backup_stale after 36 hours without a good backup, restore_drill_due after 30 days', async () => {
    await run('nightly', 'ok', 40);
    const stale = await runOpsWatch({
      alerts,
      ownerUrl: db.urls.owner,
      raw,
      probe: probe(0.1, 0.1),
      now: NOW,
    });
    expect(stale.raised).toEqual(['backup_stale']);
    await run('nightly', 'ok', 2);
    const fresh = await runOpsWatch({
      alerts,
      ownerUrl: db.urls.owner,
      raw,
      probe: probe(0.1, 0.1),
      now: NOW,
    });
    expect(fresh.resolved).toEqual(['backup_stale']);
    expect(fresh.raised).toEqual([]);

    await run('nightly', 'ok', 31 * 24);
    const due = await runOpsWatch({
      alerts,
      ownerUrl: db.urls.owner,
      raw,
      probe: probe(0.1, 0.1),
      now: NOW,
    });
    expect(due.raised).toEqual(['restore_drill_due']);
    await run('drill', 'ok', 1);
    const drilled = await runOpsWatch({
      alerts,
      ownerUrl: db.urls.owner,
      raw,
      probe: probe(0.1, 0.1),
      now: NOW,
    });
    expect(drilled.resolved).toEqual(['restore_drill_due']);
    expect(await openAlerts()).toEqual([]);
  });

  it('nothing about backups without a target, and bucket_versioning_off with S3 storage', async () => {
    await run('nightly', 'failed', 100);
    const none = await runOpsWatch({
      alerts,
      ownerUrl: db.urls.owner,
      raw: { KEPT_DATA_DIR: '/data' },
      probe: probe(0.1, 0.1),
      now: NOW,
    });
    expect(none.raised).toEqual([]);
    await run('nightly', 'ok', 1, 'false');
    const s3 = await runOpsWatch({
      alerts,
      ownerUrl: db.urls.owner,
      raw: {
        ...raw,
        KEPT_STORAGE: 's3',
        KEPT_S3_BUCKET: 'files',
        KEPT_S3_ACCESS_KEY_ID: 'id',
        KEPT_S3_SECRET_ACCESS_KEY: 'secret-value',
      },
      probe: probe(0.1, 0.1),
      now: NOW,
    });
    expect(s3.raised).toEqual(['bucket_versioning_off']);
    expect(s3.disk.data).toBeNull();
  });

  it('feeds the /metrics gauges', async () => {
    await run('nightly', 'ok', 3);
    await run('manual', 'failed', 1);
    await runOpsWatch({ alerts, ownerUrl: db.urls.owner, raw, probe: probe(0.42, 0.5), now: NOW });
    const gauges = new Map((await opsGauges(db.pools.system)).map((g) => [g.name, g.samples]));
    expect(gauges.get('kept_backup_last_success_timestamp_seconds')).toEqual([
      ['', Math.floor((NOW.getTime() - 3 * HOUR) / 1000)],
    ]);
    expect(gauges.get('kept_backup_last_run_status')).toEqual([
      ['{status="ok"}', 0],
      ['{status="warning"}', 0],
      ['{status="failed"}', 1],
    ]);
    expect(gauges.get('kept_disk_used_ratio')).toEqual([
      ['{volume="data"}', 0.42],
      ['{volume="backup"}', 0.5],
    ]);
    expect(gauges.get('kept_update_available')).toEqual([['', 0]]);
    const metrics = await withSystem(db.pools.system, async (_tx, c) => {
      const { rows } = await c.query('SELECT value FROM public.instance_settings WHERE key = $1', [
        BACKUP_METRICS_KEY,
      ]);
      return rows[0]?.value;
    });
    expect(JSON.stringify(metrics)).not.toContain('/mnt');
  });
});
