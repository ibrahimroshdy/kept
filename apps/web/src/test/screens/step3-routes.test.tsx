/**
 * Step 3's route stubs (plan T3): every screen the Phase C tasks fill in exists now, looks
 * finished, and is reachable from the navigation: Scan in the header on Home and Search, Labels
 * and Help in the sidebar and on More, AI and Import in Settings, Templates in Account, AI in
 * Admin. The print view has no app shell.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ownerScenario } from '@/api/mock/fixtures';
import { expectLogicalOnly } from '@/test/render';
import { findHeading, pathOf, renderApp } from '../app';

describe('step-3 route stubs', () => {
  it('/settings/diagnostics is the diagnostics panel (T23), which runs nothing until asked', async () => {
    await renderApp('/settings/diagnostics');
    expect(await findHeading('Diagnostics')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run the checks' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByText('Coming soon')).not.toBeInTheDocument();
  });

  it('AI usage renders its own page, not AI settings around it', async () => {
    await renderApp('/settings/ai/usage');
    expect(await findHeading('AI usage')).toBeInTheDocument();
    expect(screen.queryByText('Where your key lives')).toBeNull();
  });

  it.each([
    ['/settings/ai', 'What uses AI in Kept'],
    ['/settings/me/ai', 'What uses AI in Kept'],
    ['/admin/ai', 'What uses AI in Kept'],
    ['/settings/ai/usage', 'Every call'],
    ['/admin/ai/usage', 'Every call'],
  ])('%s is built (T29, T29a), not a placeholder', async (path, text) => {
    await renderApp(path);
    expect(await screen.findByText(text, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByText('Coming soon')).toBeNull();
  });

  it('/l/<code> shows the code on label tape while it answers (T26)', async () => {
    await renderApp('/l/zzzzzz');
    expect(await screen.findByRole('img', { name: 'ZZZZZZ' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Not in your Kept' })).toBeInTheDocument();
  });

  it('/l/<code> signed out goes to sign in, keeping the code to come back to', async () => {
    const state = ownerScenario();
    state.signedIn = false;
    const { router } = await renderApp('/l/7KQ4MZ', { state });
    await waitFor(() => expect(pathOf(router)).toBe('/signin'));
    expect(router.state.location.search).toMatchObject({ next: '/l/7KQ4MZ' });
  });

  it('the print view (T28) has no app shell', async () => {
    await renderApp('/labels/01926f00-0000-7000-8000-000000100091');
    expect(await screen.findByRole('region', { name: /^Sheet 1 of / })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('Labels (T28) is built, in Arabic too', async () => {
    await renderApp('/labels', { locale: 'ar' });
    expect(await findHeading('الملصقات')).toBeInTheDocument();
    expect(screen.queryByText('يأتي في مرحلة لاحقة')).toBeNull();
    expectLogicalOnly();
  });
});

describe('step-3 navigation', () => {
  it('Scan is in the header on Home and Search, and nowhere else', async () => {
    const { user, router } = await renderApp('/');
    await findHeading('Home');
    await user.click(screen.getByRole('link', { name: 'Scan' }));
    await waitFor(() => expect(pathOf(router)).toBe('/scan'));
    expect(await findHeading('Scan')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Scan' })).toBeNull();
  });

  it('More (and the sidebar) list Labels and Help as links', async () => {
    await renderApp('/more');
    await findHeading('More');
    const hrefs = (name: string) =>
      screen.getAllByRole('link', { name }).map((l) => l.getAttribute('href'));
    await waitFor(() => expect(hrefs('Labels')).toEqual(['/labels', '/labels']));
    expect(hrefs('Help')).toEqual(['/help', '/help']);
  });

  it('Labels is hidden when the module is off in every location (screens §1)', async () => {
    const state = ownerScenario();
    state.locations = state.locations.map((l) => ({
      ...l,
      modules: l.modules.filter((m) => m !== 'labels'),
    }));
    await renderApp('/more', { state });
    await findHeading('More');
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Help' })).toHaveLength(2));
    expect(screen.queryByRole('link', { name: 'Labels' })).toBeNull();
  });

  it('Settings has AI and Import; Account has Templates; Admin has AI', async () => {
    await renderApp('/settings/account/types');
    const settings = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(settings).getByRole('link', { name: 'AI' })).toHaveAttribute(
      'href',
      '/settings/ai',
    );
    expect(within(settings).getByRole('link', { name: 'Import' })).toHaveAttribute(
      'href',
      '/settings/import',
    );
    const account = screen.getByRole('navigation', { name: 'Account' });
    expect(within(account).getByRole('link', { name: 'Templates' })).toHaveAttribute(
      'href',
      '/settings/account/templates',
    );
  });

  it('Admin has an AI tab', async () => {
    await renderApp('/admin/ai');
    const admin = await screen.findByRole('navigation', { name: 'Instance admin' });
    expect(within(admin).getByRole('link', { name: 'AI' })).toHaveAttribute('href', '/admin/ai');
  });
});
