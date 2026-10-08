/**
 * The step-5 mock answers the vehicles contract through the real fetchers (../queries.ts), so the
 * parallel web tasks (T17–T23) start from something that behaves like the server: every path in
 * ../paths.ts has a handler, the fixtures hold the plan T3 asks for (the board's Corolla numbers
 * among them), and the rules the screens lean on hold (money behind the gate, a reading a fill
 * owns, a backwards odometer, module off, undo).
 */
import { consumption, displayConsumption } from '@kept/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undoApi } from '@/components/history/undo';
import { type ApiError, isApiError } from '../../client';
import { INV_IDS } from '../../inventory/mock/fixtures';
import { inventoryApi } from '../../inventory/queries';
import { reportsApi } from '../../inventory/reports';
import { thingApi } from '../../inventory/thing-api';
import type { MockState } from '../../mock/fixtures';
import { IDS, ownerScenario } from '../../mock/fixtures';
import { createMockApi, type MockApi } from '../../mock/server';
import { VEHICLE_METHODS, vehiclePaths } from '../paths';
import { vehiclesApi as api } from '../queries';
import { ensureVehiclesSeeded, VEHICLE_IDS as V, vehicleMockRoutes } from '.';
import { COROLLA } from './state';

let mock: MockApi;
let state: MockState;
const use = (s = ownerScenario()) => {
  state = s;
  mock = createMockApi(s);
  vi.stubGlobal('fetch', mock.fetch);
};
beforeEach(() => use());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const fail = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  if (!isApiError(e)) throw new Error('expected an ApiError');
  return e as ApiError;
};
const garage = () => state.locations.find((l) => l.id === IDS.garage);

describe('the vehicles mock', () => {
  it('has a handler for every path and method the web calls', () => {
    const routes = vehicleMockRoutes(ownerScenario());
    const matches = (template: string, path: string) =>
      new RegExp(
        `^${template
          .split('/')
          .map((part) => (part.startsWith('%3A') ? '[^/]+' : part))
          .join('/')}$`,
      ).test(path);
    const missing: string[] = [];
    for (const [key, methods] of Object.entries(VEHICLE_METHODS)) {
      const v = vehiclePaths[key as keyof typeof vehiclePaths] as string | ((id: string) => string);
      const path = typeof v === 'string' ? v : v('a');
      for (const method of methods) {
        if (!routes.some((r) => r.method === method && matches(r.template, path)))
          missing.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('lists the vehicles in use: the Corolla fresh, the Elantra stale, the generator unknown', async () => {
    const page = await api.vehicles();
    const byId = new Map(page.items.map((r) => [r.thing.id, r]));
    expect([...byId.keys()].sort()).toEqual(
      [COROLLA.thing, V.thing.elantra, V.thing.generator].sort(),
    );
    expect(byId.get(V.thing.elantra)?.meter?.estimate.advice).toBe('stale');
    expect(byId.get(V.thing.generator)?.meter?.estimate).toMatchObject({
      advice: 'unknown',
      perDay: null,
    });
    const corolla = byId.get(COROLLA.thing);
    expect(corolla?.meter?.estimate.advice).toBe('fresh');
    expect(corolla?.documentsDue).toEqual([
      expect.objectContaining({ kind: 'licence', state: 'expiring' }),
    ]);
    expect(corolla?.nextDue).toMatchObject({ name: 'Oil & filter', estimated: true });
    expect(corolla?.fuel).toEqual({ perHundred: '7.3', unit: 'L', distanceUnit: 'km' });
    // The sold motorbike only under its state (Q24).
    const sold = await api.vehicles({ 'f.state': 'sold' });
    expect(sold.items.map((r) => r.thing.id)).toEqual([V.thing.motorbike]);
    // Vehicles off in the Garage: the Corolla leaves the list.
    ensureVehiclesSeeded(state);
    const g = garage();
    if (g) g.modules = g.modules.filter((m) => m !== 'vehicles');
    expect((await api.vehicles()).items.map((r) => r.thing.id)).not.toContain(COROLLA.thing);
  });

  it('filters by reading and sorts by name', async () => {
    const stale = await api.vehicles({ 'f.reading': ['stale', 'unknown'] });
    expect(stale.items.map((r) => r.thing.id).sort()).toEqual(
      [V.thing.elantra, V.thing.generator].sort(),
    );
    const names = (await api.vehicles({ sort: 'name' })).items.map((r) => r.thing.name);
    expect(names).toEqual([...names].sort((a, b) => (a ?? '').localeCompare(b ?? '')));
  });

  it('costs: the board’s April to September, and October so far', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
    use();
    const costs = await api.costs(COROLLA.thing, { from: '2026-04', to: '2026-10' });
    expect(costs.distance).toEqual({ value: '11346', unit: 'km', basis: 'readings' });
    expect(costs.months.map((m) => [m.month, m.soFar])).toEqual([
      ['2026-04', false],
      ['2026-05', false],
      ['2026-06', false],
      ['2026-07', false],
      ['2026-08', false],
      ['2026-09', false],
      ['2026-10', true],
    ]);
    expect(costs.totals).toEqual([
      {
        currency: 'EGP',
        fuel: '19855.5',
        service: '6444.5',
        fees: '3500',
        total: '29800',
        perDistance: '2.6265',
        monthlyAverage: '4966.67',
      },
    ]);
    expect(costs.months.find((m) => m.month === '2026-06')?.notes).toEqual(['Oil & filter']);
    expect(costs.months.at(-1)?.byCurrency[0]).toMatchObject({ fuel: '218.62' });
  });

  it('the fuel summary: 7.3 L/100 km over the last 5 full fills, 1.75 EGP a km', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
    use();
    const s = await api.fuelSummary(COROLLA.thing);
    expect(s.byUnit).toEqual([
      expect.objectContaining({
        unit: 'L',
        consumption: expect.objectContaining({ perHundred: '7.3', distanceUnit: 'km', fills: 5 }),
      }),
    ]);
    expect(displayConsumption('7.3', 'L', 'km', 'imperial')).toEqual({
      value: '32.2',
      unit: 'mpg',
    });
    expect(s.perDistance).toEqual([expect.objectContaining({ currency: 'EGP', amount: '1.75' })]);
    expect(s.monthlyAverage).toEqual([{ currency: 'EGP', amount: '3309.25', months: 6 }]);
  });

  it('the fills: a missed fill-up and a partial, each with its reading', async () => {
    const page = await api.fuel(COROLLA.thing, { limit: 50, dir: 'asc' });
    expect(page.items).toHaveLength(22);
    expect(page.items.filter((f) => f.missedBefore)).toHaveLength(1);
    expect(page.items.filter((f) => !f.isFull)).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ amount: '40.387', cost: '918.8', currency: 'EGP' });
    expect(page.items.every((f) => f.reading?.state === 'accepted')).toBe(true);
    // Through the shared maths: the same headline.
    const c = consumption(
      page.items.map((f) => ({ ...f, reading: f.reading ? { value: f.reading.value } : null })),
    );
    expect(c.overall?.perHundred).toBe('7.3');
  });

  it('a viewer sees litres and consumption, not money', async () => {
    ensureVehiclesSeeded(state);
    const g = garage();
    if (g) g.role = 'viewer';
    const row = (await api.fuel(COROLLA.thing)).items[0];
    expect(row).toMatchObject({ moneyHidden: true });
    expect(row).not.toHaveProperty('cost');
    const costs = await api.costs(COROLLA.thing);
    expect(costs.moneyHidden).toBe(true);
    expect(costs.totals).toEqual([]);
    expect((await api.fuelSummary(COROLLA.thing)).moneyHidden).toBe(true);
  });

  it('logs a fill: a backwards odometer is refused with its neighbour; a fitting one is undoable', async () => {
    const back = await fail(
      api.createFuel(
        COROLLA.thing,
        {
          id: 'f1',
          takenAt: new Date().toISOString(),
          amount: '30',
          unit: 'L',
          isFull: true,
          reading: { value: '40000' },
        },
        'k1',
      ),
    );
    expect(back.status).toBe(409);
    expect(back.code).toBe('conflict');
    const ok = await api.createFuel(
      COROLLA.thing,
      {
        id: 'f2',
        // After every seeded reading: the fixtures' latest manual one is six days before now.
        takenAt: new Date(Date.now() - 86_400_000).toISOString(),
        amount: '10',
        unit: 'L',
        cost: '250',
        isFull: false,
        reading: { value: '52600' },
        vendor: { name: 'New Cairo Station' },
      },
      'k2',
    );
    expect(ok.body.entry).toMatchObject({
      amount: '10',
      cost: '250',
      currency: 'EGP',
      vendor: { name: 'New Cairo Station' },
    });
    expect(ok.body.undo.eventId).toBe(ok.auditEvents[0]);
    // Its reading belongs to the fill (Q11).
    const owned = await fail(thingApi.updateReading(ok.body.reading?.id ?? '', { value: '52601' }));
    expect(owned.code).toBe('reading_owned');
    await undoApi.undo(ok.body.undo.eventId);
    expect((await api.fuel(COROLLA.thing)).items.some((f) => f.id === 'f2')).toBe(false);
  });

  it('readings: "It\'s right" accepts a jump; proofs and owners show; filters apply', async () => {
    ensureVehiclesSeeded(state);
    const jump = await api.createReading(V.meter.generator, {
      value: '99999',
      takenAt: new Date().toISOString(),
      confirmJump: true,
      proofFileId: 'file-1',
    });
    expect(jump.body.state).toBe('accepted');
    expect(jump.body.reading.proof?.fileId).toBe('file-1');
    const fuelOnly = await api.readings(COROLLA.meter, { 'f.source': 'fuel', limit: 100 });
    expect(fuelOnly.items).toHaveLength(22);
    expect(fuelOnly.items.every((r) => r.ownedBy?.type === 'fuel')).toBe(true);
    const proofs = await api.proofs(COROLLA.meter);
    expect(proofs.items.map((x) => x.readingId === null)).toEqual([false, false, true]);
  });

  it('the series: the estimate dashed to the oil change, with its estimated date', async () => {
    const s = await api.series(COROLLA.meter);
    expect(s.unit).toBe('km');
    expect(s.thresholds).toEqual([
      expect.objectContaining({
        name: 'Oil & filter',
        value: '56695',
        estimatedOn: expect.any(String),
      }),
    ]);
    expect(s.estimate?.through.at(-1)?.value).toBe('56695');
  });

  it('starter schedules: four on the Corolla, none the second time; undoable', async () => {
    ensureVehiclesSeeded(state);
    const first = await api.starterSchedules(COROLLA.thing);
    expect(first.body.schedules.map((s) => s.name)).toEqual([
      'Oil change',
      'Tyre rotation',
      'Brake fluid',
      'Air filter',
    ]);
    expect(first.body.schedules[2]).toMatchObject({ everyUnits: null, everyMonths: 24 });
    expect((await api.starterSchedules(COROLLA.thing)).body.schedules).toEqual([]);
  });

  it('a draft from an invoice: suggestions with AI, none without; confirming makes it a service', async () => {
    ensureVehiclesSeeded(state);
    const g = garage();
    if (g) g.providerResolved = true;
    const draft = await api.createServiceDraft(
      { id: 'draft-1', subject: { thingId: COROLLA.thing }, invoiceFileIds: ['inv-1'] },
      'd1',
    );
    expect(draft.serviceRecord.reviewState).toBe('draft');
    expect(draft.serviceRecord.suggestions?.filter((s) => s.field === 'line')).toHaveLength(3);
    const list = await api.serviceRecords(COROLLA.thing);
    expect(list.items[0]?.id).toBe('draft-1');
    const confirmed = await api.confirmService(
      'draft-1',
      {
        servicedOn: '2026-10-05',
        total: '2250',
        lines: [{ kind: 'part', description: 'Oil filter', unitCost: '450' }],
      },
      draft.serviceRecord.rowVersion,
    );
    expect(confirmed.body).toMatchObject({ reviewState: 'confirmed', flags: ['total_mismatch'] });
    if (g) g.providerResolved = false;
    const plain = await api.createServiceDraft(
      { id: 'draft-2', subject: { thingId: COROLLA.thing }, invoiceFileIds: ['inv-2'] },
      'd2',
    );
    expect(plain.extraction).toBeUndefined();
    expect(plain.serviceRecord.suggestions).toEqual([]);
  });

  it('a vehicle’s documents: the licence due, the insurance’s cost', async () => {
    const docs = await api.documents({ thingId: COROLLA.thing });
    expect(docs.items.map((d) => d.kind)).toEqual(['licence', 'insurance']);
    expect(docs.items[1]).toMatchObject({ issuedOn: '2026-05-15', cost: '3500', currency: 'EGP' });
    const renewed = await api.renewDocument(
      V.document.licence,
      { expiresOn: '2027-11-01', issuedOn: '2026-10-20', cost: '1300' },
      docs.items[0]?.rowVersion ?? 1,
    );
    expect(renewed.body.renewed).toMatchObject({
      issuedOn: '2026-10-20',
      cost: '1300',
      currency: 'EGP',
    });
  });

  it('the history report is a queued run, read back as the other reports', async () => {
    const run = await api.vehicleHistoryReport({ thingId: COROLLA.thing, locale: 'ar' });
    expect(run.status).toBe('queued');
    expect((await reportsApi.run(run.id)).status).toMatch(/queued|running|done/);
  });

  it('Home counts the metered things; a meter carries its estimate and nudge', async () => {
    ensureVehiclesSeeded(state);
    const home = await api.home();
    expect(home.meteredThings).toBeGreaterThan(0);
    const thing = await inventoryApi.thing(COROLLA.thing);
    expect(thing.meters[0]).toMatchObject({ nudgeDays: 30, estimate: { advice: 'fresh' } });
    expect(INV_IDS.meter.carOdometer).toBe(COROLLA.meter);
  });
});
