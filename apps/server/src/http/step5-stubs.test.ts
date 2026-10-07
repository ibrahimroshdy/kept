import { describe, expect, it } from 'vitest';
import { fuelRoutes } from '../fuel/routes.js';
import { serviceDraftRoutes } from '../services/routes.js';
import { vehicleRoutes } from '../vehicles/routes.js';
import { INVENTORY_ROUTE_MODULES } from './routes.js';

// Step 5 (plan T2): the route modules the Phase-B tasks fill in (T9 service drafts, T11 fuel,
// T13 vehicles) are registered from the start, so no task edits http/routes.ts. Each adds its
// route table's routes; the route catalogue (test/route-catalogue.test.ts) checks their writes.

describe('the step-5 route stubs (T2)', () => {
  it('are registered, after step 4’s and in the plan’s order', () => {
    const modules: readonly unknown[] = INVENTORY_ROUTE_MODULES;
    const at = [serviceDraftRoutes, fuelRoutes, vehicleRoutes].map((m) => modules.indexOf(m));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('add the routes of the plan’s Phase B tables, and only those', async () => {
    const added: string[] = [];
    const app = {
      route: (r: { method: string; url: string }) => added.push(`${r.method} ${r.url}`),
      get: (url: string) => added.push(`GET ${url}`),
      post: (url: string) => added.push(`POST ${url}`),
      patch: (url: string) => added.push(`PATCH ${url}`),
      delete: (url: string) => added.push(`DELETE ${url}`),
    };
    for (const register of [serviceDraftRoutes, fuelRoutes, vehicleRoutes]) {
      await register(app as never, {} as never);
    }
    expect(added).toEqual([
      // T9
      'POST /api/v1/service-records/drafts',
      'GET /api/v1/service-records/:id',
      'POST /api/v1/service-records/:id/confirm',
      // T11
      'GET /api/v1/things/:id/fuel',
      'POST /api/v1/things/:id/fuel',
      'PATCH /api/v1/fuel/:id',
      'DELETE /api/v1/fuel/:id',
      'GET /api/v1/things/:id/fuel/summary',
      // T13
      'GET /api/v1/vehicles',
      'GET /api/v1/things/:id/costs',
      'GET /api/v1/meters/:id/series',
      'POST /api/v1/things/:id/starter-schedules',
    ]);
  });
});
