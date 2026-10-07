/**
 * A vehicle's page (step-5 plan T18; screens §5, §8; D26, D52, D188, D195): the tabs in the URL;
 * the Overview's odometer, schedules with estimated dates and the licence banner; Readings with the
 * proof strip and the chart's table; the Costs tab against the board's numbers, its table equal to
 * the bars, mirrored in Arabic; the viewer without money; a reading too old to estimate from;
 * starter schedules.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { ensureVehiclesSeeded, VEHICLE_IDS as V } from '@/api/vehicles/mock';
import { findHeading, renderApp } from '@/test/app';

vi.setConfig({ testTimeout: 30_000 });

const COROLLA = INV_IDS.thing.car;

function desktop() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width: 768px'),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

const seeded = (patch?: (s: MockState) => void) => {
  const state = ownerScenario();
  ensureVehiclesSeeded(state);
  patch?.(state);
  return state;
};

beforeEach(() => {
  // The board's day: October is the month "so far" (D188).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a vehicle’s tabs', () => {
  it('shows the seven vehicle tabs, then Details and the rest, and keeps the tab in the URL', async () => {
    desktop();
    const { user, router } = await renderApp(`/t/${COROLLA}`, { state: seeded() });
    await findHeading('Toyota Corolla');
    const tabs = await screen.findByRole('tablist', { name: 'Sections' });
    const names = within(tabs)
      .getAllByRole('tab')
      .map((t) => t.textContent);
    expect(names.slice(0, 8)).toEqual([
      'Overview',
      'Readings',
      'Services',
      'Fuel',
      'Schedules',
      'Documents',
      'Costs',
      'Details',
    ]);
    expect(names).toContain('History');
    expect(names).not.toContain('Meters');
    await user.click(within(tabs).getByRole('tab', { name: 'Costs' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'costs' }));
  });

  it('the Overview: the odometer, its age and source, the schedules with an estimated date, the licence', async () => {
    desktop();
    await renderApp(`/t/${COROLLA}`, { state: seeded(), digits: 'western' });
    await findHeading('Toyota Corolla');
    const odometer = await screen.findByRole('region', { name: 'Odometer' });
    expect(odometer).toHaveTextContent(/52,340 km/);
    await waitFor(() =>
      expect(odometer).toHaveTextContent(
        /Last reading \d+ days? ago, .+, (typed|from a \w+) by \w+/,
      ),
    );
    expect(
      await within(odometer).findByText(/About [\d,]+ km a day over the last \d+ days/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Licence due in \d+ days, on/)).toBeInTheDocument();
    expect(await screen.findByText('Oil & filter')).toBeInTheDocument();
    expect(await screen.findAllByText(/^estimated ~/)).not.toHaveLength(0);
  });
});

describe('the action menu', () => {
  it('has History report for a vehicle, which opens its sheet (T23)', async () => {
    desktop();
    const { user } = await renderApp(`/t/${COROLLA}`, { state: seeded() });
    await findHeading('Toyota Corolla');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'History report' }));
    expect(await screen.findByRole('dialog', { name: 'History report' })).toBeInTheDocument();
  });
});

describe('the Costs tab', () => {
  it('the board’s numbers, October so far, and a table that says what the bars say', async () => {
    desktop();
    await renderApp(`/t/${COROLLA}?tab=costs`, { state: seeded(), digits: 'western' });
    await findHeading('Toyota Corolla');
    expect(await screen.findByText(/29,800/)).toBeInTheDocument();
    expect(screen.getByText(/2\.63/)).toBeInTheDocument();
    expect(screen.getByText('October 2026 so far')).toBeInTheDocument();
    expect(screen.getByText('not compared with full months')).toBeInTheDocument();
    const table = document.querySelector('[data-chart-table]');
    // The disclosure renders its table once opened.
    if (!table) {
      const { userEvent } = await import('@testing-library/user-event');
      await userEvent.setup().click(screen.getByRole('button', { name: 'Show as table' }));
    }
    const rows = await waitFor(() => {
      const r = document.querySelectorAll('[data-chart-table] tbody tr');
      if (r.length === 0) throw new Error('no table yet');
      return [...r];
    });
    expect(rows.map((r) => r.getAttribute('data-row'))).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    // Every bar's label carries the same amount as its table cell (the spike's rule).
    const marks = await waitFor(() => {
      const m = document.querySelectorAll('rect[data-mark]');
      if (m.length === 0) throw new Error('no bars yet');
      return [...m];
    });
    for (const mark of marks) {
      const [mi, si] = (mark.getAttribute('data-mark') ?? '').split(':').map(Number);
      const row = rows[mi as number] as HTMLElement;
      const key = ['fuel', 'service', 'fees'][si as number];
      const cell = row.querySelector(`[data-key="${key}"]`)?.textContent ?? '';
      expect(mark.getAttribute('aria-label')).toContain(cell);
    }
  });

  it('in Arabic, the months run right to left and the digits are Eastern; the svg stays ltr', async () => {
    desktop();
    await renderApp(`/t/${COROLLA}?tab=costs`, {
      state: seeded(),
      locale: 'ar',
      digits: 'eastern',
    });
    const marks = await waitFor(() => {
      const m = [...document.querySelectorAll('rect[data-mark]')];
      if (m.length === 0) throw new Error('no bars yet');
      return m;
    });
    const svg = marks[0]?.closest('svg') as SVGSVGElement;
    expect(svg.style.direction).toBe('ltr');
    const xOf = (month: number) =>
      Number(
        marks.find((m) => m.getAttribute('data-mark')?.startsWith(`${month}:`))?.getAttribute('x'),
      );
    expect(xOf(0)).toBeGreaterThan(xOf(5));
    expect(marks[0]?.getAttribute('aria-label')).toMatch(/[٠-٩]/);
  });

  it('a viewer without money sees the distance and the notice, and no amounts', async () => {
    desktop();
    const state = seeded((s) => {
      const g = s.locations.find((l) => l.id === IDS.garage);
      if (g) g.role = 'viewer';
    });
    await renderApp(`/t/${COROLLA}?tab=costs`, { state, digits: 'western' });
    expect(await screen.findByText('Costs are hidden in this location')).toBeInTheDocument();
    expect(screen.getByText(/11,346 km/)).toBeInTheDocument();
    expect(screen.queryByText(/29,800/)).toBeNull();
    expect(document.querySelector('rect[data-mark]')).toBeNull();
  });
});

describe('Readings and estimates', () => {
  it('the readings tab: the chart’s table and the list, owned readings pointing at their fill', async () => {
    desktop();
    const { user } = await renderApp(`/t/${COROLLA}?tab=readings`, {
      state: seeded(),
      digits: 'western',
    });
    await findHeading('Toyota Corolla');
    expect(await screen.findByRole('list', { name: 'Readings' })).toBeInTheDocument();
    expect((await screen.findAllByText('Part of a fill: change it there')).length).toBeGreaterThan(
      0,
    );
    await user.click(await screen.findByRole('button', { name: 'Show as table' }));
    const rows = await waitFor(() => {
      const r = document.querySelectorAll('[data-chart-table] tbody tr');
      if (r.length === 0) throw new Error('no table');
      return [...r];
    });
    expect(rows.length).toBeGreaterThan(5);
  });

  it('a 70-day-old reading says "unknown: reading needed" and gives no estimated dates', async () => {
    desktop();
    await renderApp(`/t/${V.thing.generator}`, { state: seeded(), digits: 'western' });
    await findHeading('مولد الكهرباء');
    expect(await screen.findByText('Unknown: reading needed')).toBeInTheDocument();
    expect(screen.queryByText(/^estimated ~/)).toBeNull();
  });
});

describe('starter schedules', () => {
  it('offers the four on a vehicle with none, and makes the ticked ones', async () => {
    desktop();
    const state = seeded((s) => {
      const fam = s.locations.find((l) => l.id === IDS.family);
      if (fam && !fam.modules.includes('schedules')) {
        fam.modules = [...fam.modules, 'schedules'];
        fam.effectiveModules = fam.modules;
      }
    });
    const { user } = await renderApp(`/t/${V.thing.generator}?tab=schedules`, { state });
    await findHeading('مولد الكهرباء');
    await user.click(await screen.findByRole('button', { name: 'Add starter schedules' }));
    const dialog = await screen.findByRole('dialog', { name: 'Starter schedules' });
    // An hours meter: months alone (Q25).
    expect(within(dialog).getAllByText(/^Every \d+ months$/).length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole('checkbox', { name: /Brake fluid/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Added 3 schedules')).toBeInTheDocument();
    expect(await screen.findByRole('article', { name: 'Oil change' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Brake fluid' })).toBeNull();
  });
});
