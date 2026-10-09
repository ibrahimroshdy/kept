/**
 * The inbox (task 27; D18, D36, D175, D191, D205, D206), against the mock server: kind chips with
 * zero counts hidden, the keyboard map driving confirm, reject, accept and next, the currency item
 * with no default, bulk accept with one Undo, receipts linking their lines, duplicates merging
 * into the survivor chosen, the AI states, the offline read-only state with drafts still on the
 * phone, the viewer variant, and RTL.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_IDS } from '@/api/capture/mock/state';
import { capturePaths } from '@/api/capture/paths';
import { INBOX_NAMING_POLL_MS } from '@/api/capture/queries';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { ownerScenario } from '@/api/mock/fixtures';
import { resetKeyboardSeen } from '@/lib/key-hints';
import { MemoryStore } from '@/offline/store';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

// The route reads the phone's store from the offline provider; jsdom has no IndexedDB, so the
// offline test hands it a MemoryStore here.
const offline = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('@/offline/provider', async (original) => ({
  ...(await original<typeof import('@/offline/provider')>()),
  useOffline: () => (offline.store ? { store: offline.store } : null),
}));

afterEach(() => {
  offline.store = null;
  vi.restoreAllMocks();
});

const I = CAPTURE_IDS.inbox;
const S = CAPTURE_IDS.seed;
const inboxList = () => screen.findByRole('list', { name: 'Inbox' }, { timeout: 3000 });
const card = async (name: string) =>
  within(await inboxList()).findByRole('article', { name }, { timeout: 3000 });

describe('the inbox', () => {
  it('lists Mine by capture batch; a kind chip with no items is hidden (D191)', async () => {
    const { user } = await renderApp('/inbox');
    await findHeading('Inbox');
    const list = await inboxList();
    expect(list.textContent).toMatch(/6 captured · Garage › Shelves/);
    const kinds = screen.getByRole('radiogroup', { name: 'Kind' });
    const chips = within(kinds)
      .getAllByRole('radio')
      .map((r) => r.closest('label')?.textContent);
    expect(chips).toContain('Drafts8');
    // The only duplicate is Alfred's: none of mine, so no chip.
    expect(chips.some((c) => c?.startsWith('Duplicates'))).toBe(false);
    await user.click(screen.getByRole('radio', { name: /^Everyone's/ }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('radiogroup', { name: 'Kind' })).getByRole('radio', {
          name: /^Duplicates/,
        }),
      ).toBeInTheDocument(),
    );
  });

  it('the keys confirm and reject suggestions, accept, and move to the next item', async () => {
    const { user, mock } = await renderApp('/inbox?f.kind=draft');
    await card('Bosch impact driver, 18 V');
    // The first item is Home's unnamed draft: `j` moves to the impact driver.
    await user.keyboard('j');
    await waitFor(() =>
      expect(screen.getByRole('article', { name: 'Bosch impact driver, 18 V' })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    await user.keyboard('yna');
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxAccept(I.driver))?.body).toEqual({
        accept: ['serial'],
        reject: ['manufactured_on'],
      }),
    );
    expect(mock.lastCall('POST', capturePaths.inboxAccept(I.driver))?.headers['if-match']).toBe(
      '1',
    );
    // The next item is current now: `a` accepts it.
    await waitFor(() =>
      expect(screen.getByRole('article', { name: 'Extension cord, 5 m' })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    await user.keyboard('a');
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxAccept(I.cord))).toBeDefined(),
    );
  });

  it("won't accept a draft with values still waiting, and says why", async () => {
    await renderApp('/inbox?f.kind=draft');
    const driver = await card('Bosch impact driver, 18 V');
    expect(within(driver).getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(driver.textContent).toMatch(/Confirm or reject each suggested value first/);
    expect(
      within(driver).getByRole('group', { name: 'Suggested serial number' }).textContent,
    ).toMatch(/Suggested · serial number/);
    expect(
      within(driver).getByRole('group', { name: 'Suggested manufacture date' }).textContent,
    ).toMatch(/Nov 14, 2025/);
  });

  it('never offers Confirm on a field accept cannot write (T15 answers 400 for it)', async () => {
    const state = ownerScenario();
    const item = state.capture.inbox.find((i) => i.id === I.driver);
    if (!item?.suggestions?.[0]) throw new Error('no driver item');
    item.suggestions = [{ ...item.suggestions[0], field: 'price', value: '4500.00' }];
    const { user, mock } = await renderApp('/inbox?f.kind=draft', { state });
    const driver = await card('Bosch impact driver, 18 V');
    const price = within(driver).getByRole('group', { name: 'Suggested price' });
    expect(within(price).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(price.textContent).toMatch(/Set this on the thing's page/);
    await user.keyboard('j');
    await waitFor(() => expect(driver).toHaveAttribute('aria-current', 'true'));
    // `y` does nothing here; `n` leaves it out, and Accept sends only the rejection.
    await user.keyboard('y');
    expect(within(driver).getByRole('button', { name: 'Accept' })).toBeDisabled();
    await user.click(within(price).getByRole('button', { name: 'Reject' }));
    await user.click(within(driver).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxAccept(I.driver))?.body).toEqual({
        accept: [],
        reject: ['price'],
      }),
    );
  });

  it('offers an Arabic alias AI proposed for confirming (D214), and Accept sends it', async () => {
    const state = ownerScenario();
    const item = state.capture.inbox.find((i) => i.id === I.driver);
    if (!item?.suggestions?.[0]) throw new Error('no driver item');
    item.suggestions = [{ ...item.suggestions[0], field: 'alias_ar', value: 'مفك كهربائي' }];
    const { user, mock } = await renderApp('/inbox?f.kind=draft', { state });
    const driver = await card('Bosch impact driver, 18 V');
    const alias = within(driver).getByRole('group', { name: 'Suggested search word (Arabic)' });
    expect(alias.textContent).toMatch(/مفك كهربائي/);
    await user.click(within(alias).getByRole('button', { name: 'Confirm' }));
    await user.click(within(driver).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxAccept(I.driver))?.body).toEqual({
        accept: ['alias_ar'],
        reject: [],
      }),
    );
  });

  it('asks which currency "$" was, with no default (D189)', async () => {
    const { user, mock } = await renderApp('/inbox?f.kind=currency');
    // Named apart from the receipt's own review item (both are "Hardware Depot receipt" on screen).
    const receipt = await card('Hardware Depot receipt · Needs a currency');
    const choices = within(within(receipt).getByRole('group', { name: 'Currency' })).getAllByRole(
      'button',
    );
    expect(choices.map((b) => b.textContent)).toEqual([
      expect.stringMatching(/USD$/),
      expect.stringMatching(/CAD$/),
    ]);
    for (const b of choices) expect(b).not.toHaveAttribute('aria-pressed', 'true');
    await user.click(choices[1] as HTMLElement);
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxCurrency(I.currency))?.body).toEqual({
        currency: 'CAD',
      }),
    );
  });

  it('a receipt waiting for its currency takes the answer given in "Needs a currency" (D189)', async () => {
    const state = ownerScenario();
    const ace = state.capture.inbox.find((i) => i.id === I.aceReceipt)?.receipt;
    if (!ace) throw new Error('no Ace Hardware receipt in the fixtures');
    // Before the answer: no currency, so no amounts either.
    const { currency: code, total } = ace;
    delete ace.currency;
    delete ace.total;
    const { queryClient } = await renderApp('/inbox?f.kind=receipt', { state });
    const receipt = await card('Ace Hardware receipt');
    const picker = within(receipt).getByRole('combobox', { name: 'Currency' });
    expect(picker).toHaveValue('');
    expect(within(receipt).getByText('Choose the currency.')).toBeInTheDocument();
    // Answered in its own item: the purchase has them now, and the review shows them.
    Object.assign(ace, { currency: code, total });
    await queryClient.invalidateQueries();
    await waitFor(() => expect(picker).toHaveValue(code));
    expect(within(receipt).getByRole('textbox', { name: 'Total' })).toHaveValue(total);
    expect(within(receipt).queryByText('Choose the currency.')).toBeNull();
  });

  it('a receipt shown before its read fills the shop and the date when the read arrives', async () => {
    // The inbox polls while a photo is read, so the review can appear before the extraction has
    // filled the purchase (CI, 2026-10-09: Shop and Date stayed empty and Accept stayed off).
    const state = ownerScenario();
    const ace = state.capture.inbox.find((i) => i.id === I.aceReceipt)?.receipt;
    if (!ace) throw new Error('no Ace Hardware receipt in the fixtures');
    const { vendorSeen, purchasedOn } = ace;
    if (!vendorSeen || !purchasedOn) throw new Error('the fixture has no shop or date');
    delete ace.vendorSeen;
    delete ace.purchasedOn;
    const { queryClient } = await renderApp('/inbox?f.kind=receipt', { state });
    const receipt = await card('Receipt');
    const shop = within(receipt).getByRole('textbox', { name: 'Shop (new)' });
    expect(shop).toHaveValue('');
    Object.assign(ace, { vendorSeen, purchasedOn });
    await queryClient.invalidateQueries();
    await waitFor(() => expect(shop).toHaveValue(vendorSeen));
    expect(within(receipt).queryByText('Choose the date on the receipt.')).toBeNull();
    expect(within(receipt).queryByText("Type the shop's name.")).toBeNull();
  });

  it('a shop typed before the read arrives is kept', async () => {
    const state = ownerScenario();
    const ace = state.capture.inbox.find((i) => i.id === I.aceReceipt)?.receipt;
    if (!ace) throw new Error('no Ace Hardware receipt in the fixtures');
    const { vendorSeen } = ace;
    delete ace.vendorSeen;
    const { user, queryClient } = await renderApp('/inbox?f.kind=receipt', { state });
    const receipt = await card('Receipt');
    const shop = within(receipt).getByRole('textbox', { name: 'Shop (new)' });
    await user.type(shop, 'Corner shop');
    Object.assign(ace, { vendorSeen });
    await queryClient.invalidateQueries();
    await card(`${vendorSeen} receipt`);
    expect(shop).toHaveValue('Corner shop');
  });

  it('accepts the names of a selection, and one Undo reverts them all (D150)', async () => {
    const { user, mock } = await renderApp('/inbox?f.kind=draft');
    await card('Extension cord, 5 m');
    await user.click(screen.getByRole('checkbox', { name: 'Select Extension cord, 5 m' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Fire extinguisher, 2 kg' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected drafts' });
    expect(bar.textContent).toMatch(/2 selected/);
    await user.click(within(bar).getByRole('button', { name: 'Accept names' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxBulk)?.body).toEqual({
        ids: [I.cord, I.extinguisher],
        action: 'accept_names',
      }),
    );
    expect(await screen.findByText('Accepted 2 names')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'Extension cord, 5 m' })).toBeNull(),
    );
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(mock.calls.some((c) => /\/audit\/[^/]+\/undo$/.test(c.path))).toBe(true),
    );
    expect(await card('Extension cord, 5 m')).toBeInTheDocument();
  });

  it('links a receipt’s lines to the things captured before it', async () => {
    const { user, mock } = await renderApp('/inbox?f.kind=receipt');
    const receipt = await card('Ace Hardware receipt');
    await waitFor(() =>
      expect(
        within(receipt).getByRole('button', { name: 'Accept the receipt and 3 links' }),
      ).toBeEnabled(),
    );
    await user.click(
      within(receipt).getByRole('button', { name: 'Accept the receipt and 3 links' }),
    );
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxReceipt(I.aceReceipt))).toBeDefined(),
    );
    const body = mock.lastCall('POST', capturePaths.inboxReceipt(I.aceReceipt))?.body as {
      vendor: unknown;
      currency: string;
      purchasedOn: string;
      lines: { index: number; action: string; thingId?: string }[];
    };
    expect(body.vendor).toEqual({ name: 'Ace Hardware' });
    expect(body.currency).toBe('EGP');
    expect(body.purchasedOn).toBe('2026-10-03');
    expect(body.lines.map((l) => [l.action, l.thingId])).toEqual([
      ['link', S.driver],
      ['link', S.cord],
      ['link', S.extinguisher],
    ]);
  });

  it('merges a duplicate into the one chosen to stay (D36)', async () => {
    const { user, mock } = await renderApp('/inbox?f.mine=everyone&f.kind=duplicate');
    const dup = await card('Cable box');
    expect(dup.textContent).toMatch(/Merging keeps both histories/);
    await user.click(within(dup).getByRole('button', { name: 'Merge' }));
    await user.click(within(dup).getByRole('radio', { name: /This draft/ }));
    await user.click(within(dup).getByRole('button', { name: 'Merge into Cable box' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.inboxMerge(I.duplicate))?.body).toEqual({
        into: INV_IDS.thing.cableBox,
      }),
    );
  });

  it('shows where naming is: paused, waiting, naming, failed with Retry, and the AI line', async () => {
    const { user, mock } = await renderApp('/inbox?f.kind=draft');
    await card('Bosch impact driver, 18 V');
    const banner = screen.getByText(/^AI paused until .* · Home's monthly cap reached$/);
    expect(banner).toBeInTheDocument();
    const list = await inboxList();
    expect(list.textContent).toMatch(/Waiting: AI paused until/);
    expect(list.textContent).toMatch(/Naming…/);
    expect(list.textContent).toMatch(/Waiting for Groq/);
    // Short (the maintainer's iPhone): the model id is in the call's detail, and Garage's
    // account is the viewer's own.
    expect(list.textContent).toMatch(/AI · Groq · 2\.5K tokens · ≈ \$0\.004 · paid by you/);
    const failed = within(list)
      .getAllByRole('article', { name: 'Unnamed thing' })
      .find((a) => /provider error/.test(a.textContent ?? ''));
    expect(failed).toBeDefined();
    await user.click(within(failed as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.thingExtract(S.failed))).toBeDefined(),
    );
  });

  it('looks again while a photo is being named, so its name arrives without leaving the page', async () => {
    const { mock } = await renderApp('/inbox?f.kind=draft');
    const list = await inboxList();
    expect(list.textContent).toMatch(/Naming…/);
    const gets = () =>
      mock.calls.filter((c) => c.method === 'GET' && c.path === capturePaths.inbox).length;
    const first = gets();
    await waitFor(() => expect(gets()).toBeGreaterThan(first), {
      timeout: INBOX_NAMING_POLL_MS + 2000,
    });
  });

  it('on a phone: Accept, Edit and More in one row; More holds Move, Set type and Discard', async () => {
    const { user } = await renderApp('/inbox?f.kind=draft');
    const cord = await card('Extension cord, 5 m');
    const buttons = within(cord)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons).toEqual(expect.arrayContaining(['Accept', 'Edit', 'More']));
    for (const gone of ['Move', 'Set type', 'Discard'])
      expect(within(cord).queryByRole('button', { name: gone })).toBeNull();
    await user.click(within(cord).getByRole('button', { name: 'More' }));
    const sheet = await screen.findByRole('dialog', { name: 'Extension cord, 5 m' });
    const menu = within(sheet).getByRole('menu', { name: 'More actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Move', 'Set type', 'Discard']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Move' }));
    expect(
      await screen.findByRole('dialog', { name: 'Move Extension cord, 5 m' }),
    ).toBeInTheDocument();
  });

  it('the keys still reach what More holds: `m` opens Move, with no button for it', async () => {
    const { user } = await renderApp('/inbox?f.kind=draft');
    await card('Bosch impact driver, 18 V');
    await user.keyboard('j');
    await waitFor(() =>
      expect(screen.getByRole('article', { name: 'Bosch impact driver, 18 V' })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    );
    await user.keyboard('m');
    expect(
      await screen.findByRole('dialog', { name: 'Move Bosch impact driver, 18 V' }),
    ).toBeInTheDocument();
  });

  it('on a desktop every action is a button', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === '(min-width: 768px)',
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    await renderApp('/inbox?f.kind=draft');
    const cord = await card('Extension cord, 5 m');
    for (const name of ['Accept', 'Edit', 'Move', 'Set type', 'Discard'])
      expect(within(cord).getByRole('button', { name })).toBeInTheDocument();
    expect(within(cord).queryByRole('button', { name: 'More' })).toBeNull();
    vi.unstubAllGlobals();
  });

  it('names no key on a touch screen: "tap Edit"; with a mouse, "press E"', async () => {
    resetKeyboardSeen();
    await renderApp('/inbox?f.kind=draft');
    const list = await inboxList();
    await waitFor(() => expect(list.textContent).toMatch(/Needs a name: tap Edit to type one\./));
    expect(list.textContent).not.toMatch(/press E/);
    const driver = await card('Bosch impact driver, 18 V');
    expect(driver.textContent).toMatch(/Confirm or reject each suggested value first\.(?! \()/);
    expect(driver.textContent).not.toMatch(/\(Y or N\)/);
  });

  it('names the keys where there is a mouse and a keyboard', async () => {
    resetKeyboardSeen();
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === '(hover: hover) and (pointer: fine)',
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    await renderApp('/inbox?f.kind=draft');
    const list = await inboxList();
    await waitFor(() =>
      expect(list.textContent).toMatch(/Needs a name: press E, or Edit, to type one\./),
    );
    expect((await card('Bosch impact driver, 18 V')).textContent).toMatch(/\(Y or N\)/);
    vi.unstubAllGlobals();
  });

  it('a photo captured before AI was connected: one action names the unnamed drafts', async () => {
    const { user, mock } = await renderApp('/inbox?f.kind=draft');
    await card('Bosch impact driver, 18 V');
    const notice = await screen.findByText(
      '1 photo was captured before AI was connected, so it has no name yet.',
    );
    const action = screen.getByRole('button', { name: 'Name 1 unnamed photo' });
    expect(notice).toBeInTheDocument();
    await user.click(action);
    await waitFor(() =>
      expect(mock.lastCall('POST', capturePaths.thingExtract(S.early))).toBeDefined(),
    );
    // Only the draft with no reading of its photo: the others have one under way or done.
    expect(mock.calls.filter((c) => c.method === 'POST' && /\/extract$/.test(c.path))).toHaveLength(
      1,
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Name 1 unnamed photo' })).toBeNull(),
    );
  });

  it('a draft that waits for a provider says so, and where to connect one', async () => {
    const state = ownerScenario();
    const waiting = state.capture.inbox.find((i) => i.id === I.waiting);
    if (!waiting?.extraction) throw new Error('no waiting draft');
    waiting.extraction = { ...waiting.extraction, statusReason: 'no_provider' };
    await renderApp('/inbox?f.kind=draft', { state });
    const list = await inboxList();
    await waitFor(() =>
      expect(list.textContent).toMatch(/Waiting for an AI provider · Connect one in Settings → AI/),
    );
    expect(
      within(list).getByRole('link', { name: 'Connect one in Settings → AI' }),
    ).toHaveAttribute('href', '/settings/ai');
  });

  it('offline: read-only with the reason, and drafts on this phone waiting to sync', async () => {
    const store = new MemoryStore();
    await store.enqueue(
      {
        clientId: '01926f00-0000-7000-8000-0000009e0001',
        idempotencyKey: 'cap:tape',
        op: 'create_thing',
        takenAt: new Date().toISOString(),
        locationId: INV_IDS.loc.home,
        payload: { name: 'Tape measure' },
      },
      [],
    );
    offline.store = store;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await renderApp('/inbox?f.kind=draft');
    const cord = await card('Extension cord, 5 m');
    expect(screen.getByText(/Reviewing needs a connection/)).toBeInTheDocument();
    expect(within(cord).getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(within(cord).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(cord.textContent).toMatch(/Needs a connection/);
    const local = await screen.findByRole('region', { name: 'On this phone · waiting to sync' });
    expect(local.textContent).toMatch(/Tape measure/);
  });

  it('a viewer everywhere has no inbox entry, and the page says why', async () => {
    const state = ownerScenario();
    state.locations = state.locations.map((l) => ({ ...l, role: 'viewer' as const }));
    await renderApp('/inbox', { state });
    expect(await screen.findByText('The inbox is for members')).toBeInTheDocument();
    // Neither the sidebar nor the phone's tab bar offers it.
    for (const nav of screen.getAllByRole('navigation', { name: 'Main' }))
      expect(within(nav).queryByRole('link', { name: /^Inbox/ })).toBeNull();
  });

  it('mirrors in Arabic', async () => {
    await renderApp('/inbox', { locale: 'ar' });
    await screen.findByRole('list', { name: 'الوارد' }, { timeout: 3000 });
    expect(document.documentElement.dir).toBe('rtl');
    expectLogicalOnly();
  });
});
