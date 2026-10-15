/**
 * Mock handler for Insights (1.x, D234): Home's spending, values, the Corolla's costs and the
 * warranties, as the server would add them up. Other locations with Money on come back empty. A
 * location's amounts are left out where the reader's role hides money there (a viewer, unless the
 * location lets viewers see it), as the server's gate does.
 */

import { INV_IDS } from '../inventory/mock/fixtures';
import { fixtureMoney, perCurrency } from '../mock/dollars';
import type { MockState } from '../mock/fixtures';
import { IDS } from '../mock/fixtures';
import { type MockRoute, route, sessionGate } from '../mock/kit';
import type { LocationDetail } from '../types';
import { insightsPaths as p } from './paths';
import type { CostAmounts, Insights, LocationValue, VehicleCosts } from './types';

/** The Corolla in the mock's Home (api/vehicles/mock). */
/**
 * The things and places Insights names are the inventory's own (api/inventory/mock/fixtures.ts),
 * so each link opens (D246: Try Kept's route walk found them leading nowhere).
 */
export const MOCK_INSIGHT_IDS = {
  corolla: INV_IDS.thing.car,
  phone: INV_IDS.thing.phone,
  tv: INV_IDS.thing.tv,
  living: INV_IDS.place.livingRoom,
  kitchen: INV_IDS.place.kitchen,
  bedroom: INV_IDS.place.bedroom,
  unplaced: INV_IDS.place.homeUnplaced,
} as const;

const showsMoney = (l: LocationDetail) =>
  l.modules.includes('money') && (l.role !== 'viewer' || l.moneyVisibleToViewers === true);

const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

/** A month's or a year's vehicle costs, written in Egyptian pounds (dollars in the showcase). */
const cost = (state: MockState, fuel: number, service: number, fees = 0): CostAmounts => {
  const egp = (n: number) => fixtureMoney(state, String(n));
  return {
    currency: egp(0).currency,
    fuel: egp(fuel).amount,
    service: egp(service).amount,
    fees: egp(fees).amount,
    total: egp(fuel + service + fees).amount,
  };
};

/** Amounts written in Egyptian pounds, beside any in dollars: one entry per currency. */
const inPounds = (
  state: MockState,
  egp: string,
  ...others: { currency: string; amount: string }[]
) => perCurrency([fixtureMoney(state, egp), ...others]);

/** A year's warranty repairs: what they cost and what the cover paid, in Egyptian pounds. */
const repair = (state: MockState, cost: string, covered: string) => ({
  currency: fixtureMoney(state, cost).currency,
  cost: fixtureMoney(state, cost).amount,
  covered: fixtureMoney(state, covered).amount,
});

function homeValue(state: MockState, money: boolean): LocationValue {
  const m = <T extends object>(o: T) => (money ? o : {});
  return {
    locationId: IDS.home,
    things: 136,
    ...m({
      valued: 36,
      byCurrency: inPounds(state, '122800', { currency: 'USD', amount: '150' }),
    }),
    ...(money ? {} : { moneyHidden: true as const }),
    places: [
      {
        id: MOCK_INSIGHT_IDS.kitchen,
        shortCode: null,
        name: 'Kitchen',
        unplaced: false,
        things: 61,
        ...m({
          valued: 12,
          byCurrency: inPounds(state, '24300', { currency: 'USD', amount: '150' }),
        }),
      },
      {
        id: MOCK_INSIGHT_IDS.living,
        shortCode: null,
        name: 'Living room',
        unplaced: false,
        things: 42,
        ...m({ valued: 18, byCurrency: inPounds(state, '86500') }),
      },
      {
        id: MOCK_INSIGHT_IDS.bedroom,
        shortCode: null,
        name: 'Bedroom',
        unplaced: false,
        things: 30,
        ...m({ valued: 6, byCurrency: inPounds(state, '12000') }),
      },
      {
        id: MOCK_INSIGHT_IDS.unplaced,
        shortCode: null,
        name: 'Unplaced',
        unplaced: true,
        things: 3,
        ...m({ valued: 0, byCurrency: [] }),
      },
    ],
  };
}

export function insightsOf(state: MockState, filter: string[]): Insights {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  const Y = Number(today.slice(0, 4));
  const thisMonth = today.slice(0, 7);
  const locs = state.locations.filter(
    (l) => l.modules.includes('money') && (filter.length === 0 || filter.includes(l.id)),
  );
  const home = locs.find((l) => l.id === IDS.home);
  const homeMoney = home ? showsMoney(home) : false;
  const hiddenIn = locs.filter((l) => !showsMoney(l)).map((l) => l.id);
  const withVehicles = locs.filter((l) => l.modules.includes('vehicles'));
  const withWarranties = locs.filter((l) => l.modules.includes('warranties'));
  const amounts = <T>(list: T[]): T[] => (homeMoney ? list : []);

  const months = Array.from({ length: 12 }, (_, i) => addMonths(thisMonth, i - 12));
  const fuelOf = [1650, 1820, 1700, 2100, 1540, 1980, 2210, 1890, 1760, 2050, 1930, 1800];
  const serviceAt = new Map([
    [3, 3800],
    [9, 1400],
  ]);
  const corolla: VehicleCosts = {
    id: MOCK_INSIGHT_IDS.corolla,
    shortCode: 'CAR7TY',
    name: 'Toyota Corolla',
    locationId: IDS.home,
    ended: false,
    years: [Y - 2, Y - 1, Y].map((year) => ({
      year,
      soFar: year === Y,
      fills: year === Y ? 18 : 24,
      services: year === Y ? 1 : 3,
      ...(homeMoney
        ? {
            byCurrency: [
              year === Y
                ? cost(state, 16800, 1400)
                : year === Y - 1
                  ? cost(state, 21900, 6200, 4700)
                  : cost(state, 19800, 4100, 4300),
            ],
          }
        : {}),
    })),
    ...(homeMoney ? {} : { moneyHidden: true as const }),
  };

  return {
    locations: locs.map((l) => ({
      id: l.id,
      money: showsMoney(l),
      vehicles: l.modules.includes('vehicles'),
      warranties: l.modules.includes('warranties'),
    })),
    thisYear: Y,
    spending: {
      years: home
        ? [
            {
              year: Y - 3,
              soFar: false,
              purchases: 4,
              unpriced: 0,
              byCurrency: amounts(inPounds(state, '12400')),
            },
            {
              year: Y - 2,
              soFar: false,
              purchases: 7,
              unpriced: 0,
              byCurrency: amounts(inPounds(state, '31250', { currency: 'USD', amount: '420' })),
            },
            {
              year: Y - 1,
              soFar: false,
              purchases: 9,
              unpriced: homeMoney ? 1 : 0,
              byCurrency: amounts(inPounds(state, '48900')),
            },
            {
              year: Y,
              soFar: true,
              purchases: 5,
              unpriced: 0,
              byCurrency: amounts(inPounds(state, '9800')),
            },
          ]
        : [],
      hiddenIn,
    },
    value: {
      locations: locs.map((l) =>
        l.id === IDS.home
          ? homeValue(state, homeMoney)
          : {
              locationId: l.id,
              things: 0,
              ...(showsMoney(l) ? { valued: 0, byCurrency: [] } : { moneyHidden: true as const }),
              places: [],
            },
      ),
      hiddenIn,
    },
    vehicles: withVehicles.length
      ? {
          thisMonth,
          months: months.map((month, i) => ({
            month,
            byCurrency: home
              ? amounts([cost(state, fuelOf[i] ?? 0, serviceAt.get(i) ?? 0, i === 6 ? 3500 : 0)])
              : [],
          })),
          items: home && withVehicles.includes(home) ? [corolla] : [],
          more: 0,
          hiddenIn: withVehicles.filter((l) => !showsMoney(l)).map((l) => l.id),
        }
      : null,
    warranties: withWarranties.length
      ? {
          things: home ? 214 : 0,
          covered: home ? 38 : 0,
          expiring: home ? 2 : 0,
          ended: home ? 21 : 0,
          none: home ? 153 : 0,
          expiringSoon: home
            ? [
                {
                  id: MOCK_INSIGHT_IDS.phone,
                  shortCode: 'PH0N3S',
                  name: 'Galaxy S23',
                  locationId: IDS.home,
                  endsOn: `${addMonths(thisMonth, 1)}-03`,
                },
                {
                  id: MOCK_INSIGHT_IDS.tv,
                  shortCode: '5MT0QD',
                  name: 'Samsung TV, 55″',
                  locationId: IDS.home,
                  endsOn: `${addMonths(thisMonth, 1)}-20`,
                },
              ]
            : [],
          repairs: [Y - 1, Y].map((year) => ({
            year,
            soFar: year === Y,
            resolved: home && year === Y - 1 ? 1 : 0,
            ...(locs.some(showsMoney)
              ? {
                  byCurrency:
                    home && homeMoney && year === Y - 1 ? [repair(state, '1800', '1800')] : [],
                }
              : {}),
          })),
          hiddenIn: withWarranties.filter((l) => !showsMoney(l)).map((l) => l.id),
        }
      : null,
  };
}

export function insightsMockRoutes(state: MockState): MockRoute[] {
  return [
    route('GET', p.insights, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      return insightsOf(state, query.getAll('f.location'));
    }),
  ];
}
