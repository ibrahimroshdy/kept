/**
 * The web side of the step-2 contract decisions the server tasks settled (task 30): undo (D150),
 * localised history summaries, the activity search and its people, the search price filter, a
 * refused backwards reading, the place-kind Customise, the currency 409's reason, and the
 * palette's "Add a thing".
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { recordEvent } from '@/api/inventory/mock/db';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths as p } from '@/api/inventory/paths';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/kit';
import type { MockApi } from '@/api/mock/server';
import { findHeading, renderApp } from '@/test/app';
import { openFilters } from '@/test/filters';

vi.setConfig({ testTimeout: 20_000 });

const T = INV_IDS.thing;

function spyUrls(mock: MockApi): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    return mock.fetch(input, init);
  });
  return urls;
}

function asRole(role: 'viewer' | 'member', state: MockState = ownerScenario()) {
  for (const l of state.locations) if (l.id !== IDS.personal) l.role = role;
  const personal = state.locations.find((l) => l.id === IDS.personal);
  if (personal && role === 'viewer')
    personal.modules = personal.modules.filter((m) => m !== 'money');
  return state;
}

describe('undo (D150)', () => {
  it('an edit offers Undo, which posts the event to /audit/:eventId/undo', async () => {
    const { user, mock } = await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('form', { name: 'Edit Samsung TV, 55″' });
    const model = within(form).getByLabelText('Model');
    await user.clear(model);
    await user.type(model, 'QE55Q70C');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const toast = await screen.findByRole('alertdialog', { name: /Saved/ }).catch(() => null);
    const region = toast ?? (await screen.findByRole('region', { name: 'Notifications' }));
    await user.click(await within(region).findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(
        mock.calls.some((c) => c.method === 'POST' && /\/audit\/[^/]+\/undo$/.test(c.path)),
      ).toBe(true),
    );
    const tv = mock.state.inventory.things.find((x) => x.id === T.tv);
    expect(tv?.model).not.toBe('QE55Q70C');
  });

  it('the Undo toast undoes the event the write named, without reading history', async () => {
    const { user, mock } = await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    // History says nothing: the event id comes from the PATCH's X-Kept-Audit-Event alone.
    mock.on('GET', p.thingHistory(':id'), () => ({ items: [], next_cursor: null }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('form', { name: 'Edit Samsung TV, 55″' });
    const model = within(form).getByLabelText('Model');
    await user.clear(model);
    await user.type(model, 'QE55Q70C');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const toast = await screen.findByText('Saved');
    const region = toast.closest('[role="alertdialog"], [role="region"]') as HTMLElement;
    await user.click(within(region).getByRole('button', { name: 'Undo' }));
    // The edit's own event (the undo records one of its own, with `undo_of`).
    const edit = mock.state.inventory.events.find(
      (e) => e.action === 'thing.update' && e.undoable_until && !e.undo_of,
    );
    await waitFor(() => expect(mock.lastCall('POST', p.undo(edit?.id ?? ''))).toBeDefined());
    expect(mock.state.inventory.things.find((x) => x.id === T.tv)?.model).not.toBe('QE55Q70C');
  });

  it("a history row of one's own undoable change has Undo, and says it in the reader's words", async () => {
    const state = ownerScenario();
    const tv = state.inventory.things.find((x) => x.id === T.tv);
    let undone = false;
    recordEvent(
      state.inventory,
      { id: state.me.user.id, displayName: state.me.user.displayName },
      {
        action: 'thing.move',
        entity: { type: 'thing', id: T.tv },
        locationId: tv?.locationId ?? IDS.home,
        name: 'Samsung TV, 55″',
        undo: () => {
          undone = true;
        },
      },
    );
    const { user } = await renderApp(`/t/${T.tv}?tab=history`, { state });
    await findHeading('Samsung TV, 55″');
    const row = await screen.findByRole('article', { name: 'Moved Samsung TV, 55″' });
    await user.click(within(row).getByRole('button', { name: /^Undo/ }));
    await waitFor(() => expect(undone).toBe(true));
    expect(await screen.findByText('Undone')).toBeInTheDocument();
  });

  it('a viewer gets no Undo on history rows', async () => {
    await renderApp('/activity', { state: asRole('viewer') });
    await screen.findByRole('list', { name: 'Activity' }, { timeout: 3000 });
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
  });
});

describe('activity', () => {
  it('searches with q, and offers the people who acted there (/locations/:id/actors)', async () => {
    const { user, mock } = await renderApp('/activity');
    const urls = spyUrls(mock);
    await screen.findByRole('list', { name: 'Activity' }, { timeout: 3000 });
    const sheet = await openFilters(user, 'Person');
    await waitFor(() => expect(mock.calls.some((c) => c.path.endsWith('/actors'))).toBe(true));
    const people = within(sheet).getByRole('grid', { name: 'Person' });
    expect(await within(people).findByRole('row', { name: /^Alfred/ })).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search activity' }), 'lamp');
    await waitFor(() => expect(urls.some((u) => u.includes('q=lamp'))).toBe(true));
  });
});

describe('search: the price filter (T27 decision)', () => {
  it('sends priceMin, priceMax and currency, Arabic digits and all', async () => {
    const { user, mock, router } = await renderApp('/search?q=samsung');
    const urls = spyUrls(mock);
    await screen.findByRole('group', { name: 'Filters' });
    const sheet = await openFilters(user, 'Price');
    await user.type(within(sheet).getByLabelText('From'), '١٠٠');
    await user.type(within(sheet).getByLabelText('Up to'), '30000');
    await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        'f.priceMin': ['100'],
        'f.priceMax': ['30000'],
      }),
    );
    await waitFor(() =>
      expect(urls.some((u) => u.includes('priceMin=100') && u.includes('priceMax=30000'))).toBe(
        true,
      ),
    );
  });

  it('is not offered to someone who sees no money anywhere', async () => {
    const { user } = await renderApp('/search?q=samsung', { state: asRole('viewer') });
    await screen.findByRole('group', { name: 'Filters' });
    const sheet = await openFilters(user);
    expect(within(sheet).getByRole('option', { name: 'Type' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('option', { name: 'Price' })).toBeNull();
  });
});

describe('meters (T16)', () => {
  it('a backwards reading is refused, naming the reading before it', async () => {
    const { user } = await renderApp(`/t/${T.car}`);
    await findHeading('Toyota Corolla');
    await user.click(screen.getByRole('button', { name: 'Log a reading' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reading (km)'), '100');
    // Since step 5 the sheet says it while you type (components/readings/reading-field.tsx),
    // naming the latest reading, and offers Edit and Meter replaced in place of Save. The
    // server's own refusal, with the neighbour, is the fuel tab's test (fuel.test.tsx).
    expect(
      await within(dialog).findByText(
        /^100 km is lower than [\d,]+ km on .+Readings can't go down/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Meter replaced' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('admin currencies (T12)', () => {
  it("a refused switch-off says why, from the 409's reason", async () => {
    const state = ownerScenario();
    const sar = state.inventory.currencies.find((c) => c.code === 'SAR');
    if (sar) sar.enabled = true;
    const { user, mock } = await renderApp('/admin/currencies', { state });
    mock.on(
      'PATCH',
      p.adminCurrency(':code'),
      () =>
        new MockReply(409, {
          error: 'That conflicts with the current state.',
          code: 'conflict',
          reason: 'default',
        }),
    );
    const sw = await screen.findByRole('switch', { name: 'SAR on' }, { timeout: 3000 });
    await user.click(sw);
    expect(
      await screen.findByText("SAR stays on: it's one of the five defaults."),
    ).toBeInTheDocument();
  });
});

describe('the palette (T27 follow-up)', () => {
  it('"Add a thing" opens the create sheet, in the location you are on', async () => {
    const { user } = await renderApp(`/loc/${IDS.garage}`);
    await findHeading('Garage');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Search or jump to' });
    await user.click(within(dialog).getByRole('option', { name: /Add a thing/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Add a thing' });
    expect(within(sheet).getByRole('form', { name: 'Add a thing' })).toBeInTheDocument();
  });
});
