/**
 * Read-only share links (1.5, D233): sharing a box from its page, the link shown once; the
 * location's list with its states, preview and revoke after an in-app confirm; the public page
 * with only the whitelisted fields, and "This link has expired" for a link that no longer opens;
 * and Search's list shared only when narrowed to one location.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { seedShareLink } from '@/api/sharelinks/mock';
import { sharelinkPaths } from '@/api/sharelinks/paths';
import type { ShareLinkRow } from '@/api/sharelinks/types';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const BOX = INV_IDS.thing.box3;
const TOKEN = 'tokSeedLink0000000000000000000000000000000';

function link(over: Partial<ShareLinkRow> = {}): ShareLinkRow {
  return {
    id: '01926f00-0000-7000-8000-0000000051a1',
    locationId: IDS.home,
    scope: 'thing',
    subject: { id: BOX, name: 'Box 3', isUnplaced: false },
    title: null,
    view: null,
    state: 'active',
    expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    revokedAt: null,
    createdAt: new Date().toISOString(),
    createdBy: { id: IDS.ibrahim, displayName: 'Ibrahim' },
    views: 3,
    lastViewedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...over,
  };
}

describe('Share a box', () => {
  it('makes a link from the box, shows it once, and lists it', async () => {
    const { user, mock } = await renderApp(`/t/${BOX}?sheet=share`);
    const sheet = within(await screen.findByRole('dialog', { name: 'Share a read-only link' }));
    expect(sheet.getByText(/Never prices, serial numbers, secrets/)).toBeInTheDocument();
    await user.click(sheet.getByRole('radio', { name: 'A week' }));
    await user.click(sheet.getByRole('button', { name: 'Make link' }));
    expect(mock.lastCall('POST', sharelinkPaths.links(IDS.home))?.body).toEqual({
      thingId: BOX,
      expiresInDays: 7,
    });
    const url = await sheet.findByText(/^http:\/\/kept\.test\/s\//);
    expect(sheet.getByText(/Kept shows this link once/)).toBeInTheDocument();
    expect(sheet.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    await user.click(sheet.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText(url.textContent ?? '')).toBeNull());
    expectLogicalOnly();
  });
});

describe('Location settings → Share links', () => {
  it('lists the links with their state, previews one, and revokes after asking', async () => {
    const state = ownerScenario();
    seedShareLink(state, link(), TOKEN);
    seedShareLink(
      state,
      link({
        id: '01926f00-0000-7000-8000-0000000051a2',
        scope: 'view',
        subject: null,
        title: 'Winter things',
        view: { q: 'winter' },
        state: 'expired',
        views: 0,
        lastViewedAt: null,
      }),
      'tokOther000000000000000000000000000000000x',
    );
    const confirm = vi.spyOn(window, 'confirm');
    const { user, mock } = await renderApp(`/settings/location/${IDS.home}/share-links`, {
      state,
    });
    await findHeading('Share links');
    expect(screen.getByRole('link', { name: 'Share links' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('link', { name: 'Box 3' })).toBeInTheDocument();
    expect(screen.getByText('Winter things')).toBeInTheDocument();
    expect(screen.getByText('Opened 3 times')).toBeInTheDocument();
    expect(screen.getByText('Not opened yet')).toBeInTheDocument();

    // Preview as recipient: the box's contents, whitelisted fields only.
    const [firstPreview] = screen.getAllByRole('button', { name: 'Preview as recipient' });
    await user.click(firstPreview as HTMLElement);
    const preview = within(await screen.findByRole('dialog', { name: 'Preview as recipient' }));
    expect(await preview.findByText('Winter scarves')).toBeInTheDocument();
    expect(preview.getByText('Christmas lights')).toBeInTheDocument();
    expect(preview.queryByText('Peter')).toBeNull();
    await user.click(preview.getByRole('button', { name: 'Done' }));

    // Revoke: an in-app confirm, never window.confirm.
    const [revoke] = screen.getAllByRole('button', { name: 'Revoke' });
    await user.click(revoke as HTMLElement);
    const dialog = within(await screen.findByRole('alertdialog'));
    await user.click(dialog.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Link revoked')).toBeInTheDocument();
    expect(mock.calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expectLogicalOnly();
  });
});

describe('The public page', () => {
  it('shows what was shared with no account, and only the whitelist', async () => {
    const state = ownerScenario();
    state.signedIn = false;
    seedShareLink(state, link(), TOKEN);
    await renderApp(`/s/${TOKEN}`, { state });
    await findHeading('Box 3');
    expect(await screen.findByText('Winter scarves')).toBeInTheDocument();
    expect(screen.getByText('Christmas lights')).toBeInTheDocument();
    expect(screen.getByText(/Shared from Kept/)).toBeInTheDocument();
    expect(screen.getByText(/This link works until/)).toBeInTheDocument();
    // Never who a thing belongs to, and no sign-in wall.
    expect(screen.queryByText('Peter')).toBeNull();
    expect(screen.queryByText('Alfred')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull();
    expectLogicalOnly();
  });

  it('says "This link has expired" for a link that no longer opens', async () => {
    const state = ownerScenario();
    state.signedIn = false;
    seedShareLink(state, link({ state: 'revoked', revokedAt: new Date().toISOString() }), TOKEN);
    await renderApp(`/s/${TOKEN}`, { state });
    await findHeading('This link has expired');
    expect(screen.getByText('Ask the person who shared it for a new one.')).toBeInTheDocument();
  });
});

describe('Search → Share this list', () => {
  it('asks for one location first, then shares the words and filters', async () => {
    await renderApp('/search?q=winter');
    const share = await screen.findByRole('button', { name: 'Share this list' });
    expect(share).toBeDisabled();
    expect(
      screen.getByText('Filter it to one location you run to share this list.'),
    ).toBeInTheDocument();
  });

  it('shares a list narrowed to one location', async () => {
    const { user, mock } = await renderApp(`/search?q=winter&f.location=${IDS.home}`);
    await user.click(await screen.findByRole('button', { name: 'Share this list' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Share a read-only link' }));
    expect(sheet.getByRole('textbox', { name: 'Name on the page' })).toHaveValue('winter');
    await user.click(sheet.getByRole('button', { name: 'Make link' }));
    await sheet.findByText(/^http:\/\/kept\.test\/s\//);
    expect(mock.lastCall('POST', sharelinkPaths.links(IDS.home))?.body).toEqual({
      view: { q: 'winter' },
      title: 'winter',
      expiresInDays: 30,
    });
  });
});
