/**
 * The step-8 contract the web codes against (plan T3), from the Phase B route tables verbatim.
 * The shapes live once in @kept/shared (ops.ts), where the server parses its bodies with the same
 * schemas; this file re-exports them and adds what only the web has: the status response as the
 * page reads it once T10 lands, the runs list's parameters, and this device's own state (the app
 * lock and the locations kept offline, which never leave the device).
 */
import type { AdminOpsStatus, BackupRunKind, BackupRunState, Locked } from '@kept/shared';
import type { AdminStatus } from '../types';

export type {
  AdminOpsStatus,
  BackupKeep,
  BackupRun,
  BackupRunKind,
  BackupRunState,
  BackupRunsPage,
  BackupSettingsInput,
  BackupSettingsView,
  BackupSnapshot,
  BackupSnapshotsPage,
  BackupTargetInput,
  BackupTargetKind,
  BackupTargetView,
  BackupTestInput,
  BackupTestResult,
  BucketVersioning,
  DiskUsage,
  KeepOfflineRole,
  Locked,
  RecoveryKitDownloadInput,
  RecoveryKitFormat,
  RecoveryKitState,
  ResticErrorReason,
  SyncExtra,
  SyncExtraDocument,
  SyncExtrasEstimate,
  SyncExtrasPage,
  UpdateCheckError,
  UpdateCheckState,
} from '@kept/shared';

/**
 * `GET /api/v1/admin/status` after T10: the existing fields with step 8's, whose `backup`
 * replaces the alpha's `{configured, last, lastOk}`. T21 moves the status page onto this type.
 */
export type OpsAdminStatus = Omit<AdminStatus, 'backup'> & AdminOpsStatus;

/** What the status page reads (T21): OpsAdminStatus, whose step-8 fields a server sends only
 * when its database answered (`dbOk`). */
export type StatusPageData = Omit<AdminStatus, 'backup'> & Partial<AdminOpsStatus>;

/** `GET /api/v1/admin/backup/runs`: the list surface's filters (URL-backed in T21). */
export type BackupRunsParams = {
  kind?: BackupRunKind;
  status?: BackupRunState;
  /** Matches the error code or the target's description. */
  q?: string;
  cursor?: string;
};

/** `GET/PATCH /api/v1/admin/settings` gains this (T11): "Check for new versions". */
export type UpdateCheckSetting = { updateCheck: Locked<boolean> };

/**
 * This device (T23; D159, D181): the app lock and the locations kept offline. Kept in IndexedDB
 * on the device only, never sent to the server; the mock's fixture is what T23's screens start
 * from.
 */
export type DeviceState = {
  appLock: {
    enabled: boolean;
    /** "Use Face ID or fingerprint": a passkey with user verification also unlocks the app. */
    passkey: boolean;
    /** Whether the passkey's PRF output also unwraps the extras' key (plan Q22, L1). */
    passkeyUnlocksExtras: boolean;
    lockedAt: string | null;
    failedTries: number;
  };
  keptOffline: KeptOfflineLocation[];
};

export type KeptOfflineLocation = {
  locationId: string;
  things: number;
  documents: number;
  bytes: number;
  /** Documents over KEEP_OFFLINE.fileBytes, listed as "too large to keep offline". */
  tooLarge: { attachmentId: string; title: string | null; bytes: number }[];
  updatedAt: string | null;
  state: 'downloading' | 'ready' | 'failed';
};
