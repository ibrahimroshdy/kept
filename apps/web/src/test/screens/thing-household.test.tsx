/**
 * The thing page's household parts (step 4, T20; screens §5 Thing detail, frames "Samsung TV" and
 * "Bosch drill on the Loans tab"): warranties with the coverage bar and their defaults, claims
 * with "Warranty saved you", the value behind the money gate, loans (lend, mark returned with
 * Undo), schedules, the derived states in the header and the action menu; the viewer, module-off
 * and offline variants, and Arabic.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUSEHOLD_IDS as H } from '@/api/household/mock/state';
import { householdPaths as hp } from '@/api/household/paths';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const T = INV_IDS.thing;

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

function withLocation(id: string, patch: (l: MockState['locations'][number]) => void): MockState {
  const s = ownerScenario();
  const l = s.locations.find((x) => x.id === id);
  if (!l) throw new Error('fixture');
  patch(l);
  return s;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Samsung TV (in repair, two warranties)', () => {
  it('reads "At Samsung Service Centre", usually in its place, and hides Lend and Split', async () => {
    const { user } = await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    expect(document.querySelector('[data-status="in_repair"]')).toHaveTextContent(
      'At Samsung Service Centre',
    );
    const path = screen.getByRole('navigation', { name: 'Where it usually is' });
    expect(within(path).getByText('Usually in')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /^Lend/ })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Split' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Mark returned' })).toBeNull();
  });

  it('lists the warranties longest first, each with its coverage bar', async () => {
    await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    expect(await screen.findByRole('heading', { name: 'Warranties · 2' })).toBeInTheDocument();
    const cards = screen
      .getAllByRole('article')
      .filter((a) => /warranty/i.test(a.textContent ?? ''));
    expect(cards[0]).toHaveTextContent('Store warranty');
    expect(cards[0]).toHaveTextContent('Longest cover');
    expect(cards[0]).toHaveTextContent('B.TECH');
    expect(cards[1]).toHaveTextContent('Manufacturer warranty');
    expect(screen.getAllByRole('img', { name: /^Covered from / })).toHaveLength(2);
  });

  it('adds a warranty from the brand default, labelled as such, with the card', async () => {
    const { user, mock } = await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    const heading = await screen.findByRole('heading', { name: 'Warranties · 2' });
    const block = heading.closest('section') as HTMLElement;
    await user.click(within(block).getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a warranty' });
    expect(
      await within(dialog).findByText('Samsung: 2 years (from the brand)'),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Months')).toHaveValue('24');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', hp.thingWarranties(T.tv))?.body).toMatchObject({
        kind: 'manufacturer',
        termMonths: 24,
        provider: 'Samsung',
      }),
    );
    expect(await screen.findByText('Warranty added')).toBeInTheDocument();
  });

  it('a claim resolved at no cost says what the warranty saved, with Undo', async () => {
    desktop();
    const { user, mock } = await renderApp(`/t/${T.tv}?tab=claims`);
    await findHeading('Samsung TV, 55″');
    const card = (await screen.findByText('SR-4471902')).closest('article') as HTMLElement;
    expect(within(card).getByText('Samsung Service Centre')).toBeInTheDocument();
    expect(within(card).getByText('In repair', { selector: 'li' })).toHaveAttribute(
      'aria-current',
      'step',
    );
    // "In repair" once as the pill and once as the step, not in the eyebrow too (L5).
    expect(within(card).getByText('Claim · open')).toBeInTheDocument();
    expect(within(card).getAllByText('In repair')).toHaveLength(2);
    await user.click(within(card).getByRole('button', { name: 'Update' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update the claim' });
    const status = within(dialog).getByRole('combobox', { name: 'Status' });
    await user.clear(status);
    await user.type(status, 'Res');
    await user.click(await screen.findByRole('option', { name: 'Resolved' }));
    await user.type(within(dialog).getByLabelText('What it would have cost'), '3000');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('PATCH', hp.claim(H.claim.tvRepair))?.body).toMatchObject({
        status: 'resolved',
        coveredAmount: '3000',
      }),
    );
    expect(await screen.findByText(/Warranty saved you/)).toHaveTextContent('3,000');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    // No longer in repair: the header drops the service centre.
    await waitFor(() => expect(document.querySelector('[data-status="in_repair"]')).toBeNull());
  });

  it('shows the current value with its source and date', async () => {
    desktop();
    await renderApp(`/t/${T.tv}?tab=value`);
    await findHeading('Samsung TV, 55″');
    expect(await screen.findAllByText('EGP 21,000.00')).not.toHaveLength(0);
    expect(screen.getByText(/Estimate by/)).toHaveTextContent('the only valuation');
  });
});

describe('the Bosch drill (lent to Murdock, overdue)', () => {
  it('reads "With Murdock since … · due … · overdue" and marks it returned, with Undo', async () => {
    desktop();
    const { user, mock } = await renderApp(`/t/${T.drill}?tab=loans`);
    await findHeading('Bosch drill, 18 V');
    // The person's name is isolated in the line (UI step-4 review L9).
    const line = screen.getByText(
      (_, el) =>
        /^With Murdock since .* · due .* · overdue$/.test(el?.textContent ?? '') &&
        ![...(el?.children ?? [])].some((c) => /^With Murdock/.test(c.textContent ?? '')),
    );
    expect(line.querySelector('bdi')).toHaveTextContent(/^Murdock$/);
    expect(screen.getByRole('tab', { name: 'Loans · 1 open' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText('2 days overdue')).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'P' && /It never messages Murdock;/.test(el.textContent ?? ''),
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark returned' }));
    const dialog = await screen.findByRole('dialog', { name: /^Back from \u2068Murdock\u2069$/ });
    expect(within(dialog).getByText(/Tool wall/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Mark returned' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', hp.loanReturn(H.loan.drill))?.body).toMatchObject({
        to: 'previous',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(await screen.findByText('Not lent out')).toBeInTheDocument();
  });

  it('copies a polite reminder and never sends it', async () => {
    desktop();
    const { user } = await renderApp(`/t/${T.drill}?tab=loans`);
    await findHeading('Bosch drill, 18 V');
    await user.click(await screen.findByRole('button', { name: 'Copy a polite reminder' }));
    expect(await navigator.clipboard.readText()).toMatch(
      /^Hi Murdock, a friendly reminder about the Bosch drill/,
    );
    expect(await screen.findByText('Reminder copied')).toBeInTheDocument();
  });
});

describe('lending part of a quantity', () => {
  it('lends 2 of the 3 HDMI cables to a new person, with a due date', async () => {
    const { user, mock } = await renderApp(`/t/${T.hdmiCable}?sheet=lend`);
    const dialog = await screen.findByRole('dialog', { name: 'Lend HDMI cable, 2 m' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Lend to' }), 'Louis K');
    const count = within(dialog).getByLabelText('How many');
    await user.clear(count);
    await user.type(count, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Lend' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', hp.thingLend(T.hdmiCable))?.body).toMatchObject({
        person: { name: 'Louis K' },
        quantity: '2',
      }),
    );
    expect(await screen.findByText('Lent to \u2068Louis K\u2069')).toBeInTheDocument();
  });
});

describe('variants', () => {
  it('a viewer reads warranties and claims but gets no Add, New claim or Update, and no value', async () => {
    desktop();
    const s = withLocation(IDS.home, (h) => {
      h.role = 'viewer';
      h.moneyVisibleToViewers = false;
    });
    await renderApp(`/t/${T.tv}?tab=paperwork`, { state: s });
    await findHeading('Samsung TV, 55″');
    expect(await screen.findByRole('heading', { name: 'Warranties · 2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    const { user } = await import('@testing-library/user-event').then((m) => ({
      user: m.default.setup(),
    }));
    await user.click(screen.getByRole('tab', { name: /^Claims/ }));
    expect(await screen.findByText('SR-4471902')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New claim' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Value' }));
    expect(await screen.findByText('Hidden in this location')).toBeInTheDocument();
    expect(screen.queryByText('EGP 21,000.00')).toBeNull();
  });

  it('with the modules off, the step-4 tabs are gone and Lend says "Off in this location"', async () => {
    desktop();
    const s = withLocation(IDS.home, (h) =>
      Object.assign(h, { preset: 'essentials', modules: [] }),
    );
    const { user } = await renderApp(`/t/${T.hdmiCable}`, { state: s });
    await findHeading('HDMI cable, 2 m');
    const tabs = screen.getAllByRole('tab').map((x) => x.textContent);
    for (const gone of ['Value', 'Loans', 'Claims', 'Schedules'])
      expect(tabs.some((x) => x?.startsWith(gone))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const lend = await screen.findByRole('menuitem', { name: /^Lend/ });
    expect(lend).toHaveTextContent('Off in this location');
  });

  it('with Lending off, a thing still on loan can be marked returned (UI step-4 review L3)', async () => {
    desktop();
    const s = withLocation(IDS.home, (h) =>
      Object.assign(h, { preset: 'essentials', modules: [] }),
    );
    const { user, mock } = await renderApp(`/t/${T.drill}`, { state: s });
    await findHeading('Bosch drill, 18 V');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mark returned' }));
    const dialog = await screen.findByRole('dialog', { name: /^Back from/ });
    await user.click(await within(dialog).findByRole('button', { name: 'Mark returned' }));
    await waitFor(() => expect(mock.lastCall('POST', hp.loanReturn(H.loan.drill))).toBeTruthy());
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('offline, the writes are disabled with the reason', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    const heading = await screen.findByRole('heading', { name: 'Warranties · 2' });
    const block = heading.closest('section') as HTMLElement;
    expect(within(block).getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(within(block).getByText('Needs a connection')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('Arabic: right to left, logical CSS only', async () => {
    await renderApp(`/t/${T.tv}`, { locale: 'ar' });
    await screen.findByRole('heading', { level: 1 });
    expect(document.documentElement.dir).toBe('rtl');
    await screen.findAllByRole('img', { name: /./ });
    expectLogicalOnly();
  });
});
