/**
 * The Lending screen and the person page (plan T22; D56, D57, screens §5): the drill Bruce lent
 * Murdock (2 days overdue) first, the ladder borrowed from Murdock; Mark returned with Undo; the
 * polite reminder copied, never sent; Murdock's page with "Has from us" and "Lent to us"; and the
 * viewer, module-off and Arabic variants.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSeeded } from '@/api/household/mock/db';
import { HOUSEHOLD_IDS } from '@/api/household/mock/state';
import { ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '../app';

const H = HOUSEHOLD_IDS;
const DRILL = 'Bosch drill, 18 V';
const LADDER = 'Aluminium ladder, 3 m';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the lending list', () => {
  it('lists the overdue drill first, then the borrowed ladder', async () => {
    await renderApp('/lending');
    await findHeading('Lending');
    const drill = await screen.findByRole('article', { name: DRILL });
    const rows = screen.getAllByRole('article');
    expect(rows[0]).toBe(drill);
    expect(within(drill).getByText('2 days overdue')).toBeInTheDocument();
    expect(within(drill).getByRole('link', { name: 'Murdock' })).toHaveAttribute(
      'href',
      `/people/${H.person.murdock}`,
    );
    expect(within(drill).getByText(/Lent to/)).toBeInTheDocument();
    const ladder = screen.getByRole('article', { name: LADDER });
    expect(within(ladder).getByText(/Borrowed from/)).toBeInTheDocument();
    expect(screen.getByText('1 lent out · 1 borrowed · 1 overdue')).toBeInTheDocument();
  });

  it('marks the drill returned in one tap, with Undo', async () => {
    const { user, mock } = await renderApp('/lending');
    const drill = within(await screen.findByRole('article', { name: DRILL }));
    await user.click(drill.getByRole('button', { name: `Mark \u2068${DRILL}\u2069 returned` }));
    expect(await screen.findByText(`\u2068${DRILL}\u2069 is back`)).toBeInTheDocument();
    const loan = mock.state.household.loans.find((l) => l.id === H.loan.drill);
    await waitFor(() => expect(loan?.returnedAt).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(loan?.returnedAt).toBeNull());
  });

  it('copies a polite reminder and never sends it', async () => {
    const { user } = await renderApp('/lending');
    // After user-event's setup, which installs a clipboard of its own.
    const writeText = vi.fn(async (_: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const drill = within(await screen.findByRole('article', { name: DRILL }));
    await user.click(drill.getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy a polite reminder' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0]?.[0] ?? '';
    expect(text).toContain('Hi Murdock');
    expect(text).toContain(DRILL);
    expect(text).toContain('It was due back on');
    expect(
      await screen.findByText('Send it however you like. Kept never sends it.'),
    ).toBeInTheDocument();
  });

  it('a borrowed thing has no reminder to copy', async () => {
    await renderApp('/lending');
    const ladder = within(await screen.findByRole('article', { name: LADDER }));
    expect(
      ladder.getByRole('button', { name: `Mark \u2068${LADDER}\u2069 returned` }),
    ).toBeInTheDocument();
    expect(ladder.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('filters to what was lent out from the URL', async () => {
    await renderApp('/lending?f.direction=out');
    await screen.findByRole('article', { name: DRILL });
    expect(screen.queryByRole('article', { name: LADDER })).toBeNull();
  });
});

describe('the person page', () => {
  it('shows what Murdock has from us and lent us, then what belongs to him', async () => {
    // Murdock joins the registry with the household fixtures (T3's mock seeds them on first use).
    await renderApp(`/people/${H.person.murdock}`, { setup: (mock) => ensureSeeded(mock.state) });
    expect(await screen.findByRole('heading', { name: 'Has from us' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lent to us' })).toBeInTheDocument();
    const has = screen.getByRole('list', { name: 'What Murdock has from us' });
    expect(within(has).getByRole('article', { name: DRILL })).toBeInTheDocument();
    const lent = screen.getByRole('list', { name: 'What Murdock lent us' });
    expect(within(lent).getByRole('article', { name: LADDER })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Belongs to Murdock' })).toBeInTheDocument();
  });
});

describe('the variants', () => {
  it('a viewer sees the loans and no actions', async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.role = 'viewer';
    await renderApp('/lending', { state });
    const drill = within(await screen.findByRole('article', { name: DRILL }));
    expect(drill.queryByRole('button', { name: /returned/ })).toBeNull();
  });

  it('says so when Lending is off everywhere', async () => {
    const state = ownerScenario();
    for (const l of state.locations) {
      l.modules = l.modules.filter((m) => m !== 'lending');
      l.effectiveModules = l.modules;
    }
    await renderApp('/lending', { state });
    expect(await screen.findByText('Lending is off in your locations')).toBeInTheDocument();
  });

  it('reads right to left in Arabic', async () => {
    await renderApp('/lending', { locale: 'ar' });
    await screen.findByRole('article', { name: DRILL });
    expect(document.documentElement.dir).toBe('rtl');
  });
});
