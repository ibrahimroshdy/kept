/**
 * Browse (task 25): the Location, Place and Container views and every place operation (D45,
 * D118, D160), against the mock server. Each screen is checked by keyboard, right to left, as a
 * viewer, and with the Labels module off.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths } from '@/api/inventory/paths';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { createMockApi, MockReply } from '@/api/mock/server';
import { AppProviders } from '@/app-providers';
import { ContentsList, contentsSearch } from '@/components/places/contents-list';
import { activateLocale } from '@/i18n/i18n';
import { pageStore } from '@/pwa/page-store';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { openFilters } from '@/test/filters';
import { expectLogicalOnly } from '@/test/render';

const P = INV_IDS.place;
const T = INV_IDS.thing;

/** Ibrahim with a different role in Home. */
function asRole(role: 'viewer' | 'member' | 'admin', state: MockState = ownerScenario()) {
  const home = state.locations.find((l) => l.id === IDS.home);
  if (home) home.role = role;
  return state;
}

const list = (name: string | RegExp) => screen.findByRole('list', { name });

describe('the location page', () => {
  it('shows Add here, the Unplaced card, then places before things with their paths', async () => {
    await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    const add = await screen.findByRole('region', { name: 'Add here' });
    expect(
      within(add)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Thing', 'Box / container', 'Room or spot', 'Borrowed thing']);
    expect(screen.getByRole('link', { name: /Captured into Home/ })).toHaveAttribute(
      'href',
      `/p/${P.homeUnplaced}`,
    );
    expect(screen.getByRole('button', { name: 'Sort them' })).toBeInTheDocument();
    const rows = within(await list('Contents of Home')).getAllByRole('link');
    const names = rows.map((r) => r.textContent ?? '');
    // Places first (never the Unplaced area as a row), then things.
    expect(names[0]).toMatch(/^Living room/);
    expect(names.findIndex((n) => n.startsWith('Kitchen'))).toBeLessThan(
      names.findIndex((n) => n.includes('Galaxy S23')),
    );
    expect(names.some((n) => n.startsWith('Unplaced'))).toBe(false);
    // A thing at depth says where it is.
    expect(
      screen.getByRole('link', { name: /HDMI cable, 2 m.*Office.*Desk drawer.*Cable box/ }),
    ).toBeInTheDocument();
    // The settings links are still there for the owner.
    expect(screen.getByRole('link', { name: /Members and roles/ })).toBeInTheDocument();
  });

  it("counts its things from the location itself, without waiting for Home's counts", async () => {
    const state = ownerScenario();
    const live = state.inventory.things.filter(
      (t) => t.locationId === IDS.home && !t.deletedAt,
    ).length;
    await renderApp(`/loc/${IDS.home}`, {
      state,
      setup: (mock) => mock.hang('GET', inventoryPaths.home),
    });
    await findHeading('Home');
    await waitFor(() =>
      expect(document.querySelector('main')?.textContent).toContain(`· ${live} things ·`),
    );
  });

  it('search narrows places and things, and lives in the URL', async () => {
    const { user, router } = await renderApp(`/loc/${IDS.home}`);
    await list('Contents of Home');
    await user.type(screen.getByRole('searchbox', { name: 'Search Home' }), 'kitch');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'kitch' }));
    const rows = within(await list('Contents of Home')).getAllByRole('link');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/^Kitchen/)]);
  });

  it('the Display button sorts Z to A and newest first, in the strip row (D211)', async () => {
    const { user, router } = await renderApp(`/loc/${IDS.home}`);
    await list('Contents of Home');
    const thingNames = async () =>
      within(await list('Contents of Home'))
        .getAllByRole('link')
        .filter((r) => r.getAttribute('href')?.startsWith('/t/'))
        .map((r) => r.textContent ?? '');
    const before = await thingNames();
    const display = screen.getByRole('button', { name: /^Display options/ });
    expect(display).toHaveAccessibleName('Display options: sorted by Name, A to Z');
    expect(screen.queryByText('Sort by')).toBeNull();
    await user.click(display);
    let sheet = await screen.findByRole('dialog', { name: 'Display' });
    await user.click(within(sheet).getByRole('menuitemradio', { name: 'Z to A' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ dir: 'desc' }));
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(async () => expect((await thingNames())[0]).not.toBe(before[0]));
    // A date sort starts at newest first, and turns around to oldest first.
    await user.click(screen.getByRole('button', { name: /^Display options/ }));
    sheet = await screen.findByRole('dialog', { name: 'Display' });
    await user.click(within(sheet).getByRole('menuitemradio', { name: 'Last seen' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ sort: 'lastSeen' }));
    expect(router.state.location.search).not.toHaveProperty('dir');
    await user.click(within(sheet).getByRole('menuitemradio', { name: 'Oldest first' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ dir: 'asc' }));
    // A location has no layouts: those are a container's.
    expect(within(sheet).queryByText('Layout')).toBeNull();
  });

  it('the Unplaced chip narrows things to the Unplaced area', async () => {
    const { user } = await renderApp(`/loc/${IDS.home}`);
    await list('Contents of Home');
    const sheet = await openFilters(user);
    await user.click(within(sheet).getByRole('option', { name: 'Unplaced' }));
    expect(
      await screen.findByRole('button', { name: 'Remove the Unplaced filter' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Contents of Home' }))
          .getAllByRole('link')
          .map((r) => r.textContent),
      ).toEqual([expect.stringMatching(/Untitled draft/), expect.stringMatching(/Galaxy S23/)]),
    );
  });

  it('adds a room or spot at the top level, by keyboard', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    (await screen.findByRole('button', { name: 'Room or spot' })).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Add a room or spot to Home' });
    await user.keyboard('{Enter}');
    expect(
      within(dialog).getByText('Give it a name, like Shelf A or Balcony.'),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Balcony');
    expect(within(dialog).getByRole('radio', { name: 'Room' })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: 'Spot' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.locationPlaces(IDS.home))?.body).toEqual({
        name: 'Balcony',
        kindKey: 'zone',
      }),
    );
    expect(
      await within(screen.getByRole('list', { name: 'Contents of Home' })).findByRole('link', {
        name: /^Balcony/,
      }),
    ).toBeInTheDocument();
  });

  it('adds a thing into the Unplaced area', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    await user.click(await screen.findByRole('button', { name: 'Thing' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a thing to Home' });
    await user.type(within(dialog).getByLabelText('Name'), 'Umbrella{Enter}');
    // The full create sheet (T30), with where already set to the Unplaced area.
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.things)?.body).toMatchObject({
        locationId: IDS.home,
        placeId: P.homeUnplaced,
        name: 'Umbrella',
      }),
    );
    expect(await screen.findByText('Added Umbrella')).toBeInTheDocument();
  });

  it('a box gets the built-in Box / bin type', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    await user.click(await screen.findByRole('button', { name: 'Box / container' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a box to Home' });
    await user.type(within(dialog).getByLabelText('Name'), 'Box 9');
    await waitFor(() => expect(mock.calls.some((c) => c.path.endsWith('/types'))).toBe(true));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.things)?.body).toMatchObject({
        name: 'Box 9',
        typeId: INV_IDS.type.boxBin,
      }),
    );
  });

  it('a viewer browses only: no Add here, no Select, no Sort them', async () => {
    await renderApp(`/loc/${IDS.home}`, { state: asRole('viewer') });
    await list('Contents of Home');
    expect(screen.queryByRole('region', { name: 'Add here' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sort them' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Captured into Home/ })).toBeInTheDocument();
  });

  it('renders right to left in Arabic', async () => {
    await renderApp(`/loc/${IDS.family}`, { locale: 'ar' });
    await findHeading('بيت العائلة');
    await screen.findByRole('list', { name: 'محتويات «بيت العائلة»' });
    expect(document.documentElement.dir).toBe('rtl');
    expectLogicalOnly();
  });
});

describe('Sort them (D118)', () => {
  it('walks the Unplaced things one at a time: Skip, then move', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    await user.click(await screen.findByRole('button', { name: 'Sort them' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sort Unplaced · 1 of 2' });
    expect(within(dialog).getByText('Untitled draft')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Skip' }));
    const second = await screen.findByRole('dialog', { name: 'Sort Unplaced · 2 of 2' });
    expect(within(second).getByText('Galaxy S23')).toBeInTheDocument();
    await user.click(await within(second).findByRole('radio', { name: 'Kitchen' }));
    await user.click(within(second).getByRole('button', { name: 'Move here' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.move)?.body).toEqual({
        thingIds: [T.phone],
        to: { placeId: P.kitchen },
      }),
    );
    const done = await screen.findByRole('dialog', { name: 'Sort Unplaced' });
    expect(within(done).getByText('1 thing has a place now.')).toBeInTheDocument();
  });
});

describe('select and pick up (D175, frame 7a)', () => {
  it('picks up several things at once into the carrying tray', async () => {
    await pageStore().setTray([]);
    const { user } = await renderApp(`/loc/${IDS.home}`);
    await list('Contents of Home');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const bar = screen.getByRole('toolbar', { name: 'Selection' });
    expect(within(bar).getByText('Choose things')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Pick up' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select Galaxy S23' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Samsung TV, 55″' }));
    // Beside "Print labels" (T28).
    const buttons = within(bar)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons.indexOf('Pick up')).toBe(buttons.indexOf('Print labels') - 1);
    await user.click(within(bar).getByRole('button', { name: 'Pick up' }));
    expect(await screen.findByText('Picked up 2 things')).toBeInTheDocument();
    expect(await pageStore().tray()).toEqual([T.phone, T.tv]);
    expect(await screen.findByRole('link', { name: 'Carrying 2' })).toBeInTheDocument();
    // The selection is done.
    expect(screen.queryByRole('checkbox', { name: 'Select Galaxy S23' })).toBeNull();
    await pageStore().setTray([]);
  });
});

describe('select and move (D45)', () => {
  it('moves selected things, warning who loses sight across locations', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`);
    await list('Contents of Home');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Galaxy S23' }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to…' });
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search places' }), 'shel');
    await user.click(await within(dialog).findByRole('radio', { name: /Shelves/ }));
    expect(
      await within(dialog).findByText('Alfred and 1 other will lose sight of it.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Move here' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.move)?.body).toEqual({
        thingIds: [T.phone],
        to: { placeId: P.shelves },
      }),
    );
    expect(await screen.findByText('Moved to Shelves')).toBeInTheDocument();
  });

  it('Undo after a bulk move undoes every thing it moved (X-Kept-Audit-Event, D150)', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`);
    const before = new Map(
      mock.state.inventory.things
        .filter((x) => x.id === T.phone || x.id === T.tv)
        .map((x) => [x.id, x.placeId]),
    );
    await list('Contents of Home');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Galaxy S23' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Samsung TV, 55″' }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move 2 things to…' });
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search places' }), 'shel');
    await user.click(await within(dialog).findByRole('radio', { name: /Shelves/ }));
    await user.click(within(dialog).getByRole('button', { name: /^Move 2 here/ }));
    const toast = await screen.findByText('Moved 2 things to Shelves');
    const region = toast.closest('[role="alertdialog"], [role="region"]') as HTMLElement;
    await user.click(within(region).getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.method === 'POST' && /\/audit\/[^/]+\/undo$/.test(c.path)),
      ).toHaveLength(2),
    );
    expect(await screen.findByText('Undone')).toBeInTheDocument();
    for (const [id, placeId] of before)
      expect(mock.state.inventory.things.find((x) => x.id === id)?.placeId).toBe(placeId);
  });

  it('on desktop a thing can be dragged onto a place (the picker is the alternative)', async () => {
    const { mock } = await renderApp(`/loc/${IDS.home}`);
    const contents = await list('Contents of Home');
    const store: Record<string, string> = {};
    const dataTransfer = {
      types: [] as string[],
      setData: (k: string, v: string) => {
        store[k] = v;
        dataTransfer.types.push(k);
      },
      getData: (k: string) => store[k] ?? '',
      effectAllowed: 'none',
      dropEffect: 'none',
    };
    const phone = within(contents).getByRole('link', { name: /Galaxy S23/ });
    const kitchen = within(contents).getByRole('link', { name: /^Kitchen/ });
    fireEvent.dragStart(phone, { dataTransfer });
    fireEvent.dragOver(kitchen, { dataTransfer });
    fireEvent.drop(kitchen, { dataTransfer });
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.move)?.body).toEqual({
        thingIds: [T.phone],
        to: { placeId: P.kitchen },
      }),
    );
    expect(await screen.findByText('Moved Galaxy S23 to Kitchen')).toBeInTheDocument();
  });

  it('the picker is operated with arrow keys', async () => {
    const { user } = await renderApp(`/loc/${IDS.home}`);
    await list('Contents of Home');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Galaxy S23' }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to…' });
    const group = await within(dialog).findByRole('radiogroup', { name: 'Where to' });
    const first = within(group).getAllByRole('radio')[0] as HTMLElement;
    await user.click(first);
    await user.keyboard('{ArrowDown}');
    expect(within(group).getAllByRole('radio')[1]).toBeChecked();
  });
});

describe('the place page', () => {
  it('shows the breadcrumb, the kind and counts, and the contents', async () => {
    await renderApp(`/p/${P.deskDrawer}`);
    await findHeading('Desk drawer');
    const crumb = screen.getByRole('navigation', { name: 'Path' });
    expect(within(crumb).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      `/loc/${IDS.home}`,
    );
    expect(within(crumb).getByRole('link', { name: 'Office' })).toHaveAttribute(
      'href',
      `/p/${P.office}`,
    );
    expect(within(crumb).getByText('Desk drawer').closest('li')).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText(/Spot · 1 thing/)).toBeInTheDocument();
    // Its short ID (D208).
    expect(
      within(await list('Contents of Desk drawer')).getByRole('link', { name: /Cable box/ }),
    ).toHaveAttribute('href', '/t/B0X3QF');
  });

  it('renames with If-Match', async () => {
    const { user, mock } = await renderApp(`/p/${P.bedroom}`);
    await findHeading('Bedroom');
    await user.click(screen.getByRole('button', { name: /^Rename/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename Bedroom' });
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Main bedroom');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = mock.lastCall('PATCH', inventoryPaths.place(P.bedroom));
      expect(call?.body).toEqual({ name: 'Main bedroom' });
      expect(call?.headers['if-match']).toBe('1');
    });
    expect(await findHeading('Main bedroom')).toBeInTheDocument();
  });

  it('moves a place into another, never into itself', async () => {
    const { user, mock } = await renderApp(`/p/${P.office}`);
    await findHeading('Office');
    await user.click(screen.getByRole('button', { name: /^Move Put it inside/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Move Office into…' });
    await within(dialog).findByRole('radio', { name: 'Kitchen' });
    expect(within(dialog).queryByRole('radio', { name: 'Office' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: 'Desk drawer' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: /Shelves/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'Hallway closet' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move here' }));
    await waitFor(() =>
      expect(mock.lastCall('PATCH', inventoryPaths.place(P.office))?.body).toEqual({
        parentId: P.hallwayCloset,
      }),
    );
  });

  it('trash with contents asks what happens to them (D45, D160)', async () => {
    const { user, mock, router } = await renderApp(`/p/${P.kitchen}`);
    await findHeading('Kitchen');
    await user.click(screen.getByRole('button', { name: /^Move to trash/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Move Kitchen to the trash?' });
    expect(within(dialog).getByText(/has 3 things inside/)).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Move them to Unplaced/ })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Move to trash' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.placeTrash(P.kitchen))?.body).toEqual({
        contents: 'move',
        moveTo: { placeId: P.homeUnplaced },
      }),
    );
    await waitFor(() => expect(pathOf(router)).toBe(`/loc/${IDS.home}`));
    expect(await screen.findByText('Kitchen is in the trash')).toBeInTheDocument();
  });

  it('trash them too, and Undo restores the batch', async () => {
    const { user, mock } = await renderApp(`/p/${P.office}`);
    await findHeading('Office');
    await user.click(screen.getByRole('button', { name: /^Move to trash/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Move Office to the trash?' });
    expect(within(dialog).getByText(/has 1 place inside/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: /Trash them too/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Move to trash' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.placeTrash(P.office))?.body).toEqual({
        contents: 'trash',
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.placeRestore(P.office))).toBeTruthy(),
    );
  });

  it('asks for a choice when the server says contents arrived (409)', async () => {
    const { user } = await renderApp(`/p/${P.livingRoom}`, {
      setup: (mock) =>
        mock.on('POST', inventoryPaths.placeTrash(':id'), ({ body }) =>
          (body as { contents?: string }).contents
            ? { trashed: [P.livingRoom], moved: [], trashBatchId: 'b' }
            : new MockReply(409, {
                error: 'Choose what happens to what is inside.',
                code: 'contents_choice_required',
                counts: { places: 0, things: 4 },
              }),
        ),
    });
    await findHeading('Living room');
    // The page thinks it has 1 thing; the server knows of 4.
    await user.click(screen.getByRole('button', { name: /^Move to trash/ }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Move Living room to the trash?',
    });
    expect(within(dialog).getByText(/has 1 thing inside/)).toBeInTheDocument();
  });

  it('merges into another place (admins)', async () => {
    const { user, mock, router } = await renderApp(`/p/${P.bedroom}`);
    await findHeading('Bedroom');
    await user.click(screen.getByRole('button', { name: /^Merge into another place/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge Bedroom into…' });
    await user.click(await within(dialog).findByRole('radio', { name: 'Living room' }));
    await user.click(within(dialog).getByRole('button', { name: 'Merge into Living room' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.placeMergeInto(P.bedroom))).toMatchObject({
        // The source's version in the body, the target's in If-Match (T25 decision 5).
        body: { targetId: P.livingRoom, sourceRowVersion: 1 },
        headers: { 'if-match': '1' },
      }),
    );
    await waitFor(() => expect(pathOf(router)).toBe(`/p/${P.livingRoom}`));
  });

  it('turns a place with no places inside into a box, keeping its id (Q14)', async () => {
    const { user, mock, router } = await renderApp(`/p/${P.deskDrawer}`);
    await findHeading('Desk drawer');
    await user.click(screen.getByRole('button', { name: /^Turn into a box/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn Desk drawer into a box?' });
    await user.click(within(dialog).getByRole('button', { name: 'Turn into a box' }));
    await waitFor(() =>
      expect(
        mock.lastCall('POST', inventoryPaths.placeConvertToContainer(P.deskDrawer)),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(pathOf(router)).toBe(`/t/${P.deskDrawer}`));
  });

  it('a place with places inside is not offered as a box', async () => {
    await renderApp(`/p/${P.office}`);
    await findHeading('Office');
    expect(screen.queryByRole('button', { name: /^Turn into a box/ })).not.toBeInTheDocument();
  });

  it('gives a place a label ID (labels module)', async () => {
    const { user, mock } = await renderApp(`/p/${P.kitchen}`);
    await findHeading('Kitchen');
    await user.click(screen.getByRole('button', { name: /^Give it a label ID/ }));
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.placeLabel(P.kitchen))).toBeTruthy(),
    );
    expect((await screen.findAllByRole('img', { name: 'P1ACE7' })).length).toBeGreaterThan(0);
  });

  it('with Labels off: "Off in this location" and Turn on for an admin (§3)', async () => {
    const state = ownerScenario();
    const home = state.locations.find((l) => l.id === IDS.home);
    if (home) home.modules = home.modules.filter((m) => m !== 'labels');
    await renderApp(`/p/${P.kitchen}`, { state });
    await findHeading('Kitchen');
    expect(screen.getByText('Off in this location')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Turn on' })).toHaveAttribute(
      'href',
      `/settings/location/${IDS.home}/track`,
    );
    expect(screen.queryByRole('button', { name: /Give it a label ID/ })).not.toBeInTheDocument();
  });

  it('a member: no Merge; with Labels off, "Ask an admin"', async () => {
    const state = asRole('member');
    const home = state.locations.find((l) => l.id === IDS.home);
    if (home) home.modules = [];
    await renderApp(`/p/${P.kitchen}`, { state });
    await findHeading('Kitchen');
    expect(screen.getByRole('button', { name: /^Rename/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Merge/ })).not.toBeInTheDocument();
    expect(screen.getByText('Ask an admin')).toBeInTheDocument();
  });

  it('a viewer: no Add here, no Manage', async () => {
    await renderApp(`/p/${P.kitchen}`, { state: asRole('viewer') });
    await findHeading('Kitchen');
    await list('Contents of Kitchen');
    expect(screen.queryByRole('region', { name: 'Add here' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Manage' })).not.toBeInTheDocument();
  });

  it('the Unplaced area: things only, and no place operations', async () => {
    await renderApp(`/p/${P.homeUnplaced}`);
    await findHeading('Unplaced');
    const add = screen.getByRole('region', { name: 'Add here' });
    expect(within(add).queryByRole('button', { name: 'Room or spot' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Manage' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sort them' })).toBeInTheDocument();
  });

  it('an empty place says so', async () => {
    const state = ownerScenario();
    state.inventory.things = state.inventory.things.filter((t) => t.placeId !== P.livingRoom);
    await renderApp(`/p/${P.livingRoom}`, { state });
    await findHeading('Living room');
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();
  });

  it('renders right to left in Arabic, the path mirrored', async () => {
    await renderApp(`/p/${P.familyKitchen}`, { locale: 'ar' });
    await findHeading('المطبخ');
    const crumb = screen.getByRole('navigation', { name: 'المسار' });
    expect(within(crumb).getByRole('link', { name: 'بيت العائلة' })).toBeInTheDocument();
    expectLogicalOnly();
  });

  it('not found', async () => {
    await renderApp('/p/01926f00-0000-7000-8000-00000000ffff');
    expect(
      await screen.findByText("This isn't here any more, or you can't see it."),
    ).toBeInTheDocument();
  });
});

describe('place fields (D160, D156)', () => {
  function withClosetFields(state = ownerScenario()) {
    for (const kinds of Object.values(state.inventory.placeKinds))
      for (const k of kinds)
        if (k.key === 'closet')
          k.fields = [
            {
              id: 'f-filter',
              key: 'filter_size',
              label: 'Filter size',
              labelKey: null,
              kind: 'text',
              unit: null,
              options: null,
              repeatable: false,
              required: false,
              secret: false,
              sort: 1,
              archivedAt: null,
              source: { typeId: k.id, via: 'own' },
              rowVersion: 1,
            },
            {
              id: 'f-shelves',
              key: 'shelves',
              label: 'Shelves',
              labelKey: null,
              kind: 'number',
              unit: null,
              options: null,
              repeatable: false,
              required: false,
              secret: false,
              sort: 2,
              archivedAt: null,
              source: { typeId: k.id, via: 'own' },
              rowVersion: 1,
            },
          ];
    return state;
  }

  it('shows them, and saves the changed keys with If-Match', async () => {
    const { user, mock } = await renderApp(`/p/${P.hallwayCloset}`, { state: withClosetFields() });
    await findHeading('Hallway closet');
    expect(screen.getByText('Filter size')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Shelves'), '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = mock.lastCall('PATCH', inventoryPaths.place(P.hallwayCloset));
      expect(call?.body).toEqual({ custom: { shelves: 4 } });
      expect(call?.headers['if-match']).toBe('1');
    });
    // In the page: the sidebar's counts are numbers too (the notifications' unread, T24).
    expect(await within(screen.getByRole('main')).findByText('4')).toBeInTheDocument();
  });

  it('a stale save merges what only they changed, and asks about what both changed', async () => {
    const state = withClosetFields();
    const { user, mock } = await renderApp(`/p/${P.hallwayCloset}`, { state });
    await findHeading('Hallway closet');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Filter size'), '20x25');
    // Alfred saves first, changing the same field.
    const closet = state.inventory.places.find((p) => p.id === P.hallwayCloset);
    if (!closet) throw new Error('fixture');
    closet.custom = { filter_size: '16x20' };
    closet.rowVersion = 2;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const notice = await screen.findByText('Changed since you opened it');
    expect(notice.closest('[class*="border-warn"]')).toHaveTextContent(
      'Alfred changed it to 16x20; you have 20x25.',
    );
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = mock.lastCall('PATCH', inventoryPaths.place(P.hallwayCloset));
      expect(call?.body).toEqual({ custom: { filter_size: '20x25' } });
      expect(call?.headers['if-match']).toBe('2');
    });
  });

  it('a stale save of a field only I changed goes through without asking', async () => {
    const state = withClosetFields();
    const { user, mock } = await renderApp(`/p/${P.hallwayCloset}`, { state });
    await findHeading('Hallway closet');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Shelves'), '3');
    const closet = state.inventory.places.find((p) => p.id === P.hallwayCloset);
    if (!closet) throw new Error('fixture');
    closet.custom = { filter_size: '16x20' };
    closet.rowVersion = 2;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = mock.lastCall('PATCH', inventoryPaths.place(P.hallwayCloset));
      expect(call?.body).toEqual({ custom: { shelves: 3 } });
      expect(call?.headers['if-match']).toBe('2');
    });
    expect(screen.queryByText('Changed since you opened it')).not.toBeInTheDocument();
  });

  it('a viewer sees the fields but no Edit', async () => {
    await renderApp(`/p/${P.hallwayCloset}`, { state: asRole('viewer', withClosetFields()) });
    await findHeading('Hallway closet');
    expect(screen.getByText('Filter size')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

/** The container view as task 26's thing page hosts it: ContentsList on a route of its own. */
async function renderContainer(search = '', state = ownerScenario(), locale: 'en' | 'ar' = 'en') {
  const mock = createMockApi(state);
  vi.stubGlobal('fetch', mock.fetch);
  await activateLocale(locale);
  const root = createRootRoute({ component: Outlet });
  const box = createRoute({
    getParentRoute: () => root,
    path: '/box/$id',
    validateSearch: contentsSearch,
    component: function Box() {
      const { id } = box.useParams();
      const name = state.inventory.things.find((x) => x.id === id)?.name ?? '';
      return (
        <ContentsList parent={{ kind: 'container', id, name, locationId: IDS.home }} canEdit />
      );
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([box]),
    history: createMemoryHistory({ initialEntries: [`/box/${T.cableBox}${search}`] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(
    <AppProviders locale={locale}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppProviders>,
  );
  return { user, mock, router };
}

describe('ContentsList for a container (task 26 hosts it)', () => {
  it('lists what is directly inside', async () => {
    await renderContainer();
    const rows = within(await list('Contents of Cable box')).getAllByRole('link');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/HDMI cable, 2 m/)]);
  });

  it('?view=photos leads with a photo grid (D195)', async () => {
    await renderContainer('?view=photos');
    const grid = await screen.findByRole('region', { name: "Photos of what's in Cable box" });
    expect(within(grid).getByRole('link', { name: /HDMI cable/ })).toBeInTheDocument();
  });

  it("list or photos is the Display menu's Layout (D211), not a link of its own", async () => {
    const { user, router } = await renderContainer();
    await list('Contents of Cable box');
    expect(screen.queryByRole('link', { name: 'Show as a list' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Display options/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Display' });
    expect(within(sheet).getByRole('menuitemradio', { name: 'List' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(sheet).getByRole('menuitemradio', { name: 'Photos' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ view: 'photos' }));
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByRole('region', { name: "Photos of what's in Cable box" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Display options/ })).toHaveTextContent(
      'Name · photos',
    );
  });

  it('an empty box says so', async () => {
    const state = ownerScenario();
    state.inventory.things = state.inventory.things.filter((t) => t.containerId !== T.cableBox);
    await renderContainer('', state);
    expect(
      await screen.findByText(
        (_, el) => el?.textContent === 'Cable box is empty' && el.tagName === 'DIV',
      ),
    ).toBeInTheDocument();
  });
});
