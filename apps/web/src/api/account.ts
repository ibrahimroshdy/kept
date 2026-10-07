/** First run, the signed-in person, their devices, and the build info (D147). */
import { api } from './client';
import { paths } from './paths';
import type {
  DeviceSession,
  EmailChangeBody,
  EmailChangeStage,
  Me,
  SetupBody,
  SetupResult,
  SetupStatus,
  VersionInfo,
} from './types';

export const getVersion = () => api.get<VersionInfo>(paths.version);

export const getSetupStatus = () => api.get<SetupStatus>(paths.setup);
export const completeSetup = (body: SetupBody) => api.post<SetupResult>(paths.setup, body);

export const getMe = () => api.get<Me>(paths.me);
/** PATCH /api/v1/me: "Suggest where I am" (D153, T19), audited `me.preferences`. */
export const setSuggestLocation = (suggestLocation: boolean) =>
  api.patch<{ suggestLocation: boolean }>(paths.me, { suggestLocation });

export const listMySessions = () =>
  api.get<{ sessions: DeviceSession[] }>(paths.mySessions).then((r) => r.sessions);
export const revokeMySession = (id: string) => api.del(paths.mySession(id));

/**
 * Starts an email change: a link to the current address first (202 `{stage: 'confirm_old'}`).
 * Without `password`, 403 `reauth_required` when the last sign-in is over 10 minutes old.
 */
export const startEmailChange = (body: EmailChangeBody) =>
  api.post<EmailChangeStage>(paths.myEmailChange, body);
