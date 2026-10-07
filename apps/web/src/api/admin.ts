/** Instance admin (tasks 23–25). Every route here is refused for anyone else. */
import { allPages, api } from './client';
import { type AdminUserAction, paths } from './paths';
import type {
  AdminAccount,
  AdminAlert,
  AdminSettings,
  AdminSettingsBody,
  AdminStatus,
  AdminUser,
  EmbeddingsStatus,
  FailedJob,
  PutEmbeddingsBody,
} from './types';

/** Every user, oldest first (`q` narrows by email, username or name). */
export const listAdminUsers = async (q?: string): Promise<AdminUser[]> => {
  const all: AdminUser[] = [];
  await allPages<{ users: AdminUser[]; nextCursor: string | null }>(
    paths.admin.users,
    (p) => all.push(...p.users),
    q ? { q } : {},
  );
  return all;
};
/** Accounts by owner name (`q`), for the per-account cap override (T19); at most 50. */
export const listAdminAccounts = (q?: string) =>
  api.get<{ items: AdminAccount[] }>(
    `${paths.admin.accounts}?${new URLSearchParams({ limit: '50', ...(q ? { q } : {}) })}`,
  );

/** 204; your own account answers 409 for disable. */
export const adminUserAction = (id: string, action: AdminUserAction) =>
  api.post<void>(paths.admin.userAction(id, action));

export const getAdminSettings = () => api.get<AdminSettings>(paths.admin.settings);
export const putAdminSettings = (body: AdminSettingsBody) =>
  api.put<AdminSettings>(paths.admin.settings, body);

export const grantInstanceAdmin = (userId: string) =>
  api.post<{ userId: string; grantedAt: string }>(paths.admin.instanceAdmins, { userId });
/** The last instance admin answers 409. */
export const revokeInstanceAdmin = (userId: string) => api.del(paths.admin.instanceAdmin(userId));

export const getRecoveryKit = () =>
  api.get<{ acknowledgedAt: string | null }>(paths.admin.recoveryKit);
/** The first acknowledgement's time is kept; acknowledging again returns it. */
export const acknowledgeRecoveryKit = () =>
  api.post<{ acknowledgedAt: string }>(paths.admin.recoveryKitAcknowledge);

/** Newest failure first. */
export const listFailedJobs = async (): Promise<FailedJob[]> => {
  const all: FailedJob[] = [];
  await allPages<{ jobs: FailedJob[]; nextCursor: string | null }>(paths.admin.failedJobs, (p) =>
    all.push(...p.jobs),
  );
  return all;
};
/** 204; 404 when the job is no longer failed. */
export const failedJobAction = (id: string, action: 'retry' | 'discard') =>
  api.post<void>(paths.admin.failedJobAction(id, action));

/** Open and resolved alerts (the server's default is open only), most recent activity first. */
export const listAlerts = async (): Promise<AdminAlert[]> => {
  const all: AdminAlert[] = [];
  await allPages<{ alerts: AdminAlert[]; nextCursor: string | null }>(
    paths.admin.alerts,
    (p) => all.push(...p.alerts),
    { state: 'all' },
  );
  return all;
};
export const getAdminStatus = () => api.get<AdminStatus>(paths.admin.status);
/** Switches where semantic search's vectors come from (D207); audited. */
export const putEmbeddingsSource = (body: PutEmbeddingsBody) =>
  api.put<EmbeddingsStatus>(paths.admin.embeddings, body);
