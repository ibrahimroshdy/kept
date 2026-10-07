/**
 * The phone's bottom chrome (found on the maintainer's iPhone): the tab bar with its Capture
 * button raised 24 px above it, and the home indicator. What scrolls must end clear of all three.
 * The geometry itself is checked in Chromium's iPhone emulation (the phone pass); this holds the
 * classes that make it.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { findHeading, renderApp } from '@/test/app';

describe("the phone's bottom edge", () => {
  it('pads every page past the raised Capture button and the safe area', async () => {
    await renderApp('/inbox');
    await findHeading('Inbox');
    const body = document.querySelector('[data-slot="page-body"]');
    expect(body?.className).toContain('pb-[calc(6rem+env(safe-area-inset-bottom))]');
    expect(body?.className).toContain('md:pb-10');
    // The tab bar is what the bottom strip (iOS Liquid Glass) looks for.
    const bar = screen
      .getAllByRole('navigation', { name: 'Main' })
      .find((n) => n.hasAttribute('data-tab-bar'));
    expect(bar).toBeDefined();
  });
});
