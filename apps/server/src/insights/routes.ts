import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { manyOf } from '../http/list-filters.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead } from '../http/write.js';
import { insightsOf } from './service.js';

// Insights (1.x, D234; D39 item 8, D113), in the shape of the web contract
// (apps/web/src/api/insights/types.ts). Global across the caller's locations with Money on, so it
// declares no module: service.ts reads each location's gate (Money, Vehicles, Warranties & claims,
// and whether money shows to this caller).
//
// GET /api/v1/insights?f.location* → Insights (service.ts)

const Id = z.uuid();
const Query = z.object({ 'f.location': manyOf(Id).optional() });

const Amount = z.object({ currency: z.string(), amount: z.string() });
const CostAmounts = z.object({
  currency: z.string(),
  fuel: z.string(),
  service: z.string(),
  fees: z.string(),
  total: z.string(),
});

const InsightsSchema = z.object({
  locations: z.array(
    z.object({ id: Id, money: z.boolean(), vehicles: z.boolean(), warranties: z.boolean() }),
  ),
  thisYear: z.number().int(),
  spending: z.object({
    years: z.array(
      z.object({
        year: z.number().int(),
        soFar: z.boolean(),
        purchases: z.number().int(),
        unpriced: z.number().int(),
        byCurrency: z.array(Amount),
      }),
    ),
    hiddenIn: z.array(Id),
  }),
  value: z.object({
    locations: z.array(
      z.object({
        locationId: Id,
        things: z.number().int(),
        valued: z.number().int().optional(),
        byCurrency: z.array(Amount).optional(),
        moneyHidden: z.literal(true).optional(),
        places: z.array(
          z.object({
            id: Id.nullable(),
            shortCode: z.string().nullable(),
            name: z.string().nullable(),
            unplaced: z.boolean(),
            others: z.number().int().optional(),
            things: z.number().int(),
            valued: z.number().int().optional(),
            byCurrency: z.array(Amount).optional(),
          }),
        ),
      }),
    ),
    hiddenIn: z.array(Id),
  }),
  vehicles: z
    .object({
      thisMonth: z.string(),
      months: z.array(z.object({ month: z.string(), byCurrency: z.array(CostAmounts) })),
      items: z.array(
        z.object({
          id: Id,
          shortCode: z.string().nullable(),
          name: z.string().nullable(),
          locationId: Id,
          ended: z.boolean(),
          years: z.array(
            z.object({
              year: z.number().int(),
              soFar: z.boolean(),
              fills: z.number().int(),
              services: z.number().int(),
              byCurrency: z.array(CostAmounts).optional(),
            }),
          ),
          moneyHidden: z.literal(true).optional(),
        }),
      ),
      more: z.number().int(),
      hiddenIn: z.array(Id),
    })
    .nullable(),
  warranties: z
    .object({
      things: z.number().int(),
      covered: z.number().int(),
      expiring: z.number().int(),
      ended: z.number().int(),
      none: z.number().int(),
      expiringSoon: z.array(
        z.object({
          id: Id,
          shortCode: z.string().nullable(),
          name: z.string().nullable(),
          locationId: Id,
          endsOn: z.string(),
        }),
      ),
      repairs: z.array(
        z.object({
          year: z.number().int(),
          soFar: z.boolean(),
          resolved: z.number().int(),
          byCurrency: z
            .array(z.object({ currency: z.string(), cost: z.string(), covered: z.string() }))
            .optional(),
        }),
      ),
      hiddenIn: z.array(Id),
    })
    .nullable(),
});

export async function insightsRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  app.get(
    '/api/v1/insights',
    { schema: { querystring: Query, response: { 200: InsightsSchema } } },
    (req) =>
      scopedRead(pools, req, (tx, client, scope) => insightsOf(tx, client, scope, req.query)),
  );
}
