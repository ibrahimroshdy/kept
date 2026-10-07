/** The step-8 mock's gates, as the server's: a session, an instance admin, and https for writes. */
import type { MockState } from '../../mock/fixtures';
import { err, type MockReply, sessionGate } from '../../mock/kit';
import { ops } from './state';

/** 404 for anyone but an instance admin, as T10's routes answer (never 403: nothing leaks). */
export function adminGate(state: MockState): MockReply | null {
  return (
    sessionGate(state) ?? (state.me.user.instanceAdmin ? null : err(404, 'not_found', 'Not found.'))
  );
}

/** D181: 403 `https_required` while the mock's public URL is plain http. */
export function httpsGate(state: MockState): MockReply | null {
  return ops(state).https
    ? null
    : err(403, 'https_required', 'This needs a secure (https) connection to Kept.');
}
