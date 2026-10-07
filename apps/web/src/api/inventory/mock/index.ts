/**
 * The step-2 mock routes, one handler array per area, composed by api/mock/server.ts. Parallel
 * web tasks each extend their own area's file (plan Phase C), so they never edit the same one.
 */
import type { MockState } from '../../mock/fixtures';
import type { MockRoute } from '../../mock/kit';
import { codesRoutes } from './codes';
import { filesRoutes } from './files';
import { homeRoutes } from './home';
import { placesRoutes } from './places';
import { registriesRoutes } from './registries';
import { reportsRoutes } from './reports';
import { searchRoutes } from './search';
import { thingsRoutes } from './things';
import { trashRoutes } from './trash';

export function inventoryMockRoutes(state: MockState): MockRoute[] {
  return [
    ...registriesRoutes(state),
    ...placesRoutes(state),
    ...thingsRoutes(state),
    ...filesRoutes(state),
    ...searchRoutes(state),
    ...trashRoutes(state),
    ...homeRoutes(state),
    ...reportsRoutes(state),
    // T17a (D208): own codes, and a location's numbering and format rule.
    ...codesRoutes(state),
  ];
}
