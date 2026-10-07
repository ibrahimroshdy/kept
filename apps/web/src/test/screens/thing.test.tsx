/**
 * Thing detail (task 26): header, layout, the action menu by keyboard, the viewer and module-off
 * variants, Arabic right to left, secrets, the create sheet, lifecycle, split, re-type, links and
 * meters. Conflicts (D156) are in conflict.test.tsx; uploads in upload.test.tsx.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths as p } from '@/api/inventory/paths';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { MockReply } from '@/api/mock/server';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

// Whole-app renders under a parallel run can pass the 5 s default.
vi.setConfig({ testTimeout: 15_000 });

const T = INV_IDS.thing;

/** From `md` up the screen uses tabs; jsdom has no matchMedia, so a test opts in. */
function desktop() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width: 768px'),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

function withHome(patch: (home: MockState['locations'][number]) => void): MockState {
  const s = ownerScenario();
  const home = s.locations.find((l) => l.id === IDS.home);
  if (!home) throw new Error('fixture');
  patch(home);
  return s;
}

/** user-event installs its own clipboard; read what was written there. */
const copied = () => navigator.clipboard.readText();

describe('header and layout', () => {
  it('shows the name, the ID chip, the path, the type and the purchase with its price', async () => {
    await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    const chip = screen.getByRole('img', { name: '5MT0QD' });
    expect(chip).toHaveAttribute('dir', 'ltr');
    // The TV is in repair (step 4): its place is where it usually is (screens §8).
    const path = screen.getByRole('navigation', { name: 'Where it usually is' });
    expect(within(path).getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(within(path).getByRole('link', { name: 'Living room' })).toHaveAttribute(
      'href',
      `/p/${INV_IDS.place.livingRoom}`,
    );
    expect(screen.getAllByText('TV / display').length).toBeGreaterThan(0);
    expect(screen.getByText('B.TECH')).toBeInTheDocument();
    expect(screen.getByText('EGP 28,999.00')).toBeInTheDocument();
  });

  it('an ended thing shows its lifecycle as a pill and its end details', async () => {
    await renderApp(`/t/${T.kettle}`);
    await findHeading('Old kettle');
    expect(screen.getAllByText('Given away').length).toBeGreaterThan(0);
    expect(screen.getByText('Alfred')).toBeInTheDocument();
  });

  it('a container opens on its Contents (phone: sections with anchored chips)', async () => {
    await renderApp(`/t/${T.cableBox}`);
    await findHeading('Cable box');
    const chips = screen.getByRole('navigation', { name: 'Sections' });
    const links = within(chips)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(links[0]).toBe('Contents');
    expect(links).toContain('Details');
    expect(await screen.findByText('HDMI cable, 2 m')).toBeInTheDocument();
  });

  it('on desktop the sections are tabs, and the tab is in the URL', async () => {
    desktop();
    const { user, router } = await renderApp(`/t/${T.tv}?tab=links`);
    await findHeading('Samsung TV, 55″');
    expect(screen.getByRole('tab', { name: 'Links' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('No links yet')).toBeInTheDocument();
    // Arrow keys move between tabs and the URL follows.
    await user.click(screen.getByRole('tab', { name: 'Links' }));
    await user.keyboard('{ArrowLeft}');
    // Step 4 put Claims before Links (screens §5's order).
    await waitFor(() =>
      expect((router.state.location.search as { tab?: string }).tab).toBe('claims'),
    );
    expect(screen.getByRole('tab', { name: 'Claims · 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('a metered thing gets a Meters section with the needs-review reading', async () => {
    const { user, mock } = await renderApp(`/t/${T.car}`);
    await findHeading('Toyota Corolla');
    expect(await screen.findByText('1 to review')).toBeInTheDocument();
    expect(await screen.findByText('Lower than the reading before it')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() =>
      expect(mock.calls.some((c) => c.method === 'POST' && c.path.endsWith('/accept'))).toBe(true),
    );
  });

  it('logs a reading with Eastern Arabic digits', async () => {
    const { user, mock } = await renderApp(`/t/${T.car}`);
    await findHeading('Toyota Corolla');
    await user.click(screen.getByRole('button', { name: 'Log a reading' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reading (km)'), '٥٣٠٠٠');
    await user.click(within(dialog).getByRole('button', { name: 'Save reading' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.meterReadings(INV_IDS.meter.carOdometer))?.body).toMatchObject(
        { value: '53000' },
      ),
    );
  });
});

describe('the action menu', () => {
  it('opens from the keyboard and runs Mark seen', async () => {
    const { user, mock } = await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    screen.getByRole('button', { name: 'Actions' }).focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: 'Actions' });
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((m) => m.textContent);
    expect(items).toEqual(
      expect.arrayContaining([
        'Move',
        'Duplicate',
        'Mark seen',
        'Not here',
        'Re-type',
        'Move to Trash',
      ]),
    );
    // Split doesn't apply at quantity 1 (screens §8), and the TV isn't a container.
    expect(items).not.toContain('Split');
    expect(items).not.toContain('Convert to a room or spot');
    // Focus starts on the first item; arrow down to Mark seen.
    expect(document.activeElement).toHaveTextContent('Move');
    for (let i = 0; i < items.indexOf('Mark seen'); i++) await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveTextContent('Mark seen');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mock.lastCall('POST', p.thingSeen(T.tv))).toBeDefined());
    expect(await screen.findByText('Marked as seen')).toBeInTheDocument();
  });

  it('Split shows at quantity 3 and takes some off', async () => {
    const { user, mock } = await renderApp(`/t/${T.hdmiCable}`);
    await findHeading('HDMI cable, 2 m');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Split' }));
    const dialog = await screen.findByRole('dialog', { name: 'Split HDMI cable, 2 m' });
    const count = within(dialog).getByLabelText('How many to take off');
    await user.clear(count);
    await user.type(count, '3');
    await user.click(within(dialog).getByRole('button', { name: 'Split' }));
    expect(await within(dialog).findByText('Between 1 and 2.')).toBeInTheDocument();
    await user.clear(count);
    await user.type(count, '2');
    await user.click(within(dialog).getByRole('button', { name: 'Split' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.thingSplit(T.hdmiCable))?.body).toMatchObject({ quantity: 2 }),
    );
  });

  it('Change lifecycle records how it ended', async () => {
    const { user, mock } = await renderApp(`/t/${T.drill}`);
    await findHeading('Bosch drill, 18 V');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change lifecycle…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change lifecycle' });
    const box = within(dialog).getByRole('combobox', { name: 'What happened to it' });
    await user.clear(box);
    await user.type(box, 'Given');
    await user.click(await screen.findByRole('option', { name: 'Given away' }));
    await user.type(within(dialog).getByLabelText('Given to'), 'Louis');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.thingLifecycle(T.drill))).toMatchObject({
        body: { lifecycle: 'given_away', endedTo: 'Louis' },
        headers: { 'if-match': '1' },
      }),
    );
  });

  it('Re-type names the values that will be archived', async () => {
    const { user, mock } = await renderApp(`/t/${T.drill}`);
    await findHeading('Bosch drill, 18 V');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Re-type' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the type' });
    await user.type(within(dialog).getByRole('combobox', { name: 'New type' }), 'Charg');
    await user.click(await screen.findByRole('option', { name: /^Charger/ }));
    expect(await within(dialog).findByText('These values will be archived')).toBeInTheDocument();
    expect(within(dialog).getByText('Voltage, Battery platform')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Change type' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.thingRetype(T.drill))?.body).toEqual({
        typeId: INV_IDS.type.charger,
      }),
    );
    expect(await screen.findByText('Archived fields · 2')).toBeInTheDocument();
  });

  it('trashing a box with things inside asks what happens to them', async () => {
    const { user, mock, router } = await renderApp(`/t/${T.box3}`);
    await findHeading('Box 3');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to Trash' }));
    const dialog = await screen.findByRole('dialog', { name: 'Box 3 has things in it' });
    await user.click(within(dialog).getByRole('button', { name: /Move them to Hallway closet/ }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.thingTrash(T.box3))?.body).toEqual({
        contents: 'move',
        moveTo: { placeId: INV_IDS.place.hallwayCloset },
      }),
    );
    await waitFor(() => expect(pathOf(router)).toBe(`/p/${INV_IDS.place.hallwayCloset}`));
  });

  it('Move offers the things the server marks as containers, whatever their type', async () => {
    const state = ownerScenario();
    // A phone isn't a container type, but with something inside it the server says it is one.
    const phone = state.inventory.things.find((x) => x.id === T.phone);
    if (!phone) throw new Error('fixture');
    phone.isContainer = true;
    const { user } = await renderApp(`/t/${T.tv}`, { state });
    await findHeading('Samsung TV, 55″');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Room, spot or box' }));
    await user.keyboard('{ArrowDown}');
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options.some((o) => o.includes('Galaxy S23'))).toBe(true);
    expect(options.some((o) => o.includes('Box 3'))).toBe(true);
    // Not a container, and not offered.
    expect(options.some((o) => o.includes('HDMI cable'))).toBe(false);
  });

  it('links another thing', async () => {
    const { user, mock } = await renderApp(`/t/${T.phone}`);
    await findHeading('Galaxy S23');
    await user.click(screen.getByRole('button', { name: 'Link a thing' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox', { name: '…this one' }), 'HDMI');
    await user.click(await screen.findByRole('option', { name: /HDMI cable/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.thingLinks(T.phone))?.body).toEqual({
        toThingId: T.hdmiCable,
        kind: 'accessory_of',
      }),
    );
    expect(await screen.findByRole('link', { name: 'HDMI cable, 2 m' })).toBeInTheDocument();
  });
});

describe('a viewer (screens §5, A viewer’s thing detail)', () => {
  const viewer = () =>
    withHome((h) => Object.assign(h, { role: 'viewer', modules: [...h.modules, 'secrets'] }));

  it('gets Copy link only: no action menu, no Edit, no Mark seen', async () => {
    const { user } = await renderApp(`/t/${T.tv}`, { state: viewer() });
    await findHeading('Samsung TV, 55″');
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add the first photo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link a thing' })).toBeNull();
    expect(screen.getByText("You're a viewer here")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    // The short-ID address (D208).
    await waitFor(async () => expect(await copied()).toBe(`${window.location.origin}/t/5MT0QD`));
  });

  it('sees no price (D13) and no Reveal (D116)', async () => {
    await renderApp(`/t/${T.tv}`, { state: viewer() });
    await findHeading('Samsung TV, 55″');
    expect(screen.queryByText('EGP 28,999.00')).toBeNull();
    expect(screen.getByText('Not shown to viewers here')).toBeInTheDocument();
    expect(screen.getByText('B.TECH')).toBeInTheDocument();
  });

  it('sees a set secret without Reveal', async () => {
    await renderApp(`/t/${T.phone}`, { state: viewer() });
    await findHeading('Galaxy S23');
    const row = screen.getByRole('listitem', { name: 'Linked account or login' });
    expect(within(row).queryByRole('button', { name: 'Reveal' })).toBeNull();
    expect(within(row).getByText("Secret · you can't reveal this one")).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Replace' })).toBeNull();
  });
});

describe('modules off (screens §3)', () => {
  const essentials = () => withHome((h) => Object.assign(h, { preset: 'essentials', modules: [] }));

  it('Money off: the purchase keeps its date and shop but loses the price row', async () => {
    await renderApp(`/t/${T.tv}`, { state: essentials() });
    await findHeading('Samsung TV, 55″');
    expect(screen.getByText('B.TECH')).toBeInTheDocument();
    expect(screen.queryByText('Price')).toBeNull();
    expect(screen.queryByText('EGP 28,999.00')).toBeNull();
  });

  it('Secrets off: a stored secret says "Off in this location", with Turn on for the owner', async () => {
    await renderApp(`/t/${T.safe}`, { state: essentials() });
    await findHeading('Wall safe');
    expect(screen.getByText('Passwords and codes · Off in this location')).toBeInTheDocument();
    // Warranties are off too (step 4), and say so the same way.
    expect(screen.getByText('Warranties · Off in this location')).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: 'Turn on' }))
      expect(link).toHaveAttribute('href', `/settings/location/${IDS.home}/track`);
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
  });

  it('Labels off: the Label action says so, and its sheet explains', async () => {
    const { user } = await renderApp(`/t/${T.tv}`, { state: essentials() });
    await findHeading('Samsung TV, 55″');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const label = await screen.findByRole('menuitem', { name: /^Label/ });
    expect(label).toHaveTextContent('Off in this location');
    await user.click(label);
    const dialog = await screen.findByRole('dialog', { name: 'Label' });
    expect(within(dialog).getByText('Labels & QR · Off in this location')).toBeInTheDocument();
  });

  it('a member sees "Ask an admin" instead of Turn on', async () => {
    const s = withHome((h) => Object.assign(h, { role: 'member', modules: [] }));
    await renderApp(`/t/${T.safe}`, { state: s });
    await findHeading('Wall safe');
    expect(
      screen.getAllByText('Ask an admin of this location to turn it on.').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Turn on' })).toBeNull();
  });
});

describe('secrets (D116, D175)', () => {
  const secretsOn = () => withHome((h) => Object.assign(h, { modules: [...h.modules, 'secrets'] }));

  it('Reveal shows the value with "Revealed · logged", then hides it after 30 s', async () => {
    const { user, mock } = await renderApp(`/t/${T.safe}`, {
      state: secretsOn(),
      setup: (m) =>
        m.on('POST', p.thingSecretReveal(':id', ':fieldKey'), () => ({
          value: '17-42-08',
          revealedUntil: new Date(Date.now() + 1200).toISOString(),
        })),
    });
    await findHeading('Wall safe');
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText('17-42-08')).toBeInTheDocument();
    expect(screen.getByText('Revealed · logged')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(async () => expect(await copied()).toBe('17-42-08'));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.thingSecretCopied(T.safe, 'combination'))).toBeDefined(),
    );
    await waitFor(() => expect(screen.queryByText('17-42-08')).toBeNull(), { timeout: 4000 });
  });

  it('hides a revealed value at once when the tab is hidden', async () => {
    const { user } = await renderApp(`/t/${T.safe}`, { state: secretsOn() });
    await findHeading('Wall safe');
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText('17-42-08')).toBeInTheDocument();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(screen.queryByText('17-42-08')).toBeNull());
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('hides it when you leave the page', async () => {
    const { user, router } = await renderApp(`/t/${T.safe}`, { state: secretsOn() });
    await findHeading('Wall safe');
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText('17-42-08')).toBeInTheDocument();
    await router.navigate({ to: '/t/$id', params: { id: T.tv } });
    await findHeading('Samsung TV, 55″');
    await router.navigate({ to: '/t/$id', params: { id: T.safe } });
    await findHeading('Wall safe');
    expect(screen.queryByText('17-42-08')).toBeNull();
  });

  it('Replace is write-only; the recovery-kit gate explains itself (D193)', async () => {
    const { user, mock } = await renderApp(`/t/${T.safe}`, { state: secretsOn() });
    await findHeading('Wall safe');
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.type(screen.getByLabelText('New Combination'), '99-11-22');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The recovery kit comes first')).toBeInTheDocument();
    expect(
      screen.getByText('Ask your instance admin to download the recovery kit.'),
    ).toBeInTheDocument();
    mock.state.admin.status.recoveryKitAcknowledged = true;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.thingSecret(T.safe, 'combination'))?.body).toEqual({
        value: '99-11-22',
      }),
    );
  });
});

describe('create sheet', () => {
  it('adds a thing to a box, with a price typed in Arabic digits (D172)', async () => {
    const { user, mock } = await renderApp(`/t/${T.cableBox}`);
    await findHeading('Cable box');
    await user.click(screen.getByRole('button', { name: 'Add a thing' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a thing' });
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(within(dialog).getByText('Give it a name.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'USB-C cable');
    await user.type(within(dialog).getByRole('combobox', { name: 'Type' }), 'Cable');
    await user.click(await screen.findByRole('option', { name: /^Cable/ }));
    const qty = within(dialog).getByLabelText('Quantity');
    await user.clear(qty);
    await user.type(qty, '٢');
    await user.type(within(dialog).getByLabelText('Price'), '١٬٢٠٠٫٥');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('A price needs a currency.')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('combobox', { name: 'Currency' }), 'EGP');
    await user.click(await screen.findByRole('option', { name: /^EGP/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(mock.lastCall('POST', p.things)?.body).toMatchObject({
        locationId: IDS.home,
        containerId: T.cableBox,
        name: 'USB-C cable',
        typeId: INV_IDS.type.cable,
        quantity: 2,
        purchase: { currency: 'EGP', price: '1200.5' },
      }),
    );
    expect(await screen.findByText('Added USB-C cable')).toBeInTheDocument();
  });

  it('hides quantity for a serialized type and the purchase without Money', async () => {
    const s = withHome((h) => Object.assign(h, { modules: [] }));
    const { user } = await renderApp(`/t/${T.cableBox}`, { state: s });
    await findHeading('Cable box');
    await user.click(screen.getByRole('button', { name: 'Add a thing' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a thing' });
    expect(within(dialog).queryByLabelText('Price')).toBeNull();
    await user.type(within(dialog).getByRole('combobox', { name: 'Type' }), 'Phone');
    await user.click(await screen.findByRole('option', { name: /^Phone/ }));
    expect(within(dialog).queryByLabelText('Quantity')).toBeNull();
  });
});

describe('Arabic, right to left', () => {
  it('mirrors, keeps the ID left to right, and uses logical CSS only', async () => {
    await renderApp(`/t/${T.arToolbox}`, { locale: 'ar' });
    await findHeading('صندوق العدة');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('img', { name: 'K7Q3FM' })).toHaveAttribute('dir', 'ltr');
    expect(await screen.findByText('مفك براغي')).toBeInTheDocument();
    expectLogicalOnly();
  });

  it('a not-found thing says so', async () => {
    await renderApp('/t/01926f00-0000-7000-8000-0000000d9999', {
      setup: (m) =>
        m.on(
          'GET',
          p.thing(':id'),
          () => new MockReply(404, { error: 'Not found.', code: 'not_found' }),
        ),
    });
    expect(
      await screen.findByText("This isn't here any more, or you can't see it."),
    ).toBeInTheDocument();
  });
});
