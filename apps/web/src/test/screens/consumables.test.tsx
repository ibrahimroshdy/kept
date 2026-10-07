/**
 * Consumables (step-7 plan T23; D14, D150, D172, D183): the AA batteries (12 left, keep at least
 * 16, in Home's kitchen) listed as low with Adjust; Adjust in Eastern digits with the Undo toast;
 * the viewer, module-off, offline and Arabic variants; the thing page's "Keep at least"; and
 * Home's "Low stock" row, last in the attention panel.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { pt } from '@/api/portability/mock/state';
import { parseAmount } from '@/components/consumables/stock.household';
import { FSI, PDI } from '@/lib/bidi';
import { expectLogicalOnly } from '@/test/render';
import { findHeading, renderApp } from '../app';

const BATTERIES = 'AA batteries';
/** The sheet's title, its name isolated (lib/bidi). */
const ADJUST = /^Adjust .AA batteries.$/;
const isolated = (before: string, name: string) => `${before} ${FSI}${name}${PDI}`;

afterEach(() => {
  vi.restoreAllMocks();
});

const row = (name = BATTERIES) => screen.findByRole('article', { name }, { timeout: 3000 });

function homeOff(state: MockState = ownerScenario()) {
  const home = state.locations.find((l) => l.id === IDS.home);
  if (!home) throw new Error('no Home');
  home.modules = home.modules.filter((m) => m !== 'consumables');
  if (home.effectiveModules)
    home.effectiveModules = home.effectiveModules.filter((m) => m !== 'consumables');
  return state;
}

describe('parsing a count', () => {
  it('takes Western and Eastern digits, and the Arabic decimal mark', () => {
    expect(parseAmount('20')).toBe(20);
    expect(parseAmount('٢٠')).toBe(20);
    expect(parseAmount('١٫٥')).toBe(1.5);
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('-1')).toBeNull();
    expect(parseAmount('a few')).toBeNull();
  });
});

describe('the consumables list', { timeout: 20_000 }, () => {
  it('lists the batteries as low, with what’s left, the minimum and where', async () => {
    await renderApp('/consumables', { digits: 'western' });
    await findHeading('Consumables');
    const batteries = within(await row());
    expect(batteries.getByText('Low')).toBeInTheDocument();
    expect(batteries.getByText(/12 left/)).toHaveTextContent(
      /^12 left.+keep at least 16.+Kitchen$/,
    );
    expect(batteries.getByRole('button', { name: `Adjust ${BATTERIES}` })).toBeEnabled();
  });

  it('adjusts the count in Eastern digits, with Undo', async () => {
    const { user, mock } = await renderApp('/consumables', { digits: 'western' });
    await user.click(within(await row()).getByRole('button', { name: `Adjust ${BATTERIES}` }));
    const sheet = await screen.findByRole('dialog', { name: ADJUST });
    const count = await within(sheet).findByRole('textbox', { name: 'How many are left' });
    expect(count).toHaveValue('12');
    await user.click(within(sheet).getByRole('button', { name: 'One more' }));
    expect(count).toHaveValue('13');
    await user.clear(count);
    await user.type(count, '٢٠');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    const thing = mock.state.inventory.things.find((t) => t.id === INV_IDS.thing.batteries);
    await waitFor(() => expect(thing?.quantity).toBe(20));
    expect(await screen.findByText(isolated('Adjusted', BATTERIES))).toBeVisible();
    // 20 is enough: no longer low.
    await waitFor(async () => expect(within(await row()).queryByText('Low')).toBeNull());
    expect(screen.getByText('Enough')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(thing?.quantity).toBe(12));
  });

  it('changes and removes the minimum from the same sheet', async () => {
    const { user, mock } = await renderApp('/consumables', { digits: 'western' });
    await user.click(within(await row()).getByRole('button', { name: `Adjust ${BATTERIES}` }));
    const sheet = await screen.findByRole('dialog', { name: ADJUST });
    const min = await within(sheet).findByRole('textbox', { name: 'Keep at least' });
    expect(min).toHaveValue('16');
    await user.clear(min);
    await user.type(min, '10');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(pt(mock.state).stockRules[0]?.minQuantity).toBe(10));
    expect(
      mock.lastCall('PUT', `/api/v1/things/${INV_IDS.thing.batteries}/stock-rule`)?.body,
    ).toEqual({ minQuantity: 10 });
  });

  it('a viewer sees the list and no Adjust', async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.role = 'viewer';
    await renderApp('/consumables', { state });
    const batteries = within(await row());
    expect(batteries.queryByRole('button', { name: /Adjust/ })).toBeNull();
  });

  it('says so where the module is off', async () => {
    await renderApp('/consumables', { state: homeOff() });
    expect(
      await screen.findByText('Things you run out of is off in your locations'),
    ).toBeInTheDocument();
  });

  it('says so in the location chosen, with Turn on for its admins', async () => {
    await renderApp(`/consumables?f.location=${IDS.home}`, { state: homeOff() });
    expect(
      await screen.findByText('Things you run out of is off in this location'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Turn on' })).toHaveAttribute(
      'href',
      `/settings/location/${IDS.home}/track`,
    );
  });

  it('offline, Adjust says it needs a connection', async () => {
    await renderApp('/consumables');
    await row();
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      window.dispatchEvent(new Event('offline'));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Needs a connection' })).toBeDisabled(),
      );
    } finally {
      offline.mockRestore();
      window.dispatchEvent(new Event('online'));
    }
  });

  it('reads right to left in Arabic, in Eastern digits', async () => {
    await renderApp('/consumables', { locale: 'ar' });
    const batteries = await row();
    expect(document.documentElement.dir).toBe('rtl');
    expect(batteries.textContent).toContain('١٢');
    expectLogicalOnly();
  });
});

describe('Keep at least on the thing page', { timeout: 20_000 }, () => {
  it('shows the minimum and Low, with Adjust', async () => {
    await renderApp(`/t/${INV_IDS.thing.batteries}`, { digits: 'western' });
    await findHeading(BATTERIES);
    const heading = await screen.findByRole(
      'heading',
      { name: 'Keep at least' },
      { timeout: 3000 },
    );
    const section = heading.closest('section') as HTMLElement;
    expect(within(section).getByText(/12 left/)).toBeInTheDocument();
    expect(within(section).getByText('Low')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: `Adjust ${BATTERIES}` })).toBeEnabled();
  });

  it('is absent where the module is off', async () => {
    await renderApp(`/t/${INV_IDS.thing.batteries}`, { state: homeOff() });
    await findHeading(BATTERIES);
    await screen.findByRole('heading', { name: 'Details' });
    expect(screen.queryByRole('heading', { name: 'Keep at least' })).toBeNull();
  });
});

describe('Home’s Low stock row', { timeout: 20_000 }, () => {
  it('counts the batteries, last in the panel, and opens Consumables', async () => {
    await renderApp('/');
    const heading = await screen.findByRole('heading', { name: 'Needs you' }, { timeout: 3000 });
    const panel = heading.closest('section') as HTMLElement;
    const links = within(panel).getAllByRole('link');
    const last = links[links.length - 1] as HTMLElement;
    expect(last.querySelector('[data-title]')?.textContent).toBe('Low stock');
    expect(last).toHaveAttribute('href', '/consumables?f.state=low');
  });

  it('is hidden where the module is off', async () => {
    await renderApp('/', { state: homeOff() });
    const heading = await screen.findByRole('heading', { name: 'Needs you' }, { timeout: 3000 });
    const panel = heading.closest('section') as HTMLElement;
    expect(within(panel).queryByText('Low stock')).toBeNull();
  });
});
