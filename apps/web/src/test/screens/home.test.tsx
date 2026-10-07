/**
 * The signed-in gate, Home (task 29: the computed Get-started checklist, the attention panel,
 * recent activity and the location cards) and the app frame.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { householdPaths as hp } from '@/api/household/paths';
import { inventoryPaths as p } from '@/api/inventory/paths';
import type { ChecklistKey, HomeResponse } from '@/api/inventory/types';
import {
  firstRunScenario,
  IDS,
  memberScenario,
  ownerScenario,
  setupScenario,
  signedOutScenario,
} from '@/api/mock/fixtures';
import { type MockApi, MockReply } from '@/api/mock/server';
import { paths } from '@/api/paths';
import type { LocationDetail } from '@/api/types';
import { ATTENTION_ORDER } from '@/components/home/attention';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

// Whole-app renders under a parallel run can pass the 5 s default.
vi.setConfig({ testTimeout: 15_000 });

/** jsdom serves the page over http:, which is what D193 checks; a test can say https. */
const https = vi.hoisted(() => ({ plain: true }));
vi.mock('@/lib/https', () => ({ servedOverHttp: () => https.plain }));
beforeEach(() => {
  https.plain = true;
});

/** jsdom has no matchMedia: a test lists the queries that match (desktop, installed app). */
function media(matching: string[]) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: matching.includes(q),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

function checklist(done: Partial<Record<ChecklistKey, boolean>> = {}): HomeResponse['checklist'] {
  const all: Record<ChecklistKey, boolean> = {
    locationCreated: true,
    threeThings: true,
    labelPrinted: false,
    invited: true,
    aiConnected: false,
    installed: false,
    ...done,
  };
  return {
    dismissed: false,
    items: (Object.keys(all) as ChecklistKey[]).map((key) => ({ key, done: all[key] })),
  };
}

/** Nothing on the agenda and no open loans: step 4's rows stay out of step 2's tests. */
const quietHousehold = (m: MockApi): void => {
  m.on('GET', hp.agenda, () => ({
    items: [],
    next_cursor: null,
    counts: { overdue: 0, due: 0, expiring: 0 },
  }));
  m.on('GET', hp.loans, () => ({
    items: [],
    next_cursor: null,
    counts: { out: 0, in: 0, overdue: 0 },
  }));
};

/** Answer GET /home with this (the rest as a quiet owner's), and a quiet agenda. */
const homeIs =
  (over: Partial<HomeResponse>) =>
  (m: MockApi): void => {
    quietHousehold(m);
    m.on('GET', p.home, () => ({
      checklist: checklist(),
      attention: { toReview: 0, uncertain: 0, longUnseen: 0, unplaced: 0 },
      counts: { inbox: 0, unprintedLabels: 0 },
      locations: [],
      ...over,
    }));
  };

const section = async (name: string) => (await findHeading(name)).closest('section') as HTMLElement;
const checklistItems = async () => within(await section('Get started')).getAllByRole('listitem');

describe('the signed-in gate', () => {
  it('sends a fresh server to first-run setup', async () => {
    const { router } = await renderApp('/', { state: setupScenario() });
    expect(await findHeading('Enter the setup code')).toBeInTheDocument();
    expect(pathOf(router)).toBe('/setup');
  });

  it('sends a signed-out visitor to sign in, remembering where they were going', async () => {
    const { router } = await renderApp('/settings', { state: signedOutScenario() });
    expect(await findHeading('Sign in to Kept')).toBeInTheDocument();
    expect(pathOf(router)).toBe('/signin');
    expect(router.state.location.search).toEqual({ next: '/settings' });
  });

  it('sends a session with a pending second factor to the challenge', async () => {
    const state = signedOutScenario();
    state.signedIn = true;
    state.mfaPending = true;
    const { router } = await renderApp('/', { state });
    expect(await findHeading("Confirm it's you")).toBeInTheDocument();
    expect(pathOf(router)).toBe('/signin/two-factor');
  });

  it('shows a skeleton while the session loads', async () => {
    await renderApp('/', { setup: (m) => m.hang('GET', paths.me) });
    expect(await screen.findByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows an error with a retry when the server fails', async () => {
    let fail = true;
    const { user } = await renderApp('/', {
      setup: (m) => {
        const real = m.state;
        m.on('GET', paths.me, () =>
          fail ? new MockReply(500, { error: 'boom', code: 'internal' }) : real.me,
        );
      },
    });
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await findHeading('Home')).toBeInTheDocument();
  });
});

describe('Home', () => {
  it('loads with skeleton rows', async () => {
    await renderApp('/', { setup: (m) => m.hang('GET', paths.locations) });
    expect(
      await screen.findByRole('status', { name: 'Loading your locations' }),
    ).toBeInTheDocument();
  });

  it('says when the locations could not load', async () => {
    await renderApp('/', {
      setup: (m) =>
        m.on('GET', paths.locations, () => new MockReply(503, { error: 'x', code: 'internal' })),
    });
    expect(await screen.findByText("Couldn't load this")).toBeInTheDocument();
  });

  it("says so when the server can't reach its database", async () => {
    await renderApp('/', {
      setup: (m) =>
        m.on(
          'GET',
          paths.locations,
          () => new MockReply(503, { error: 'x', code: 'database_unavailable' }),
        ),
    });
    expect(
      await screen.findByText("Kept can't reach its database right now. Try again in a minute."),
    ).toBeInTheDocument();
  });

  it('first run: the Personal card and Create your first home, with no checklist', async () => {
    await renderApp('/', { state: firstRunScenario() });
    expect(await findHeading('Welcome, Ibrahim')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create your first home/ })).toHaveAttribute(
      'href',
      '/locations/new',
    );
    expect(screen.getByText(/captures with no location land here/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs you' })).not.toBeInTheDocument();
    // Over plain HTTP the admin still hears about HTTPS (D193).
    expect(screen.getByText('Put Kept on HTTPS')).toBeInTheDocument();
  });

  it('a new location gets an Invite card, and the cards list every location', async () => {
    await renderApp('/');
    expect(await screen.findByText('Invite people to Garage')).toBeInTheDocument();
    const cards = within(await section('Locations')).getAllByRole('link', { name: /things/ });
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining('Personal'),
      expect.stringContaining('Home'),
      expect.stringContaining('Garage'),
      // Bruce's Arabic household, where Ibrahim is a member (the step-2 fixtures).
      expect.stringContaining('بيت العائلة'),
    ]);
  });

  it('a location card says how many things need a place, from /home', async () => {
    await renderApp('/', {
      setup: homeIs({
        locations: [
          { id: IDS.personal, thingCount: 9, unplacedCount: 0 },
          { id: IDS.home, thingCount: 214, unplacedCount: 12 },
          { id: IDS.garage, thingCount: 63, unplacedCount: 1 },
        ],
      }),
    });
    const cards = await section('Locations');
    const home = within(cards).getByRole('link', { name: /Home.*Apartment/ });
    expect(home).toHaveTextContent('12 things need a place');
    expect(home).toHaveAttribute('href', `/loc/${IDS.home}`);
    expect(within(cards).getByRole('link', { name: /Garage/ })).toHaveTextContent(
      '1 thing needs a place',
    );
    expect(within(cards).getByRole('link', { name: /Personal/ })).not.toHaveTextContent(
      'need a place',
    );
  });

  it('renders in Arabic, right to left, with Eastern digits', async () => {
    await renderApp('/', { locale: 'ar' });
    expect(await findHeading('خطوات البدء')).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(screen.getByText('٣ من ٧')).toBeInTheDocument();
    // The cards count what /home counted (the mock's inventory), in Eastern digits.
    expect(within(await section('المواقع')).getByRole('link', { name: /Home/ })).toHaveTextContent(
      '١٢ شيئًا',
    );
    expectLogicalOnly();
  });

  it('Western digits when the person chooses them', async () => {
    await renderApp('/', { locale: 'ar', digits: 'western' });
    expect(await screen.findByText('3 من 7')).toBeInTheDocument();
  });
});

describe('Home: Get started (D138, D191, D193)', () => {
  it('over plain HTTP the admin sees HTTPS first; done steps fold into one Done row', async () => {
    await renderApp('/');
    const items = await checklistItems();
    expect(items.map((i) => i.querySelector('[data-title]')?.textContent)).toEqual([
      'Put Kept on HTTPS',
      'Done',
      'Print your first label',
      'Connect an AI provider',
      'Install on your phone',
    ]);
    expect(items[1]).toHaveTextContent('Created Home · Added 3 things · Invited someone');
    const checklist = await section('Get started');
    expect(within(checklist).getByText('3 of 7')).toBeInTheDocument();
    expect(within(checklist).getByText('4 more steps and Kept is set up.')).toBeInTheDocument();
  });

  it('over HTTPS there is no HTTPS step', async () => {
    https.plain = false;
    await renderApp('/');
    const items = await checklistItems();
    expect(items[0]).toHaveTextContent('Done');
    expect(screen.queryByText('Put Kept on HTTPS')).not.toBeInTheDocument();
    expect(screen.getByText('3 of 6')).toBeInTheDocument();
  });

  it('the 3-things step stays open until three are captured; Add opens the create sheet', async () => {
    const { user } = await renderApp('/', {
      setup: homeIs({ checklist: checklist({ threeThings: false }) }),
    });
    const items = await checklistItems();
    const three = items.find((i) => i.textContent?.includes('Add 3 things')) as HTMLElement;
    expect(three).toBeTruthy();
    expect(items[1]).not.toHaveTextContent('Added 3 things');
    await user.click(within(three).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('dialog', { name: 'Add a thing' })).toBeInTheDocument();
  });

  it('on Essentials there is no AI step (D191)', async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.preset = 'essentials';
    await renderApp('/', { state });
    await checklistItems();
    expect(screen.queryByText('Connect an AI provider')).not.toBeInTheDocument();
    expect(screen.getByText('Print your first label')).toBeInTheDocument();
  });

  it('an invited member: no invite or AI step, and the home he joined counts', async () => {
    await renderApp('/', { state: memberScenario() });
    const items = await checklistItems();
    expect(items[0]).toHaveTextContent('Done');
    expect(items[0]).toHaveTextContent('Joined Home');
    expect(screen.queryByText('Invite someone')).not.toBeInTheDocument();
    expect(screen.queryByText('Connect an AI provider')).not.toBeInTheDocument();
    expect(screen.queryByText(/Invite people to/)).not.toBeInTheDocument();
    expect(screen.queryByText('Put Kept on HTTPS')).not.toBeInTheDocument();
  });

  it('a viewer: no invite step or card, the panel still shows, and Add goes to his Personal', async () => {
    const state = memberScenario();
    const home = state.locations.find((l) => l.id === IDS.home) as LocationDetail;
    home.role = 'viewer';
    const { user } = await renderApp('/', {
      state,
      setup: homeIs({
        checklist: checklist({ threeThings: false }),
        attention: { toReview: 0, uncertain: 2, longUnseen: 0, unplaced: 0 },
      }),
    });
    // What needs attention is still shown: a viewer can look.
    expect(await section('Needs you')).toBeInTheDocument();
    expect(screen.queryByText(/Invite people to/)).not.toBeInTheDocument();
    // His Personal location is his to add to (D114), so the step keeps its button.
    const items = await checklistItems();
    const three = items.find((i) => i.textContent?.includes('Add 3 things')) as HTMLElement;
    await user.click(within(three).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('dialog', { name: 'Add a thing' })).toBeInTheDocument();
  });

  it('hide and Undo go through the server, so another phone agrees', async () => {
    const { user, mock } = await renderApp('/');
    await findHeading('Get started');
    await user.click(screen.getByRole('button', { name: 'Hide Get started' }));
    expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.hint('checklist'))?.body).toEqual({ dismissed: true }),
    );
    expect(mock.state.inventory.checklistDismissed).toBe(true);
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await findHeading('Get started')).toBeInTheDocument();
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.hint('checklist'))?.body).toEqual({ dismissed: false }),
    );
  });

  it('dismissed elsewhere stays hidden here, and Show Get started brings it back', async () => {
    const state = ownerScenario();
    state.inventory.checklistDismissed = true;
    const { user, mock } = await renderApp('/', { state });
    await section('Locations');
    expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Get started' }));
    expect(await findHeading('Get started')).toBeInTheDocument();
    expect(mock.lastCall('PUT', p.hint('checklist'))?.body).toEqual({ dismissed: false });
  });

  it("step 1's hidden flag on this device moves to the server", async () => {
    localStorage.setItem('kept.getStarted.hidden', '1');
    const { mock } = await renderApp('/');
    await section('Locations');
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.hint('checklist'))?.body).toEqual({ dismissed: true }),
    );
    expect(localStorage.getItem('kept.getStarted.hidden')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
  });

  it('opened as the installed app, Install on your phone ticks itself', async () => {
    media(['(display-mode: standalone)']);
    const { mock } = await renderApp('/');
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.hint('installed_standalone'))?.body).toEqual({ seen: true }),
    );
    await waitFor(() => expect(screen.getByText(/Installed on your phone/)).toBeInTheDocument());
    expect(screen.queryByText('Install on your phone')).not.toBeInTheDocument();
  });

  it('How shows the install steps, iPhone first on an iPhone', async () => {
    const { user } = await renderApp('/');
    const items = await checklistItems();
    const install = items.find((i) =>
      i.textContent?.includes('Install on your phone'),
    ) as HTMLElement;
    await user.click(within(install).getByRole('button', { name: 'How' }));
    const sheet = await screen.findByRole('dialog', { name: 'Install Kept on your phone' });
    expect(
      within(sheet)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['iPhone, iPad', 'Android', 'Computer']);
    await user.click(within(sheet).getByRole('tab', { name: 'Android' }));
    expect(within(sheet).getByText(/Install app/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('disappears once every step is done', async () => {
    https.plain = false;
    await renderApp('/', {
      setup: homeIs({
        checklist: checklist({ labelPrinted: true, aiConnected: true, installed: true }),
      }),
    });
    await section('Locations');
    expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show Get started' })).not.toBeInTheDocument();
  });
});

describe('Home: Needs you (D185, screens §8)', () => {
  it('rows keep the fixed order, zero rows are hidden, and each opens its search', async () => {
    await renderApp('/', {
      setup: homeIs({ attention: { toReview: 2, uncertain: 0, longUnseen: 4, unplaced: 3 } }),
    });
    const panel = await section('Needs you');
    const rows = within(panel).getAllByRole('link');
    expect(rows.map((r) => r.querySelector('[data-title]')?.textContent)).toEqual([
      'To review',
      'Long unseen',
      'Unplaced',
    ]);
    expect(rows[0]).toHaveTextContent('2');
    expect(rows[2]).toHaveTextContent('3 things waiting for a place');
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/search?f.state=to_review',
      '/search?f.state=long_unseen',
      '/search?f.state=unplaced',
    ]);
  });

  it('"To review" with inbox items waiting opens the inbox on Everyone’s (T22)', async () => {
    const { user, router } = await renderApp('/', {
      setup: homeIs({
        attention: { toReview: 5, uncertain: 0, longUnseen: 0, unplaced: 0 },
        counts: { inbox: 4, unprintedLabels: 0 },
      }),
    });
    const panel = await section('Needs you');
    const row = within(panel).getByRole('link', { name: /To review/ });
    expect(row).toHaveTextContent('5 items need a look');
    expect(row.getAttribute('href')).toBe('/inbox?f.mine=everyone');
    await user.click(row);
    await waitFor(() => expect(pathOf(router)).toBe('/inbox'));
  });

  it('the sidebar’s Inbox shows the open items from Home’s counts (D198)', async () => {
    await renderApp('/', {
      setup: homeIs({ counts: { inbox: 7, unprintedLabels: 0 } }),
    });
    expect(await screen.findByRole('link', { name: 'Inbox 7' })).toBeInTheDocument();
  });

  it('the registry order is the §8 order, later rows included', () => {
    expect(ATTENTION_ORDER).toEqual([
      'toReview',
      'overdue',
      'due',
      'expiring',
      'lentOut',
      'borrowedIn',
      'uncertain',
      'longUnseen',
      'unplaced',
      'lowStock',
    ]);
  });

  it('counts come from the inventory (the mock computes them like the server)', async () => {
    await renderApp('/');
    const panel = await section('Needs you');
    const titles = within(panel)
      .getAllByRole('link')
      .map((r) => r.querySelector('[data-title]')?.textContent);
    expect(titles[0]).toBe('To review');
    expect(titles).toContain('Uncertain');
  });

  it('nothing needs you: no panel at all', async () => {
    await renderApp('/', {
      setup: homeIs({ attention: { toReview: 0, uncertain: 0, longUnseen: 0, unplaced: 0 } }),
    });
    await section('Locations');
    expect(screen.queryByRole('heading', { name: 'Needs you' })).not.toBeInTheDocument();
  });

  it('a row opens search with its filter applied', async () => {
    const { user, router } = await renderApp('/', {
      setup: homeIs({ attention: { toReview: 0, uncertain: 1, longUnseen: 0, unplaced: 0 } }),
    });
    const panel = await section('Needs you');
    await user.click(within(panel).getByRole('link', { name: /Uncertain/ }));
    await waitFor(() => expect(pathOf(router)).toBe('/search'));
    expect(String((router.state.location.search as Record<string, unknown>)['f.state'])).toBe(
      'uncertain',
    );
  });
});

describe("Home: step 4's rows (plan T13, T27)", () => {
  const titles = (panel: HTMLElement) =>
    within(panel)
      .getAllByRole('link')
      .map((r) => r.querySelector('[data-title]')?.textContent);

  it('overdue · due · expiring · lent out · borrowed in, in the §8 order', async () => {
    await renderApp('/');
    const panel = await section('Needs you');
    await waitFor(() => expect(titles(panel)).toContain('Borrowed in'));
    const shown = titles(panel);
    const order = ['Overdue', 'Due', 'Expiring', 'Lent out', 'Borrowed in'].filter((x) =>
      shown.includes(x),
    );
    expect(order).toEqual(['Overdue', 'Due', 'Expiring', 'Lent out', 'Borrowed in']);
    expect(shown.indexOf('Borrowed in')).toBeLessThan(shown.indexOf('Uncertain'));
    const row = (name: string) => within(panel).getByRole('link', { name: new RegExp(`^${name}`) });
    expect(row('Due').getAttribute('href')).toBe('/schedules?f.state=due');
    expect(row('Expiring').getAttribute('href')).toBe('/expiring?f.state=expiring');
    expect(row('Lent out').getAttribute('href')).toBe('/lending?f.direction=out&f.state=open');
    expect(row('Borrowed in').getAttribute('href')).toBe('/lending?f.direction=in&f.state=open');
    expect(row('Overdue').getAttribute('href')).toMatch(/^\/expiring\?f\.state=overdue/);
  });

  it("a row's count is what the list it opens shows", async () => {
    const { user, router } = await renderApp('/');
    const panel = await section('Needs you');
    const overdue = await within(panel).findByRole('link', { name: /^Overdue/ });
    const n = Number(
      (overdue.textContent ?? '')
        .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
        .match(/\d+/)?.[0],
    );
    await user.click(overdue);
    await waitFor(() => expect(pathOf(router)).toBe('/expiring'));
    const list = await screen.findByRole('list', { name: 'Expiring' });
    await waitFor(() => expect(within(list).getAllByRole('article')).toHaveLength(n));
  });

  it("takes the counts and the rows' links from /home when it carries them, and asks nothing else", async () => {
    const asked: string[] = [];
    const { user, router } = await renderApp('/', {
      setup: (m) => {
        homeIs({
          attention: {
            toReview: 0,
            uncertain: 0,
            longUnseen: 0,
            unplaced: 0,
            overdue: 2,
            due: 3,
            expiring: 1,
            lentOut: 4,
            borrowedIn: 0,
          },
          agendaBySource: {
            overdue: { schedule: 2 },
            due: { schedule: 1, warranty: 2 },
            expiring: { document: 1 },
          },
        })(m);
        m.on('GET', hp.agenda, () => {
          asked.push('agenda');
          return { items: [], next_cursor: null, counts: { overdue: 0, due: 0, expiring: 0 } };
        });
        m.on('GET', hp.loans, () => {
          asked.push('loans');
          return { items: [], next_cursor: null, counts: { out: 0, in: 0, overdue: 0 } };
        });
      },
    });
    const panel = await section('Needs you');
    expect(titles(panel)).toEqual(['Overdue', 'Due', 'Expiring', 'Lent out']);
    const row = (name: string) => within(panel).getByRole('link', { name: new RegExp(`^${name}`) });
    expect(row('Overdue').getAttribute('href')).toBe('/schedules?f.state=overdue');
    expect(row('Due').getAttribute('href')).toMatch(/^\/expiring\?f\.state=due/);
    expect(row('Lent out')).toHaveTextContent('4');
    expect(asked).toEqual([]);
    await user.click(row('Overdue'));
    await waitFor(() => expect(pathOf(router)).toBe('/schedules'));
  });

  it('hidden with nothing on the agenda and no loans', async () => {
    await renderApp('/', { setup: quietHousehold });
    const panel = await section('Needs you');
    await section('Locations');
    expect(titles(panel)).not.toContain('Overdue');
    expect(titles(panel)).not.toContain('Lent out');
  });
});

describe('Home: recent activity (screens §8)', () => {
  it('three entries on the phone, with All activity', async () => {
    await renderApp('/');
    const recent = await section('Recent activity');
    await waitFor(() => expect(within(recent).getAllByRole('article')).toHaveLength(3));
    expect(within(recent).getByRole('link', { name: 'All activity' })).toHaveAttribute(
      'href',
      '/activity',
    );
    // Newest first, each linking to what it's about.
    expect(within(recent).getAllByRole('article')[0]).toHaveTextContent('Added HDMI cable, 2 m');
  });

  it('five on desktop', async () => {
    media(['(min-width: 768px)']);
    await renderApp('/');
    const recent = await section('Recent activity');
    await waitFor(() => expect(within(recent).getAllByRole('article')).toHaveLength(5));
  });

  it('no activity yet: no section', async () => {
    const state = ownerScenario();
    state.inventory.events = [];
    await renderApp('/', { state });
    await section('Locations');
    expect(screen.queryByRole('heading', { name: 'Recent activity' })).not.toBeInTheDocument();
  });
});

describe('the frame', () => {
  it('has the phone tabs and the sidebar entries, later ones inert', async () => {
    await renderApp('/');
    await findHeading('Home');
    const navs = screen.getAllByRole('navigation', { name: 'Main' });
    const tabs = navs.find((n) => within(n).queryByText('More')) as HTMLElement;
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Home', 'Search', 'Capture', 'Inbox', 'More']);
    const sidebar = navs.find((n) => within(n).queryByText('Insights')) as HTMLElement;
    // Vehicles is a page since step 5 (shown once the locations say the module is on somewhere);
    // Insights is still to come.
    expect(await within(sidebar).findByRole('link', { name: 'Vehicles' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(within(sidebar).getByText('Insights').closest('[aria-disabled]')).toBeTruthy();
    expect(within(sidebar).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('shows the version and the Source code link (D147)', async () => {
    await renderApp('/');
    const links = await screen.findAllByRole('link', { name: 'Source code' });
    expect(links[0]).toHaveAttribute('href', 'https://github.com/ibrahimroshdy/kept/tree/3f9ed1d');
    expect(screen.getAllByText('v0.1.0').length).toBeGreaterThan(0);
  });

  it('keeps the image’s third-party notices out of the footer, even when the server serves them (D151)', async () => {
    const state = ownerScenario();
    state.version = { ...state.version, notices: '/notices.txt' };
    await renderApp('/more', { state });
    await screen.findAllByRole('link', { name: 'Source code' });
    expect(screen.queryByRole('link', { name: 'Third-party notices' })).toBeNull();
  });

  // /search is built from step 2 (task 27): src/test/screens/search.test.tsx; /capture from
  // step 3 (task 25): src/components/capture/capture-screen.test.tsx; /inbox from step 3
  // (task 27): src/test/screens/inbox.test.tsx.

  it('More lists the locations and every entry', async () => {
    await renderApp('/more');
    await findHeading('More');
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: /Garage/ }).length).toBeGreaterThan(0),
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});
