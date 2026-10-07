/**
 * Short-ID addresses and own codes (D208, plan T17a): a thing or place opens by its short ID typed
 * any way, a UUID address is replaced in place by the short ID, a thing without one (created
 * offline, D112) keeps its UUID; "Your codes" on the thing and place pages; and a location's
 * numbering and format rule in Settings → General.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, pathOf, renderApp } from '@/test/app';

vi.setConfig({ testTimeout: 20_000 });

const T = INV_IDS.thing;
const P = INV_IDS.place;

function asViewer(state: MockState = ownerScenario()) {
  for (const l of state.locations) if (l.id === IDS.garage || l.id === IDS.home) l.role = 'viewer';
  return state;
}

describe('short-ID addresses', () => {
  it('/t/2hx-9rb and /t/<uuid> open the same thing, and the address becomes /t/2HX9RB in place', async () => {
    const typed = await renderApp('/t/2hx-9rb');
    await findHeading('Bosch drill, 18 V');
    await waitFor(() => expect(pathOf(typed.router)).toBe('/t/2HX9RB'));
    expect(typed.router.history.length).toBe(1);
    typed.unmount();

    const byId = await renderApp(`/t/${T.drill}?tab=overview`);
    await findHeading('Bosch drill, 18 V');
    await waitFor(() => expect(pathOf(byId.router)).toBe('/t/2HX9RB'));
    // Replaced, not pushed: no second history entry, and the search is kept.
    expect(byId.router.history.length).toBe(1);
    expect(byId.router.state.location.search).toMatchObject({ tab: 'overview' });
  });

  it('a thing created offline, with no short ID yet, opens by its UUID and keeps it', async () => {
    const state = ownerScenario();
    const scarves = state.inventory.things.find((x) => x.id === T.scarves);
    if (!scarves) throw new Error('fixture');
    scarves.shortCode = null;
    const { router } = await renderApp(`/t/${T.scarves}`, { state });
    await findHeading(scarves.name ?? '');
    await new Promise((r) => setTimeout(r, 50));
    expect(pathOf(router)).toBe(`/t/${T.scarves}`);
  });

  it('a place opens by its short ID or its UUID, and the address becomes the short ID', async () => {
    const { router } = await renderApp(`/p/${P.office}`);
    await findHeading('Office');
    await waitFor(() => expect(pathOf(router)).toBe('/p/R00M4K'));
    expect(router.history.length).toBe(1);
  });

  it('a code that is nothing here says it can’t load, like any missing thing', async () => {
    await renderApp('/t/zzzzzz');
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
  });

  it('lists link to things by their short ID', async () => {
    await renderApp(`/p/${P.toolWall}`);
    const link = await screen.findByRole('link', { name: /Bosch drill, 18 V/ });
    expect(link).toHaveAttribute('href', '/t/2HX9RB');
  });
});

describe('short addresses in place links and activity (D208)', () => {
  it('the place tree, a place row and the breadcrumb link a place by its short ID', async () => {
    await renderApp(`/loc/${IDS.home}`);
    const row = await screen.findByRole('link', { name: /^Office/ });
    expect(row).toHaveAttribute('href', '/p/R00M4K');
    for (const link of screen.getAllByRole('link', { name: 'Office' }))
      expect(link).toHaveAttribute('href', '/p/R00M4K');
  });

  it("a place page's breadcrumb links its parent by the short ID", async () => {
    await renderApp(`/p/${P.deskDrawer}`);
    await findHeading('Desk drawer');
    const path = await screen.findByRole('navigation', { name: 'Path' });
    await waitFor(() =>
      expect(within(path).getByRole('link', { name: 'Office' })).toHaveAttribute(
        'href',
        '/p/R00M4K',
      ),
    );
  });

  it('an activity row about a thing or place links to its short ID', async () => {
    const state = ownerScenario();
    const cable = state.inventory.things.find((x) => x.id === T.hdmiCable);
    if (!cable) throw new Error('fixture');
    cable.shortCode = 'HDM1CB';
    await renderApp('/activity', { state });
    const list = await screen.findByRole('list', { name: 'Activity' }, { timeout: 3000 });
    const row = within(list).getAllByRole('article')[0] as HTMLElement;
    expect(row).toHaveAccessibleName('Added HDMI cable, 2 m');
    expect(within(row).getByRole('link')).toHaveAttribute('href', '/t/HDM1CB');
  });
});

describe('own codes on a thing', () => {
  it('adds a code (stored in capitals, offered Undo), refuses a duplicate with a link to what has it', async () => {
    const { user } = await renderApp(`/t/${T.drill}?tab=overview`);
    await findHeading('Bosch drill, 18 V');
    const section = await screen.findByRole('form', { name: 'Add a code' });
    await user.type(within(section).getByLabelText('Add a code'), 'gar-0042');
    await user.click(within(section).getByRole('button', { name: 'Add' }));
    const list = await screen.findByRole('list', { name: 'Your codes' });
    expect(await within(list).findByText('GAR-0042')).toHaveAttribute('dir', 'ltr');
    const region = await screen.findByRole('region', { name: 'Notifications' });
    expect(await within(region).findByRole('button', { name: 'Undo' })).toBeInTheDocument();

    await user.type(within(section).getByLabelText('Add a code'), 'GAR-0042');
    await user.click(within(section).getByRole('button', { name: 'Add' }));
    expect(
      await within(section).findByText('This code is already on something else here.'),
    ).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'Open what has it' })).toHaveAttribute(
      'href',
      `/t/${T.drill}`,
    );
  });

  it('changes and removes a code', async () => {
    const { user } = await renderApp(`/t/${T.drill}?tab=overview`);
    await findHeading('Bosch drill, 18 V');
    const form = await screen.findByRole('form', { name: 'Add a code' });
    await user.type(within(form).getByLabelText('Add a code'), 'OLD-1');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('button', { name: 'Change OLD-1' }));
    const edit = await screen.findByRole('form', { name: 'Change OLD-1' });
    const field = within(edit).getByLabelText('Code');
    await user.clear(field);
    await user.type(field, 'new-2');
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    const list = await screen.findByRole('list', { name: 'Your codes' });
    expect(await within(list).findByText('NEW-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove NEW-2' }));
    await waitFor(() => expect(within(list).queryByText('NEW-2')).toBeNull());
    // The drill's Homebox asset ID is listed too, read-only.
    expect(within(list).getByText('From Homebox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove 0/ })).toBeNull();
  });

  it('a viewer sees no form to add a code', async () => {
    await renderApp(`/t/${T.drill}?tab=overview`, { state: asViewer() });
    await findHeading('Bosch drill, 18 V');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('form', { name: 'Add a code' })).toBeNull();
  });
});

describe('numbering and the format rule (Settings → General)', () => {
  it('saves a rule, which a code then has to match: the owner’s message and example, then the list of codes that don’t match', async () => {
    const { user } = await renderApp(`/settings/location/${IDS.garage}/general`);
    const form = await screen.findByRole('form', { name: 'Your own codes' });
    await user.click(
      within(form).getByRole('switch', { name: 'Check codes against a format rule' }),
    );
    await user.type(within(form).getByLabelText(/^Pattern/), 'GAR-[[0-9]{{4}');
    await user.type(
      within(form).getByLabelText(/^Message when a code doesn't match/),
      'GAR- and four digits, like the stickers.',
    );
    await user.type(within(form).getByLabelText(/^Example/), 'GAR-0001');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Every code here matches the rule')).toBeInTheDocument();
  });

  it('refuses a pattern too slow to check, next to the field', async () => {
    const { user } = await renderApp(`/settings/location/${IDS.garage}/general`);
    const form = await screen.findByRole('form', { name: 'Your own codes' });
    await user.click(
      within(form).getByRole('switch', { name: 'Check codes against a format rule' }),
    );
    await user.type(within(form).getByLabelText(/^Pattern/), '(a+)+$');
    await user.type(within(form).getByLabelText(/^Message when a code doesn't match/), 'Letters.');
    await user.type(within(form).getByLabelText(/^Example/), 'AAA');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/takes too long to check/)).toBeInTheDocument();
  });

  it('numbering offers "Next number" on a thing, and a code breaking the rule says the owner’s words', async () => {
    const state = ownerScenario();
    const first = await renderApp(`/settings/location/${IDS.garage}/general`, { state });
    const form = await screen.findByRole('form', { name: 'Your own codes' });
    await first.user.click(
      within(form).getByRole('switch', { name: 'Number new things automatically' }),
    );
    await first.user.type(within(form).getByLabelText('Prefix'), 'GAR-');
    await first.user.click(
      within(form).getByRole('switch', { name: 'Check codes against a format rule' }),
    );
    await first.user.type(within(form).getByLabelText(/^Pattern/), 'GAR-[[0-9]{{4}');
    await first.user.type(
      within(form).getByLabelText(/^Message when a code doesn't match/),
      'Use the sticker number.',
    );
    await first.user.type(within(form).getByLabelText(/^Example/), 'GAR-0001');
    await first.user.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByText('Every code here matches the rule');
    first.unmount();

    const { user } = await renderApp(`/t/${T.drill}?tab=overview`, { state });
    await findHeading('Bosch drill, 18 V');
    const add = await screen.findByRole('form', { name: 'Add a code' });
    await user.click(await within(add).findByRole('button', { name: /Next number/ }));
    const list = await screen.findByRole('list', { name: 'Your codes' });
    expect(await within(list).findByText('GAR-0001')).toBeInTheDocument();
    await user.type(within(add).getByLabelText('Add a code'), 'drill');
    await user.click(within(add).getByRole('button', { name: 'Add' }));
    expect(await within(add).findByText('Use the sticker number.')).toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('keeps codes left to right in a right-to-left page', async () => {
    const { user } = await renderApp(`/t/${T.drill}?tab=overview`, { locale: 'ar' });
    const form = await screen.findByRole('form', { name: 'أضف رمزًا' });
    const input = within(form).getByRole('textbox');
    expect(input).toHaveAttribute('dir', 'ltr');
    await user.type(input, 'gar-٠٠٤٢');
    await user.click(within(form).getByRole('button', { name: 'إضافة' }));
    expect(await screen.findByText('GAR-0042')).toHaveAttribute('dir', 'ltr');
  });
});
