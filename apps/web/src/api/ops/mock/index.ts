/**
 * The step-8 mock routes, one handler array per area, composed by api/mock/server.ts after step
 * 7's. Parallel web tasks (T21–T23) each extend their own area's file; the state and fixtures are
 * in ./state.ts.
 */
import type { MockState } from '../../mock/fixtures';
import type { MockRoute } from '../../mock/kit';
import { backupRoutes } from './backup';
import { deviceRoutes } from './device';
import { kitRoutes } from './kit';
import { statusRoutes } from './status';
import { updateRoutes } from './updates';

export function opsMockRoutes(state: MockState): MockRoute[] {
  return [
    ...backupRoutes(state),
    ...statusRoutes(state),
    ...kitRoutes(state),
    ...updateRoutes(state),
    ...deviceRoutes(state),
  ];
}
