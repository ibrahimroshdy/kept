/**
 * Condition reports (1.x, D171, D235): starting a move-in report from a location's rooms,
 * recording a room, adding one, finishing (and the lock that follows), comparing a move-out with
 * it room by room, and what a viewer sees.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { seedConditionReport } from '@/api/condition/mock';
import { conditionPaths } from '@/api/condition/paths';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const person = { displayName: 'Ibrahim' };
const room = (reportId: string, id: string, name: string, extra = {}) => ({
  id,
  reportId,
  placeId: null,
  name,
  condition: null,
  note: null,
  sort: 0,
  rowVersion: 1,
  ...extra,
});
const report = (id: string, kind: 'move_in' | 'move_out', heldOn: string, rooms: object[]) => ({
  id,
  locationId: IDS.home,
  kind,
  heldOn,
  notes: null,
  createdBy: person,
  createdAt: `${heldOn}T09:00:00Z`,
  finishedAt: null,
  finishedBy: null,
  rowVersion: 1,
  rooms: rooms as ReturnType<typeof room>[],
});

const IN = '01926f00-0000-7000-8000-0000000cr001';
const OUT = '01926f00-0000-7000-8000-0000000cr002';

describe('Condition reports', () => {
  it('starts a report from the location’s rooms, records one, adds one and finishes it', async () => {
    const { user, mock } = await renderApp('/condition-reports');
    await findHeading('Condition reports');
    expect(await screen.findByText('No condition reports')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New report' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: 'Start' }));

    await findHeading(/^Move-in/);
    const kitchen = await screen.findByRole('article', { name: 'Kitchen' });
    for (const name of ['Living room', 'Office', 'Bedroom'])
      expect(screen.getByRole('article', { name })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Desk drawer' })).toBeNull();
    expect(screen.queryByRole('article', { name: 'Hallway closet' })).toBeNull();

    await user.click(within(kitchen).getByRole('radio', { name: 'Fair' }));
    await waitFor(() => {
      const patch = mock.calls.find(
        (c) => c.method === 'PATCH' && c.path.includes('/condition-rooms/'),
      );
      expect(patch?.body).toEqual({ condition: 'fair' });
    });

    await user.type(screen.getByRole('textbox', { name: 'Another room' }), 'Balcony');
    await user.click(screen.getByRole('button', { name: 'Add room' }));
    expect(await screen.findByRole('article', { name: 'Balcony' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Finish' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Finish' }));
    expect(await screen.findByText(/Finished by/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('radio', { name: 'Fair' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Add room' })).toBeNull();
    expectLogicalOnly();
  });

  it('compares a move-out with the move-in, room by room, the earlier first', async () => {
    const state = ownerScenario();
    seedConditionReport(
      state,
      report(IN, 'move_in', '2026-01-10', [
        room(IN, '01926f00-0000-7000-8000-0000000cm001', 'Kitchen', {
          condition: 'good',
          note: 'Oven clean',
        }),
        room(IN, '01926f00-0000-7000-8000-0000000cm002', 'Garden'),
      ]),
    );
    seedConditionReport(
      state,
      report(OUT, 'move_out', '2026-10-10', [
        room(OUT, '01926f00-0000-7000-8000-0000000cm003', 'kitchen', {
          condition: 'damaged',
          note: 'Burn mark on the worktop',
        }),
      ]),
    );
    const { user } = await renderApp(`/condition-reports/${OUT}`, { state });
    await findHeading(/^Move-out/);
    await user.click(screen.getByRole('button', { name: /Compare with/ }));
    await user.click(await screen.findByRole('option', { name: /^Move-in/ }));

    expect(await screen.findByRole('heading', { name: 'Room by room' })).toBeInTheDocument();
    const kitchen = screen.getByRole('article', { name: 'Kitchen' });
    expect(within(kitchen).getByText('Oven clean')).toBeInTheDocument();
    expect(within(kitchen).getByText('Burn mark on the worktop')).toBeInTheDocument();
    const sides = within(kitchen).getAllByRole('heading', { level: 4 });
    expect(sides[0]).toHaveTextContent(/^Move-in/);
    expect(sides[1]).toHaveTextContent(/^Move-out/);
    const garden = screen.getByRole('article', { name: 'Garden' });
    expect(within(garden).getByText('Not in this report.')).toBeInTheDocument();
  });

  it('lets a viewer read a report and make its PDF, and nothing else', async () => {
    const state = ownerScenario();
    const home = state.locations.find((l) => l.id === IDS.home);
    if (home) home.role = 'viewer';
    for (const l of state.locations) if (l.id !== IDS.home) l.role = 'viewer';
    seedConditionReport(
      state,
      report(IN, 'move_in', '2026-01-10', [
        room(IN, '01926f00-0000-7000-8000-0000000cm001', 'Kitchen', { condition: 'fair' }),
      ]),
    );
    const { user, mock } = await renderApp(`/condition-reports/${IN}`, { state });
    await findHeading(/^Move-in/);
    const kitchen = await screen.findByRole('article', { name: 'Kitchen' });
    expect(within(kitchen).getByText('Fair')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Fair' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Make the PDF' }));
    const sheet = await screen.findByRole('dialog');
    expect(
      within(sheet).getByText("This report isn't finished, and the PDF says so."),
    ).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Make the PDF' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', conditionPaths.pdf)?.body).toMatchObject({ reportId: IN }),
    );
  });
});
