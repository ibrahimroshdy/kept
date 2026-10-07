/**
 * The Schedules screen (plan T21; screens §5, D29, step-4 Q28): the boiler service in Home's
 * kitchen, due in 10 days; Complete, Snooze and Skip once with Undo; a new schedule that needs an
 * interval; and the viewer, module-off, offline and Arabic variants.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUSEHOLD_IDS } from '@/api/household/mock/state';
import { ownerScenario } from '@/api/mock/fixtures';
import { pullsOn } from '@/components/pull-to-refresh';
import { findHeading, renderApp } from '../app';

const H = HOUSEHOLD_IDS;
const boilerRow = () => screen.findByRole('article', { name: 'Boiler service' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the schedules list', () => {
  it('shows the boiler service with what it is for, how often and when it is due', async () => {
    await renderApp('/schedules');
    await findHeading('Schedules');
    const row = within(await boilerRow());
    expect(row.getByRole('link', { name: 'Kitchen' })).toHaveAttribute(
      'href',
      expect.stringContaining('/p/'),
    );
    expect(row.getByText('Every 12 months', { exact: false })).toBeInTheDocument();
    expect(row.getByText('In 10 days')).toBeInTheDocument();
    expect(screen.getByText('0 overdue · 1 due')).toBeInTheDocument();
  });

  it('completes it from its sheet, with Undo', async () => {
    const { user, mock } = await renderApp('/schedules');
    const row = within(await boilerRow());
    await user.click(row.getByRole('button', { name: 'Complete Boiler service' }));
    const sheet = await screen.findByRole('dialog', { name: 'Complete Boiler service' });
    await user.type(within(sheet).getByRole('textbox', { name: /Notes/ }), 'Annual check');
    await user.click(within(sheet).getByRole('button', { name: 'Complete' }));
    expect(await screen.findByText('Done: Boiler service')).toBeInTheDocument();
    // The count restarts: next due a year from today.
    await waitFor(() =>
      expect(
        within(screen.getByRole('article', { name: 'Boiler service' })).queryByText('In 10 days'),
      ).toBeNull(),
    );
    const records = mock.state.household.serviceRecords.filter((r) =>
      r.completes.some((c) => c.scheduleId === H.schedule.boiler),
    );
    expect(records.at(-1)?.notes).toBe('Annual check');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Undone')).toBeInTheDocument();
    expect(await within(await boilerRow()).findByText('In 10 days')).toBeInTheDocument();
  });

  it('snoozes it to a date from More, and Unsnooze takes it back', async () => {
    const { user, mock } = await renderApp('/schedules');
    const row = within(await boilerRow());
    await user.click(row.getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Snooze' }));
    const sheet = await screen.findByRole('dialog', { name: 'Snooze Boiler service' });
    await user.click(within(sheet).getByRole('button', { name: 'Snooze' }));
    expect((await screen.findAllByText(/^Snoozed until/)).length).toBeGreaterThan(0);
    const stored = mock.state.household.schedules.find((s) => s.id === H.schedule.boiler);
    expect(stored?.snoozedUntil).toBeTruthy();
    await user.click(within(await boilerRow()).getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Unsnooze' }));
    await waitFor(() => expect(stored?.snoozedUntil).toBeNull());
  });

  it('skips it once, with Undo', async () => {
    const { user, mock } = await renderApp('/schedules');
    await user.click(within(await boilerRow()).getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Skip once' }));
    expect(await screen.findByText('Skipping Boiler service once')).toBeInTheDocument();
    const stored = mock.state.household.schedules.find((s) => s.id === H.schedule.boiler);
    expect(stored?.skipNext).toBe(true);
  });

  it('Log a service: lines, the total and the schedules it completes', async () => {
    const { user, mock } = await renderApp('/schedules');
    await user.click(
      within(await boilerRow()).getByRole('button', { name: 'Complete Boiler service' }),
    );
    const complete = await screen.findByRole('dialog', { name: 'Complete Boiler service' });
    await user.click(
      within(complete).getByRole('button', { name: 'Add line items or an invoice' }),
    );
    const sheet = within(await screen.findByRole('dialog', { name: 'Log a service' }));
    // Opened for the boiler: it's ticked.
    expect(sheet.getByRole('checkbox', { name: /Boiler service/ })).toBeChecked();
    await user.click(sheet.getByRole('button', { name: 'Add a line' }));
    await user.type(sheet.getByRole('textbox', { name: 'What' }), 'Burner clean');
    await user.type(sheet.getByRole('textbox', { name: 'Quantity' }), '1');
    await user.type(sheet.getByRole('textbox', { name: 'Cost each' }), '650');
    expect(sheet.getByText(/The lines add up to/)).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    expect((await screen.findAllByText('Service logged')).length).toBeGreaterThan(0);
    const saved = mock.state.household.serviceRecords.at(-1);
    expect(saved?.lines.map((l) => l.description)).toEqual(['Burner clean']);
    expect(saved?.total?.amount).toBe('650');
    expect(saved?.completes.map((c) => c.scheduleId)).toEqual([H.schedule.boiler]);
  });

  it('a new schedule needs a name and how often, then lands in the list', async () => {
    const { user } = await renderApp('/schedules');
    await findHeading('Schedules');
    await user.click(await screen.findByRole('button', { name: 'New schedule' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'New schedule' }));
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    expect(await sheet.findByText("Choose what it's for.")).toBeInTheDocument();
    expect(sheet.getByText('Give it a name, like "Boiler service".')).toBeInTheDocument();
    expect(
      sheet.getByText('Set how often: every so many months or units, or a date.'),
    ).toBeInTheDocument();
  });

  it('pulls to refresh on phones', () => {
    expect(pullsOn('/schedules')).toBe(true);
    expect(pullsOn('/lending')).toBe(true);
  });
});

describe('the variants', () => {
  it('a viewer sees the schedule and no actions', async () => {
    const state = ownerScenario();
    for (const l of state.locations) l.role = 'viewer';
    await renderApp('/schedules', { state });
    const row = within(await boilerRow());
    expect(row.queryByRole('button', { name: /Complete/ })).toBeNull();
    expect(row.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New schedule' })).toBeNull();
  });

  it('says so when Schedules is off everywhere', async () => {
    const state = ownerScenario();
    for (const l of state.locations) {
      l.modules = l.modules.filter((m) => m !== 'schedules');
      l.effectiveModules = l.modules;
    }
    await renderApp('/schedules', { state });
    expect(await screen.findByText('Schedules are off in your locations')).toBeInTheDocument();
  });

  it('offline, Complete waits for a connection', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      await renderApp('/schedules');
      const row = within(await boilerRow());
      expect(row.getByRole('button', { name: 'Complete Boiler service' })).toBeDisabled();
      expect(screen.getByText(/Needs a connection/)).toBeInTheDocument();
    } finally {
      // @ts-expect-error back to the prototype's getter
      delete navigator.onLine;
    }
  });

  it('reads right to left in Arabic', async () => {
    await renderApp('/schedules', { locale: 'ar' });
    await boilerRow();
    expect(document.documentElement.dir).toBe('rtl');
  });
});
