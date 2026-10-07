/**
 * The type editor's conversions (step-7 plan T24; D172, D177, D193): the account owner makes the
 * Batteries type's Size field secret, plain, or another kind, through a preview per location
 * (counts, never values) and the field's name typed to confirm; the recovery kit asked for first;
 * hidden from an admin who isn't the owner; Arabic.
 *
 * The Batteries type is copied into Ibrahim's account here (a built-in is read-only until
 * Customise). Its Size values: Home "12", "4", "about 6", "1.5" and the batteries' "AA"; Garage
 * "9", "two" (api/portability/mock/state.ts).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import type { TypeDetail } from '@/api/inventory/types';
import { type MockState, ownerScenario } from '@/api/mock/fixtures';
import { sizeFieldId } from '@/api/portability/mock/state';
import { conversions } from '@/components/registries/field-list';
import { FSI, PDI } from '@/lib/bidi';
import { expectLogicalOnly } from '@/test/render';
import { renderApp } from '../app';

const Y = INV_IDS.type;

/** Batteries as Ibrahim's own copy, so its fields are his to change. */
function copied(state: MockState = ownerScenario(), kitSaved = true): MockState {
  const type = state.inventory.types.find((t) => t.id === Y.batteries) as TypeDetail;
  (type as { copiedFromId: string | null }).copiedFromId = Y.consumables;
  if (state.me.instance) state.me.instance.recoveryKitAcknowledged = kitSaved;
  return state;
}

const editor = async () =>
  (await screen.findAllByRole('article', {}, { timeout: 3000 }))[0] as HTMLElement;

/** The Size field's row in the editor. */
async function sizeRow() {
  const ed = within(await editor());
  // By its key, which reads the same in every language.
  return ed.getByText('size').closest('li') as HTMLElement;
}

/** Opens the row's More sheet (a phone's width in jsdom) and picks an action. */
async function convertAction(
  user: { click: (e: Element) => Promise<void> },
  action: 'Make secret' | 'Make plain' | 'Change kind',
) {
  await user.click(within(await sizeRow()).getByRole('button', { name: 'More' }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

describe('what a field can become', () => {
  it('text: secret or another kind; a secret: plain; money: nothing', () => {
    expect(conversions({ kind: 'text', secret: false })).toEqual(['secret', 'kind']);
    expect(conversions({ kind: 'text', secret: true })).toEqual(['plain']);
    expect(conversions({ kind: 'number', secret: false })).toEqual(['kind']);
    expect(conversions({ kind: 'money', secret: false })).toEqual([]);
  });
});

describe('converting a field', { timeout: 30_000 }, () => {
  it('makes Size secret after the preview and the name typed', async () => {
    const state = copied();
    const { user, mock } = await renderApp(`/types/${Y.batteries}`, { state, digits: 'western' });
    await convertAction(user, 'Make secret');
    const sheet = await screen.findByRole('dialog', { name: `Make ${FSI}Size${PDI} secret?` });
    const preview = await within(sheet).findByRole('list', { name: 'What changes, by location' });
    expect(within(preview).getByText('Home').closest('li')).toHaveTextContent(
      '5 values move to secrets',
    );
    expect(within(preview).getByText('Garage').closest('li')).toHaveTextContent(
      '2 values move to secrets',
    );
    // Counts only: no value reaches the page.
    expect(sheet.textContent).not.toContain('about 6');
    expect(
      within(sheet).getByText(
        'Past history keeps that the value changed, but no longer the value.',
      ),
    ).toBeInTheDocument();
    const button = within(sheet).getByRole('button', { name: 'Make secret' });
    expect(button).toBeDisabled();
    await user.type(within(sheet).getByRole('textbox', { name: /to confirm/ }), 'Siz');
    expect(button).toBeDisabled();
    await user.type(within(sheet).getByRole('textbox', { name: /to confirm/ }), 'e');
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const field = state.inventory.types
      .find((t) => t.id === Y.batteries)
      ?.fields.find((f) => f.id === sizeFieldId(state));
    await waitFor(() => expect(field?.secret).toBe(true));
    expect(mock.lastCall('POST', `/api/v1/type-fields/${field?.id}/convert`)?.body).toEqual({
      toSecret: true,
    });
    expect(await screen.findByText(`${FSI}Size${PDI} is secret now`)).toBeInTheDocument();
  });

  it('changes Size to a number, saying how many go to the notes', async () => {
    const { user } = await renderApp(`/types/${Y.batteries}`, {
      state: copied(),
      digits: 'western',
    });
    await convertAction(user, 'Change kind');
    const sheet = await screen.findByRole('dialog', {
      name: `Change the kind of ${FSI}Size${PDI}`,
    });
    const kind = within(sheet).getByRole('combobox', { name: 'New kind' });
    await user.type(kind, 'Num');
    await user.click(await screen.findByRole('option', { name: 'Number' }));
    const preview = await within(sheet).findByRole('list', { name: 'What changes, by location' });
    expect(within(preview).getByText('Home').closest('li')).toHaveTextContent(
      /3 convert.+2 go to the notes/,
    );
    expect(within(preview).getByText('Garage').closest('li')).toHaveTextContent(
      /1 converts.+1 goes to the notes/,
    );
  });

  it('asks for the recovery kit first', async () => {
    const { user } = await renderApp(`/types/${Y.batteries}`, {
      state: copied(ownerScenario(), false),
    });
    await convertAction(user, 'Make secret');
    const sheet = await screen.findByRole('dialog', { name: /secret\?$/ });
    await within(sheet).findByRole('list', { name: 'What changes, by location' });
    await user.type(within(sheet).getByRole('textbox', { name: /to confirm/ }), 'Size');
    await user.click(within(sheet).getByRole('button', { name: 'Make secret' }));
    expect(await within(sheet).findByText('Download the recovery kit first')).toBeInTheDocument();
  });

  it('is hidden from an admin who isn’t the account owner', async () => {
    const state = copied();
    // Ibrahim as an admin of the account, not its owner.
    const own = state.inventory.accounts.find((a) => a.isOwn);
    if (own) Object.assign(own, { isOwn: false, canManage: true });
    await renderApp(`/types/${Y.batteries}`, { state });
    const row = await sizeRow();
    expect(within(row).queryByRole('button', { name: 'More' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Make secret' })).toBeNull();
  });

  it('reads right to left in Arabic', async () => {
    const { user } = await renderApp(`/types/${Y.batteries}`, { state: copied(), locale: 'ar' });
    await editor();
    expect(document.documentElement.dir).toBe('rtl');
    await user.click(
      within(await sizeRow())
        .getAllByRole('button')
        .at(-1) as HTMLElement,
    );
    await screen.findAllByRole('menuitem');
    expectLogicalOnly();
  });
});
