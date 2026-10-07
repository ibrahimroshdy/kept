/**
 * The step-8 half of the mock server's state: the backup settings, runs and snapshots, the status
 * page's step-8 fields, the recovery kit, the update check, and this device. Kept beside the
 * MockState (a WeakMap), not in it, so the shared fixtures don't change; `ops(state)` seeds it on
 * first use, with the `s3` scenario.
 *
 * Fixtures (step-8 plan T3):
 * - `s3` (the default): an S3-compatible backup with 9 runs, one `warning` (a suspiciously small
 *   dump, `backup_suspicious_size`) and one `failed` (`unreachable`); S3 file storage with bucket
 *   versioning off; the drill 41 days old; the data disk at 88 %; Kept 1.3.0 available; a recovery
 *   kit downloaded before the backup settings last changed (stale);
 * - `dir_same_disk`: a directory target on the data's own disk, its last run `ok`;
 * - `unconfigured`: no target, no password, nothing run;
 * - this device: the app lock on with a passkey, and Home kept offline.
 *
 * `serveStatus` is on since T21 moved the status page onto `OpsAdminStatus`: `GET /admin/status`
 * answers step 1's fields with `opsStatus(state)` over them. Off, it answers step 1's shape alone,
 * as a server whose database didn't answer does.
 */
import { BACKUP_KEEP_DEFAULT, BACKUP_STALE_HOURS } from '@kept/shared';
import { INV_IDS } from '../../inventory/mock/fixtures';
import { IDS, type MockState } from '../../mock/fixtures';
import type {
  AdminOpsStatus,
  BackupRun,
  BackupSettingsView,
  BackupSnapshot,
  DeviceState,
  RecoveryKitState,
  SyncExtra,
  UpdateCheckState,
} from '../types';

export const OPS_SCENARIOS = ['s3', 'dir_same_disk', 'unconfigured'] as const;
export type OpsScenario = (typeof OPS_SCENARIOS)[number];

export type OpsState = {
  scenario: OpsScenario;
  settings: BackupSettingsView;
  runs: BackupRun[];
  snapshots: BackupSnapshot[];
  status: AdminOpsStatus;
  kit: RecoveryKitState;
  updates: UpdateCheckState;
  device: DeviceState;
  /** Home's extras, for `GET /sync/extras`. */
  extras: SyncExtra[];
  /** Whether KEPT_PUBLIC_URL is https; false makes the writes answer 403 `https_required`. */
  https: boolean;
  /** Whether `GET /admin/status` answers with the step-8 fields (on since T21). */
  serveStatus: boolean;
};

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const hex = (n: number, len = 64) => n.toString(16).padStart(len, '0');

/** Stable ids for the fixtures, for tests and the demo. */
export const OPS_IDS = {
  run: (n: number) => `01926f00-0000-7000-8000-0000000e8${String(n).padStart(3, '0')}`,
  latestVersion: '1.3.0',
} as const;

const S3_TARGET_TEXT = 'S3 bucket kept-backups at s3.example.org';
const DIR_TARGET_TEXT = 'directory /mnt/backup/kept';

function run(
  n: number,
  startedAgo: number,
  over: Partial<BackupRun> & Pick<BackupRun, 'kind' | 'status'>,
  target: string,
  storageMode: 'local' | 's3',
): BackupRun {
  const started = Date.now() - startedAgo;
  const finished = over.status === 'running' ? null : new Date(started + 6 * 60_000).toISOString();
  return {
    id: OPS_IDS.run(n),
    startedAt: new Date(started).toISOString(),
    finishedAt: finished,
    storageMode,
    target,
    snapshotId: over.status === 'failed' ? null : hex(n * 7919),
    dbBytes: 41_943_040,
    bytesAdded: 6_291_456,
    bytesTotal: 2_254_857_830,
    filesTotal: 1_204,
    filesNew: 9,
    missing: 0,
    readableLocations: 4,
    readableBytes: 188_743_680,
    sameVolume: storageMode === 'local' ? false : null,
    bucketVersioningOk: storageMode === 's3' ? false : null,
    fromVersion: null,
    toVersion: null,
    verifiedAt: null,
    error: null,
    detail: {},
    ...over,
  };
}

function s3Runs(): BackupRun[] {
  const r = (n: number, at: number, o: Partial<BackupRun> & Pick<BackupRun, 'kind' | 'status'>) =>
    run(n, at, o, S3_TARGET_TEXT, 's3');
  return [
    r(9, 4 * HOUR, { kind: 'manual', status: 'ok', filesNew: 2, bytesAdded: 1_048_576 }),
    r(8, 1 * DAY + 2 * HOUR, {
      kind: 'nightly',
      status: 'warning',
      error: 'backup_suspicious_size',
      dbBytes: 9_437_184,
      bytesAdded: 524_288,
      detail: { smallerTables: ['things', 'attachments'] },
    }),
    r(7, 2 * DAY + 2 * HOUR, {
      kind: 'nightly',
      status: 'failed',
      error: 'unreachable',
      dbBytes: null,
      bytesAdded: null,
      bytesTotal: null,
      filesTotal: null,
      filesNew: null,
      readableLocations: null,
      readableBytes: null,
    }),
    r(6, 3 * DAY + 2 * HOUR, { kind: 'nightly', status: 'ok' }),
    r(5, 4 * DAY + 2 * HOUR, { kind: 'nightly', status: 'ok', filesNew: 31 }),
    r(4, 5 * DAY + 2 * HOUR, { kind: 'verify', status: 'ok', verifiedAt: ago(5 * DAY) }),
    r(3, 6 * DAY + 2 * HOUR, {
      kind: 'pre_upgrade',
      status: 'ok',
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      readableLocations: null,
      readableBytes: null,
    }),
    r(2, 7 * DAY + 2 * HOUR, { kind: 'nightly', status: 'ok' }),
    r(1, 41 * DAY, { kind: 'drill', status: 'ok', verifiedAt: ago(41 * DAY) }),
  ];
}

function snapshotsOf(runs: BackupRun[]): BackupSnapshot[] {
  return runs
    .filter((r) => r.snapshotId && r.kind !== 'drill' && r.kind !== 'verify')
    .map((r) => ({
      id: r.snapshotId as string,
      time: r.startedAt,
      kind: r.kind,
      version: r.kind === 'pre_upgrade' ? r.fromVersion : '1.2.0',
      tags: ['kept', r.kind, `v${r.kind === 'pre_upgrade' ? r.fromVersion : '1.2.0'}`],
    }));
}

const locked = <T>(value: T, isLocked = false) => ({ value, locked: isLocked });

function settingsOf(scenario: OpsScenario): BackupSettingsView {
  const keep = {
    daily: locked(BACKUP_KEEP_DEFAULT.daily),
    weekly: locked(BACKUP_KEEP_DEFAULT.weekly),
    monthly: locked(BACKUP_KEEP_DEFAULT.monthly),
  };
  if (scenario === 'unconfigured') {
    return {
      configured: false,
      target: locked(null),
      passwordSet: locked(false),
      time: locked('02:30'),
      keep,
      version: 1,
    };
  }
  if (scenario === 'dir_same_disk') {
    // Set by the environment (KEPT_BACKUP_DIR, KEPT_BACKUP_PASSWORD): locked, read-only.
    return {
      configured: true,
      target: locked({ kind: 'dir', path: '/mnt/backup/kept' }, true),
      passwordSet: locked(true, true),
      time: locked('02:30'),
      keep,
      version: 3,
    };
  }
  return {
    configured: true,
    target: locked({
      kind: 's3',
      endpoint: 'https://s3.example.org',
      region: 'eu-central-1',
      bucket: 'kept-backups',
      prefix: 'kept-backups/',
      forcePathStyle: false,
      accessKeyId: 'KEPTEXAMPLEKEYID',
      secretAccessKeySet: true,
    }),
    passwordSet: locked(true),
    time: locked('02:30'),
    keep,
    version: 7,
  };
}

function updatesOf(): UpdateCheckState {
  return {
    enabled: true,
    locked: false,
    lastCheckedAt: ago(5 * HOUR),
    latest: {
      version: OPS_IDS.latestVersion,
      url: `https://example.org/kept/releases/${OPS_IDS.latestVersion}`,
      publishedAt: ago(3 * DAY),
    },
    error: null,
  };
}

function statusOf(
  scenario: OpsScenario,
  runs: BackupRun[],
  snapshots: BackupSnapshot[],
  kit: RecoveryKitState,
  updates: UpdateCheckState,
  version: MockState['version'],
): AdminOpsStatus {
  const last = runs.find((r) => r.kind === 'nightly' || r.kind === 'manual') ?? null;
  const lastOk =
    runs.find((r) => (r.kind === 'nightly' || r.kind === 'manual') && r.status === 'ok') ?? null;
  const drill = runs.find((r) => r.kind === 'drill') ?? null;
  const verify = runs.find((r) => r.kind === 'verify') ?? null;
  const configured = scenario !== 'unconfigured';
  return {
    release: {
      version: version.version,
      revision: version.revision ?? null,
      sourceUrl: version.source ?? null,
      lastMigration: '0083_import_history_doors',
      rolledBackFrom: null,
    },
    backup: {
      configured,
      locked: scenario === 'dir_same_disk',
      target:
        scenario === 's3' ? S3_TARGET_TEXT : scenario === 'dir_same_disk' ? DIR_TARGET_TEXT : null,
      storageMode: scenario === 's3' ? 's3' : 'local',
      last,
      lastOk,
      stale: false,
      snapshots: configured ? snapshots.length : null,
      repositoryBytes: configured ? 2_254_857_830 : null,
      readableBytes: configured ? 188_743_680 : null,
      sameVolume: scenario === 'dir_same_disk' ? true : scenario === 's3' ? null : null,
      bucketVersioning: scenario === 's3' ? 'off' : 'not_applicable',
      lastDrillAt: drill?.startedAt ?? null,
      drillDue: configured && (!drill || Date.now() - Date.parse(drill.startedAt) > 30 * DAY),
      lastVerifyAt: verify?.startedAt ?? null,
      upgradeWithoutSnapshot: null,
    },
    recoveryKit: {
      acknowledgedAt: kit.acknowledgedAt,
      downloadedAt: kit.downloadedAt,
      stale: kit.stale,
    },
    disk: {
      data: { usedRatio: 0.88, freeBytes: 12_884_901_888 },
      backup: scenario === 'dir_same_disk' ? { usedRatio: 0.88, freeBytes: 12_884_901_888 } : null,
    },
    updates,
    jobs: { failedLastDay: scenario === 's3' ? 2 : 0 },
    https: true,
  };
}

function seed(state: MockState, scenario: OpsScenario): OpsState {
  const runs =
    scenario === 's3'
      ? s3Runs()
      : scenario === 'dir_same_disk'
        ? [
            run(
              21,
              3 * HOUR,
              { kind: 'nightly', status: 'ok', sameVolume: true },
              DIR_TARGET_TEXT,
              'local',
            ),
            run(
              20,
              1 * DAY + 3 * HOUR,
              { kind: 'nightly', status: 'ok', sameVolume: true },
              DIR_TARGET_TEXT,
              'local',
            ),
          ]
        : [];
  const snapshots = snapshotsOf(runs);
  const kit: RecoveryKitState = {
    acknowledgedAt: ago(60 * DAY),
    downloadedAt: scenario === 's3' ? ago(20 * DAY) : null,
    stale: scenario === 's3',
  };
  const updates = updatesOf();
  return {
    scenario,
    settings: settingsOf(scenario),
    runs,
    snapshots,
    status: statusOf(scenario, runs, snapshots, kit, updates, state.version),
    kit,
    updates,
    device: {
      appLock: {
        enabled: true,
        passkey: true,
        passkeyUnlocksExtras: true,
        lockedAt: null,
        failedTries: 0,
      },
      keptOffline: [
        {
          locationId: IDS.home,
          things: 3,
          documents: 4,
          bytes: 9_175_040,
          tooLarge: [
            {
              attachmentId: '01926f00-0000-7000-8000-0000000e8f01',
              title: 'TV service manual',
              bytes: 41_943_040,
            },
          ],
          updatedAt: ago(2 * HOUR),
          state: 'ready',
        },
      ],
    },
    extras: homeExtras(),
    https: true,
    serveStatus: true,
  };
}

function doc(
  n: number,
  kind: SyncExtra['documents'][number]['kind'],
  title: string,
  bytes: number,
) {
  return {
    attachmentId: `01926f00-0000-7000-8000-0000000e8d${String(n).padStart(2, '0')}`,
    fileId: `01926f00-0000-7000-8000-0000000e8e${String(n).padStart(2, '0')}`,
    kind,
    title,
    mime: 'application/pdf',
    bytes,
    sha256: hex(n * 104_729),
  };
}

function homeExtras(): SyncExtra[] {
  return [
    {
      thingId: INV_IDS.thing.tv,
      purchase: { date: '2025-11-28', price: '18999.00', currency: 'EGP' },
      currentValue: { amount: '15000.00', currency: 'EGP' },
      documents: [
        doc(1, 'receipt', 'TV receipt', 412_000),
        doc(2, 'warranty_doc', 'TV warranty', 1_310_720),
      ],
    },
    {
      thingId: INV_IDS.thing.kettle,
      purchase: { date: '2026-02-03', price: '1450.00', currency: 'EGP' },
      currentValue: null,
      documents: [doc(3, 'manual', 'Kettle manual', 2_621_440)],
    },
    {
      thingId: INV_IDS.thing.cableBox,
      purchase: null,
      currentValue: null,
      documents: [doc(4, 'invoice', 'Installation invoice', 204_800)],
    },
  ];
}

const STORE = new WeakMap<MockState, OpsState>();

/** The step-8 state of this mock, seeded on first use. */
export function ops(state: MockState): OpsState {
  let s = STORE.get(state);
  if (!s) {
    s = seed(state, 's3');
    STORE.set(state, s);
  }
  return s;
}

/** Switches to another scenario, reseeding everything but `serveStatus` and `https`. */
export function setOpsScenario(state: MockState, scenario: OpsScenario): OpsState {
  const prev = STORE.get(state);
  const s = seed(state, scenario);
  if (prev) {
    s.serveStatus = prev.serveStatus;
    s.https = prev.https;
  }
  STORE.set(state, s);
  return s;
}

/** The status page's step-8 fields as they stand now (the runs may have moved since seeding). */
export function opsStatus(state: MockState): AdminOpsStatus {
  const s = ops(state);
  const last = s.runs.find((r) => r.kind === 'nightly' || r.kind === 'manual') ?? null;
  const lastOk =
    s.runs.find((r) => (r.kind === 'nightly' || r.kind === 'manual') && r.status === 'ok') ?? null;
  return {
    ...s.status,
    backup: {
      ...s.status.backup,
      configured: s.settings.configured,
      last,
      lastOk,
      stale:
        s.settings.configured &&
        (!lastOk?.finishedAt ||
          Date.now() - Date.parse(lastOk.finishedAt) > BACKUP_STALE_HOURS * HOUR),
      snapshots: s.settings.configured ? s.snapshots.length : null,
    },
    recoveryKit: {
      acknowledgedAt: s.kit.acknowledgedAt,
      downloadedAt: s.kit.downloadedAt,
      stale: s.kit.stale,
    },
    updates: s.updates,
    https: s.https,
  };
}
