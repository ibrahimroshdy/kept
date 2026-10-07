/**
 * Mock handlers for Admin → Backups (T10; D64, D66, D186, D193; plan Q6). Instance admins only.
 * A PUT needs If-Match, the recovery kit's acknowledgement (409 `recovery_kit_required`), https,
 * a password of 12+ characters when one is sent (400 `backup_password_weak`), and leaves a field
 * the environment locks as it is (400 `setting_locked`). Run now starts a `manual` run, which
 * finishes on the next read of the runs; a second one meanwhile is 409 `backup_running`.
 */
import {
  BACKUP_PASSWORD_MIN,
  BACKUP_RUN_KINDS,
  BACKUP_RUN_STATES,
  BackupSettingsInput,
  type BackupTargetInput,
} from '@kept/shared';
import { paginate } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, reply, route } from '../../mock/kit';
import { opsPaths as p } from '../paths';
import type { BackupRun, BackupTargetView } from '../types';
import { adminGate, httpsGate } from './guard';
import { OPS_IDS, ops } from './state';

const viewOf = (t: BackupTargetInput, prev: BackupTargetView | null): BackupTargetView => {
  if (t.kind === 'dir') return { kind: 'dir', path: t.path };
  if (t.kind === 's3') {
    const had = prev?.kind === 's3' && prev.secretAccessKeySet;
    return {
      kind: 's3',
      endpoint: t.endpoint ?? null,
      region: t.region,
      bucket: t.bucket,
      prefix: t.prefix,
      forcePathStyle: t.forcePathStyle,
      accessKeyId: t.accessKeyId,
      secretAccessKeySet: t.secretAccessKey !== undefined || had,
    };
  }
  const had = prev?.kind === 'sftp' && prev.privateKeySet;
  return {
    kind: 'sftp',
    host: t.host,
    port: t.port,
    user: t.user,
    path: t.path,
    hostKey: t.hostKey,
    privateKeySet: t.privateKey !== undefined || had,
  };
};

const sameTarget = (a: BackupTargetView | null, b: BackupTargetView) =>
  JSON.stringify(a) === JSON.stringify(b);

export function backupRoutes(state: MockState): MockRoute[] {
  const s = () => ops(state);
  let nextRun = 100;

  const finishRunning = () => {
    for (const r of s().runs) {
      if (r.status !== 'running') continue;
      r.status = 'ok';
      r.finishedAt = new Date().toISOString();
      r.snapshotId = 'f'.repeat(56) + String(nextRun).padStart(8, '0');
      r.bytesAdded = 2_097_152;
      r.filesNew = 3;
      s().snapshots.unshift({
        id: r.snapshotId,
        time: r.startedAt,
        kind: 'manual',
        version: state.version.version,
        tags: ['kept', 'manual', `v${state.version.version}`],
      });
    }
  };

  return [
    route('GET', p.backup, () => adminGate(state) ?? s().settings),

    route('PUT', p.backup, ({ body, headers }) => {
      const gate = adminGate(state) ?? httpsGate(state);
      if (gate) return gate;
      if (!s().kit.acknowledgedAt) {
        return err(409, 'recovery_kit_required', 'Save the recovery kit first.');
      }
      if (headers['if-match'] !== String(s().settings.version)) {
        return err(412, 'precondition_failed', 'This changed since you opened it.');
      }
      const raw = body as { password?: unknown };
      if (typeof raw?.password === 'string' && raw.password.length < BACKUP_PASSWORD_MIN) {
        return err(400, 'backup_password_weak', 'Use a backup password of at least 12 characters.');
      }
      const parsed = BackupSettingsInput.safeParse(body);
      if (!parsed.success) return err(400, 'validation', 'The request is not valid.');
      const input = parsed.data;
      const cur = s().settings;
      const target = viewOf(input.target, cur.target.value);
      const keep = input.keep;
      const lockedChange =
        (cur.target.locked && !sameTarget(cur.target.value, target)) ||
        (cur.passwordSet.locked && input.password !== undefined) ||
        (cur.time.locked && cur.time.value !== input.time) ||
        (['daily', 'weekly', 'monthly'] as const).some(
          (k) => cur.keep[k].locked && cur.keep[k].value !== keep[k],
        );
      if (lockedChange) {
        return err(
          400,
          'setting_locked',
          "This is set by the server's environment and can't be changed here.",
        );
      }
      const passwordSet = cur.passwordSet.value || input.password !== undefined;
      s().settings = {
        configured: passwordSet,
        target: { value: target, locked: cur.target.locked },
        passwordSet: { value: passwordSet, locked: cur.passwordSet.locked },
        time: { value: input.time, locked: cur.time.locked },
        keep: {
          daily: { value: keep.daily, locked: cur.keep.daily.locked },
          weekly: { value: keep.weekly, locked: cur.keep.weekly.locked },
          monthly: { value: keep.monthly, locked: cur.keep.monthly.locked },
        },
        version: cur.version + 1,
      };
      // A change to the backup settings makes the downloaded kit stale (plan T9).
      if (s().kit.downloadedAt) s().kit.stale = true;
      return s().settings;
    }),

    route('POST', p.backupTest, ({ body }) => {
      const gate = adminGate(state) ?? httpsGate(state);
      if (gate) return gate;
      if (!s().settings.configured) {
        return err(409, 'backup_not_configured', 'Backups are not set up yet.');
      }
      const init = (body as { init?: boolean } | undefined)?.init === true;
      return { ok: true, initialised: init || s().runs.length > 0 };
    }),

    route('POST', p.backupRun, () => {
      const gate = adminGate(state);
      if (gate) return gate;
      if (!s().settings.configured) {
        return err(409, 'backup_not_configured', 'Backups are not set up yet.');
      }
      if (s().runs.some((r) => r.status === 'running')) {
        return err(409, 'backup_running', 'A backup is already running.');
      }
      const target = s().status.backup.target ?? 'backup';
      const r: BackupRun = {
        id: OPS_IDS.run(nextRun++),
        kind: 'manual',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        storageMode: s().status.backup.storageMode,
        target,
        snapshotId: null,
        dbBytes: null,
        bytesAdded: null,
        bytesTotal: null,
        filesTotal: null,
        filesNew: null,
        missing: 0,
        readableLocations: null,
        readableBytes: null,
        sameVolume: null,
        bucketVersioningOk: null,
        fromVersion: null,
        toVersion: null,
        verifiedAt: null,
        error: null,
        detail: {},
      };
      s().runs.unshift(r);
      return reply(202, r);
    }),

    route('GET', p.backupRuns, ({ query }) => {
      const gate = adminGate(state);
      if (gate) return gate;
      const kind = query.get('kind');
      const status = query.get('status');
      if (kind && !(BACKUP_RUN_KINDS as readonly string[]).includes(kind)) {
        return err(400, 'validation', 'The request is not valid.');
      }
      if (status && !(BACKUP_RUN_STATES as readonly string[]).includes(status)) {
        return err(400, 'validation', 'The request is not valid.');
      }
      const page = paginate(
        s().runs.filter(
          (r) =>
            (!kind || r.kind === kind) &&
            (!status || r.status === status) &&
            (!query.get('q') ||
              `${r.error ?? ''} ${r.target}`
                .toLowerCase()
                .includes(String(query.get('q')).toLowerCase())),
        ),
        query,
      );
      // A run Run now started finishes once the list is read again.
      finishRunning();
      return page;
    }),

    route('GET', p.backupSnapshots, () => {
      const gate = adminGate(state);
      if (gate) return gate;
      if (!s().settings.configured) {
        return err(409, 'backup_not_configured', 'Backups are not set up yet.');
      }
      return { items: s().snapshots, cachedAt: new Date().toISOString() };
    }),
  ];
}
