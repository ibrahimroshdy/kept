/**
 * Registries and the type editor (task 28; D11, D92, D123, D160, D168, D177, D192), against the
 * mock server: the type tree and editor with the impact preview, Customise on a built-in, field
 * redefinition and cycles, secret fields for the owner only, the Device group shown as inherited,
 * the icon picker by keyboard, place kinds, the registries with the duplicate hint and merge, the
 * person page's contact card, currencies, and the owner / admin / member / viewer variants, in
 * English and in Arabic (RTL).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { householdPaths as hp } from '@/api/household/paths';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths as p } from '@/api/inventory/paths';
import type { TypeDetail } from '@/api/inventory/types';
import { type MockState, ownerScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/server';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

const Y = INV_IDS.type;
const A = INV_IDS.account;

const typesUrl = (type?: string, extra = '') =>
  `/settings/account/types${type ? `?type=${type}` : ''}${extra}`;

/**
 * Ibrahim in Bruce's account (`?account=`): an admin of his home, a member (the fixture), or a
 * viewer. His account gets a custom type of its own, so an admin has something editable.
 */
const SEWING = '01926f00-0000-7000-8000-0000000e0060';
function inBruces(role: 'admin' | 'member' | 'viewer', state: MockState = ownerScenario()) {
  const bruce = state.inventory.accounts.find((a) => a.id === A.bruce);
  if (bruce) bruce.canManage = role === 'admin';
  const family = state.locations.find((l) => l.id === INV_IDS.loc.family);
  if (family) family.role = role;
  const base = state.inventory.types.find((x) => x.id === Y.boardGame) as TypeDetail;
  state.inventory.types.push({
    ...base,
    id: SEWING,
    name: 'Sewing kit',
    icon: 'lucide:box',
    inUse: 0,
    fields: [],
    ownerAccountId: A.bruce,
  } as TypeDetail);
  return state;
}
const BRUCE = `&account=${A.bruce}`;

/** Text that a `<bdi>` or two break into pieces: the innermost element whose text matches. */
const hasText = (re: RegExp) => (_: string, el: Element | null) =>
  !!el &&
  re.test(el.textContent ?? '') &&
  ![...el.children].some((c) => re.test(c.textContent ?? ''));

/** Pick a Combobox option by typing, as a person would. */
async function choose(
  user: {
    clear: (e: Element) => Promise<void>;
    type: (e: Element, s: string) => Promise<void>;
    click: (e: Element) => Promise<void>;
  },
  box: HTMLElement,
  text: string,
  option: string | RegExp,
) {
  await user.clear(box);
  await user.type(box, text);
  await user.click(await screen.findByRole('option', { name: option }));
}

const editor = (name: string | RegExp) => screen.findByRole('article', { name }, { timeout: 3000 });

describe('the type tree and editor', { timeout: 20_000 }, () => {
  it('lists the tree, and a built-in shows its inherited and Device-group fields read-only (D192)', async () => {
    const { user } = await renderApp(typesUrl());
    const tree = await screen.findByRole('navigation', { name: 'Types' }, { timeout: 3000 });
    expect(within(tree).getByRole('link', { name: /Electronics/ })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Field groups' })).getByRole('link', {
        name: /Device/,
      }),
    ).toBeInTheDocument();
    await user.click(within(tree).getByRole('link', { name: /TV \/ display/ }));
    const tv = await editor('TV / display');
    expect(within(tv).getByText(/Built in · read-only until you customise it/)).toBeInTheDocument();
    // The Device group, headed with who shares it, its fields inherited from the group.
    const heading = within(tv).getByRole('heading', { name: /Device group · shared by/ });
    expect(heading.textContent).toMatch(/Phone/);
    expect(heading.textContent).toMatch(/TV \/ display/);
    expect(within(tv).getByText('MAC address')).toBeInTheDocument();
    expect(within(tv).getByText(/repeatable/)).toBeInTheDocument();
    // A secret field has a lock, and its Policy button is the owner's.
    expect(
      within(tv).getByText('Linked account or login', { selector: 'bdi' }),
    ).toBeInTheDocument();
    expect(
      within(tv).getByRole('button', { name: 'Policy Linked account or login' }),
    ).toBeInTheDocument();
    // Read-only until customised: no field or save controls, and the group shown as built in.
    expect(within(tv).queryByRole('button', { name: 'Add a field' })).toBeNull();
    expect(
      within(tv).getByText(/Built in · read-only · its fields are listed above/),
    ).toBeInTheDocument();
    expect(within(tv).getByRole('button', { name: 'Customise' })).toBeInTheDocument();
    // Inherited capabilities show on, from Electronics.
    expect(within(tv).getByRole('button', { name: 'Warranty, inherited' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('Customise copies a built-in into the account and opens the copy (Q13b)', async () => {
    const { user, mock, router } = await renderApp(typesUrl(Y.phone));
    const phone = await editor('Phone');
    await user.click(within(phone).getByRole('button', { name: 'Customise' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.typeCustomise(Y.phone))?.body).toEqual({
        accountId: A.ibrahim,
      }),
    );
    await waitFor(() =>
      expect((router.state.location.search as { type?: string }).type).not.toBe(Y.phone),
    );
    const copy = await editor('Phone');
    expect(within(copy).getByText(/Customised from the built-in type/)).toBeInTheDocument();
    expect(within(copy).getByRole('textbox', { name: 'Name' })).toHaveValue('Phone');
    expect(within(copy).getByRole('button', { name: 'Add a field' })).toBeInTheDocument();
    // The account's phone now uses the copy, and the tree shows one Phone, not two.
    const tree = screen.getByRole('navigation', { name: 'Types' });
    expect(within(tree).getAllByRole('link', { name: /^Phone/ })).toHaveLength(1);
    expect(await screen.findByText(/Your things of this type use the copy/)).toBeInTheDocument();
  });

  it('saving opens the impact preview first, then PATCHes with If-Match (D92, D123)', async () => {
    const { user, mock } = await renderApp(typesUrl(Y.boardGame));
    const game = await editor('Board game');
    const name = within(game).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Tabletop game');
    await user.click(within(game).getByRole('button', { name: /^Container/ }));
    await user.click(within(game).getByRole('button', { name: 'Review and save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save changes to Board game?' });
    expect(
      await within(dialog).findByText(/Also affects 1 location you can't see/),
    ).toBeInTheDocument();
    expect(mock.lastCall('PATCH', p.type(Y.boardGame))).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = mock.lastCall('PATCH', p.type(Y.boardGame));
      expect(call?.body).toEqual({ name: 'Tabletop game', capabilities: ['container'] });
      expect(call?.headers['if-match']).toBe('1');
    });
    expect(await editor('Tabletop game')).toBeInTheDocument();
  });

  it('a cycle is refused with its own message', async () => {
    const state = ownerScenario();
    const card: TypeDetail = {
      ...(state.inventory.types.find((x) => x.id === Y.boardGame) as TypeDetail),
      id: '01926f00-0000-7000-8000-0000000e0051',
      name: 'Card game',
      fields: [],
      inUse: 0,
    };
    state.inventory.types.push(card);
    const { user } = await renderApp(typesUrl(Y.boardGame), { state });
    const game = await editor('Board game');
    await choose(user, within(game).getByRole('combobox', { name: 'Inside' }), 'Card', 'Card game');
    // Meanwhile someone put Card game inside Board game.
    card.parentId = Y.boardGame;
    await user.click(within(game).getByRole('button', { name: 'Review and save' }));
    const dialog = await screen.findByRole('dialog', { name: /Save changes to Board game/ });
    await user.click(await within(dialog).findByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(/can't sit inside itself or a type below it/),
    ).toBeInTheDocument();
  });

  it('adds a field; a key already defined is refused on the key field (D92)', async () => {
    const { user, mock } = await renderApp(typesUrl(Y.boardGame), {
      setup: (m) =>
        m.on('POST', p.typeFields(':id'), ({ body }) =>
          (body as { key: string }).key === 'box_size'
            ? new MockReply(409, {
                error: 'That field key is already used.',
                code: 'conflict',
                reason: 'field_redefined',
                key: 'box_size',
              })
            : new MockReply(201, { ...(body as object), id: 'f-new' }),
        ),
    });
    const game = await editor('Board game');
    await user.click(within(game).getByRole('button', { name: 'Add a field' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a field' });
    // Already on this type: caught before sending.
    await user.type(within(dialog).getByRole('textbox', { name: 'Label' }), 'Players');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText(/is already a field of this type/)).toBeInTheDocument();
    expect(mock.lastCall('POST', p.typeFields(Y.boardGame))).toBeUndefined();
    // Defined below or in a group: the server's 409 lands on the key field too.
    const label = within(dialog).getByRole('textbox', { name: 'Label' });
    await user.clear(label);
    await user.type(label, 'Box size');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/is already a field of this type/)).toBeInTheDocument();
    expect(mock.lastCall('POST', p.typeFields(Y.boardGame))?.body).toMatchObject({
      key: 'box_size',
      label: 'Box size',
      kind: 'text',
    });
    // A fresh key works.
    await user.clear(label);
    await user.type(label, 'Age range');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.typeFields(Y.boardGame))?.body).toMatchObject({
        key: 'age_range',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a field' })).toBeNull());
  });

  it('a secret field is offered to the owner only (D177)', async () => {
    const { user, mock } = await renderApp(typesUrl(Y.boardGame));
    const game = await editor('Board game');
    await user.click(within(game).getByRole('button', { name: 'Add a field' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a field' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Label' }), 'Online code');
    await user.click(within(dialog).getByRole('switch', { name: /Secret/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.typeFields(Y.boardGame))?.body).toEqual({
        key: 'online_code',
        label: 'Online code',
        kind: 'text',
        secret: true,
      }),
    );
    const after = await editor('Board game');
    expect(await within(after).findByText('Online code', { selector: 'bdi' })).toBeInTheDocument();
    expect(within(after).getByRole('button', { name: 'Policy Online code' })).toBeInTheDocument();
  });

  it('an admin edits types but sees no secret switch or policy (D177)', async () => {
    const { user } = await renderApp(typesUrl(SEWING, BRUCE), { state: inBruces('admin') });
    const game = await editor('Sewing kit');
    await user.click(within(game).getByRole('button', { name: 'Add a field' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a field' });
    expect(within(dialog).queryByRole('switch', { name: /Secret/ })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(
      within(screen.getByRole('navigation', { name: 'Types' })).getByRole('link', {
        name: /TV \/ display/,
      }),
    );
    const tv = await editor('TV / display');
    expect(
      within(tv).getByText('Linked account or login', { selector: 'bdi' }),
    ).toBeInTheDocument();
    expect(within(tv).queryByRole('button', { name: /Policy/ })).toBeNull();
    expect(within(tv).getByRole('button', { name: 'Customise' })).toBeInTheDocument();
  });

  it('a member sees types read-only', async () => {
    await renderApp(typesUrl(SEWING, BRUCE), { state: inBruces('member') });
    const game = await editor('Sewing kit');
    expect(within(game).getByText(/Only the owner and admins change types/)).toBeInTheDocument();
    expect(within(game).queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(within(game).queryByRole('button', { name: 'Add a field' })).toBeNull();
    expect(within(game).queryByRole('button', { name: 'Change icon' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New type' })).toBeNull();
  });

  it('archives and restores a field (D92)', async () => {
    const { user, mock } = await renderApp(typesUrl(Y.boardGame));
    const game = await editor('Board game');
    await user.click(within(game).getByRole('button', { name: 'Archive Players' }));
    await waitFor(() =>
      expect(mock.calls.some((c) => c.method === 'POST' && c.path.endsWith('/archive'))).toBe(true),
    );
    expect(await screen.findByText(/Archived fields · values are kept/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Restore Players' }));
    expect(await screen.findByRole('button', { name: 'Archive Players' })).toBeInTheDocument();
  });

  it('the icon picker works by keyboard and returns focus', async () => {
    const { user } = await renderApp(typesUrl(Y.boardGame));
    const game = await editor('Board game');
    const change = within(game).getByRole('button', { name: 'Change icon' });
    change.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Choose an icon' });
    const search = await within(dialog).findByRole(
      'searchbox',
      { name: 'Search icons' },
      { timeout: 5000 },
    );
    await user.type(search, 'tv');
    const grid = within(dialog).getByRole('listbox', { name: 'Icons' });
    expect(within(grid).getByRole('option', { name: 'tv' })).toBeInTheDocument();
    await user.tab();
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Choose an icon' })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName('Change icon'));
    expect(game.querySelector('header [data-icon^="lucide:tv"]')).not.toBeNull();
    expect(within(game).getByRole('button', { name: 'Review and save' })).toBeInTheDocument();
  });

  it('works right to left in Arabic', async () => {
    await renderApp(typesUrl(Y.tvDisplay), { locale: 'ar' });
    const tv = await editor('تلفزيون / شاشة');
    expect(document.documentElement.dir).toBe('rtl');
    expect(within(tv).getByText('الحساب المرتبط', { selector: 'bdi' })).toBeInTheDocument();
    expectLogicalOnly();
  });

  it('merging a type previews first, then moves its things (D92)', async () => {
    // Into the account's own copy of Furniture: a built-in original is never a target (T11).
    const state = ownerScenario();
    const furniture = state.inventory.types.find((x) => x.id === Y.furniture);
    if (furniture) furniture.copiedFromId = 'the-built-in-furniture';
    const { user, mock, router } = await renderApp(typesUrl(Y.boardGame), { state });
    const game = await editor('Board game');
    await user.click(within(game).getByRole('button', { name: 'Merge into…' }));
    const pick = await screen.findByRole('dialog', { name: 'Merge Board game into…' });
    await choose(
      user,
      within(pick).getByRole('combobox', { name: 'Merge into' }),
      'Furn',
      'Furniture',
    );
    await user.click(within(pick).getByRole('button', { name: 'Review' }));
    const preview = await screen.findByRole('dialog', { name: 'Merge Board game into Furniture?' });
    await user.click(await within(preview).findByRole('button', { name: 'Merge' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.typeMergeInto(Y.boardGame))?.body).toEqual({
        targetId: Y.furniture,
      }),
    );
    await waitFor(() => expect(router.state.location.search).toMatchObject({ type: Y.furniture }));
  });

  it('deleting a type in use says to merge instead (D92)', async () => {
    const { user } = await renderApp(typesUrl(Y.boardGame), {
      setup: (m) =>
        m.on(
          'DELETE',
          p.type(':id'),
          () => new MockReply(409, { error: 'In use.', code: 'in_use' }),
        ),
    });
    const game = await editor('Board game');
    await user.click(within(game).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete Board game?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/Board game is in use/)).toBeInTheDocument();
  });

  it('/types/<id> shows the same editor on its own page', async () => {
    await renderApp(`/types/${Y.car}`);
    await findHeading('Car');
    const car = await editor('Car');
    expect(
      within(car).getByRole('heading', { name: /From Vehicle · inherited/ }),
    ).toBeInTheDocument();
    expect(within(car).getByText('VIN')).toBeInTheDocument();
  });
});

describe('place kinds (D160)', { timeout: 20_000 }, () => {
  it('makes a kind and gives it a field with the same field sheet', async () => {
    const { user, mock } = await renderApp('/settings/account/place-kinds');
    await screen.findByRole('list', { name: 'Place kinds' }, { timeout: 3000 });
    await user.click(screen.getByRole('button', { name: 'New kind' }));
    const dialog = await screen.findByRole('dialog', { name: 'New place kind' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Shelf');
    await user.click(within(dialog).getByRole('button', { name: 'Make the kind' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.accountPlaceKinds(A.ibrahim))?.body).toMatchObject({
        key: 'shelf',
        name: 'Shelf',
      }),
    );
    const shelf = await editor('Shelf');
    await user.click(within(shelf).getByRole('button', { name: 'Add a field' }));
    const add = await screen.findByRole('dialog', { name: 'Add a field' });
    await user.type(within(add).getByRole('textbox', { name: 'Label' }), 'Width');
    await choose(user, within(add).getByRole('combobox', { name: 'Kind' }), 'Num', 'Number');
    await user.type(within(add).getByRole('textbox', { name: 'Unit' }), 'cm');
    await user.click(within(add).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        mock.calls.find((c) => c.method === 'POST' && c.path.endsWith('/fields'))?.body,
      ).toEqual({
        key: 'width',
        label: 'Width',
        kind: 'number',
        unit: 'cm',
      }),
    );
    expect(
      await within(await editor('Shelf')).findByText('Width', { selector: 'bdi' }),
    ).toBeInTheDocument();
  });

  it('a built-in kind is read-only until customised, which makes the account its own (T28)', async () => {
    const { user, mock } = await renderApp('/settings/account/place-kinds');
    const list = await screen.findByRole('list', { name: 'Place kinds' }, { timeout: 3000 });
    await user.click(within(list).getByRole('link', { name: /Room/ }));
    const room = await editor('Room');
    expect(within(room).queryByRole('button', { name: 'Add a field' })).toBeNull();
    await user.click(within(room).getByRole('button', { name: 'Customise' }));
    await waitFor(() =>
      expect(
        mock.lastCall('POST', p.placeKindCustomise(INV_IDS.account.ibrahim, 'room')),
      ).toBeDefined(),
    );
    const copy = await editor('Room');
    expect(await within(copy).findByRole('button', { name: 'Add a field' })).toBeInTheDocument();
    expect(within(copy).getByText("Your account's own kind")).toBeInTheDocument();
  });

  it("the account's own copy of a built-in has no Customise; the built-ins keep it", async () => {
    const state = ownerScenario();
    const kinds = state.inventory.placeKinds[A.ibrahim] ?? [];
    const closet = kinds.find((k) => k.builtinKey === 'closet');
    if (!closet) throw new Error('fixture');
    // Customised earlier: still `builtinKey: 'closet'`, but the account's own now.
    closet.ownerAccountId = A.ibrahim;
    const { user } = await renderApp('/settings/account/place-kinds', { state });
    const list = await screen.findByRole('list', { name: 'Place kinds' }, { timeout: 3000 });
    expect(within(list).getByRole('link', { name: /Closet/ })).toHaveTextContent('Your own');
    expect(within(list).getByRole('link', { name: /Room/ })).toHaveTextContent('Built in');
    await user.click(within(list).getByRole('link', { name: /Closet/ }));
    const copy = await editor('Closet');
    expect(within(copy).queryByRole('button', { name: 'Customise' })).toBeNull();
    expect(within(copy).getByText("Your account's own kind")).toBeInTheDocument();
    expect(within(copy).getByRole('button', { name: 'Add a field' })).toBeInTheDocument();
  });
});

describe('brands, vendors, people and tags (D11)', { timeout: 20_000 }, () => {
  it('adding a near-duplicate person is a hint, never a block, and offers the merge', async () => {
    const { user, mock } = await renderApp('/settings/account/people');
    const list = await screen.findByRole('list', { name: 'People' }, { timeout: 3000 });
    expect(within(list).getByRole('link', { name: /Alfred/ })).toHaveAttribute(
      'href',
      `/people/${INV_IDS.person.alfred}`,
    );
    await user.type(screen.getByRole('textbox', { name: 'Add a person' }), 'alfred ');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.accountRegistry(A.ibrahim, 'people'))?.body).toMatchObject({
        displayName: 'alfred',
      }),
    );
    expect(await screen.findByText(hasText(/Is it Alfred, already here\?/))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Merge into Alfred' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge alfred into…' });
    await user.click(within(dialog).getByRole('button', { name: 'Merge into Alfred' }));
    await waitFor(() => {
      const call = mock.calls.find((c) => c.method === 'POST' && c.path.includes('/merge-into'));
      expect(call?.body).toEqual({ targetId: INV_IDS.person.alfred });
    });
  });

  it('a brand that already exists is refused with a link to it (409 existingId)', async () => {
    const { user } = await renderApp('/settings/account/brands');
    await screen.findByRole('list', { name: 'Brands' }, { timeout: 3000 });
    await user.type(screen.getByRole('textbox', { name: 'Add a brand' }), 'SAMSUNG');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(hasText(/SAMSUNG is already in this list/))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      `/brands/${INV_IDS.brand.samsung}`,
    );
  });

  it('search is in the URL, and rows have Edit, Merge and Delete for admins', async () => {
    const { user, router, mock } = await renderApp('/settings/account/vendors');
    await screen.findByRole('list', { name: 'Vendors' }, { timeout: 3000 });
    await user.type(screen.getByRole('searchbox', { name: 'Search vendors' }), 'b.te');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'b.te' }));
    const list = await screen.findByRole('list', { name: 'Vendors' });
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Actions for B.TECH' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit B.TECH' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Address' }), 'Nasr City');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = mock.lastCall('PATCH', p.registryItem('vendors', INV_IDS.vendor.bTech));
      expect(call?.body).toMatchObject({ name: 'B.TECH', address: 'Nasr City', kind: 'store' });
      expect(call?.headers['if-match']).toBe('1');
    });
  });

  it('a member adds people and tags, but not brands, and changes nothing', async () => {
    const { user } = await renderApp(`/settings/account/tags?${BRUCE.slice(1)}`, {
      state: inBruces('member'),
    });
    await screen.findByRole('list', { name: 'Tags' }, { timeout: 3000 });
    expect(screen.getByRole('textbox', { name: 'Add a tag' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Brands' }));
    await screen.findByRole('list', { name: 'Brands' }, { timeout: 3000 });
    expect(screen.queryByRole('textbox', { name: 'Add a brand' })).toBeNull();
    expect(screen.getByText(/Only the owner and admins add and change brands/)).toBeInTheDocument();
  });

  it('a viewer only looks', async () => {
    await renderApp(`/settings/account/people?${BRUCE.slice(1)}`, { state: inBruces('viewer') });
    await screen.findByRole('list', { name: 'People' }, { timeout: 3000 });
    expect(screen.queryByRole('textbox', { name: 'Add a person' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('the account switcher lists accounts you manage and keeps the choice in the URL (Q21)', async () => {
    const state = ownerScenario();
    const bruce = state.inventory.accounts.find((a) => a.id === A.bruce);
    if (bruce) bruce.canManage = true;
    const { user, router } = await renderApp('/settings/account/people', { state });
    const picker = await screen.findByRole('combobox', { name: 'Account' }, { timeout: 3000 });
    expect(picker).toHaveValue('Your account');
    await choose(user, picker, 'Bruce', "Bruce's account");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ account: A.bruce }));
    const list = await screen.findByRole('list', { name: 'People' });
    await waitFor(() =>
      expect(within(list).getByRole('link', { name: /ألفريد/ })).toBeInTheDocument(),
    );
    // The tabs keep the account.
    expect(screen.getByRole('link', { name: 'Tags' }).getAttribute('href')).toContain(A.bruce);
  });
});

describe('the person, vendor and brand pages', { timeout: 20_000 }, () => {
  it("a person's page shows the contact card and what belongs to them (D57, D177)", async () => {
    await renderApp(`/people/${INV_IDS.person.alfred}`);
    await findHeading('Alfred');
    expect(await screen.findByRole('link', { name: /\+20 100 555 0199/ })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Belongs to Alfred' });
    expect(within(list).getByRole('link', { name: /Christmas lights/ })).toBeInTheDocument();
  });

  it('the contact card is not there when the server withholds it (a member, D177)', async () => {
    const { mock } = await renderApp(`/people/${INV_IDS.person.alfredAr}`, {
      state: inBruces('member'),
    });
    await findHeading('ألفريد');
    await screen.findByText(/Nothing yet/);
    // Not asked for: a member can't be shown it, and the 404 was console noise (UI step-4 L8).
    expect(mock.lastCall('GET', p.personContact(INV_IDS.person.alfredAr))).toBeFalsy();
    expect(screen.queryByText(/\+20 100/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Contact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it("a brand's page shows its support details and its things", async () => {
    await renderApp(`/brands/${INV_IDS.brand.samsung}`);
    await findHeading('Samsung');
    expect(screen.getByText('19400')).toBeInTheDocument();
    expect(screen.getByText('Built in')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Things by Samsung' });
    expect(within(list).getAllByRole('link').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe("a brand's logo (T9, T29)", { timeout: 20_000 }, () => {
  it("an admin of the brand's account adds one: the image itself is the PUT's body", async () => {
    const { user, mock } = await renderApp(`/brands/${INV_IDS.brand.toshiba}`, {
      state: inBruces('admin'),
    });
    await findHeading('توشيبا');
    const add = await screen.findByRole('button', { name: 'Add a logo' });
    expect(screen.getByText('PNG, JPEG, WebP or SVG, up to 2 MB.')).toBeInTheDocument();
    const input = add.parentElement?.querySelector('input[type="file"]') as HTMLInputElement;
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
    await user.upload(input, png);
    await waitFor(() =>
      expect(mock.lastCall('PUT', hp.brandLogo(INV_IDS.brand.toshiba))).toBeTruthy(),
    );
    expect(mock.lastCall('PUT', hp.brandLogo(INV_IDS.brand.toshiba))?.body).toBeInstanceOf(File);
    // The brand's tile asks for the new version.
    await waitFor(() =>
      expect(
        screen.getByRole('img', { name: 'Logo of توشيبا', hidden: true }).getAttribute('src'),
      ).toMatch(/\/logo\?v=/),
    );
  });

  it('asks for no image when the brand says it has none (UI step-4 review L8)', async () => {
    const state = inBruces('member');
    const toshiba = state.inventory.brands.find((b) => b.id === INV_IDS.brand.toshiba);
    if (toshiba) Object.assign(toshiba, { hasLogo: false });
    await renderApp(`/brands/${INV_IDS.brand.toshiba}`, { state });
    await findHeading('توشيبا');
    await screen.findByRole('list', { name: /Things by/ });
    expect(screen.queryByRole('img', { name: 'Logo of توشيبا', hidden: true })).toBeNull();
  });

  it('a member sees no logo actions; a built-in brand has none either', async () => {
    await renderApp(`/brands/${INV_IDS.brand.toshiba}`, { state: inBruces('member') });
    await findHeading('توشيبا');
    await screen.findByRole('list', { name: /Things by/ });
    expect(screen.queryByRole('button', { name: 'Add a logo' })).toBeNull();
  });
});

describe('admin → currencies (D168)', { timeout: 20_000 }, () => {
  it('switches a currency on; the defaults stay on with the reason', async () => {
    const { user, mock } = await renderApp('/admin/currencies');
    await screen.findByRole('list', { name: 'Currencies' }, { timeout: 3000 });
    const egp = screen.getByRole('switch', { name: 'EGP on' });
    expect(egp).toBeChecked();
    expect(egp).toBeDisabled();
    expect(screen.getAllByText('Always on: one of the five defaults').length).toBe(5);
    await user.click(screen.getByRole('switch', { name: 'SAR on' }));
    await waitFor(() =>
      expect(mock.lastCall('PATCH', p.adminCurrency('SAR'))?.body).toEqual({ enabled: true }),
    );
    expect(await screen.findByText('SAR is on')).toBeInTheDocument();
  });
});
