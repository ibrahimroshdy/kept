/**
 * Moving mode (1.x, D39 (5), D251): starting a move, adding a numbered box, marking it in
 * transit from its page, unpacking a packed box into its room (everything inside goes too), the
 * still-to-unpack list, what a viewer sees, and the board in Arabic.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, type MockState, memberScenario, ownerScenario } from '@/api/mock/fixtures';
import { seedMove } from '@/api/moving/mock';
import { movingPaths } from '@/api/moving/paths';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const MOVE = '01926f00-0000-7000-8000-0000000mv001';
const T = INV_IDS.thing;
const P = INV_IDS.place;

/** Home with Moving mode on (Labels is already on there). */
function withMoving(state: MockState = ownerScenario()): MockState {
  for (const l of state.locations)
    if (l.id === IDS.home && !l.modules.includes('moving')) l.modules.push('moving');
  return state;
}

/** A move of Home, within Home: Box 3 is box 1, going to the kitchen; the TV box is box 2. */
function seeded(state = withMoving()): MockState {
  seedMove(state, {
    id: MOVE,
    locationId: IDS.home,
    toLocationId: null,
    name: 'Spring clear-out',
    status: 'active',
    createdBy: { displayName: 'Ibrahim' },
    createdAt: '2026-10-10T09:00:00Z',
    finishedAt: null,
    rowVersion: 1,
    boxes: [
      {
        containerId: T.box3,
        number: 1,
        state: 'packed',
        stateAt: '2026-10-10T09:05:00Z',
        stateBy: { displayName: 'Ibrahim' },
        destinationPlaceId: P.kitchen,
        rowVersion: 1,
      },
      {
        containerId: T.cableBox,
        number: 2,
        state: 'in_transit',
        stateAt: '2026-10-10T09:10:00Z',
        stateBy: { displayName: 'Ibrahim' },
        destinationPlaceId: null,
        rowVersion: 1,
      },
    ],
  });
  return state;
}

describe('Moving', () => {
  it('has a nav entry where it is on, starts a move, and adds a numbered box', async () => {
    const { user, mock } = await renderApp('/moving', { state: withMoving() });
    await findHeading('Moving');
    expect((await screen.findAllByRole('link', { name: 'Moving' })).length).toBeGreaterThan(0);
    expect(await screen.findByText('No moves yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Start a move' })[0] as HTMLElement);
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: 'Start' }));
    expect(await within(sheet).findByText('Give the move a name.')).toBeInTheDocument();
    await user.type(within(sheet).getByRole('textbox', { name: 'Name' }), 'To the new flat');
    await user.click(within(sheet).getByRole('button', { name: 'Start' }));

    await findHeading('To the new flat');
    expect(await screen.findByText('No boxes yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Add a box' })[0] as HTMLElement);
    const add = await screen.findByRole('dialog');
    await user.click(within(add).getByRole('button', { name: 'Add the box' }));
    expect(await screen.findByRole('article', { name: 'Box 1' })).toBeInTheDocument();
    const post = mock.calls.find((c) => c.method === 'POST' && c.path.endsWith('/boxes'));
    expect(post?.body).toEqual({ new: { prefix: 'Box' } });
    expectLogicalOnly();
  });

  it('marks a box in transit from its page, with Undo', async () => {
    const { user, mock } = await renderApp(`/moving/${MOVE}/boxes/${T.box3}`, {
      state: seeded(),
    });
    await findHeading('Box 1');
    expect(screen.getByText('Kitchen')).toBeInTheDocument();
    expect(await screen.findByText('Winter scarves')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark in transit' }));
    await waitFor(() => {
      const patch = mock.lastCall('PATCH', movingPaths.box(MOVE, T.box3));
      expect(patch?.body).toEqual({ state: 'in_transit' });
    });
    expect(await screen.findByText('Box 1: In transit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Back to packed' })).toBeInTheDocument();
  });

  it('unpacks a box into its room, and the board counts it', async () => {
    const state = seeded();
    const { user, mock } = await renderApp(`/moving/${MOVE}/boxes/${T.box3}`, { state });
    await findHeading('Box 1');
    await user.click(screen.getByRole('button', { name: 'Unpack' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(await within(sheet).findByRole('button', { name: 'Unpack into Kitchen' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', movingPaths.unpack(MOVE, T.box3))).toBeTruthy(),
    );
    const box = state.inventory.things.find((t) => t.id === T.box3);
    expect(box?.placeId).toBe(P.kitchen);
    // What was inside stays inside: it went with the box.
    expect(state.inventory.things.find((t) => t.id === T.scarves)?.containerId).toBe(T.box3);
    expect(await screen.findByText('Box 1 unpacked into Kitchen')).toBeInTheDocument();
  });

  it('leads the board with the counts and what is still to unpack', async () => {
    await renderApp(`/moving/${MOVE}`, { state: seeded() });
    await findHeading('Spring clear-out');
    const count = (state: string) =>
      screen.getAllByText(state).find((el) => el.tagName === 'DT')?.parentElement;
    expect(count('Packed')).toHaveTextContent('1');
    expect(count('In transit')).toHaveTextContent('1');
    expect(count('Unpacked')).toHaveTextContent('0');
    expect(screen.getByRole('heading', { name: '2 boxes still to unpack' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Box 2' })).toHaveTextContent('No room chosen yet');
    expect(screen.getByRole('button', { name: 'Scan to unpack' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Print labels' })).toHaveAttribute(
      'href',
      expect.stringContaining('/labels?'),
    );
  });

  it('a viewer follows the board, without its actions', async () => {
    const state = seeded(withMoving(memberScenario()));
    for (const l of state.locations) if (l.id === IDS.home) l.role = 'viewer';
    await renderApp(`/moving/${MOVE}`, { state });
    await findHeading('Spring clear-out');
    expect(screen.getByRole('article', { name: 'Box 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scan to unpack' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a box' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete the move' })).toBeNull();
  });

  it('reads right to left in Arabic, with logical CSS only', async () => {
    await renderApp(`/moving/${MOVE}`, { state: seeded(), locale: 'ar' });
    await findHeading('Spring clear-out');
    expect(document.documentElement.dir).toBe('rtl');
    expectLogicalOnly();
  });
});
