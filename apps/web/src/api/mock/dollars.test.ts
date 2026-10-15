/**
 * `inDollars`: the demo the docs screenshots show (`?demo=…&showcase=1`) has its money in US
 * dollars, at 25 pounds to the dollar, while the fixtures themselves keep the Egyptian pounds the
 * tests assert.
 */
import { describe, expect, it } from 'vitest';
import { hh } from '../household/mock/db';
import { insightsOf } from '../insights/mock';
import { INV_IDS } from '../inventory/mock/fixtures';
import { ops } from '../ops/mock/state';
import { ensureVehiclesSeeded, VEHICLE_IDS } from '../vehicles/mock/state';
import { dollars, inDollars } from './dollars';
import { IDS, ownerScenario } from './fixtures';

const sum = (xs: string[]) => String(xs.reduce((n, x) => n + Math.round(Number(x) * 100), 0) / 100);

describe('dollars', () => {
  it('turns pounds into cents at 25 to the dollar', () => {
    expect(dollars('28999.00')).toBe('1159.96');
    expect(dollars('122800')).toBe('4912');
    expect(dollars('594.5')).toBe('23.78');
    expect(dollars('918.8')).toBe('36.75');
  });
});

describe('inDollars', () => {
  it('leaves the fixtures in pounds', () => {
    const state = ownerScenario();
    expect(state.locations.find((l) => l.id === IDS.home)?.currency).toBe('EGP');
    const home = insightsOf(state, []).value.locations.find((l) => l.locationId === IDS.home);
    expect(home?.byCurrency).toEqual([
      { currency: 'EGP', amount: '122800' },
      { currency: 'USD', amount: '150' },
    ]);
    ensureVehiclesSeeded(state);
    expect(ensureVehiclesSeeded(state).fills.every((f) => f.currency === 'EGP')).toBe(true);
  });

  it('turns every location and every amount the state holds into dollars', () => {
    const state = ownerScenario();
    inDollars(state);

    expect(state.locations.every((l) => l.currency === 'USD')).toBe(true);
    // The USD→EGP exchange rate and the currency list keep their codes: they aren't amounts.
    const json = JSON.stringify(state);
    expect(json).not.toContain('"currency":"EGP"');

    const tv = state.inventory.things.find((t) => t.id === INV_IDS.thing.tv);
    expect(tv?.purchase).toMatchObject({ currency: 'USD', unitPrice: '1159.96', quantity: 1 });
    const valuation = state.household.valuations.find((v) => v.thingId === INV_IDS.thing.tv);
    expect(valuation).toMatchObject({ currency: 'USD', amount: '840' });

    // A receipt's lines move with it, so they still add up to its total.
    const receipts = state.capture.inbox.flatMap((i) => (i.receipt ? [i.receipt] : []));
    const ace = receipts.find((r) => r.vendorSeen === 'Ace Hardware');
    expect(ace).toMatchObject({ currency: 'USD', total: '232' });
    expect(sum(ace?.lines.map((l) => l.unitPrice ?? '0') ?? [])).toBe('232');
  });

  it('turns what the mock seeds later, and the Insights figures, into dollars', () => {
    const state = ownerScenario();
    inDollars(state);

    const v = ensureVehiclesSeeded(state);
    expect(v.fills.every((f) => f.currency === 'USD')).toBe(true);
    const oil = hh(state).serviceRecords.find((r) => r.id === VEHICLE_IDS.serviceRecord.oilChange);
    expect(oil?.total).toEqual({ amount: '90', currency: 'USD' });
    expect(
      sum(oil?.lines.map((l) => String(Number(l.quantity) * Number(l.unitCost?.amount))) ?? []),
    ).toBe('90');
    expect(v.documentCosts.get(VEHICLE_IDS.document.insurance)).toMatchObject({
      cost: '140',
      currency: 'USD',
    });

    const tvExtra = ops(state).extras.find((x) => x.thingId === INV_IDS.thing.tv);
    expect(tvExtra?.purchase).toMatchObject({ price: '759.96', currency: 'USD' });
    expect(tvExtra?.currentValue).toEqual({ amount: '600', currency: 'USD' });

    const insights = insightsOf(state, []);
    const home = insights.value.locations.find((l) => l.locationId === IDS.home);
    // 122,800 pounds and $150 meet in one dollar figure, as do the Kitchen's.
    expect(home?.byCurrency).toEqual([{ currency: 'USD', amount: '5062' }]);
    const kitchen = home?.places.find((p) => p.name === 'Kitchen');
    expect(kitchen?.byCurrency).toEqual([{ currency: 'USD', amount: '1122' }]);
    expect(insights.spending.years.at(-1)?.byCurrency).toEqual([
      { currency: 'USD', amount: '392' },
    ]);
    for (const month of insights.vehicles?.months ?? [])
      for (const c of month.byCurrency) {
        expect(c.currency).toBe('USD');
        expect(sum([c.fuel, c.service, c.fees])).toBe(c.total);
      }
    expect(JSON.stringify(insights)).not.toContain('EGP');
  });
});
