/**
 * The step-5 mock routes (plan T3), one handler array per area, composed by api/mock/server.ts
 * after steps 2–4 so an area can extend an earlier step's route. The parallel web tasks (T17–T23)
 * each extend their own area's file. State, fixtures and the shared rules are in ./state.ts.
 */
import type { MockState } from '../../mock/fixtures';
import type { MockRoute } from '../../mock/kit';
import { costsRoutes } from './costs';
import { documentRoutes } from './documents';
import { fuelRoutes } from './fuel';
import { vehicleReportRoutes } from './reports';
import { seriesRoutes } from './series';
import { serviceDraftRoutes } from './service-drafts';
import { vehicleListRoutes } from './vehicles';

export { ensureVehiclesSeeded, VEHICLE_IDS } from './state';

export function vehicleMockRoutes(state: MockState): MockRoute[] {
  return [
    ...vehicleListRoutes(state),
    ...seriesRoutes(state),
    ...costsRoutes(state),
    ...fuelRoutes(state),
    ...serviceDraftRoutes(state),
    ...documentRoutes(state),
    ...vehicleReportRoutes(state),
  ];
}
