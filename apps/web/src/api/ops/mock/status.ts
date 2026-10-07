/**
 * The status page's step-8 fields (T10). `GET /admin/status` answers step 1's fields, step 6's
 * (OIDC, connectors, embeddings: the connections mock's state) and `opsStatus(state)` over them
 * while `ops(state).serveStatus` is on, as it is since T21 moved the page onto OpsAdminStatus.
 * Off, it passes to the step-6 route, as a server whose database didn't answer sends no step-8
 * fields.
 */
import { instanceMock } from '../../connections/mock/instance';
import type { MockState } from '../../mock/fixtures';
import { type MockRoute, PASS, route } from '../../mock/kit';
import { paths } from '../../paths';
import { adminGate } from './guard';
import { ops, opsStatus } from './state';

export function statusRoutes(state: MockState): MockRoute[] {
  return [
    route('GET', paths.admin.status, () => {
      if (!ops(state).serveStatus) return PASS;
      const gate = adminGate(state);
      if (gate) return gate;
      const step6 = instanceMock(state);
      return {
        ...state.admin.status,
        oidc: step6.oidc,
        connectors: step6.connectors,
        embeddings: step6.embeddings,
        ...opsStatus(state),
      };
    }),
  ];
}
