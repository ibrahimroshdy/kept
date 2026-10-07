import type pg from 'pg';
import { withSystem } from '../db/scope.js';
import { UPDATE_CHECK_STATE_KEY } from '../updates/check.js';
import { BACKUP_METRICS_KEY, type BackupMetrics, DISK_STATUS_KEY, diskStatusOf } from './watch.js';

// Step 8's Prometheus gauges (plan T10; D66, D166), served by /metrics (http/health.ts, behind
// its bearer token). Read on kept_system from what the hourly `ops-watch` and the update check
// keep in instance_settings, so a scrape never touches backup_runs (the owner's), a disk or
// GitHub. The backup's figures are therefore up to an hour old, well inside the 36-hour stale
// threshold an alert rule would use. No label holds a path or a target.

export type OpsGauge = { name: string; help: string; samples: [string, number][] };

const STATUSES = ['ok', 'warning', 'failed'] as const;

export async function opsGauges(system: pg.Pool): Promise<OpsGauge[]> {
  const rows = await withSystem(system, async (_tx, client) => {
    const res = await client.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM public.instance_settings WHERE key = ANY($1::text[])',
      [[BACKUP_METRICS_KEY, DISK_STATUS_KEY, UPDATE_CHECK_STATE_KEY]],
    );
    return new Map(res.rows.map((r) => [r.key, r.value]));
  });
  const backup = (rows.get(BACKUP_METRICS_KEY) ?? null) as Partial<BackupMetrics> | null;
  const lastSuccess =
    typeof backup?.lastSuccessAt === 'string' ? Date.parse(backup.lastSuccessAt) : Number.NaN;
  const disk = diskStatusOf(rows.get(DISK_STATUS_KEY));
  const update = rows.get(UPDATE_CHECK_STATE_KEY) as { latest?: unknown } | undefined;
  const volumes = (['data', 'backup'] as const).filter((v) => disk[v] !== null);
  return [
    {
      name: 'kept_backup_last_success_timestamp_seconds',
      help: 'When the last good backup finished (Unix seconds); 0 before the first.',
      samples: [['', Number.isNaN(lastSuccess) ? 0 : Math.floor(lastSuccess / 1000)]],
    },
    {
      name: 'kept_backup_last_run_status',
      help: 'The status of the last finished backup run: 1 for its status, 0 for the others.',
      samples: STATUSES.map((s) => [`{status="${s}"}`, backup?.lastStatus === s ? 1 : 0]),
    },
    {
      name: 'kept_disk_used_ratio',
      help: 'How full the data volume and a directory backup target are (0 to 1).',
      samples: volumes.map((v) => [`{volume="${v}"}`, disk[v]?.usedRatio ?? 0]),
    },
    {
      name: 'kept_update_available',
      help: 'Whether the opt-in update check found a newer release (1) or not (0).',
      samples: [['', update?.latest ? 1 : 0]],
    },
  ];
}
