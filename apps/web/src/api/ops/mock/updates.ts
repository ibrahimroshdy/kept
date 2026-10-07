/**
 * The update check's "Check now" (T11; D65): records the check and answers the state. With the
 * check off it answers the state unchanged, as the server would refuse to ask GitHub.
 */
import type { MockState } from '../../mock/fixtures';
import { type MockRoute, route } from '../../mock/kit';
import { opsPaths as p } from '../paths';
import { adminGate } from './guard';
import { ops } from './state';

export function updateRoutes(state: MockState): MockRoute[] {
  return [
    route('POST', p.updatesCheck, () => {
      const gate = adminGate(state);
      if (gate) return gate;
      const s = ops(state);
      if (s.updates.enabled) s.updates = { ...s.updates, lastCheckedAt: new Date().toISOString() };
      return s.updates;
    }),
  ];
}
