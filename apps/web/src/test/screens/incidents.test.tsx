/**
 * Plan T26 (D76, D136, D158; Q19–Q21): Account → Exchange rates, incidents (the list, the page,
 * the selection's Add to incident and "Mark these stolen"), the insurance report and the claim
 * pack, against the mock. Keyboard and viewer, module-off, offline and Arabic variants.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSeeded, hh } from '@/api/household/mock/db';
import { HOUSEHOLD_IDS } from '@/api/household/mock/state';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

const TV = 'Samsung TV, 55″';
const PHONE = 'Galaxy S23';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A burglary at Home, with the TV in it, recorded on 12 Sep 2026. */
function withBurglary(state: MockState) {
  ensureSeeded(state);
  hh(state).incidents.push({
    id: '01926f00-0000-7000-8000-000000299001',
    locationId: IDS.home,
    kind: 'burglary',
    occurredOn: '2026-09-12',
    policeReference: 'CR-2026-4471',
    insurerReference: null,
    notes: null,
    documents: [],
    createdBy: { displayName: 'Ibrahim' },
    rowVersion: 1,
    thingIds: [INV_IDS.thing.tv],
  });
  return '01926f00-0000-7000-8000-000000299001';
}

describe('Account → Exchange rates', () => {
  it('lists the pair, says rates are never estimated, and deletes one with Undo', async () => {
    const { user, mock } = await renderApp('/settings/account/exchange-rates');
    // The file's first render loads the on-demand route cold: under the full gate's load it took
    // over the default 5 s once (the final check).
    const pair = await screen.findByRole('region', { name: 'USD→EGP' }, { timeout: 20_000 });
    expect(within(pair).getByText(/1 USD = 48\.65 EGP/)).toBeInTheDocument();
    expect(screen.getByText(/never estimates one/)).toBeInTheDocument();
    await user.click(within(pair).getByRole('button', { name: /Delete the rate from/ }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Rate deleted')).toBeInTheDocument();
    await waitFor(() => expect(hh(mock.state).fxRates).toHaveLength(0));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(hh(mock.state).fxRates).toHaveLength(1));
  });

  it('changes a rate, reading Arabic digits and the Arabic decimal point', async () => {
    const { user, mock } = await renderApp('/settings/account/exchange-rates');
    const pair = await screen.findByRole('region', { name: 'USD→EGP' });
    await user.click(within(pair).getByRole('button', { name: /Change the rate from/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the rate' });
    const field = within(dialog).getByRole('textbox', { name: '1 USD is worth' });
    await user.clear(field);
    await user.type(field, '٤٩٫١٠');
    expect(within(dialog).getByText(/1 USD = 49\.1 EGP/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Rate changed')).toBeInTheDocument();
    expect(hh(mock.state).fxRates[0]?.rate).toBe('49.1');
  });

  it("in Bruce's account, where you're a member, you read the rates and can't change them", async () => {
    await renderApp(`/settings/account/exchange-rates?account=${INV_IDS.account.bruce}`);
    expect(
      await screen.findByText('Only an owner or admin of this account changes its rates.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('No exchange rates yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a rate' })).toBeNull();
  });

  it('offline, Add a rate is off and says why', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await renderApp('/settings/account/exchange-rates');
    expect(await screen.findByRole('button', { name: 'Add a rate' })).toBeDisabled();
  });
});

describe('incidents', () => {
  it('lists an incident with its things and references', async () => {
    await renderApp('/incidents', { setup: (m) => void withBurglary(m.state) });
    await findHeading('Incidents');
    const row = await screen.findByRole('article', { name: /^Burglary on/ });
    expect(within(row).getByText(/1 thing · 0 claims/)).toBeInTheDocument();
    expect(within(row).getByText('CR-2026-4471')).toBeInTheDocument();
  });

  it('has an empty state, and New incident records one and opens it', async () => {
    const { user, router, mock } = await renderApp('/incidents');
    expect(await screen.findByText('No incidents')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New incident' }));
    const dialog = await screen.findByRole('dialog', { name: 'New incident' });
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Police reference (optional)' }),
      'CR-1',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(pathOf(router)).toMatch(/^\/incidents\/.+/));
    expect(hh(mock.state).incidents).toHaveLength(1);
    expect(await screen.findByText('CR-1')).toBeInTheDocument();
  });

  it('marks its things stolen on the incident page, with Undo', async () => {
    let id = '';
    const { user, mock } = await renderApp('/incidents', {
      setup: (m) => {
        id = withBurglary(m.state);
      },
    });
    await user.click(await screen.findByRole('link', { name: /^Burglary on/ }));
    await findHeading(/^Burglary on/);
    expect(screen.getByRole('list', { name: /^Things in Burglary/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark these stolen' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Mark these stolen' }));
    expect(await screen.findByText('Ended 1 thing')).toBeInTheDocument();
    const tv = mock.state.inventory.things.find((t) => t.id === INV_IDS.thing.tv);
    expect(tv?.lifecycle).toBe('stolen');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(tv?.lifecycle).toBe('in_use'));
    expect(id).not.toBe('');
  });

  it('takes a thing out of the incident, with Undo', async () => {
    let id = '';
    const { user, mock } = await renderApp('/incidents', {
      setup: (m) => {
        id = withBurglary(m.state);
      },
    });
    await user.click(await screen.findByRole('link', { name: /^Burglary on/ }));
    await user.click(await screen.findByRole('button', { name: `Take ${TV} out of the incident` }));
    const incident = () => hh(mock.state).incidents.find((i) => i.id === id);
    await waitFor(() => expect(incident()?.thingIds).toEqual([]));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(incident()?.thingIds).toEqual([INV_IDS.thing.tv]));
  });

  it('an owner can add a document to it', async () => {
    const state = ownerScenario();
    const id = withBurglary(state);
    await renderApp(`/incidents/${id}`, { state });
    await findHeading(/^Burglary on/);
    expect(screen.getByRole('button', { name: 'Add a document' })).toBeInTheDocument();
  });

  it('a viewer reads it, with no edit, delete, mark or claim pack', async () => {
    const state = ownerScenario();
    const id = withBurglary(state);
    for (const l of state.locations) l.role = 'viewer';
    await renderApp(`/incidents/${id}`, { state });
    await findHeading(/^Burglary on/);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark these stolen' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Claim pack' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New incident' })).toBeNull();
  });

  it('reads right to left in Arabic, in logical CSS', async () => {
    const state = ownerScenario();
    const id = withBurglary(state);
    await renderApp(`/incidents/${id}`, { state, locale: 'ar' });
    await screen.findByRole('list', { name: /سرقة/ });
    expect(document.documentElement.dir).toBe('rtl');
    expectLogicalOnly();
  });
});

describe('Add to incident, from a location', () => {
  it('records a new incident from the selection and marks the things stolen', async () => {
    const { user, router, mock } = await renderApp(`/loc/${IDS.home}`);
    await screen.findByRole('list', { name: 'Contents of Home' });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('checkbox', { name: `Select ${PHONE}` }));
    const bar = screen.getByRole('toolbar', { name: 'Selection' });
    await user.click(within(bar).getByRole('button', { name: 'Add to incident' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add 1 thing to an incident' });
    await user.click(await within(dialog).findByRole('checkbox', { name: /Mark these stolen/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(pathOf(router)).toMatch(/^\/incidents\/.+/));
    const incident = hh(mock.state).incidents[0];
    expect(incident?.thingIds).toEqual([INV_IDS.thing.phone]);
    const phone = mock.state.inventory.things.find((t) => t.id === INV_IDS.thing.phone);
    expect(phone?.lifecycle).toBe('stolen');
  });

  it('adds to an existing incident, with Undo', async () => {
    let id = '';
    const { user, mock } = await renderApp(`/loc/${IDS.home}`, {
      setup: (m) => {
        id = withBurglary(m.state);
      },
    });
    await screen.findByRole('list', { name: 'Contents of Home' });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('checkbox', { name: `Select ${PHONE}` }));
    await user.click(screen.getByRole('button', { name: 'Add to incident' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add 1 thing to an incident' });
    expect(await within(dialog).findByRole('radio', { name: /^Burglary on/ })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    const incident = () => hh(mock.state).incidents.find((i) => i.id === id);
    await waitFor(() => expect(incident()?.thingIds).toContain(INV_IDS.thing.phone));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(incident()?.thingIds).toEqual([INV_IDS.thing.tv]));
  });

  it('with Warranties & claims off, there is no Add to incident', async () => {
    const state = ownerScenario();
    for (const l of state.locations) {
      l.modules = l.modules.filter((m) => m !== 'warranties');
      l.effectiveModules = l.modules;
    }
    const { user } = await renderApp(`/loc/${IDS.home}`, { state });
    await screen.findByRole('list', { name: 'Contents of Home' });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.queryByRole('button', { name: 'Add to incident' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Incidents' })).toBeNull();
  });

  it("a member doesn't get Add to incident", async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.role = 'member';
    const { user } = await renderApp(`/loc/${IDS.home}`, { state });
    await screen.findByRole('list', { name: 'Contents of Home' });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.queryByRole('button', { name: 'Add to incident' })).toBeNull();
  });
});

describe('the insurance report', () => {
  it('makes the PDF for a location and offers it', async () => {
    const { user } = await renderApp(`/reports/insurance?loc=${IDS.home}`);
    await findHeading('Insurance report');
    await user.click(await screen.findByRole('button', { name: 'Make the PDF' }));
    expect(await screen.findByText('Your PDF is ready', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open PDF' })).toBeInTheDocument();
  });

  it('lists the missing pairs when a converted total has no rate', async () => {
    const { user, mock } = await renderApp(`/reports/insurance?loc=${IDS.home}`, {
      setup: (m) => {
        ensureSeeded(m.state);
        hh(m.state).fxRates = [];
      },
    });
    await findHeading('Insurance report');
    const picker = await screen.findByRole('combobox', { name: 'Also total in (optional)' });
    await user.type(picker, 'USD');
    await user.click(await screen.findByRole('option', { name: /USD/ }));
    await user.click(screen.getByRole('button', { name: 'Make the PDF' }));
    const missing = await screen.findByRole('list', { name: 'Missing rates' });
    expect(within(missing).getByText('EGP → USD')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add exchange rates' })).toBeInTheDocument();
    expect(mock.state).toBeTruthy();
  });

  it('for an incident, names it', async () => {
    const state = ownerScenario();
    const id = withBurglary(state);
    await renderApp(`/reports/insurance?incident=${id}`, { state });
    expect(await screen.findByText(/^Burglary on/)).toBeInTheDocument();
  });

  it('says so where money is off', async () => {
    const state = ownerScenario();
    for (const l of state.locations) {
      l.modules = l.modules.filter((m) => m !== 'money');
      l.effectiveModules = l.modules;
    }
    await renderApp('/reports/insurance', { state });
    expect(await screen.findByText('No location to report on')).toBeInTheDocument();
  });
});

describe('the claim pack', () => {
  it('needs the warning ticked, then makes the pack and a link shown once', async () => {
    const state = ownerScenario();
    const id = withBurglary(state);
    const { user } = await renderApp(`/reports/claim-pack?incident=${id}`, { state });
    await findHeading('Claim pack');
    expect(await screen.findByText('This includes prices and documents')).toBeInTheDocument();
    const make = screen.getByRole('button', { name: 'Make the claim pack' });
    expect(make).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /shares prices and documents/ }));
    await user.click(make);
    expect(
      await screen.findByText('Your claim pack is ready', {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No link yet. Nobody can download it until you make one.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(
      await screen.findByText('Copy it now: Kept shows it only this once.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/\/x\/mock-/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(await screen.findByText('Not downloaded yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Link revoked')).toBeInTheDocument();
    expect(screen.queryByText(/\/x\/mock-/)).toBeNull();
  });

  it('resumes a pack from its link, with its downloads', async () => {
    await renderApp(`/reports/claim-pack?run=${HOUSEHOLD_IDS.claimPack.home}`);
    expect(await screen.findByText('Your claim pack is ready')).toBeInTheDocument();
    expect(screen.getByText(/Downloaded 1 time/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New link' })).toBeInTheDocument();
  });

  it('a member is told only owners and admins make one', async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.role = 'member';
    await renderApp(`/reports/claim-pack?loc=${IDS.home}&things=${INV_IDS.thing.tv}`, { state });
    expect(await screen.findByText('Only an owner or admin makes one')).toBeInTheDocument();
  });
});
