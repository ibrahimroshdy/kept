/**
 * Insights (1.x, D234), as `apps/server/src/insights/service.ts` answers it. Money is per currency
 * and never converted. Where a location's money is hidden from the reader, its amounts are left
 * out (`moneyHidden: true` on a row, its id in a section's `hiddenIn`); counts stay.
 */

export type Amount = { currency: string; amount: string };
export type CostAmounts = {
  currency: string;
  fuel: string;
  service: string;
  fees: string;
  total: string;
};

export type InsightsParams = { location?: string[] };

export type SpendingYear = {
  year: number;
  /** The current year: shown apart, never compared with full years (D188). */
  soFar: boolean;
  purchases: number;
  unpriced: number;
  byCurrency: Amount[];
};

export type PlaceValue = {
  /** Null for the folded rest (`others` places). */
  id: string | null;
  shortCode: string | null;
  name: string | null;
  unplaced: boolean;
  others?: number;
  things: number;
  valued?: number;
  byCurrency?: Amount[];
};

export type LocationValue = {
  locationId: string;
  things: number;
  valued?: number;
  byCurrency?: Amount[];
  moneyHidden?: true;
  places: PlaceValue[];
};

export type VehicleYear = {
  year: number;
  soFar: boolean;
  fills: number;
  services: number;
  byCurrency?: CostAmounts[];
};

export type VehicleCosts = {
  id: string;
  shortCode: string | null;
  name: string | null;
  locationId: string;
  ended: boolean;
  years: VehicleYear[];
  moneyHidden?: true;
};

export type Insights = {
  locations: Array<{ id: string; money: boolean; vehicles: boolean; warranties: boolean }>;
  thisYear: number;
  spending: { years: SpendingYear[]; hiddenIn: string[] };
  value: { locations: LocationValue[]; hiddenIn: string[] };
  vehicles: {
    thisMonth: string;
    months: Array<{ month: string; byCurrency: CostAmounts[] }>;
    items: VehicleCosts[];
    more: number;
    hiddenIn: string[];
  } | null;
  warranties: {
    things: number;
    covered: number;
    expiring: number;
    ended: number;
    none: number;
    expiringSoon: Array<{
      id: string;
      shortCode: string | null;
      name: string | null;
      locationId: string;
      endsOn: string;
    }>;
    repairs: Array<{
      year: number;
      soFar: boolean;
      resolved: number;
      byCurrency?: Array<{ currency: string; cost: string; covered: string }>;
    }>;
    hiddenIn: string[];
  } | null;
};
