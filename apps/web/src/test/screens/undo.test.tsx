/**
 * The Undo toast (D150; plan T31): lifecycle changes, re-types and trash offer it now that the
 * server records them undoably (T20); it stays 10 s, is announced politely and never takes focus;
 * a refusal says why in words, with "Open the thing"; offline it says Undo needs a connection.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths as p } from '@/api/inventory/paths';
import { MockReply } from '@/api/mock/server';
import { toastQueue } from '@/components/ui/toast';
import { findHeading, pathOf, renderApp } from '@/test/app';

const T = INV_IDS.thing;

afterEach(() => {
  vi.restoreAllMocks();
});

async function giveAway(user: Awaited<ReturnType<typeof renderApp>>['user']) {
  await user.click(screen.getByRole('button', { name: 'Actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Change lifecycle…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Change lifecycle' });
  const box = within(dialog).getByRole('combobox', { name: 'What happened to it' });
  await user.clear(box);
  await user.type(box, 'Given');
  await user.click(await screen.findByRole('option', { name: 'Given away' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
}

const region = () => screen.getByRole('region', { name: 'Notifications' });

describe('the Undo toast', () => {
  it('a lifecycle change offers Undo for 10 s, politely, without taking focus', async () => {
    const { user, mock } = await renderApp(`/t/${T.drill}`);
    await findHeading('Bosch drill, 18 V');
    await giveAway(user);
    const toast = await within(region()).findByText('Given away');
    expect(toast.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
    expect(toastQueue.visibleToasts[0]?.timeout).toBe(10_000);
    expect(region().contains(document.activeElement)).toBe(false);

    await user.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect(await within(region()).findByText('Undone')).toBeInTheDocument();
    const drill = mock.state.inventory.things.find((x) => x.id === T.drill);
    expect(drill?.lifecycle).toBe('in_use');
    expect(
      mock.calls.some((c) => c.method === 'POST' && /\/audit\/[^/]+\/undo$/.test(c.path)),
    ).toBe(true);
  });

  it('a refusal says who changed what, and offers "Open the thing"', async () => {
    const { user, mock, router } = await renderApp(`/t/${T.drill}`);
    await findHeading('Bosch drill, 18 V');
    // The page's own address: the short ID once it replaces the UUID (D208).
    const thingPath = pathOf(router);
    mock.on(
      'POST',
      p.undo(':id'),
      () =>
        new MockReply(409, {
          code: 'undo_refused',
          error: "That can't be undone any more.",
          hint: "Can't undo: Alfred changed place_id since.",
          reason: 'changed_since',
          field: 'place_id',
          conflicts: ['place_id'],
          changedBy: { displayName: 'Alfred' },
        }),
    );
    await giveAway(user);
    await within(region()).findByText('Given away');
    await user.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect(
      await within(region()).findByText("Can't undo: Alfred changed Place since"),
    ).toBeInTheDocument();
    await router.navigate({ to: '/help' });
    await findHeading('Help');
    await user.click(within(region()).getByRole('button', { name: 'Open the thing' }));
    await waitFor(() => expect(pathOf(router)).toBe(thingPath));
  });

  it('offline, Undo says it needs a connection and sends nothing', async () => {
    const { user, mock } = await renderApp(`/t/${T.drill}`);
    await findHeading('Bosch drill, 18 V');
    await giveAway(user);
    await within(region()).findByText('Given away');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const before = mock.calls.length;
    await user.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect(await within(region()).findByText('Undo needs a connection')).toBeInTheDocument();
    expect(mock.calls.slice(before).some((c) => c.method === 'POST')).toBe(false);
  });

  it('trashing a thing is undone through its audit event, back on its page', async () => {
    const { user, mock, router } = await renderApp(`/t/${T.drill}`);
    await findHeading('Bosch drill, 18 V');
    const thingPath = pathOf(router);
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to Trash' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Move to Trash',
      }),
    );
    await within(region()).findByText('Bosch drill, 18 V is in Trash');
    await user.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect(await within(region()).findByText('Undone')).toBeInTheDocument();
    expect(mock.state.inventory.things.find((x) => x.id === T.drill)?.deletedAt).toBeNull();
    expect(mock.calls.some((c) => c.path.endsWith('/restore'))).toBe(false);
    await waitFor(() => expect(pathOf(router)).toBe(thingPath));
  });

  it("a thing's timeline offers Undo on what the server lists as undoable", async () => {
    const { user } = await renderApp(`/t/${T.drill}`);
    await findHeading('Bosch drill, 18 V');
    await giveAway(user);
    await within(region()).findByText('Given away');
    const history = await screen.findByRole('list', { name: 'History' }, { timeout: 3000 });
    const undo = await within(history).findByRole('button', { name: /^Undo: / });
    await user.click(undo);
    expect(await within(region()).findByText('Undone')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Undo: / })).toBeNull());
  });
});
