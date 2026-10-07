/**
 * D156 on the thing screen: a 412 on Save runs the three-way merge. Fields only Alfred changed are
 * taken silently; fields only I changed are saved on top of his version; a field we both changed
 * opens the conflict sheet (Keep mine, Keep theirs, or Edit).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths as p } from '@/api/inventory/paths';
import type { MockApi } from '@/api/mock/server';
import { findHeading, renderApp } from '@/test/app';

// Whole-app renders under a parallel run can pass the 5 s default.
vi.setConfig({ testTimeout: 15_000 });

const TV = INV_IDS.thing.tv;

/** Alfred saves his own edit while mine is open: the row moves on a version. */
function alfredEdits(mock: MockApi, patch: Record<string, unknown>) {
  const tv = mock.state.inventory.things.find((x) => x.id === TV);
  if (!tv) throw new Error('fixture');
  const { custom, ...plain } = patch as { custom?: Record<string, unknown> };
  Object.assign(tv, plain);
  if (custom) Object.assign(tv.custom, custom);
  tv.rowVersion += 1;
}

const patches = (mock: MockApi) =>
  mock.calls.filter((c) => c.method === 'PATCH' && c.path === p.thing(TV));

async function openEdit() {
  const r = await renderApp(`/t/${TV}`);
  await findHeading('Samsung TV, 55″');
  await r.user.click(screen.getByRole('button', { name: 'Edit' }));
  const form = await screen.findByRole('form', { name: 'Edit Samsung TV, 55″' });
  return { ...r, form };
}

describe('edit and save', () => {
  it('sends only what changed, with If-Match', async () => {
    const { user, mock, form } = await openEdit();
    const model = within(form).getByLabelText('Model');
    await user.clear(model);
    await user.type(model, 'QE55Q70C');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(mock)).toHaveLength(1));
    expect(patches(mock)[0]).toMatchObject({
      body: { model: 'QE55Q70C' },
      headers: { 'if-match': '1' },
    });
    expect((await screen.findAllByText('QE55Q70C'))[0]).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /^Edit / })).toBeNull();
  });

  it('Cancel discards the edit', async () => {
    const { user, mock, form } = await openEdit();
    await user.type(within(form).getByLabelText('Model'), 'X');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: /^Edit / })).toBeNull();
    expect(patches(mock)).toHaveLength(0);
  });

  it('validates next to the field (screens §7)', async () => {
    const { user, mock, form } = await openEdit();
    await user.clear(within(form).getByLabelText('Name'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByText('This needs a value.')).toBeInTheDocument();
    expect(patches(mock)).toHaveLength(0);
  });

  it('edits a type field, with a unit and Eastern Arabic digits', async () => {
    const { user, mock, form } = await openEdit();
    const size = within(form).getByLabelText('Screen size (in)');
    await user.clear(size);
    await user.type(size, '٦٥');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(mock)[0]?.body).toEqual({ custom: { screen_size: 65 } }));
  });
});

describe('a 412: the field-level merge (D156)', () => {
  it('takes a field only Alfred changed silently, and saves mine on top of his version', async () => {
    const { user, mock, form } = await openEdit();
    alfredEdits(mock, { model: 'QE55Q60B-M' });
    const serial = within(form).getByLabelText('Serial number');
    await user.clear(serial);
    await user.type(serial, 'NEW-SERIAL-1');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(mock)).toHaveLength(2));
    // The first try was stale; the second carries only my field, against Alfred's version.
    expect(patches(mock)[1]).toMatchObject({
      body: { serial: 'NEW-SERIAL-1' },
      headers: { 'if-match': '2' },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText("Alfred's other changes were kept too.")).toBeInTheDocument();
    expect(screen.getByText('QE55Q60B-M')).toBeInTheDocument();
    expect(screen.getAllByText('NEW-SERIAL-1')[0]).toBeInTheDocument();
  });

  it('opens the conflict sheet for a field we both changed: Keep mine', async () => {
    const { user, mock, form } = await openEdit();
    alfredEdits(mock, { model: 'ALFREDS-MODEL', notes: 'on the wall mount' });
    const model = within(form).getByLabelText('Model');
    await user.clear(model);
    await user.type(model, 'MY-MODEL');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const sheet = await screen.findByRole('dialog', {
      name: 'Alfred changed this since you opened it',
    });
    // Only the field we both changed is in the sheet; his notes went in silently.
    const rows = sheet.querySelectorAll('[data-conflict]');
    expect([...rows].map((r) => r.getAttribute('data-conflict'))).toEqual(['model']);
    expect(within(sheet).getByText('MY-MODEL')).toBeInTheDocument();
    expect(within(sheet).getByText('ALFREDS-MODEL')).toBeInTheDocument();
    const save = within(sheet).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(within(sheet).getByRole('radio', { name: 'Keep mine' }));
    await user.click(save);
    await waitFor(() => expect(patches(mock)).toHaveLength(2));
    expect(patches(mock)[1]).toMatchObject({
      body: { model: 'MY-MODEL' },
      headers: { 'if-match': '2' },
    });
    expect((await screen.findAllByText('MY-MODEL'))[0]).toBeInTheDocument();
    expect(screen.getByText('on the wall mount')).toBeInTheDocument();
  });

  it('Keep theirs: nothing of mine is left to send', async () => {
    const { user, mock, form } = await openEdit();
    alfredEdits(mock, { model: 'ALFREDS-MODEL' });
    const model = within(form).getByLabelText('Model');
    await user.clear(model);
    await user.type(model, 'MY-MODEL');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const sheet = await screen.findByRole('dialog', { name: /Alfred changed this/ });
    await user.click(within(sheet).getByRole('radio', { name: 'Keep theirs' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: /^Edit / })).toBeNull());
    expect(patches(mock)).toHaveLength(1);
    expect(screen.getByText('ALFREDS-MODEL')).toBeInTheDocument();
  });

  it('Edit goes back to the form on that field, holding his other changes', async () => {
    const { user, mock, form } = await openEdit();
    alfredEdits(mock, { model: 'ALFREDS-MODEL', serial: 'ALFREDS-SERIAL' });
    const model = within(form).getByLabelText('Model');
    await user.clear(model);
    await user.type(model, 'MY-MODEL');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const sheet = await screen.findByRole('dialog', { name: /Alfred changed this/ });
    await user.keyboard('{Tab}');
    await user.click(within(sheet).getByRole('radio', { name: 'Edit' }));
    await user.click(within(sheet).getByRole('button', { name: 'Back to editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const again = screen.getByRole('form', { name: /^Edit/ });
    expect(within(again).getByLabelText('Model')).toHaveValue('MY-MODEL');
    expect(within(again).getByLabelText('Serial number')).toHaveValue('ALFREDS-SERIAL');
    await user.clear(within(again).getByLabelText('Model'));
    await user.type(within(again).getByLabelText('Model'), 'AGREED');
    await user.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(mock)).toHaveLength(2));
    expect(patches(mock)[1]).toMatchObject({
      body: { model: 'AGREED' },
      headers: { 'if-match': '2' },
    });
  });

  it('two people editing different custom fields never conflict', async () => {
    const { user, mock, form } = await openEdit();
    alfredEdits(mock, { custom: { os: 'Tizen' } });
    const size = within(form).getByLabelText('Screen size (in)');
    await user.clear(size);
    await user.type(size, '65');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(mock)).toHaveLength(2));
    expect(patches(mock)[1]?.body).toEqual({ custom: { screen_size: 65 } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
