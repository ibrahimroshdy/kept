/**
 * A vehicle's running costs (plan T13; D26, D188; Q5, Q22), after the server's
 * `vehicles/costs.ts`: fuel is the fills' costs by their local month, service the confirmed
 * service records' totals by their date, fees the documents' costs by their issue date (renewals
 * included). Per currency, never added across currencies. The distance is the odometer's rise over
 * the full months only (`distanceBetween`), and the current month is "so far": never averaged.
 */
import { COST_CATEGORIES, type CostCategory, distanceBetween, perDistance } from '@kept/shared';
import { hh, localDate, locOf } from '../../household/mock/db';
import type { MockState } from '../../mock/fixtures';
import { type MockRoute, route } from '../../mock/kit';
import { vehiclePaths as p } from '../paths';
import type { CostAmounts, CostReport } from '../types';
import {
  acceptedReadings,
  ensureVehiclesSeeded,
  mainMeter,
  moneyShown,
  thingGate,
  vehiclesOf,
} from './state';

/** Whole cents as a canonical decimal string (`1985550` → `"19855.5"`). */
function centsOut(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const frac = String(abs % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${sign}${Math.floor(abs / 100)}${frac ? `.${frac}` : ''}`;
}

/** YYYY-MM of `offset` months from `month`. */
export function addMonths(month: string, offset: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return d.toISOString().slice(0, 7);
}

/** The instant a local month starts in `tz` (the UTC instant of its midnight). */
export function monthStart(month: string, tz: string): string {
  // Find the UTC instant whose local date is the 1st at 00:00: try the offsets Kept's zones use.
  for (let h = -14; h <= 14; h++) {
    const at = new Date(Date.parse(`${month}-01T00:00:00.000Z`) - h * 3_600_000);
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    if (localDate(tz, at) === `${month}-01` && Number(local) === 0) return at.toISOString();
  }
  return `${month}-01T00:00:00.000Z`;
}

export function costsRoutes(state: MockState): MockRoute[] {
  return [
    route('GET', p.thingCosts(':id'), ({ params, query }) => {
      ensureVehiclesSeeded(state);
      const g = thingGate(state, params.id, 'vehicles', 'read');
      if ('reply' in g) return g.reply;
      const t = g.thing;
      const tz = locOf(state, t.locationId)?.timezone ?? 'Africa/Cairo';
      const thisMonth = localDate(tz).slice(0, 7);
      const from = (query.get('from') ?? addMonths(thisMonth, -6)).slice(0, 7);
      const to = (query.get('to') ?? thisMonth).slice(0, 7);
      const months: string[] = [];
      for (let m = from; m <= to && months.length < 120; m = addMonths(m, 1)) months.push(m);

      // Amounts by month, currency and category.
      const sums = new Map<string, Map<string, Record<CostCategory, number>>>();
      const notes = new Map<string, string[]>();
      const add = (month: string, currency: string, cat: CostCategory, amount: string) => {
        if (!months.includes(month)) return;
        const byCur = sums.get(month) ?? new Map();
        const row = byCur.get(currency) ?? { fuel: 0, service: 0, fees: 0 };
        row[cat] += Math.round(Number(amount) * 100);
        byCur.set(currency, row);
        sums.set(month, byCur);
      };
      const v = vehiclesOf(state);
      for (const f of v.fills.filter((x) => x.thingId === t.id))
        if (f.cost && f.currency)
          add(localDate(tz, new Date(f.takenAt)).slice(0, 7), f.currency, 'fuel', f.cost);
      for (const r of hh(state).serviceRecords) {
        if (!('thingId' in r.subject) || r.subject.thingId !== t.id) continue;
        if (v.drafts.get(r.id)?.reviewState === 'draft') continue;
        const month = r.servicedOn.slice(0, 7);
        if (r.total) add(month, r.total.currency, 'service', r.total.amount);
        const label = r.completes[0]?.name ?? r.lines[0]?.description;
        if (label && months.includes(month)) notes.set(month, [...(notes.get(month) ?? []), label]);
      }
      for (const d of hh(state).documents) {
        if (!('thingId' in d.subject) || d.subject.thingId !== t.id) continue;
        const c = v.documentCosts.get(d.id);
        if (c?.issuedOn && c.cost && c.currency)
          add(c.issuedOn.slice(0, 7), c.currency, 'fees', c.cost);
      }

      const money = moneyShown(state, t.locationId);
      const out = centsOut;
      const amounts = (row: Record<CostCategory, number>): CostAmounts => ({
        fuel: out(row.fuel),
        service: out(row.service),
        fees: out(row.fees),
        total: out(row.fuel + row.service + row.fees),
      });
      const full = months.filter((m) => m < thisMonth);
      const meter = mainMeter(t);
      const distance =
        meter && full.length > 0
          ? distanceBetween(
              acceptedReadings(state, meter.id),
              monthStart(full[0] as string, tz),
              monthStart(addMonths(full.at(-1) as string, 1), tz),
            )
          : null;

      const report: CostReport = {
        period: {
          from: `${from}-01`,
          to: localDate(tz, new Date(Date.parse(monthStart(addMonths(to, 1), tz)) - 1)),
        },
        distance:
          distance && meter ? { value: distance, unit: meter.unit, basis: 'readings' } : null,
        months: months.map((month) => ({
          month,
          soFar: month === thisMonth,
          byCurrency: money
            ? [...(sums.get(month) ?? new Map<string, Record<CostCategory, number>>())].map(
                ([currency, row]) => ({ currency, ...amounts(row) }),
              )
            : [],
          notes: notes.get(month) ?? [],
        })),
        totals: [],
      };
      if (!money) return { ...report, moneyHidden: true };
      const totals = new Map<string, Record<CostCategory, number>>();
      for (const month of full) {
        for (const [currency, row] of sums.get(month) ?? []) {
          const acc = totals.get(currency) ?? { fuel: 0, service: 0, fees: 0 };
          for (const c of COST_CATEGORIES) acc[c] += row[c];
          totals.set(currency, acc);
        }
      }
      report.totals = [...totals].map(([currency, row]) => {
        const total = row.fuel + row.service + row.fees;
        const per = distance ? perDistance([{ amount: out(total), currency }], distance)[0] : null;
        return {
          currency,
          ...amounts(row),
          ...(per ? { perDistance: per.amount } : {}),
          monthlyAverage: (total / 100 / Math.max(1, full.length)).toFixed(2),
        };
      });
      return report;
    }),
  ];
}
