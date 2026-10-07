/**
 * The step-7 mock routes, one handler array per area, composed by api/mock/server.ts after steps
 * 2–4. Parallel web tasks (T19–T24) each extend their own area's file; the state and fixtures are
 * in ./state.ts.
 */
import type { MockState } from '../../mock/fixtures';
import type { MockRoute } from '../../mock/kit';
import { consumableRoutes } from './consumables';
import { exportRoutes } from './exports';
import { fieldRoutes } from './fields';
import { importRoutes } from './imports';

export function portabilityMockRoutes(state: MockState): MockRoute[] {
  return [
    ...importRoutes(state),
    ...exportRoutes(state),
    ...consumableRoutes(state),
    ...fieldRoutes(state),
  ];
}
