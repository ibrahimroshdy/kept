/**
 * Step-8 fetchers, query keys and hooks, over the contract in ./types.ts and the paths in
 * ./paths.ts. Writes are fetchers on `opsApi` for the screens to wrap in `useMutation`.
 *
 * Secrets (the backup password, an S3 secret key, an SFTP private key, the account password that
 * re-authenticates the kit's download) go only into a request body: never into a query key, a
 * URL or browser storage. The recovery kit comes back as a Blob, for a download link the screen
 * revokes at once (T22); it is never cached by TanStack Query.
 */

import type {
  BackupSettingsInput,
  BackupTestInput,
  RecoveryKitDownloadInput,
  RecoveryKitState,
} from '@kept/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ifMatch, toApiError } from '../client';
import { qs } from '../inventory/paths';
import { paths } from '../paths';
import { keys } from '../queries';
import { opsPaths as p } from './paths';
import type {
  BackupRun,
  BackupRunsPage,
  BackupRunsParams,
  BackupSettingsView,
  BackupSnapshotsPage,
  BackupTestResult,
  StatusPageData,
  SyncExtrasEstimate,
  SyncExtrasPage,
  UpdateCheckState,
} from './types';

export const opsKeys = {
  backup: {
    all: ['admin', 'backup'] as const,
    settings: () => ['admin', 'backup', 'settings'] as const,
    runs: (params: BackupRunsParams = {}) => ['admin', 'backup', 'runs', params] as const,
    snapshots: () => ['admin', 'backup', 'snapshots'] as const,
  },
  /** Under `admin`, so the status page's invalidation refreshes it too. */
  recoveryKit: () => ['admin', 'recovery-kit'] as const,
  extrasEstimate: (locationId: string) => ['sync', 'extras', locationId, 'estimate'] as const,
};
const k = opsKeys;

export const opsApi = {
  status: () => api.get<StatusPageData>(paths.admin.status),
  backup: () => api.get<BackupSettingsView>(p.backup),
  putBackup: (body: BackupSettingsInput, version: number) =>
    api.put<BackupSettingsView>(p.backup, body, ifMatch(version)),
  testBackup: (body: BackupTestInput = {}) => api.post<BackupTestResult>(p.backupTest, body),
  runBackup: () => api.post<BackupRun>(p.backupRun),
  backupRuns: (params: BackupRunsParams = {}) => api.get<BackupRunsPage>(p.backupRuns + qs(params)),
  backupSnapshots: () => api.get<BackupSnapshotsPage>(p.backupSnapshots),
  recoveryKit: () => api.get<RecoveryKitState>(paths.admin.recoveryKit),
  checkUpdates: () => api.post<UpdateCheckState>(p.updatesCheck),
  syncExtras: (locationId: string, cursor?: string) =>
    api.get<SyncExtrasPage>(p.syncExtras + qs({ locationId, ...(cursor ? { cursor } : {}) })),
  syncExtrasEstimate: (locationId: string) =>
    api.get<SyncExtrasEstimate>(p.syncExtras + qs({ locationId, estimate: '1' })),
  /**
   * The recovery kit as a file (T9): text or the printable page. Not through `request()`: the
   * answer is the attachment itself. A refusal (403 `reauth_required`, `https_required`) is the
   * usual error body, thrown as an ApiError; `reauth_required` carries `details.reauth`:
   * `password` or `sign_in` (an account without a password whose sign-in is too old).
   */
  downloadRecoveryKit: async (body: RecoveryKitDownloadInput): Promise<Blob> => {
    const res = await fetch(p.recoveryKitDownload, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toApiError(res);
    return res.blob();
  },
};

/**
 * Admin → Status with step 8's fields (T10, T21), under the same key as `useAdminStatus`, so a
 * write that invalidates the status refreshes both. The step-8 fields are optional here: a server
 * whose database didn't answer sends the step-1 summary alone (admin/routes.ts).
 */
export const useOpsStatus = () => useQuery({ queryKey: keys.admin.status, queryFn: opsApi.status });

/** The kit's state (T9): acknowledged, last downloaded, and stale since. */
export const useRecoveryKit = () =>
  useQuery({ queryKey: k.recoveryKit(), queryFn: opsApi.recoveryKit });

export const useBackupSettings = () =>
  useQuery({ queryKey: k.backup.settings(), queryFn: opsApi.backup });

export const useBackupSnapshots = () =>
  useQuery({ queryKey: k.backup.snapshots(), queryFn: opsApi.backupSnapshots });

/** When "Run now" was last pressed (RunNowButton). The worker writes the run's row only when it
 * starts the job, after the 202, so the runs list polls for a minute after a press. */
let runNowAt = 0;
export const noteRunNow = () => {
  runNowAt = Date.now();
};
const RUN_NOW_WATCH_MS = 60_000;
const RUNS_POLL_MS = 3_000;

export const useBackupRuns = (params: BackupRunsParams = {}) =>
  useInfiniteQuery({
    queryKey: k.backup.runs(params),
    queryFn: ({ pageParam }) =>
      opsApi.backupRuns({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // Until the newest run ends, and for a minute after a Run now, so it shows without a reload.
    refetchInterval: (q) =>
      q.state.data?.pages[0]?.items[0]?.status === 'running' ||
      Date.now() - runNowAt < RUN_NOW_WATCH_MS
        ? RUNS_POLL_MS
        : false,
  });

export const useSyncExtrasEstimate = (locationId: string | null) =>
  useQuery({
    queryKey: k.extrasEstimate(locationId ?? ''),
    queryFn: () => opsApi.syncExtrasEstimate(locationId ?? ''),
    enabled: locationId !== null,
  });
