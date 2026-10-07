/**
 * Scan's ways in, through the real route tree (plan T26): a `/l/<code>` link opens what it's on in
 * place of itself (and marks it seen), "Pick up" in a thing's menu fills the carrying tray whose
 * chip then sits in every page header, and a box's menu starts its box check.
 */
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { pageStore } from '@/pwa/page-store';
import { findHeading, pathOf, renderApp } from '../app';

const T = INV_IDS.thing;

describe('scan entry points', () => {
  it('/l/<code> opens the box it is on, leading with its photos, and marks it seen', async () => {
    const { router, mock } = await renderApp('/l/b0x3qf');
    await waitFor(() => expect(pathOf(router)).toBe(`/t/${T.cableBox}`));
    expect(router.state.location.search).toMatchObject({ view: 'photos' });
    await waitFor(() =>
      expect(mock.lastCall('POST', `/api/v1/things/${T.cableBox}/seen`)).toBeTruthy(),
    );
    // Back goes where the person came from, not to the label page again.
    expect(router.history.canGoBack()).toBe(false);
  });

  it('/l/<code> opens a thing that is not a box plainly, without view=photos (UI audit L10)', async () => {
    const { router } = await renderApp('/l/7kq4mz');
    await waitFor(() => expect(pathOf(router)).toBe(`/t/${T.hdmiCable}`));
    expect(router.state.location.search).not.toHaveProperty('view');
  });

  it('"Pick up" fills the tray, and "Carrying 1" opens it from any header', async () => {
    await pageStore().setTray([]);
    const { user, router } = await renderApp(`/t/${T.tv}`);
    await findHeading('Samsung TV, 55″');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pick up' }));
    expect(await screen.findByText('Picked up Samsung TV, 55″')).toBeInTheDocument();
    const chip = await screen.findByRole('link', { name: 'Carrying 1' });
    expect(await pageStore().tray()).toEqual([T.tv]);
    await user.click(chip);
    await waitFor(() => expect(pathOf(router)).toBe('/scan'));
    expect(router.state.location.search).toEqual({ tray: 1 });
    await pageStore().setTray([]);
  });

  it('a box offers Box check, which opens its checklist', async () => {
    const { user, router } = await renderApp(`/t/${T.cableBox}`);
    await findHeading('Cable box');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Box check' }));
    await waitFor(() => expect(pathOf(router)).toBe(`/box-check/${T.cableBox}`));
    expect(await screen.findByText('Box check · in progress')).toBeInTheDocument();
  });
});
