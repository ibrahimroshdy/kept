/**
 * Trash, the activity feed and the history timeline (task 27; D110, D162, D174, D183), against
 * the mock server: role rules for restore and delete permanently, money redacted for viewers and
 * where the Money module is off, secrets shown only as changed, the moved-in row, filters in the
 * URL, keyboard operation and RTL.
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
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths } from '@/api/inventory/paths';
import { IDS, type MockState, memberScenario, ownerScenario } from '@/api/mock/fixtures';
import { createMockApi } from '@/api/mock/server';
import { AppProviders } from '@/app-providers';
import { type HistorySubject, HistoryTimeline } from '@/components/history/timeline';
import { activateLocale } from '@/i18n/i18n';
import { findHeading, renderApp } from '@/test/app';
import { filterBy } from '@/test/filters';
import { expectLogicalOnly } from '@/test/render';

const T = INV_IDS.thing;

function asRole(role: 'viewer' | 'member' | 'admin', state: MockState = ownerScenario()) {
  const home = state.locations.find((l) => l.id === IDS.home);
  if (home) home.role = role;
  return state;
}

const trashList = () => screen.findByRole('list', { name: 'Trash' }, { timeout: 3000 });

describe('trash', () => {
  it('lists what was trashed, where it was, who trashed it and when it goes for good', async () => {
    await renderApp('/trash');
    await findHeading('Trash');
    const list = await trashList();
    const lamp = within(list).getByRole('article', { name: 'Broken lamp' });
    expect(lamp.textContent).toMatch(/Was in Home/);
    expect(lamp.textContent).toMatch(/Goes for good on/);
    const shelf = within(list).getByRole('article', { name: 'Old shelf' });
    expect(shelf.textContent).toMatch(/Was in Home › Kitchen/);
    expect(shelf.textContent).toMatch(/by Ibrahim/);
    // Places can be restored but have no permanent delete.
    expect(within(shelf).getByRole('button', { name: 'Restore Old shelf' })).toBeInTheDocument();
    expect(within(shelf).queryByRole('button', { name: /permanently/ })).toBeNull();
  });

  it('restores a thing, by keyboard', async () => {
    const { user, mock } = await renderApp('/trash');
    const list = await trashList();
    within(list).getByRole('button', { name: 'Restore Broken lamp' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(mock.lastCall('POST', inventoryPaths.thingRestore(T.brokenLamp))).toBeDefined(),
    );
    expect(await screen.findByText('Restored Broken lamp')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Trash' })).queryByText('Broken lamp'),
      ).toBeNull(),
    );
  });

  it('deletes permanently only after confirming (admins and above)', async () => {
    const { user, mock } = await renderApp('/trash');
    const list = await trashList();
    await user.click(within(list).getByRole('button', { name: 'Delete Broken lamp permanently' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Broken lamp for good?' });
    // Focus starts on Cancel: Enter cancels.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mock.lastCall('DELETE', inventoryPaths.thing(T.brokenLamp))).toBeUndefined();

    await user.click(within(list).getByRole('button', { name: 'Delete Broken lamp permanently' }));
    const again = await screen.findByRole('alertdialog');
    await user.click(within(again).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() =>
      expect(mock.lastCall('DELETE', inventoryPaths.thing(T.brokenLamp))).toBeDefined(),
    );
    expect(dialog).not.toBeInTheDocument();
  });

  it('a member restores but cannot delete permanently', async () => {
    await renderApp('/trash', { state: memberScenario() });
    const lamp = within(await trashList()).getByRole('article', { name: 'Broken lamp' });
    expect(within(lamp).getByRole('button', { name: 'Restore Broken lamp' })).toBeInTheDocument();
    expect(within(lamp).queryByRole('button', { name: /permanently/ })).toBeNull();
  });

  it('a viewer sees the trash and no buttons', async () => {
    await renderApp('/trash', { state: asRole('viewer') });
    const lamp = within(await trashList()).getByRole('article', { name: 'Broken lamp' });
    expect(within(lamp).queryByRole('button')).toBeNull();
  });

  it('filters by kind in the URL', async () => {
    const { user, router } = await renderApp('/trash');
    await trashList();
    await filterBy(user, 'Kind', ['Places']);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ 'f.kind': ['place'] }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Trash' }))
          .getAllByRole('article')
          .map((a) => a.getAttribute('aria-label')),
      ).toEqual(['Old shelf']),
    );
  });

  it('is empty when nothing is trashed', async () => {
    const state = ownerScenario();
    state.inventory.things = state.inventory.things.filter((x) => !x.deletedAt);
    state.inventory.places = state.inventory.places.filter((x) => !x.deletedAt);
    await renderApp('/trash', { state });
    expect(await screen.findByText('The trash is empty')).toBeInTheDocument();
  });

  it('renders right to left in Arabic', async () => {
    await renderApp('/trash', { locale: 'ar' });
    expect(
      await screen.findByRole('article', { name: 'Broken lamp' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
    expectLogicalOnly();
  });
});

describe('activity', () => {
  const feed = () => screen.findByRole('list', { name: 'Activity' }, { timeout: 3000 });

  it('lists every location newest first, by day, each linked, with its location', async () => {
    await renderApp('/activity');
    await findHeading('Activity');
    const list = await feed();
    const rows = within(list).getAllByRole('article');
    expect(rows[0]).toHaveAccessibleName('Added HDMI cable, 2 m');
    // By its short ID (D208).
    expect(within(rows[0] as HTMLElement).getByRole('link')).toHaveAttribute('href', '/t/7KQ4MZ');
    expect(within(list).getByText('بيت العائلة')).toBeInTheDocument();
    expect(within(list).getAllByRole('presentation')[0]?.textContent).toMatch(/Today|Yesterday|\d/);
  });

  it('filters by person, kind and date in the URL and the request', async () => {
    const { user, router, mock } = await renderApp('/activity');
    await feed();
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return mock.fetch(input, init);
    });
    await filterBy(user, 'Person', ['Alfred']);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ 'f.actor': ['u-alfred'] }),
    );
    await waitFor(() => expect(urls.some((u) => u.includes('actorId=u-alfred'))).toBe(true));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Activity' }))
          .getAllByRole('article')
          .every((a) => a.textContent?.includes('Alfred')),
      ).toBe(true),
    );
    await filterBy(user, 'Date', ['Last 7 days']);
    await waitFor(() => expect(urls.some((u) => u.includes('from='))).toBe(true));
    expect(screen.getByRole('button', { name: 'Date: Last 7 days' })).toBeInTheDocument();
  });

  it('"is none of" leaves a person out (D205)', async () => {
    const { user, router, mock } = await renderApp('/activity');
    await feed();
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return mock.fetch(input, init);
    });
    await filterBy(user, 'Person', ['Alfred'], { none: true });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        'f.actor': ['u-alfred'],
        not: ['actor'],
      }),
    );
    await waitFor(() =>
      expect(urls.some((u) => u.includes('actorId=u-alfred') && u.includes('not=actorId'))).toBe(
        true,
      ),
    );
    expect(screen.getByRole('button', { name: 'Person: not Alfred' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Activity' }))
          .getAllByRole('article')
          .some((a) => a.textContent?.includes('Alfred')),
      ).toBe(false),
    );
  });

  it('shows money to an owner, hides it from a viewer (D110)', async () => {
    await renderApp('/activity');
    const tv = within(await feed())
      .getAllByRole('article', { name: 'Edited Samsung TV, 55″' })
      .find((a) => a.textContent?.includes('Insured value')) as HTMLElement;
    expect(tv.textContent).toMatch(/Insured value12,000→14,500/);
  });

  it('a viewer sees "hidden" for money and never the amounts', async () => {
    await renderApp('/activity', { state: asRole('viewer') });
    const tv = within(await feed())
      .getAllByRole('article', { name: 'Edited Samsung TV, 55″' })
      .find((a) => a.textContent?.includes('Insured value')) as HTMLElement;
    expect(tv.textContent).toContain('Insured valuehidden');
    // The amounts, not any "12" or "14": the row's timestamp can hold those digits.
    expect(tv.textContent).not.toMatch(/12,000|14,500/);
    // The plain field in the same event is still shown.
    expect(tv.textContent).toContain('Wall-mounted in the living room');
  });

  it('where the Money module is off, money is hidden even from the owner', async () => {
    await renderApp('/activity');
    const pump = within(await feed()).getByRole('article', { name: 'Marked Tyre pump as sold' });
    expect(pump.textContent).toContain('Price when it endedhidden');
    expect(pump.textContent).not.toContain('350');
    expect(pump.textContent).toMatch(/StatusIn use→Sold/);
  });

  it('names the new status from its stored code, and says "changed the status" without one', async () => {
    const state = ownerScenario();
    const lifecycleEvent = (n: number, summaryParams: Record<string, string>) => ({
      id: `01926f00-0000-7000-8000-0000000ef9${n}0`,
      at: new Date(Date.now() - 3_600_000).toISOString(),
      location_id: INV_IDS.loc.garage,
      action: 'thing.lifecycle',
      actor: { type: 'user' as const, id: null, displayName: 'Ibrahim' },
      entity: { type: 'thing', id: T.pump },
      root_thing_id: T.pump,
      // No diff to read: the sentence comes from summaryParams alone.
      diff: null,
      undo_of: null,
      undoable_until: null,
      summaryKey: 'thing.lifecycle',
      summaryParams,
      summary: 'English, never shown',
    });
    state.inventory.events.push(
      lifecycleEvent(1, { name: 'Tyre pump', lifecycle: 'given_away' }),
      lifecycleEvent(2, { name: 'Tyre pump' }),
    );
    await renderApp('/activity', { state });
    const list = await feed();
    expect(
      within(list).getByRole('article', { name: 'Marked Tyre pump as given away' }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole('article', { name: 'Changed the status of Tyre pump' }),
    ).toBeInTheDocument();
  });

  it("leaves out an audit row's internal columns, and reads sizes and label IDs as people do", async () => {
    const state = ownerScenario();
    const event = (n: number, action: string, diff: Record<string, unknown>) => ({
      id: `01926f00-0000-7000-8000-0000000efa${n}0`,
      at: new Date(Date.now() - 3_600_000).toISOString(),
      location_id: INV_IDS.loc.garage,
      action,
      actor: { type: 'user' as const, id: null, displayName: 'Ibrahim' },
      entity: { type: 'thing', id: T.pump },
      root_thing_id: T.pump,
      diff: Object.fromEntries(
        Object.entries(diff).map(([k, after]) => [
          k,
          { before: null, after, class: 'plain' as const },
        ]),
      ),
      undo_of: null,
      undoable_until: null,
      summaryKey: 'event',
      summaryParams: { action },
      summary: 'English, never shown',
    });
    state.inventory.events.push(
      event(1, 'saved_view.create', { name: 'Tools', shared: true, surface: 'search' }),
      event(2, 'file.upload', {
        mime: 'image/jpeg',
        bytes: 316,
        class: 'evidence',
        has_gps: false,
        derivative_state: 'ready',
      }),
      event(3, 'thing.label', { short_code: '3CB8WN' }),
    );
    await renderApp('/activity', { state });
    const list = await feed();
    const view = within(list).getByRole('article', { name: 'Saved view added' });
    expect(view.textContent).toContain('Tools');
    expect(view.textContent).not.toMatch(/Surface|search/);
    const file = within(list).getByRole('article', { name: 'File uploaded' });
    expect(file.textContent).toContain('316 byte');
    expect(file.textContent).not.toMatch(/Kind of file|evidence|Has gps|Derivative state|ready/);
    const label = within(list).getByRole('article', { name: 'Label assigned' });
    expect(label.textContent).toContain('3CB\u20118WN');
  });

  it("step 4's records read in words: their event, their fields and their codes (T29)", async () => {
    const state = ownerScenario();
    const event = (n: number, action: string, type: string, diff: Record<string, unknown>) => ({
      id: `01926f00-0000-7000-8000-0000000efb${n}0`,
      at: new Date(Date.now() - 3_600_000).toISOString(),
      location_id: INV_IDS.loc.garage,
      action,
      actor: { type: 'user' as const, id: null, displayName: 'Ibrahim' },
      entity: { type, id: `01926f00-0000-7000-8000-0000000efc${n}0` },
      root_thing_id: T.pump,
      diff: Object.fromEntries(
        Object.entries(diff).map(([k, after]) => [
          k,
          { before: null, after, class: 'plain' as const },
        ]),
      ),
      undo_of: null,
      undoable_until: null,
      summaryKey: 'event',
      summaryParams: { action },
      summary: 'English, never shown',
    });
    state.inventory.events.push(
      event(1, 'claim.create', 'claim', { status: 'in_repair', opened_on: '2026-09-24' }),
      event(2, 'loan.create', 'loan', { direction: 'out', lead_days: 0 }),
      event(3, 'valuation.create', 'valuation', { source: 'appraisal', value: '32000' }),
      event(4, 'warranty.delete', 'warranty', {
        kind: 'extended',
        documents: [{ id: 'x', role: 'warranty_doc' }],
      }),
    );
    await renderApp('/activity', { state });
    const list = await feed();
    const claim = within(list).getByRole('article', { name: 'Claim opened' });
    expect(claim.textContent).toMatch(/Status.*In repair/);
    expect(claim.textContent).toContain('Opened on');
    const loan = within(list).getByRole('article', { name: 'Loan added' });
    expect(loan.textContent).toMatch(/Direction.*Lent/);
    const value = within(list).getByRole('article', { name: 'Valuation added' });
    expect(value.textContent).toMatch(/Source.*Appraisal/);
    expect(value.textContent).toMatch(/Value/);
    expect(value.textContent).not.toMatch(/Reading/);
    const warranty = within(list).getByRole('article', { name: 'Warranty removed' });
    expect(warranty.textContent).toContain('Extended warranty');
    expect(warranty.textContent).not.toMatch(/Documents|warranty_doc/);
  });

  it("steps 6–8's events read in words, never the server's English fallback", async () => {
    const state = ownerScenario();
    const sentences: Record<string, string> = {
      'webhook.create': 'Webhook added',
      'webhook.update': 'Webhook changed',
      'webhook.delete': 'Webhook removed',
      'webhook.rotate_secret': 'Webhook secret replaced',
      'purchase.reextract': 'Receipt read again',
      'thing.enrich': 'Other names added',
      'import.enrich': 'Other names requested for an import',
      'import.homebox_connect': 'Connected to Homebox',
      'instance.setup': 'Kept set up',
      'instance.settings_update': 'Instance settings changed',
      'instance.backup': 'Backup made',
      'instance.backup_run': 'Backup started by hand',
      'instance.backup_settings': 'Backup settings changed',
      'instance.backup_test': 'Backup target tested',
      'instance.restore': 'Restored from a backup',
      'instance.export': 'Whole instance exported',
      'instance.downgrade_forced': 'Started on an older version anyway',
      'instance.rotate_key': 'Encryption key replaced',
      'instance.drop_key': 'Old encryption key removed',
      'instance.embeddings_source': 'Semantic search source changed',
      'instance.recovery_kit_download': 'Recovery kit downloaded',
      'instance.recovery_kit_acknowledge': 'Recovery kit noted as kept',
      'instance.update_check': 'Checked for updates',
      'instance.setup_code_reissue': 'New setup code issued',
      'instance.oidc_changed': 'OIDC sign-in settings changed',
      'instance.smtp_changed': 'Email settings changed',
    };
    Object.keys(sentences).forEach((action, n) => {
      const hex = n.toString(16).padStart(2, '0');
      state.inventory.events.push({
        id: `01926f00-0000-7000-8000-0000000ef8${hex}`,
        at: new Date(Date.now() - 3_600_000 - n * 1000).toISOString(),
        location_id: INV_IDS.loc.garage,
        action,
        actor: { type: 'user' as const, id: null, displayName: 'Ibrahim' },
        entity: {
          type: action.split('.')[0] as string,
          id: `01926f00-0000-7000-8000-0000000ef7${hex}`,
        },
        root_thing_id: null,
        diff: null,
        undo_of: null,
        undoable_until: null,
        summaryKey: 'event',
        summaryParams: { action },
        summary: 'English, never shown',
      });
    });
    await renderApp('/activity', { state });
    const list = await feed();
    for (const sentence of Object.values(sentences)) {
      expect(within(list).getByRole('article', { name: sentence })).toBeInTheDocument();
    }
    expect(list.textContent).not.toContain('English, never shown');
  });

  it("a reading's review reason reads in words, not its field or its code (UI step-4 review L10)", async () => {
    const state = ownerScenario();
    state.inventory.events.push({
      id: '01926f00-0000-7000-8000-0000000efd10',
      at: new Date(Date.now() - 3_600_000).toISOString(),
      location_id: INV_IDS.loc.garage,
      action: 'reading.accept',
      actor: { type: 'user' as const, id: null, displayName: 'Ibrahim' },
      entity: { type: 'reading', id: '01926f00-0000-7000-8000-0000000efe10' },
      root_thing_id: T.pump,
      diff: {
        review_reason: { before: 'implausible_jump', after: null, class: 'plain' as const },
      },
      undo_of: null,
      undoable_until: null,
      summaryKey: 'event',
      summaryParams: { action: 'reading.accept' },
      summary: 'English, never shown',
    });
    await renderApp('/activity', { state });
    const list = await feed();
    const row = within(list).getByRole('article', { name: 'Reading kept' });
    expect(row.textContent).toContain('Why it needs a look');
    expect(row.textContent).toContain('A bigger jump than it could make');
    expect(row.textContent).not.toMatch(/Review reason|implausible_jump/);
  });

  it("a created thing's row leaves out the values every new thing starts with (UI audit L9)", async () => {
    const state = ownerScenario();
    const diff = {
      name: 'Drill',
      brand: 'Bosch',
      review_state: 'confirmed',
      location_uncertain: false,
      lifecycle: 'in_use',
      quantity: '1',
      aliases: [],
    };
    state.inventory.events.push({
      id: '01926f00-0000-7000-8000-0000000efb10',
      at: new Date(Date.now() - 3_600_000).toISOString(),
      location_id: INV_IDS.loc.garage,
      action: 'thing.create',
      actor: { type: 'user' as const, id: null, displayName: 'Ibrahim' },
      entity: { type: 'thing', id: T.pump },
      root_thing_id: T.pump,
      diff: Object.fromEntries(
        Object.entries(diff).map(([k, after]) => [
          k,
          { before: null, after, class: 'plain' as const },
        ]),
      ),
      undo_of: null,
      undoable_until: null,
      summaryKey: 'thing.create',
      summaryParams: { name: 'Drill' },
      summary: 'Added Drill',
    });
    await renderApp('/activity', { state });
    const row = within(await feed()).getByRole('article', { name: 'Added Drill' });
    expect(row.textContent).toContain('Bosch');
    expect(row.textContent).not.toMatch(/Confirmed|Not sure where|In use|Quantity|Aliases/);
  });

  it('a secret shows as changed, never a value', async () => {
    await renderApp('/activity');
    const safe = within(await feed()).getByRole('article', {
      name: 'Edited Wall safe',
    });
    expect(safe.textContent).toContain('Combinationchanged · value not recorded');
  });
});

/** The timeline as task 26's thing page (and a place page) host it. */
async function renderTimeline(
  subject: HistorySubject,
  state: MockState = ownerScenario(),
  locale: 'en' | 'ar' = 'en',
) {
  const mock = createMockApi(state);
  vi.stubGlobal('fetch', mock.fetch);
  await activateLocale(locale);
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <HistoryTimeline subject={subject} heading="History" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <AppProviders locale={locale}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppProviders>,
  );
  return { mock, user: userEvent.setup() };
}

describe('the history timeline', () => {
  it("shows a thing's events, newest first, with before → after", async () => {
    await renderTimeline({ kind: 'thing', id: T.tv });
    const list = await screen.findByRole('list', { name: 'History' }, { timeout: 3000 });
    const rows = within(list).getAllByRole('article');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Edited Samsung TV, 55″',
      'Edited Samsung TV, 55″',
      'Edited Samsung TV, 55″',
    ]);
    expect(rows[0]?.textContent).toMatch(/ModelQE55Q60A→QE55Q60B/);
    expect(rows.at(-1)?.textContent).toMatch(/Quantity2→1/);
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
  });

  it('a move in from a location you cannot see is its own row, with no old path (D183)', async () => {
    await renderTimeline({ kind: 'thing', id: T.hdmiCable });
    const row = await screen.findByRole('article', { name: 'Moved in from another location' });
    expect(within(row).queryByRole('term')).toBeNull();
    expect(row.textContent).not.toMatch(/Bruce/);
  });

  it("a merged thing's events are in the survivor's history, marked merged from it (T15)", async () => {
    const state = ownerScenario();
    const cable = state.inventory.things.find((x) => x.id === T.hdmiCable);
    if (!cable) throw new Error('no cable');
    cable.mergedIntoId = T.cableBox;
    cable.deletedAt = new Date().toISOString();
    await renderTimeline({ kind: 'thing', id: T.cableBox }, state);
    const row = await screen.findByRole('article', { name: 'Moved in from another location' });
    expect(row.textContent).toContain('merged from HDMI cable, 2 m');
    expect(within(row).getByText('HDMI cable, 2 m').tagName).toBe('BDI');
  });

  it('merged from a thing with no name says so', async () => {
    const state = ownerScenario();
    const cable = state.inventory.things.find((x) => x.id === T.hdmiCable);
    if (!cable) throw new Error('no cable');
    cable.mergedIntoId = T.cableBox;
    cable.name = null;
    await renderTimeline({ kind: 'thing', id: T.cableBox }, state);
    const row = await screen.findByRole('article', { name: 'Moved in from another location' });
    expect(row.textContent).toContain('merged from a thing with no name');
  });

  it('money is hidden for a viewer, and secrets only say changed', async () => {
    await renderTimeline({ kind: 'thing', id: T.tv }, asRole('viewer'));
    const list = await screen.findByRole('list', { name: 'History' }, { timeout: 3000 });
    expect(list.textContent).toContain('Insured valuehidden');
    expect(list.textContent).not.toContain('14,500');
    await renderTimeline({ kind: 'thing', id: T.safe });
    expect(
      (await screen.findAllByRole('article', { name: 'Edited Wall safe' }))[0]?.textContent,
    ).toContain('changed · value not recorded');
  });

  it("a place's history", async () => {
    await renderTimeline({ kind: 'place', id: INV_IDS.place.office });
    expect(await screen.findByRole('article', { name: 'Added Office' })).toBeInTheDocument();
  });

  it('says so when there is none', async () => {
    await renderTimeline({ kind: 'place', id: INV_IDS.place.kitchen });
    expect(await screen.findByText('No history yet')).toBeInTheDocument();
  });

  it('reads right to left in Arabic, the arrow turned', async () => {
    await renderTimeline({ kind: 'thing', id: T.tv }, ownerScenario(), 'ar');
    const list = await screen.findByRole('list', {}, { timeout: 3000 });
    expect(list.querySelector('[role="img"].rtl\\:-scale-x-100')).not.toBeNull();
    expectLogicalOnly();
  });
});
