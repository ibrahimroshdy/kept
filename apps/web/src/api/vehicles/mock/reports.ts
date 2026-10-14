/**
 * The vehicle history report (plan T15; D51, D201; Q16): a third kind on the report runs, read
 * back through step 2's `GET /reports/:id` (api/inventory/mock/reports.ts `queueReportRun`), which
 * advances it to a download. Anyone who can see the vehicle may make one, viewers included, in a
 * location with Vehicles on; its total is the vehicle's readings, services and fills, plus the
 * render.
 */
import { hh } from '../../household/mock/db';
import { queueReportRun } from '../../inventory/mock/reports';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, reply, route, sessionGate } from '../../mock/kit';
import { vehiclePaths as p } from '../paths';
import type { LubeLoggerImportBody, VehicleHistoryReportBody } from '../types';
import { ensureVehiclesSeeded, isVehicle, thingGate, vehiclesOf } from './state';

export function vehicleReportRoutes(state: MockState): MockRoute[] {
  return [
    route('POST', p.reportsVehicleHistory, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      ensureVehiclesSeeded(state);
      const b = body as VehicleHistoryReportBody;
      const g = thingGate(state, b?.thingId, 'vehicles', 'read');
      if ('reply' in g) return g.reply;
      if (!isVehicle(state, g.thing))
        return err(
          400,
          'validation',
          'The request is not valid.',
          'Check body.thingId: a vehicle.',
        );
      const t = g.thing;
      const readings = t.meters.reduce(
        (n, m) => n + (state.inventory.readings[m.id]?.length ?? 0),
        0,
      );
      const services = hh(state).serviceRecords.filter(
        (r) => 'thingId' in r.subject && r.subject.thingId === t.id,
      ).length;
      const fills = vehiclesOf(state).fills.filter((f) => f.thingId === t.id).length;
      return reply(
        202,
        queueReportRun(state, { locationId: t.locationId }, readings + services + fills),
      );
    }),
    // 1.3 (D229): the LubeLogger import, answered from the rows without keeping anything (a row
    // with no readable date is an issue, the rest would be added).
    route('POST', p.thingLubeLogger(':id'), ({ params, body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      ensureVehiclesSeeded(state);
      const g = thingGate(state, params.id, 'vehicles', 'write');
      if ('reply' in g) return g.reply;
      const b = body as LubeLoggerImportBody;
      const issues = b.rows.flatMap((r, i) =>
        /^\s*\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/.test(r.Date ?? '')
          ? []
          : [{ row: i + 1, code: 'date' }],
      );
      return {
        created: b.rows.length - issues.length,
        skipped: 0,
        issues,
        dryRun: b.dryRun === true,
      };
    }),
  ];
}
