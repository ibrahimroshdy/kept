/**
 * The signed-in gate, Home (task 29; D240's redesign: Get started as one line, Needs you as tiles,
 * the location cards with map previews, shortcuts, recent activity with its chips and Photos to
 * review, the Insights teaser; today, day one, a viewer, Money off, a phone width, Arabic) and the
 * app frame.
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
import { ensureVehiclesSeeded } from '@/api/vehicles/mock';
import { assistantStore, setDraft, showThread } from '@/assistant/store';
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
/** Get started, one line (D240): its region, and its steps once the chevron opens them. */
const startedRegion = () => screen.findByRole('region', { name: 'Get started' }, { timeout: 3000 });
async function openSteps(user: { click: (el: Element) => Promise<void> }) {
  const region = await startedRegion();
  await user.click(within(region).getByRole('button', { name: /^Get started/ }));
  return within(region).getAllByRole('listitem');
}

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

  it('today: every section, in the one-column order a phone shows', async () => {
    await renderApp('/');
    await section('Locations');
    for (const name of ['Needs you', 'Shortcuts', 'Recent activity', 'Insights'])
      expect(await section(name)).toBeInTheDocument();
    expect(await startedRegion()).toBeInTheDocument();
    // The banners stay above Needs you; the Invite card sits under the locations (D194).
    expect(screen.getByText('Invite people to Garage')).toBeInTheDocument();
    const order = (name: string) =>
      Number(
        [...(screen.getByRole('heading', { name }).closest('section')?.classList ?? [])]
          .find((c) => /^order-\d$/.test(c))
          ?.slice(6),
      );
    expect(
      ['Needs you', 'Shortcuts', 'Locations', 'Recent activity', 'Insights'].map(order),
    ).toEqual([3, 4, 5, 7, 8]);
    expectLogicalOnly();
  });

  it('day one: the welcome, the steps after it, the Personal card, three shortcuts and an empty Recent', async () => {
    await renderApp('/', { state: firstRunScenario() });
    expect(await findHeading('Welcome, Ibrahim')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create your first home/ })).toHaveAttribute(
      'href',
      '/locations/new',
    );
    expect(await screen.findByText(/^Then: add 3 things/)).toBeInTheDocument();
    expect(screen.getByText(/captures with no location land here/)).toBeInTheDocument();
    // No checklist: its first step is the button. Nothing to count yet.
    expect(screen.queryByRole('region', { name: 'Get started' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs you' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Insights' })).not.toBeInTheDocument();
    const shortcuts = await section('Shortcuts');
    expect([...shortcuts.querySelectorAll('a, button')].map((b) => b.textContent)).toEqual([
      'Capture',
      'Scan a label',
      'Add a thing',
    ]);
    const recent = await section('Recent activity');
    expect(
      await within(recent).findByText('Nothing yet. What you add, move and check shows here.'),
    ).toBeInTheDocument();
    expect(within(recent).queryByRole('link', { name: 'All activity' })).not.toBeInTheDocument();
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

  it('a location card: things, places, value and its flags, with a map preview', async () => {
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
    expect(home).toHaveAttribute('href', `/loc/home-0000b002`);
    expect(home).toHaveTextContent('12 things need a place');
    await waitFor(() => expect(home).toHaveTextContent(/places/));
    // The mock's Insights: Home holds EGP and USD values, each its own, never converted.
    expect(home).toHaveTextContent(/EGP\s?122,800\.00 · \$150\.00 value/);
    expect(home).toHaveTextContent('1 low');
    expect(home.querySelector('svg circle[data-pin]')).not.toBeNull();
    expect(within(cards).getByRole('link', { name: /Garage/ })).toHaveTextContent(
      '1 thing needs a place',
    );
    // Money is off in the Garage: no value line at all.
    expect(within(cards).getByRole('link', { name: /Garage/ })).not.toHaveTextContent('value');
    expect(within(cards).getByRole('link', { name: /Personal/ })).not.toHaveTextContent(
      'need a place',
    );
  });

  it('renders in Arabic, right to left, with Eastern digits', async () => {
    await renderApp('/', { locale: 'ar' });
    expect(await screen.findByText('تم ٣ من ٧')).toBeInTheDocument();
    expect(await findHeading('ما يحتاج إليك')).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    // The cards count what /home counted (the mock's inventory), in Eastern digits.
    expect(within(await section('المواقع')).getByRole('link', { name: /Home/ })).toHaveTextContent(
      '١٢ شيئًا',
    );
    expect(await findHeading('اختصارات')).toBeInTheDocument();
    expectLogicalOnly();
  });

  it('Western digits when the person chooses them', async () => {
    await renderApp('/', { locale: 'ar', digits: 'western' });
    expect(await screen.findByText('تم 3 من 7')).toBeInTheDocument();
  });

  it('at a phone width nothing is cut off with an ellipsis', async () => {
    const { container } = await renderApp('/');
    await section('Recent activity');
    await waitFor(() =>
      expect(within(screen.getByRole('main')).getAllByRole('article').length).toBe(3),
    );
    const clipped = [...container.querySelectorAll<HTMLElement>('[class]')].filter((el) =>
      /(^|\s)(truncate|text-ellipsis|line-clamp-\d)(\s|$)/.test(el.getAttribute('class') ?? ''),
    );
    expect(clipped.map((el) => el.textContent)).toEqual([]);
  });

  it('asks for Home once each, and only Home asks for its overview', async () => {
    const asked: string[] = [];
    const { mock } = await renderApp('/', {
      setup: homeIs({
        attention: {
          toReview: 0,
          uncertain: 0,
          longUnseen: 0,
          unplaced: 0,
          overdue: 0,
          due: 0,
          expiring: 0,
          lentOut: 0,
          borrowedIn: 0,
        },
        agendaBySource: { overdue: {}, due: {}, expiring: {} },
      }),
    });
    await section('Shortcuts');
    await waitFor(() => expect(mock.calls.some((c) => c.path === p.homeOverview)).toBe(true));
    for (const c of mock.calls) if (c.method === 'GET') asked.push(c.path);
    expect(asked.filter((x) => x === p.homeOverview)).toHaveLength(1);
    expect(asked.filter((x) => x === p.home)).toHaveLength(1);
    // Nothing waits in the inbox, the counts are /home's: no inbox, agenda, loans or Insights.
    expect(asked).not.toContain('/api/v1/inbox');
    expect(asked).not.toContain(hp.agenda);
    expect(asked).not.toContain(hp.loans);
    expect(asked).not.toContain('/api/v1/insights');
  });
});

describe('Home: Get started (D138, D191, D193, D240)', () => {
  it('is one line: progress, "3 of 7 done", the next step; the chevron opens the steps', async () => {
    const { user } = await renderApp('/');
    const started = await startedRegion();
    expect(within(started).getByText('3 of 7 done')).toBeInTheDocument();
    expect(within(started).getByText('Put Kept on HTTPS')).toBeInTheDocument();
    expect(within(started).queryByRole('listitem')).not.toBeInTheDocument();
    const items = await openSteps(user);
    expect(items.map((i) => i.querySelector('[data-title]')?.textContent)).toEqual([
      'Put Kept on HTTPS',
      'Print your first label',
      'Connect an AI provider',
      'Install on your phone',
      'Done',
    ]);
    expect(items[4]).toHaveTextContent('Created Home · Added 3 things · Invited someone');
    expect(within(started).getByRole('button', { name: /^Get started/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('over HTTPS there is no HTTPS step', async () => {
    https.plain = false;
    const { user } = await renderApp('/');
    expect(within(await startedRegion()).getByText('3 of 6 done')).toBeInTheDocument();
    const items = await openSteps(user);
    expect(items[0]).toHaveTextContent('Print your first label');
    expect(screen.queryByText('Put Kept on HTTPS')).not.toBeInTheDocument();
  });

  it('asks the instance admin to set up email while mail is off, with how', async () => {
    https.plain = false;
    const { user } = await renderApp('/', {
      setup: (m) => {
        m.state.admin.status.mail.configured = false;
      },
    });
    await waitFor(async () =>
      expect(within(await startedRegion()).getByText('3 of 7 done')).toBeInTheDocument(),
    );
    const items = await openSteps(user);
    const step = items.find((i) => i.textContent?.includes('Set up email')) as HTMLElement;
    await user.click(within(step).getByRole('button', { name: 'How' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up email' });
    expect(within(dialog).getByText('KEPT_SMTP_URL')).toBeInTheDocument();
    expect(within(dialog).getByText('KEPT_SMTP_FROM')).toBeInTheDocument();
  });

  it('the 3-things step stays open until three are captured; Add opens the create sheet', async () => {
    const { user } = await renderApp('/', {
      setup: homeIs({ checklist: checklist({ threeThings: false }) }),
    });
    const items = await openSteps(user);
    const three = items.find((i) => i.textContent?.includes('Add 3 things')) as HTMLElement;
    expect(three).toBeTruthy();
    expect(items.at(-1)).not.toHaveTextContent('Added 3 things');
    await user.click(within(three).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('dialog', { name: 'Add a thing' })).toBeInTheDocument();
  });

  it('on Essentials there is no AI step (D191)', async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.preset = 'essentials';
    const { user } = await renderApp('/', { state });
    await openSteps(user);
    expect(screen.queryByText('Connect an AI provider')).not.toBeInTheDocument();
    expect(screen.getAllByText('Print your first label').length).toBeGreaterThan(0);
  });

  it('an invited member: no invite or AI step, and the home he joined counts', async () => {
    const { user } = await renderApp('/', { state: memberScenario() });
    const items = await openSteps(user);
    const done = items.at(-1) as HTMLElement;
    expect(done).toHaveTextContent('Done');
    expect(done).toHaveTextContent('Joined Home');
    expect(screen.queryByText('Invite someone')).not.toBeInTheDocument();
    expect(screen.queryByText('Connect an AI provider')).not.toBeInTheDocument();
    expect(screen.queryByText(/Invite people to/)).not.toBeInTheDocument();
    expect(screen.queryByText('Put Kept on HTTPS')).not.toBeInTheDocument();
  });

  it('hide for good and Undo go through the server, so another phone agrees', async () => {
    const { user, mock } = await renderApp('/');
    await startedRegion();
    await user.click(screen.getByRole('button', { name: 'Hide Get started for good' }));
    expect(screen.queryByRole('region', { name: 'Get started' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.hint('checklist'))?.body).toEqual({ dismissed: true }),
    );
    expect(mock.state.inventory.checklistDismissed).toBe(true);
    expect(await screen.findByText('Get started hidden. Help brings it back.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await startedRegion()).toBeInTheDocument();
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.hint('checklist'))?.body).toEqual({ dismissed: false }),
    );
  });

  it('dismissed elsewhere stays hidden here; only Help brings it back', async () => {
    const state = ownerScenario();
    state.inventory.checklistDismissed = true;
    await renderApp('/', { state });
    await section('Locations');
    expect(screen.queryByRole('region', { name: 'Get started' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show Get started' })).not.toBeInTheDocument();
  });

  it("step 1's hidden flag on this device moves to the server", async () => {
    localStorage.setItem('kept.getStarted.hidden', '1');
    const { mock } = await renderApp('/');
    await section('Locations');
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.hint('checklist'))?.body).toEqual({ dismissed: true }),
    );
    expect(localStorage.getItem('kept.getStarted.hidden')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Get started' })).not.toBeInTheDocument();
  });

  it('opened as the installed app, Install on your phone ticks itself', async () => {
    media(['(display-mode: standalone)']);
    const { user, mock } = await renderApp('/');
    await waitFor(() =>
      expect(mock.lastCall('PUT', p.hint('installed_standalone'))?.body).toEqual({ seen: true }),
    );
    await waitFor(async () =>
      expect(within(await startedRegion()).getByText('4 of 7 done')).toBeInTheDocument(),
    );
    await openSteps(user);
    expect(screen.getByText(/Installed on your phone/)).toBeInTheDocument();
    expect(screen.queryByText('Install on your phone')).not.toBeInTheDocument();
  });

  it('How shows the install steps, iPhone first on an iPhone', async () => {
    const { user } = await renderApp('/');
    const items = await openSteps(user);
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
    expect(screen.queryByRole('region', { name: 'Get started' })).not.toBeInTheDocument();
  });
});

const tiles = (panel: HTMLElement) =>
  within(panel)
    .getAllByRole('link')
    .map((r) => r.querySelector('[data-title]')?.textContent);

describe('Home: Needs you (D185, D240, screens §8)', () => {
  it('six fixed tiles; a zero stays, muted; the extras join only with a count', async () => {
    await renderApp('/', {
      setup: homeIs({ attention: { toReview: 2, uncertain: 0, longUnseen: 4, unplaced: 3 } }),
    });
    const panel = await section('Needs you');
    expect(tiles(panel)).toEqual([
      'Overdue',
      'Due',
      'Expiring',
      'Lent out',
      'Uncertain',
      'Low stock',
      'Long unseen',
    ]);
    const tile = (name: string) =>
      within(panel).getByRole('link', { name: new RegExp(`^${name}`) });
    expect(tile('Uncertain')).toHaveAttribute('data-zero', 'true');
    expect(tile('Uncertain')).toHaveAttribute('href', '/search?f.state=uncertain');
    expect(tile('Uncertain')).toHaveTextContent('Nothing');
    expect(tile('Long unseen')).toHaveAccessibleName('Long unseen 4');
    expect(tile('Long unseen')).toHaveAttribute('href', '/search?f.state=long_unseen');
    // To review and Unplaced left Needs you (D240).
    expect(within(panel).queryByText('To review')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Unplaced')).not.toBeInTheDocument();
  });

  it('each tile names its most urgent item, from the overview', async () => {
    await renderApp('/');
    const panel = await section('Needs you');
    const tile = (name: string) =>
      within(panel).getByRole('link', { name: new RegExp(`^${name}`) });
    await waitFor(() => expect(tile('Low stock')).toHaveTextContent(/left, keep/));
    expect(tile('Low stock')).toHaveAccessibleDescription(/AA batteries/);
    expect(tile('Lent out')).toHaveTextContent('Murdock');
  });

  it('a module off everywhere has no tile: Lending and Consumables', async () => {
    const state = ownerScenario();
    for (const l of state.locations)
      l.modules = l.modules.filter((m) => m !== 'lending' && m !== 'consumables');
    await renderApp('/', { state });
    const panel = await section('Needs you');
    await waitFor(() =>
      expect(tiles(panel).slice(0, 4)).toEqual(['Overdue', 'Due', 'Expiring', 'Uncertain']),
    );
    expect(tiles(panel)).not.toContain('Lent out');
    expect(tiles(panel)).not.toContain('Low stock');
    expect(tiles(panel)).not.toContain('Borrowed in');
  });

  it('a tile opens search with its filter applied', async () => {
    const { user, router } = await renderApp('/', {
      setup: homeIs({ attention: { toReview: 0, uncertain: 1, longUnseen: 0, unplaced: 0 } }),
    });
    const panel = await section('Needs you');
    await user.click(within(panel).getByRole('link', { name: /^Uncertain/ }));
    await waitFor(() => expect(pathOf(router)).toBe('/search'));
    expect(String((router.state.location.search as Record<string, unknown>)['f.state'])).toBe(
      'uncertain',
    );
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
});

describe("Home: step 4's counts (plan T13, T27)", () => {
  it('overdue · due · expiring · lent out, then borrowed in, with their links', async () => {
    await renderApp('/');
    const panel = await section('Needs you');
    await waitFor(() => expect(tiles(panel)).toContain('Borrowed in'));
    const row = (name: string) => within(panel).getByRole('link', { name: new RegExp(`^${name}`) });
    expect(row('Due').getAttribute('href')).toBe('/schedules?f.state=due');
    expect(row('Expiring').getAttribute('href')).toBe('/expiring?f.state=expiring');
    expect(row('Lent out').getAttribute('href')).toBe('/lending?f.direction=out&f.state=open');
    expect(row('Borrowed in').getAttribute('href')).toBe('/lending?f.direction=in&f.state=open');
    expect(row('Overdue').getAttribute('href')).toMatch(/^\/expiring\?f\.state=overdue/);
  });

  it("a tile's count is what the list it opens shows", async () => {
    const { user, router } = await renderApp('/');
    const panel = await section('Needs you');
    const overdue = await within(panel).findByRole('link', { name: /^Overdue/ });
    await waitFor(() => expect(overdue).not.toHaveAccessibleName('Overdue ٠'));
    const n = Number(
      (overdue.getAttribute('aria-label') ?? '')
        .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
        .match(/\d+/)?.[0],
    );
    await user.click(overdue);
    await waitFor(() => expect(pathOf(router)).toBe('/expiring'));
    const list = await screen.findByRole('list', { name: 'Expiring' });
    await waitFor(() => expect(within(list).getAllByRole('article')).toHaveLength(n));
  });

  it("takes the counts and the tiles' links from /home when it carries them, and asks nothing else", async () => {
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
    const row = (name: string) => within(panel).getByRole('link', { name: new RegExp(`^${name}`) });
    expect(row('Overdue')).toHaveAccessibleName('Overdue 2');
    expect(row('Overdue').getAttribute('href')).toBe('/schedules?f.state=overdue');
    expect(row('Due').getAttribute('href')).toMatch(/^\/expiring\?f\.state=due/);
    expect(row('Lent out')).toHaveAccessibleName('Lent out 4');
    expect(tiles(panel)).not.toContain('Borrowed in');
    expect(asked).toEqual([]);
    await user.click(row('Overdue'));
    await waitFor(() => expect(pathOf(router)).toBe('/schedules'));
  });

  it('nothing on the agenda and no loans: the tiles stay, at zero', async () => {
    await renderApp('/', { setup: quietHousehold });
    const panel = await section('Needs you');
    const row = (name: string) => within(panel).getByRole('link', { name: new RegExp(`^${name}`) });
    await waitFor(() => expect(row('Overdue')).toHaveAttribute('data-zero', 'true'));
    expect(row('Lent out')).toHaveAttribute('data-zero', 'true');
    expect(tiles(panel)).not.toContain('Borrowed in');
  });
});

describe('Home: shortcuts and Insights (D240, D234)', () => {
  it('Capture, Scan a label, Log a reading and Add a thing', async () => {
    // A metered car (step 5's fixtures) puts Log a reading among them.
    const state = ownerScenario();
    ensureVehiclesSeeded(state);
    const { user } = await renderApp('/', { state });
    const shortcuts = await section('Shortcuts');
    await waitFor(() =>
      expect([...shortcuts.querySelectorAll('a, button')].map((b) => b.textContent)).toEqual([
        'Capture',
        'Scan a label',
        'Log a reading',
        'Add a thing',
      ]),
    );
    expect(within(shortcuts).getByRole('link', { name: 'Capture' })).toHaveAttribute(
      'href',
      '/capture',
    );
    expect(within(shortcuts).getByRole('link', { name: 'Scan a label' })).toHaveAttribute(
      'href',
      '/scan',
    );
    await user.click(within(shortcuts).getByRole('button', { name: 'Add a thing' }));
    expect(await screen.findByRole('dialog', { name: 'Add a thing' })).toBeInTheDocument();
  });

  it('the teaser: this year so far and the years before, the value, per currency, and what it leaves out', async () => {
    await renderApp('/');
    const teaser = await section('Insights');
    const year = new Date().getFullYear();
    expect(within(teaser).getByText(`Spent on things, ${year} so far`)).toBeInTheDocument();
    expect(teaser).toHaveTextContent(/EGP\s?9,800\.00/);
    expect(teaser).toHaveTextContent(/EGP\s?122,800\.00/);
    expect(teaser).toHaveTextContent('$150.00');
    expect(teaser).toHaveTextContent('36 of 136 things have a value');
    expect(within(teaser).getByText('Leaves out Garage: Money is off there.')).toBeInTheDocument();
    expect(within(teaser).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/insights');
  });

  it('a viewer: no amounts on the cards, no teaser, Needs you still shows, no invite card', async () => {
    const state = memberScenario();
    const home = state.locations.find((l) => l.id === IDS.home) as LocationDetail;
    home.role = 'viewer';
    await renderApp('/', { state });
    expect(await section('Needs you')).toBeInTheDocument();
    const cards = await section('Locations');
    await waitFor(() =>
      expect(within(cards).getByRole('link', { name: /Home/ })).toHaveTextContent(/places/),
    );
    expect(within(cards).getByRole('link', { name: /Home/ })).not.toHaveTextContent('value');
    expect(within(cards).getByRole('link', { name: /Home/ })).toHaveTextContent('Viewer');
    expect(screen.queryByRole('heading', { name: 'Insights' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Invite people to/)).not.toBeInTheDocument();
  });

  it('Money off everywhere: no value and no teaser', async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.modules = l.modules.filter((m) => m !== 'money');
    await renderApp('/', { state });
    const cards = await section('Locations');
    await waitFor(() =>
      expect(within(cards).getByRole('link', { name: /Home.*Apartment/ })).toHaveTextContent(
        /places/,
      ),
    );
    expect(within(cards).getByRole('link', { name: /Home.*Apartment/ })).not.toHaveTextContent(
      'value',
    );
    expect(screen.queryByRole('heading', { name: 'Insights' })).not.toBeInTheDocument();
  });
});

describe('Home: recent activity (screens §8, D240)', () => {
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

  it('the chips ask the feed for what was added, moved or checked', async () => {
    const { user } = await renderApp('/');
    const recent = await section('Recent activity');
    await waitFor(() => expect(within(recent).getAllByRole('article').length).toBeGreaterThan(0));
    expect(within(recent).getByRole('radio', { name: 'All' })).toBeChecked();
    await user.click(within(recent).getByRole('radio', { name: 'Moved' }));
    await waitFor(() =>
      expect(
        within(recent)
          .getAllByRole('article')
          .every((a) => /Moved/.test(a.getAttribute('aria-label') ?? '')),
      ).toBe(true),
    );
  });

  it('Photos to review: the inbox’s newest, everyone’s, each opening the Inbox', async () => {
    await renderApp('/', {
      setup: homeIs({
        attention: { toReview: 5, uncertain: 0, longUnseen: 0, unplaced: 0 },
        counts: { inbox: 4, unprintedLabels: 0 },
      }),
    });
    const recent = await section('Recent activity');
    expect(within(recent).getByText('Photos to review')).toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: /^Inbox/ })).toHaveAttribute(
      'href',
      '/inbox?f.mine=everyone',
    );
    // One reading waits that isn't an inbox item: its own line, to Search.
    expect(within(recent).getByRole('link', { name: '1 reading needs a look' })).toHaveAttribute(
      'href',
      '/search?f.state=to_review',
    );
    await waitFor(() => expect(within(recent).getAllByRole('listitem').length).toBeGreaterThan(0));
  });

  it('no activity yet: Recent says what will show there', async () => {
    const state = ownerScenario();
    state.inventory.events = [];
    await renderApp('/', { state });
    const recent = await section('Recent activity');
    expect(
      await within(recent).findByText('Nothing yet. What you add, move and check shows here.'),
    ).toBeInTheDocument();
  });
});

describe('the frame', () => {
  it('has the phone tabs and the sidebar entries', async () => {
    await renderApp('/');
    await findHeading('Home');
    const navs = screen.getAllByRole('navigation', { name: 'Main' });
    const tabs = navs.find((n) => within(n).queryByText('More')) as HTMLElement;
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Home', 'Search', 'Capture', 'Inbox', 'More']);
    const sidebar = navs.find((n) => within(n).queryByText('Settings')) as HTMLElement;
    // Vehicles is a page since step 5 and Insights since 1.x (D234), each shown once the locations
    // say its module is on somewhere.
    expect(await within(sidebar).findByRole('link', { name: 'Vehicles' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(await within(sidebar).findByRole('link', { name: 'Insights' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(within(sidebar).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('shows the version and the Source code link (D147)', async () => {
    await renderApp('/');
    const links = await screen.findAllByRole('link', { name: 'Source code' });
    expect(links[0]).toHaveAttribute('href', 'https://github.com/keptinventory/kept/tree/3f9ed1d');
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

  it('signing out leaves nothing of the assistant for whoever signs in next (review finding)', async () => {
    const { user } = await renderApp('/more');
    await findHeading('More');
    showThread('01926f00-0000-7000-8000-0000000000aa');
    setDraft('Where is the passport');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(assistantStore.get().draft).toBe(''));
    expect(assistantStore.get()).toMatchObject({ open: false, threadId: null, draft: '' });
  });

  it('More lists the locations and every entry', async () => {
    await renderApp('/more');
    await findHeading('More');
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: /Garage/ }).length).toBeGreaterThan(0),
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});
