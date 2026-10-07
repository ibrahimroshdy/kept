/**
 * Step 4's frame (plan T3; screens §1): Schedules, Lending and Paperwork in the navigation while
 * their module is on in any location, Notifications for everyone, the header's bell with the
 * unread count, and the step-4 routes answering (stubs until Phase C builds them).
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '../app';

const nav = () => screen.getAllByRole('navigation', { name: 'Main' })[0] as HTMLElement;

describe('the step-4 navigation', () => {
  it('links Schedules, Lending, Paperwork and Notifications', async () => {
    await renderApp('/');
    await findHeading('Home');
    const main = within(nav());
    for (const [name, href] of [
      ['Schedules', '/schedules'],
      ['Lending', '/lending'],
      ['Paperwork', '/paperwork'],
      // With its unread count after the name (D198, T24).
      [/^Notifications\b/, '/notifications'],
    ] as const)
      expect(await main.findByRole('link', { name })).toHaveAttribute('href', href);
  });

  it('hides a module entry when the module is off everywhere, never Notifications', async () => {
    const state = ownerScenario();
    for (const l of state.locations) {
      l.modules = l.modules.filter((m) => m !== 'lending');
      l.effectiveModules = l.modules;
    }
    await renderApp('/', { state });
    await findHeading('Home');
    const main = within(nav());
    // Once the locations are in: Schedules is on in Home, Lending nowhere.
    expect(await main.findByRole('link', { name: 'Schedules' })).toBeInTheDocument();
    expect(main.queryByRole('link', { name: 'Lending' })).toBeNull();
    expect(main.getByRole('link', { name: /^Notifications\b/ })).toBeInTheDocument();
  });
});

describe('the bell', () => {
  it('shows the unread count in its name and opens the notification centre', async () => {
    const { user } = await renderApp('/');
    await findHeading('Home');
    const bells = await screen.findAllByRole('link', { name: '4 unread notifications' });
    expect(bells[0]).toHaveAttribute('href', '/notifications');
    await user.click(bells[0] as HTMLElement);
    expect(await findHeading('Notifications')).toBeInTheDocument();
    // The centre's own header carries no bell.
    expect(screen.queryByRole('link', { name: /unread/ })).toBeNull();
  });

  it('says only "Notifications" when nothing is unread', async () => {
    const state = ownerScenario();
    for (const n of state.household.notifications) n.readAt ??= new Date().toISOString();
    await renderApp('/search', { state });
    await findHeading('Search');
    const header = screen.getAllByRole('banner')[0] as HTMLElement;
    expect(within(header).getAllByRole('link', { name: 'Notifications' }).length).toBeGreaterThan(
      0,
    );
  });
});

describe('the step-4 routes', () => {
  it.each([
    ['/schedules', 'Schedules'],
    ['/lending', 'Lending'],
    ['/paperwork', 'Paperwork'],
    ['/expiring', 'Expiring'],
    ['/incidents', 'Incidents'],
    ['/reports/insurance', 'Insurance report'],
    ['/reports/claim-pack', 'Claim pack'],
    ['/settings/me/notifications', 'Notifications'],
  ])('%s answers', async (path, title) => {
    await renderApp(path);
    expect(await findHeading(title)).toBeInTheDocument();
  });

  it('an incident page renders inside /incidents, not beside it', async () => {
    await renderApp('/incidents/01926f00-0000-7000-8000-000000000001');
    expect(await findHeading('Incident')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Incidents', level: 1 })).toBeNull();
  });

  it('Account → Exchange rates is a tab of the Account frame', async () => {
    await renderApp('/settings/account/exchange-rates');
    await findHeading('Account');
    expect(screen.getByRole('link', { name: 'Exchange rates' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('Me links to its notification settings', async () => {
    await renderApp('/settings');
    await findHeading('Settings');
    const open = screen
      .getAllByRole('link', { name: 'Open' })
      .find((a) => a.getAttribute('href') === '/settings/me/notifications');
    expect(open).toBeDefined();
  });
});
