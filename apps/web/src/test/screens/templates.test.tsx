/**
 * Templates on the T3 mock (T30; D76, D177, Q17): Account → Templates lists them with where they
 * are shared; the template sheet offers the type's fields but never money or secret ones; "Save
 * as template" on a thing; and quick add, where "From a template" fills the create sheet and the
 * thing is created with its templateId.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { capturePaths as cp } from '@/api/capture/paths';
import { captureApi } from '@/api/capture/queries';
import type { CreateTemplateBody, SaveAsTemplateBody } from '@/api/capture/types';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths as ip } from '@/api/inventory/paths';
import type { CreateThingBody, ResolvedField } from '@/api/inventory/types';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const field = (key: string, kind: ResolvedField['kind'], extra: Partial<ResolvedField> = {}) =>
  ({
    id: `f-${key}`,
    key,
    label: key === 'insured_value' ? 'Insured value' : key === 'dial' ? 'Dial' : null,
    labelKey: null,
    kind,
    unit: null,
    options: null,
    repeatable: false,
    required: false,
    secret: false,
    sort: 0,
    archivedAt: null,
    source: { typeId: INV_IDS.type.safe, via: 'own' },
    rowVersion: 1,
    ...extra,
  }) as ResolvedField;

describe('templates', () => {
  it('Account → Templates lists each template with where it is shared', async () => {
    await renderApp('/settings/account/templates');
    const list = await screen.findByRole('list', { name: 'Templates' });
    expect(within(list).getByText('Storage box')).toBeInTheDocument();
    expect(within(list).getByText(/Shared with 1 location/)).toHaveTextContent(
      'Shared with 1 location: Home',
    );
    expectLogicalOnly();
  });

  it('the template sheet offers the type’s fields but never money or secret ones', async () => {
    const state = ownerScenario();
    const safe = state.inventory.types.find((t) => t.id === INV_IDS.type.safe);
    if (!safe) throw new Error('no safe type');
    safe.fields = [...safe.fields, field('dial', 'text'), field('insured_value', 'money')];
    const { user, mock } = await renderApp('/settings/account/templates', { state });
    await screen.findByRole('list', { name: 'Templates' });
    await user.click(screen.getByRole('button', { name: 'New template' }));
    const sheet = await screen.findByRole('dialog', { name: 'New template' });
    await user.type(within(sheet).getByRole('textbox', { name: 'Template name' }), 'Wall safe');
    const typeBox = within(sheet).getByRole('combobox', { name: 'Type' });
    await user.type(typeBox, 'Safe');
    await user.click((await screen.findAllByRole('option', { name: /Safe/ }))[0] as HTMLElement);
    expect(await within(sheet).findByRole('textbox', { name: 'Dial' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('textbox', { name: 'Insured value' })).toBeNull();
    expect(within(sheet).queryByRole('textbox', { name: /combination/i })).toBeNull();
    await user.type(within(sheet).getByRole('textbox', { name: 'Dial' }), 'Brass');

    // Sharing is required.
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('Share it with at least one location.')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: /Share with/ }));
    await user.click(await screen.findByRole('option', { name: 'Home' }));
    await user.keyboard('{Escape}');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', cp.accountTemplates(INV_IDS.account.ibrahim))).toBeTruthy(),
    );
    const body = mock.lastCall('POST', cp.accountTemplates(INV_IDS.account.ibrahim))
      ?.body as CreateTemplateBody;
    expect(body).toMatchObject({
      name: 'Wall safe',
      typeId: INV_IDS.type.safe,
      payload: { custom: { dial: 'Brass' } },
      locationIds: [IDS.home],
    });
    expect(JSON.stringify(body.payload)).not.toMatch(/insured|combination|price/);
  });

  it('a template name is at most 80 characters, as the server and the database hold it', async () => {
    const { user, mock } = await renderApp('/settings/account/templates');
    await screen.findByRole('list', { name: 'Templates' });
    await user.click(screen.getByRole('button', { name: 'New template' }));
    const sheet = await screen.findByRole('dialog', { name: 'New template' });
    const name = within(sheet).getByRole('textbox', { name: 'Template name' });
    fireEvent.change(name, { target: { value: 'x'.repeat(81) } });
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('At most 80 characters.')).toBeInTheDocument();
    expect(mock.lastCall('POST', cp.accountTemplates(INV_IDS.account.ibrahim))).toBeFalsy();

    // The mock refuses what the server refuses.
    await expect(
      captureApi.createTemplate(INV_IDS.account.ibrahim, {
        name: 'x'.repeat(81),
        payload: {},
        locationIds: [IDS.home],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'validation' });
  });

  it('Save as template on a thing names it after the thing and shares it here', async () => {
    const { user, mock } = await renderApp(`/t/${INV_IDS.thing.drill}?sheet=template`);
    const sheet = await screen.findByRole('dialog', { name: 'Save as template' });
    const name = within(sheet).getByRole('textbox', { name: 'Template name' });
    expect((name as HTMLInputElement).value).not.toBe('');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', cp.thingSaveAsTemplate(INV_IDS.thing.drill))).toBeTruthy(),
    );
    const body = mock.lastCall('POST', cp.thingSaveAsTemplate(INV_IDS.thing.drill))
      ?.body as SaveAsTemplateBody;
    expect(body.locationIds).toHaveLength(1);
  });

  it('quick add: From a template fills the create sheet and sends templateId', async () => {
    const { user, mock } = await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Search or jump to' });
    await user.click(within(palette).getByRole('option', { name: /Add a thing/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Add a thing' });
    await user.click(await within(sheet).findByRole('button', { name: 'From a template' }));
    const picker = await screen.findByRole('dialog', { name: 'Start from a template' });
    await user.click(within(picker).getByRole('button', { name: 'Storage box' }));
    expect(within(sheet).getByRole('textbox', { name: 'Name' })).toHaveValue('Storage box');
    expect(within(sheet).queryByRole('button', { name: 'From a template' })).toBeNull();
    await user.type(within(sheet).getByRole('combobox', { name: 'Where it is' }), 'Kitchen');
    await user.click((await screen.findAllByRole('option', { name: /Kitchen/ }))[0] as HTMLElement);
    await user.click(within(sheet).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mock.lastCall('POST', ip.things)).toBeTruthy());
    expect(mock.lastCall('POST', ip.things)?.body as CreateThingBody).toMatchObject({
      name: 'Storage box',
      colour: 'Grey',
      notes: 'Stackable, 40 L',
      templateId: expect.any(String),
    });
  });
});
