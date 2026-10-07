/**
 * Every step-8 server path the web app calls, in one place, from the route tables of the step-8
 * plan's Phase B: T10 (Admin → Backups, `admin/backup-routes.ts`), T9 (the recovery kit's
 * download, `admin/routes.ts`), T11 (the update check's "Check now") and T12 (the keep-offline
 * extras, `sync/extras.ts`). A path the server names differently is fixed here and nowhere else.
 * The contract check (T25) reads `OPS_METHODS` against the server's openapi.json.
 *
 * Paths that already exist are not repeated: the status page (`paths.admin.status`), the
 * recovery kit's state and acknowledgement (`paths.admin.recoveryKit`, `…Acknowledge`) and the
 * admin settings, which T11 extends with `updateCheck`.
 */

const V1 = '/api/v1';

export const opsPaths = {
  // ----- Admin → Backups (T10) -----
  backup: `${V1}/admin/backup`,
  backupTest: `${V1}/admin/backup/test`,
  backupRun: `${V1}/admin/backup/run`,
  /** `?kind&status&q&cursor` */
  backupRuns: `${V1}/admin/backup/runs`,
  backupSnapshots: `${V1}/admin/backup/snapshots`,

  // ----- the recovery kit (T9) -----
  recoveryKitDownload: `${V1}/admin/recovery-kit/download`,

  // ----- the update check (T11) -----
  updatesCheck: `${V1}/admin/updates/check`,

  // ----- keep this location available offline (T12) -----
  /** `?locationId&cursor&estimate` */
  syncExtras: `${V1}/sync/extras`,
} as const;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** The methods the web app uses on each path (the contract check, T25). */
export const OPS_METHODS: Record<keyof typeof opsPaths, readonly Method[]> = {
  backup: ['GET', 'PUT'],
  backupTest: ['POST'],
  backupRun: ['POST'],
  backupRuns: ['GET'],
  backupSnapshots: ['GET'],
  recoveryKitDownload: ['POST'],
  updatesCheck: ['POST'],
  syncExtras: ['GET'],
};
