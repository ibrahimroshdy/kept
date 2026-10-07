/**
 * The step-3 mock routes, one handler array per area, composed by api/mock/server.ts after step
 * 2's. Parallel web tasks (T23–T31) each extend their own area's file, so they never edit the
 * same one; the state and fixtures are in ./state.ts.
 */
import type { MockState } from '../../mock/fixtures';
import type { MockRoute } from '../../mock/kit';
import { aiRoutes } from './ai';
import { captureRoutes } from './capture';
import { importsRoutes } from './imports';
import { inboxRoutes } from './inbox';
import { labelsRoutes } from './labels';
import { scanRoutes } from './scan';
import { syncRoutes } from './sync';
import { templatesRoutes } from './templates';
import { undoRoutes } from './undo';

export function captureMockRoutes(state: MockState): MockRoute[] {
  return [
    ...captureRoutes(state),
    ...inboxRoutes(state),
    ...aiRoutes(state),
    ...labelsRoutes(state),
    ...scanRoutes(state),
    ...importsRoutes(state),
    ...templatesRoutes(state),
    ...undoRoutes(state),
    ...syncRoutes(state),
  ];
}
