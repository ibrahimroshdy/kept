/**
 * The step-8 mock answers the operations contract through the real fetchers (../queries.ts), so
 * the parallel web tasks (T21–T23) start from something that behaves like the server: every path
 * in ../paths.ts has a handler, the fixtures hold what the plan's T3 asks for, and the rules the
 * screens lean on (instance admins only, If-Match, the kit gate, locks, https, re-authentication)
 * hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiError, isApiError } from '../../client';
import { IDS, type MockState, memberScenario, ownerScenario } from '../../mock/fixtures';
import { createMockApi } from '../../mock/server';
import { OPS_METHODS, opsPaths } from '../paths';
import { opsApi as api } from '../queries';
import type { BackupSettingsInput } from '../types';
import { opsMockRoutes } from '.';
import { ops, opsStatus, setOpsScenario } from './state';

const use = (state: MockState = ownerScenario()) => {
  vi.stubGlobal('fetch', createMockApi(state).fetch);
  return state;
};
let state: MockState;
beforeEach(() => {
  state = use();
});
afterEach(() => vi.unstubAllGlobals());

const fail = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  if (!isApiError(e)) throw new Error('expected an ApiError');
  return e as ApiError;
};

const S3: BackupSettingsInput = {
  target: {
    kind: 's3',
    endpoint: 'https://s3.example.org',
    region: 'eu-central-1',
    bucket: 'kept-backups',
    prefix: 'kept-backups/',
    forcePathStyle: false,
    accessKeyId: 'KEPTEXAMPLEKEYID',
  },
  time: '03:15',
  keep: { daily: 7, weekly: 4, monthly: 6 },
};

describe('the operations mock', () => {
  it('has a handler for every path and method the web calls', () => {
    const routes = opsMockRoutes(ownerScenario());
    for (const [key, methods] of Object.entries(OPS_METHODS)) {
      const path = opsPaths[key as keyof typeof opsPaths];
      for (const method of methods) {
        expect(
          routes.some((r) => r.method === method && r.template === path),
          `${method} ${path}`,
        ).toBe(true);
      }
    }
  });

  it('holds the plan’s fixtures: 9 runs, a warning and a failure, the old drill, the disk, the update', () => {
    const s = ops(state);
    expect(s.runs).toHaveLength(9);
    expect(s.runs.filter((r) => r.status === 'warning').map((r) => r.error)).toEqual([
      'backup_suspicious_size',
    ]);
    expect(s.runs.filter((r) => r.status === 'failed')).toHaveLength(1);
    const status = opsStatus(state);
    expect(status.backup.bucketVersioning).toBe('off');
    expect(status.backup.drillDue).toBe(true);
    expect(status.disk.data?.usedRatio).toBe(0.88);
    expect(status.updates.latest?.version).toBe('1.3.0');
    expect(status.recoveryKit.stale).toBe(true);
    expect(s.device.appLock.enabled).toBe(true);
    expect(s.device.keptOffline.map((k) => k.locationId)).toEqual([IDS.home]);
  });

  it('switches to a directory on the data’s disk (locked by the environment) and to unconfigured', () => {
    setOpsScenario(state, 'dir_same_disk');
    expect(opsStatus(state).backup).toMatchObject({ sameVolume: true, locked: true });
    expect(ops(state).settings.target.locked).toBe(true);
    setOpsScenario(state, 'unconfigured');
    expect(opsStatus(state).backup).toMatchObject({ configured: false, last: null });
  });
});

describe('Admin → Backups', () => {
  it('reads the settings with write-only fields as …Set', async () => {
    const view = await api.backup();
    expect(view.configured).toBe(true);
    expect(view.target.value).toMatchObject({ kind: 's3', secretAccessKeySet: true });
    expect(JSON.stringify(view)).not.toMatch(/secretAccessKey"/);
  });

  it('saves with If-Match, keeps a stored secret, and refuses a stale version or a weak password', async () => {
    const { version } = await api.backup();
    expect((await fail(api.putBackup(S3, version - 1))).code).toBe('precondition_failed');
    expect((await fail(api.putBackup({ ...S3, password: 'short' }, version))).code).toBe(
      'backup_password_weak',
    );
    const saved = await api.putBackup(S3, version);
    expect(saved.version).toBe(version + 1);
    expect(saved.time.value).toBe('03:15');
    expect(saved.target.value).toMatchObject({ secretAccessKeySet: true });
  });

  it('needs the recovery kit first (409) and https (403)', async () => {
    ops(state).kit.acknowledgedAt = null;
    const { version } = await api.backup();
    expect((await fail(api.putBackup(S3, version))).code).toBe('recovery_kit_required');
    ops(state).kit.acknowledgedAt = new Date().toISOString();
    ops(state).https = false;
    expect((await fail(api.putBackup(S3, version))).code).toBe('https_required');
  });

  it('refuses to change what the environment locks', async () => {
    setOpsScenario(state, 'dir_same_disk');
    const { version } = await api.backup();
    const moved = { ...S3, target: { kind: 'dir' as const, path: '/mnt/elsewhere' } };
    expect((await fail(api.putBackup(moved, version))).code).toBe('setting_locked');
    const same = { ...S3, target: { kind: 'dir' as const, path: '/mnt/backup/kept' } };
    await expect(api.putBackup(same, version)).resolves.toMatchObject({ version: version + 1 });
  });

  it('runs now once at a time, and lists runs filtered by kind, status and text', async () => {
    const started = await api.runBackup();
    expect(started).toMatchObject({ kind: 'manual', status: 'running' });
    expect((await fail(api.runBackup())).code).toBe('backup_running');
    const failed = await api.backupRuns({ status: 'failed' });
    expect(failed.items.map((r) => r.error)).toEqual(['unreachable']);
    const drills = await api.backupRuns({ kind: 'drill' });
    expect(drills.items).toHaveLength(1);
    const small = await api.backupRuns({ q: 'suspicious' });
    expect(small.items).toHaveLength(1);
    const all = await api.backupRuns();
    expect(all.items.find((r) => r.id === started.id)?.status).toBe('ok');
    expect((await api.backupSnapshots()).items.length).toBeGreaterThan(0);
  });

  it('tests the repository, and says when nothing is configured', async () => {
    await expect(api.testBackup({ init: true })).resolves.toEqual({ ok: true, initialised: true });
    setOpsScenario(state, 'unconfigured');
    expect((await fail(api.testBackup())).code).toBe('backup_not_configured');
    expect((await fail(api.runBackup())).code).toBe('backup_not_configured');
  });

  it('is not there for someone who isn’t an instance admin (404)', async () => {
    use(memberScenario());
    expect((await fail(api.backup())).status).toBe(404);
    expect((await fail(api.backupRuns())).status).toBe(404);
    expect((await fail(api.checkUpdates())).status).toBe(404);
  });
});

describe('the recovery kit download', () => {
  it('needs the password again, then hands out the kit and clears staleness', async () => {
    expect((await fail(api.downloadRecoveryKit({ password: 'wrong', format: 'text' }))).code).toBe(
      'reauth_required',
    );
    const blob = await api.downloadRecoveryKit({ password: state.password, format: 'text' });
    expect(await blob.text()).toContain('recovery kit');
    expect(ops(state).kit.stale).toBe(false);
    expect(opsStatus(state).recoveryKit.downloadedAt).not.toBeNull();
  });

  it('is refused over plain http', async () => {
    ops(state).https = false;
    expect(
      (await fail(api.downloadRecoveryKit({ password: state.password, format: 'html' }))).code,
    ).toBe('https_required');
  });
});

describe('the status page and the update check', () => {
  it('answers the step-8 fields since T21, and step 1’s alone with them off', async () => {
    const on = (await (await fetch('/api/v1/admin/status')).json()) as Record<string, unknown>;
    expect(on).toMatchObject({ release: { version: state.version.version }, https: true });
    ops(state).serveStatus = false;
    const off = (await (await fetch('/api/v1/admin/status')).json()) as Record<string, unknown>;
    expect(off).not.toHaveProperty('release');
    ops(state).serveStatus = true;
  });

  it('records a Check now', async () => {
    const before = ops(state).updates.lastCheckedAt;
    const after = await api.checkUpdates();
    expect(after.lastCheckedAt).not.toBe(before);
  });
});

describe('keep this location available offline', () => {
  it('estimates, then pages Home’s money and documents', async () => {
    const estimate = await api.syncExtrasEstimate(IDS.home);
    expect(estimate).toMatchObject({ things: 3, documents: 4 });
    const page = await api.syncExtras(IDS.home);
    expect(page.items[0]?.purchase?.price).toBe('18999.00');
    expect(page.totalBytes).toBe(estimate.totalBytes);
    expect(page.items.flatMap((x) => x.documents.map((d) => d.kind))).not.toContain('photo');
  });

  it('answers 404 for a location the person isn’t in', async () => {
    expect((await fail(api.syncExtras('01926f00-0000-7000-8000-0000000fffff'))).status).toBe(404);
  });
});
