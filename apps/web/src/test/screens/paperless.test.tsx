/**
 * Paperless-ngx (1.x, D248): Location settings → Paperless (connect, a refused token said in
 * words, the token never shown, the plain-http warning, disconnect after asking), and a thing's
 * Paperwork section (the linked documents, the picker that searches and links, copy and unlink).
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { seedPaperless } from '@/api/paperless/mock';
import { paperlessPaths } from '@/api/paperless/paths';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const PATH = `/settings/location/${IDS.home}/paperless`;
/** A thing in Home (the Bosch drill is in the Garage). */
const TV = INV_IDS.thing.tv;

describe('Location settings → Paperless', () => {
  it('connects; a refused token says why; the token is never shown again', async () => {
    const { user, mock } = await renderApp(PATH);
    await findHeading('Paperless-ngx');
    expect(screen.getByRole('link', { name: 'Paperless' })).toHaveAttribute('aria-current', 'page');
    const url = await screen.findByRole('textbox', { name: /Paperless address/ });
    await user.type(url, 'https://fail.example');
    await user.type(screen.getByLabelText(/^API token/), 'a'.repeat(40));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Paperless refused the token.')).toBeInTheDocument();
    expect(mock.lastCall('PUT', paperlessPaths.connection(IDS.home))?.body).toEqual({
      url: 'https://fail.example',
      token: 'a'.repeat(40),
    });

    await user.clear(url);
    await user.type(url, 'http://192.168.1.20:8000');
    expect(screen.getByText('Plain http')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('heading', { name: 'Change the connection' });
    expect(screen.getByText('Not encrypted')).toBeInTheDocument();
    expect(screen.getByText(/Version 3\.3\.1/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^API token/)).toHaveValue('');
    expect(screen.getByText('Saved. Leave it empty to keep it.')).toBeInTheDocument();
    expectLogicalOnly();
  });

  it('tests the connection, and disconnects after asking, saying the links go too', async () => {
    const state = ownerScenario();
    seedPaperless(state, IDS.home, { links: [{ subject: { thingId: TV }, documentIds: [13] }] });
    const { user, mock } = await renderApp(PATH, { state, digits: 'western' });
    await findHeading('Paperless-ngx');
    expect(await screen.findByText(/1 linked document/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Paperless answers: version 3.3.1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/The 1 links to its documents go too/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(mock.lastCall('DELETE', paperlessPaths.connection(IDS.home))).toBeTruthy(),
    );
    expect(
      await screen.findByRole('heading', { name: 'Connect Paperless-ngx' }),
    ).toBeInTheDocument();
  });

  it('is hidden from a member', async () => {
    const state = ownerScenario();
    const home = state.locations.find((l) => l.id === IDS.home);
    if (home) home.role = 'member';
    await renderApp(PATH, { state });
    expect(await screen.findByText('Only the owner and admins change this')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Paperless' })).toBeNull();
  });
});

describe("a thing's Paperless documents", () => {
  it('shows nothing where the location has no Paperless', async () => {
    await renderApp(`/t/${TV}`);
    await screen.findAllByText(/Paperwork/);
    expect(screen.queryByText('From Paperless-ngx')).toBeNull();
  });

  it('lists the linked ones, links more through the picker, copies one, and unlinks', async () => {
    const state = ownerScenario();
    seedPaperless(state, IDS.home, { links: [{ subject: { thingId: TV }, documentIds: [13] }] });
    const { user, mock } = await renderApp(`/t/${TV}`, { state });
    const block = await screen.findByTestId('paperless-documents');
    const list = within(block).getByRole('list', { name: 'Paperless documents' });
    expect(within(list).getByText('Bosch GSB 18V manual')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Open in Paperless' })).toHaveAttribute(
      'href',
      'https://paperless.example.com/documents/13',
    );

    await user.click(within(block).getByRole('button', { name: 'Link from Paperless' }));
    const dialog = await screen.findByRole('dialog', { name: /Link from Paperless to/ });
    expect(await within(dialog).findByText('Drill warranty card')).toBeInTheDocument();
    // Already linked: ticked and shown as such.
    const manual = within(dialog).getByRole('checkbox', { name: /Bosch GSB 18V manual/ });
    expect(manual).toBeChecked();
    expect(manual).toBeDisabled();
    await user.type(
      within(dialog).getByRole('searchbox', { name: 'Search Paperless' }),
      'warranty',
    );
    await waitFor(() => expect(within(dialog).queryByText('Fridge invoice')).toBeNull());
    await user.click(within(dialog).getByRole('checkbox', { name: /Drill warranty card/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Link 1 document' }));
    await waitFor(() => expect(mock.lastCall('POST', paperlessPaths.links())).toBeTruthy());
    expect(mock.lastCall('POST', paperlessPaths.links())?.body).toEqual({
      thingId: TV,
      documentIds: [14],
    });
    expect(await within(block).findByText('Drill warranty card')).toBeInTheDocument();

    const row = within(block).getByText('Drill warranty card').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Copy into Kept' }));
    expect(await within(row).findByText('Copied into Kept')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Unlink Drill warranty card' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/the copy in Kept stays/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(within(block).queryByText('Drill warranty card')).toBeNull());
    expectLogicalOnly();
  });
});
