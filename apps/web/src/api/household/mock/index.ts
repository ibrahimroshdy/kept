/**
 * The step-4 mock routes, one handler array per area, composed by api/mock/server.ts after steps
 * 2 and 3. Parallel web tasks (T20–T28) each extend their own area's file, so they never edit the
 * same one; the state and fixtures are in ./state.ts, the shared rules (gates, views, the agenda)
 * in ./db.ts.
 */
import type { MockState } from '../../mock/fixtures';
import type { MockRoute } from '../../mock/kit';
import { agendaRoutes } from './agenda';
import { calendarRoutes } from './calendar';
import { installStep4 } from './db';
import { incidentsRoutes } from './incidents';
import { lendingRoutes } from './lending';
import { moneyRoutes } from './money';
import { notifyRoutes } from './notify';
import { paperworkRoutes } from './paperwork';
import { schedulesRoutes } from './schedules';
import { warrantiesRoutes } from './warranties';

export function householdMockRoutes(state: MockState): MockRoute[] {
  // Lent, borrowed and in repair on every thing, and the step-4 attachment subjects (T20).
  installStep4(state);
  return [
    ...moneyRoutes(state),
    ...warrantiesRoutes(state),
    ...lendingRoutes(state),
    ...schedulesRoutes(state),
    ...paperworkRoutes(state),
    ...agendaRoutes(state),
    ...notifyRoutes(state),
    ...calendarRoutes(state),
    ...incidentsRoutes(state),
  ];
}
