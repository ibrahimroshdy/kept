/**
 * Exports (step-7 T21; D68, D149, D180): a location exported with its secrets behind a passphrase
 * given twice; a member exports only their own data; an admin is never offered "Include
 * secrets"; mismatched passphrases hold the button with the reason beside the field; Download
 * asks for a fresh link on each click and keeps none in the page; an expired export offers Export
 * again; Settings → Me's "Export my data"; and the owner's delete sheet, with Export first, which
 * refuses a mistyped name.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDS, memberScenario, ownerScenario } from '@/api/mock/fixtures';
import { paths } from '@/api/paths';
import { PORTABILITY_IDS, pt } from '@/api/portability/mock/state';
import { portabilityPaths as p } from '@/api/portability/paths';
import type { CreateExportBody } from '@/api/portability/types';
import { findHeading, pathOf, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => vi.restoreAllMocks());

const E = PORTABILITY_IDS.export;

describe('Settings → Export', () => {
  it('exports a location with its secrets, the passphrase twice', async () => {
    const { user, mock } = await renderApp('/settings/export');
    await user.click(await screen.findByRole('button', { name: 'Export a location' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export a location' });
    await user.click(within(dialog).getByRole('switch', { name: 'Include secrets' }));
    expect(
      within(dialog).getByText(
        "Anyone with this file and the passphrase can read every secret in it. Kept can't recover a forgotten passphrase.",
      ),
    ).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Export Home' });
    await user.type(within(dialog).getByLabelText('Passphrase'), 'a long passphrase');
    await user.type(within(dialog).getByLabelText('The passphrase again'), 'a long passphrasf');
    // The reason sits beside the field, and the button waits.
    expect(within(dialog).getByText('The two passphrases are different.')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('The passphrase again'));
    await user.type(within(dialog).getByLabelText('The passphrase again'), 'a long passphrase');
    expect(submit).toBeEnabled();
    expectLogicalOnly();
    // Secrets leave only once the recovery kit is saved (409), and the sheet says so.
    await user.click(submit);
    expect(
      await within(dialog).findByText(
        'Secrets leave Kept only once the recovery kit is saved. An instance admin saves it from the status page.',
      ),
    ).toBeInTheDocument();
    mock.state.me.instance.recoveryKitAcknowledged = true;
    // One running per location: Home's queued export holds the next one back.
    await user.click(submit);
    expect(
      await within(dialog).findByText('An export of this location is already running.'),
    ).toBeInTheDocument();
    for (const r of pt(mock.state).exports)
      if (r.locationId === IDS.home && (r.status === 'queued' || r.status === 'running'))
        r.status = 'cancelled';
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const body = mock.lastCall('POST', p.exports)?.body as CreateExportBody;
    expect(body).toMatchObject({
      scope: { locationId: IDS.home },
      includeSecrets: true,
      passphrase: 'a long passphrase',
      passphraseAgain: 'a long passphrase',
    });
    // Nothing of the passphrase is kept anywhere the page can be read back from.
    expect(JSON.stringify(localStorage)).not.toContain('passphrase');
    expect(JSON.stringify(sessionStorage)).not.toContain('a long');
  });

  it('never offers an admin "Include secrets"', async () => {
    const state = ownerScenario();
    const garage = state.locations.find((l) => l.id === IDS.garage);
    if (!garage) throw new Error('no Garage');
    garage.role = 'admin';
    const { user } = await renderApp('/settings/export?sheet=location', { state });
    const dialog = await screen.findByRole('dialog', { name: 'Export a location' });
    expect(within(dialog).getByRole('switch', { name: 'Include secrets' })).toBeInTheDocument();
    const picker = within(dialog).getByRole('combobox', { name: 'Location' });
    await user.clear(picker);
    await user.type(picker, 'Gar');
    await user.click(await screen.findByRole('option', { name: 'Garage' }));
    expect(within(dialog).queryByRole('switch', { name: 'Include secrets' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Export Garage' })).toBeEnabled();
  });

  it('a member exports only their own data', async () => {
    const { user, mock } = await renderApp('/settings/export', { state: memberScenario() });
    const mine = await screen.findByRole('button', { name: 'Export my data' });
    expect(screen.queryByRole('button', { name: 'Export a location' })).toBeNull();
    await user.click(mine);
    const dialog = await screen.findByRole('dialog', { name: 'Export my data' });
    expect(within(dialog).queryByRole('switch', { name: 'Include secrets' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Export my data' }));
    await waitFor(() =>
      expect(
        (mock.lastCall('POST', p.exports)?.body as CreateExportBody | undefined)?.scope,
      ).toEqual({
        me: true,
      }),
    );
  });

  it('asks for a fresh link on each Download and keeps none in the page', async () => {
    const { user, mock } = await renderApp('/settings/export');
    const list = await screen.findByRole('list', { name: 'Exports' });
    const download = await within(list).findByRole('button', {
      name: 'Download the export of Home',
    });
    expect(document.querySelector('a[href*="mock-export"]')).toBeNull();
    await user.click(download);
    await waitFor(() => expect(mock.lastCall('GET', p.exportRun(E.done))).toBeDefined());
    await user.click(download);
    await waitFor(() =>
      expect(
        mock.calls.filter((c) => c.method === 'GET' && c.path === p.exportRun(E.done)),
      ).toHaveLength(2),
    );
    expect(document.querySelector('a[href*="mock-export"]')).toBeNull();
    // Expired: Export again opens the sheet; failed: why, with Try again.
    expect(within(list).getByText('Expired')).toBeInTheDocument();
    expect(within(list).getByText(/the server ran out of space/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Export again' }));
    expect(await screen.findByRole('dialog', { name: 'Export my data' })).toBeInTheDocument();
  });

  it('Settings → Me opens Export my data', async () => {
    const { user } = await renderApp('/settings');
    await findHeading('Settings');
    const link = screen
      .getAllByRole('link', { name: 'Export' })
      .find((a) => a.getAttribute('href')?.includes('sheet=me'));
    if (!link) throw new Error('no Export my data link');
    await user.click(link);
    expect(await screen.findByRole('dialog', { name: 'Export my data' })).toBeInTheDocument();
  });
});

describe('deleting a location', () => {
  it('offers Export first, and refuses a mistyped name', async () => {
    const { user, mock, router } = await renderApp(`/settings/location/${IDS.garage}/general`);
    await user.click(await screen.findByRole('button', { name: 'Delete Garage…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Garage?' });
    await user.click(within(dialog).getByRole('button', { name: 'Export first' }));
    await waitFor(() =>
      expect(
        (mock.lastCall('POST', p.exports)?.body as CreateExportBody | undefined)?.scope,
      ).toEqual({
        locationId: IDS.garage,
      }),
    );
    const typed = within(dialog).getByRole('textbox', { name: 'Type Garage to confirm' });
    const remove = within(dialog).getByRole('button', { name: 'Delete Garage' });
    await user.type(typed, 'Garag');
    expect(remove).toBeDisabled();
    expect(within(dialog).getByText("That isn't the location's name.")).toBeInTheDocument();
    expect(mock.lastCall('DELETE', paths.location(IDS.garage))).toBeUndefined();
    await user.type(typed, 'e');
    await user.click(remove);
    await waitFor(() => expect(pathOf(router)).toBe('/'));
    expect(mock.lastCall('DELETE', paths.location(IDS.garage))).toBeDefined();
  });

  it('is the owner’s only', async () => {
    await renderApp(`/settings/location/${IDS.home}/general`, { state: memberScenario() });
    await screen.findAllByRole('heading');
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });
});
