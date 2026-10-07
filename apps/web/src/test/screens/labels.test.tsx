/**
 * The labels screens (plan T28; D43, D44, D137, D175, D185; screens §6): the labels screen, the
 * batch builder with its stock and start cell, the print view's sheets, "Printed OK?" with the
 * first-print hint, Arabic names on labels, codes kept left to right, and a location with the
 * module off.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LabelBatch } from '@/api/capture/types';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { expectLogicalOnly } from '@/test/render';
import { findHeading, pathOf, renderApp } from '../app';

const T = INV_IDS.thing;

afterEach(() => vi.restoreAllMocks());

describe('the labels screen', () => {
  it('offers each location its unprinted labels and a blank sheet, and lists recent batches', async () => {
    await renderApp('/labels');
    expect(await findHeading('Labels')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Blank sheet \(24\)/ }).length).toBeGreaterThan(0);
    expect(
      await screen.findAllByRole('link', { name: /Label everything unprinted/ }),
    ).not.toHaveLength(0);
    expect(await screen.findByRole('heading', { name: 'Recent batches' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByText('Coming soon')).toBeNull();
  });

  it('a location with Labels off says so, with Turn on for its admin', async () => {
    const state = ownerScenario();
    state.locations = state.locations.map((l) =>
      l.id === IDS.garage ? { ...l, modules: [], effectiveModules: [] } : l,
    );
    await renderApp(`/labels?loc=${IDS.garage}&blank=24`, { state });
    expect(await screen.findByText('Off in this location')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Turn on' })).toHaveAttribute(
      'href',
      `/settings/location/${IDS.garage}/track`,
    );
    expect(screen.queryByRole('button', { name: /^Print/ })).toBeNull();
  });
});

describe('the batch builder', () => {
  it('prints a selection from start cell 20, then asks "Printed OK?" and shows the first-print hint', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const { user, router } = await renderApp(
      `/labels?loc=${IDS.home}&things=${T.hdmiCable},${T.box3},${T.draft}`,
    );
    expect(await findHeading('Print labels')).toBeInTheDocument();
    // What prints is the server's dry run: the draft has no ID yet, so it's left out.
    expect(await screen.findByRole('img', { name: '7KQ4MZ' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'B0X3AA' })).toBeInTheDocument();
    expect(screen.getByText('1 thing was left out: its ID is still pending.')).toBeInTheDocument();

    expect(screen.getByRole('radio', { name: /A4 sheet · 24 labels/ })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Label 20, row 7, column 2' }));
    expect(
      screen.getByText('Start at label 20 (row 7, column 2). Tap any cell to start there.'),
    ).toBeInTheDocument();
    expect(screen.getByText('19 already used')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Print 2 labels' }));
    await waitFor(() => expect(pathOf(router)).toMatch(/^\/labels\/[\w-]+$/));
    // The builder's Print opens the print dialog by itself, then asks.
    const ask = await screen.findByRole('dialog', { name: 'Printed OK?' });
    expect(print).toHaveBeenCalledTimes(1);
    const sheet = screen.getByRole('region', { name: 'Sheet 1 of 1', hidden: true });
    expect(sheet.querySelector('[data-cell="20"]')).not.toBeNull();
    expect(sheet.querySelector('[data-cell="21"]')).not.toBeNull();
    expect(sheet.querySelectorAll('[data-slot="label"]')).toHaveLength(2);
    // No app shell around the paper.
    expect(screen.queryByRole('navigation', { name: 'Main', hidden: true })).toBeNull();

    await user.click(within(ask).getByRole('button', { name: 'Yes, printed OK' }));
    const tip = await screen.findByRole('dialog', { name: 'Now stick one on and scan it' });
    await user.click(within(tip).getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/^Printed on /)).toBeInTheDocument();
  });

  it('a batch with nothing left to label since the preview says why (T16: 400 with excluded)', async () => {
    const state = ownerScenario();
    const { user } = await renderApp(`/labels?loc=${IDS.home}&things=${T.hdmiCable},${T.draft}`, {
      state,
    });
    expect(await screen.findByRole('img', { name: '7KQ4MZ' })).toBeInTheDocument();
    // Trashed on another phone after the preview.
    const cable = state.inventory.things.find((x) => x.id === T.hdmiCable);
    if (!cable) throw new Error('no cable');
    cable.deletedAt = new Date().toISOString();
    await user.click(screen.getByRole('button', { name: 'Print 1 label' }));
    expect(await screen.findByText('Nothing here can be labelled now')).toBeInTheDocument();
    expect(screen.getByText('1 is waiting to sync: its ID is still pending.')).toBeInTheDocument();
    expect(
      screen.getByText("1 can't be labelled here: it is in the trash or in another location."),
    ).toBeInTheDocument();
    // The list is read again, as it is now.
    await waitFor(() => expect(screen.queryByRole('img', { name: '7KQ4MZ' })).toBeNull());
  });

  it('a roll has no start cell, and a blank sheet counts its labels', async () => {
    const { user } = await renderApp(`/labels?loc=${IDS.home}&blank=24`);
    expect(await findHeading('Print labels')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Print 24 labels' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: 'Print 34 labels' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /40 × 30 mm roll/ }));
    expect(screen.queryByRole('radio', { name: /^Label 1,/ })).toBeNull();
    expect(screen.getByText('Label preview')).toBeInTheDocument();
  });
});

describe('where printing starts', () => {
  it("a place's page prints its label, and everything unprinted inside it", async () => {
    const { user, router } = await renderApp(`/p/${INV_IDS.place.office}`);
    await findHeading('Office');
    await user.click(screen.getByRole('button', { name: /^Print its label/ }));
    await waitFor(() => expect(pathOf(router)).toBe('/labels'));
    expect(router.state.location.search).toMatchObject({
      loc: IDS.home,
      places: INV_IDS.place.office,
    });
    expect(await screen.findByRole('img', { name: 'R00M4K' })).toBeInTheDocument();
  });

  it("a thing's Label sheet opens the builder for that thing", async () => {
    const { user, router } = await renderApp(`/t/${T.box3}`);
    await findHeading('Box 3');
    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Label/ }));
    await user.click(await screen.findByRole('link', { name: 'Print its label' }));
    await waitFor(() => expect(pathOf(router)).toBe('/labels'));
    expect(router.state.location.search).toMatchObject({ loc: IDS.home, things: T.box3 });
  });
});

describe('the print view', () => {
  const batch = (over: Partial<LabelBatch> = {}): LabelBatch => ({
    id: '01926f00-0000-7000-8000-000000100099',
    locationId: IDS.family,
    kind: 'things',
    stock: 'thermal_50x30',
    startCell: 1,
    createdAt: '2026-10-06T08:00:00Z',
    printedConfirmedAt: null,
    labels: [
      {
        code: 'AR7HDM',
        url: 'https://kept.example/l/AR7HDM',
        kind: 'thing',
        name: 'كابل HDMI',
        path: 'غرفة المعيشة',
        targetId: T.arHdmi,
      },
    ],
    ...over,
  });

  it('keeps an Arabic name in its own direction and the code left to right, in Arabic', async () => {
    const state = ownerScenario();
    state.capture.labelBatches.unshift(batch());
    await renderApp('/labels/01926f00-0000-7000-8000-000000100099', { state, locale: 'ar' });
    const sheet = await screen.findByRole('region', { name: 'الورقة ١ من ١' });
    const name = within(sheet).getByText('كابل HDMI');
    expect(name).toHaveAttribute('dir', 'auto');
    const code = within(sheet).getByText('AR7‑HDM');
    expect(code.tagName).toBe('BDI');
    expect(code).toHaveAttribute('dir', 'ltr');
    // The paper is laid out left to right like the maker's sheet, whatever the page's direction.
    expect(sheet).toHaveAttribute('dir', 'ltr');
    expectLogicalOnly();
  });

  it('puts the title on its own row on a phone, the actions under it, Print first', async () => {
    const state = ownerScenario();
    state.capture.labelBatches.unshift(batch());
    await renderApp('/labels/01926f00-0000-7000-8000-000000100099', { state });
    const title = await screen.findByRole('heading', { level: 1, name: '1 label' });
    const actions = document.querySelector('[data-slot="label-actions"]') as HTMLElement;
    // Not in the title's row: the actions are a sibling of the row holding the back link.
    expect(actions.contains(title)).toBe(false);
    expect(title.closest('div.flex')?.contains(actions)).toBe(false);
    expect(
      within(actions)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Print', 'Share as images']);
    expect(actions).toHaveClass('grid-cols-2', 'md:flex-row-reverse');
    expect(screen.getByRole('link', { name: 'Back to labels' })).toBeInTheDocument();
  });

  it('on a compact stock prints only the QR and the code', async () => {
    const state = ownerScenario();
    state.capture.labelBatches.unshift(batch({ stock: 'a4_65_38x21', startCell: 3 }));
    await renderApp('/labels/01926f00-0000-7000-8000-000000100099', { state });
    const sheet = await screen.findByRole('region', { name: 'Sheet 1 of 1' });
    expect(within(sheet).getByText('AR7‑HDM')).toBeInTheDocument();
    expect(within(sheet).queryByText('كابل HDMI')).toBeNull();
    expect(sheet.querySelector('[data-cell="3"]')).not.toBeNull();
  });
});
