import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { SetupCodeHelp, storedWay } from './setup-code-help';

const KEY = 'kept.setup.codeHelp';

afterEach(() => localStorage.removeItem(KEY));

function stubClipboard() {
  // After user-event's setup, which installs a clipboard of its own.
  const writeText = vi.fn(async (_: string) => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}

describe('SetupCodeHelp', () => {
  it('opens on Docker Compose with a command that greps for the printed line', async () => {
    await renderUI(<SetupCodeHelp />);
    expect(screen.getByRole('heading', { name: 'Where to find it' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'How this server runs' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Docker Compose',
      'Docker',
      'Kubernetes',
      'New code',
    ]);
    expect(screen.getByRole('tab', { name: 'Docker Compose' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('docker compose logs kept | grep "KEPT SETUP CODE"');
    expect(screen.getByRole('link', { name: 'Install guide' })).toHaveAttribute(
      'href',
      'https://ibrahimroshdy.com/kept/install/compose/',
    );
  });

  it('switches tabs, marks placeholders and remembers the choice', async () => {
    const { user } = await renderUI(<SetupCodeHelp />);
    await user.click(screen.getByRole('tab', { name: 'Kubernetes' }));
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent(
      'kubectl -n <namespace> logs deploy/<deployment> | grep "KEPT SETUP CODE"',
    );
    expect([...panel.querySelectorAll('var[data-placeholder]')].map((v) => v.textContent)).toEqual([
      '<namespace>',
      '<deployment>',
    ]);
    expect(panel).toHaveTextContent('--previous');
    expect(screen.getByRole('link', { name: 'Install guide' })).toHaveAttribute(
      'href',
      'https://ibrahimroshdy.com/kept/install/kubernetes/',
    );
    expect(localStorage.getItem(KEY)).toBe('kubernetes');
    expect(storedWay()).toBe('kubernetes');
  });

  it('opens on the remembered tab, and ignores a stored value it does not know', async () => {
    localStorage.setItem(KEY, 'cli');
    const { unmount } = await renderUI(<SetupCodeHelp />);
    expect(screen.getByRole('tab', { name: 'New code' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent(
      'docker compose run --rm migrate admin setup-code',
    );
    unmount();
    localStorage.setItem(KEY, 'podman');
    expect(storedWay()).toBe('compose');
  });

  it('gives the compact controls hit areas of at least 44 px', async () => {
    await renderUI(<SetupCodeHelp />);
    // jsdom has no layout: check the overhanging ::before that makes each hit area
    // (tabs 28 + 2 × 10 px, the copy button 28 + 2 × 10 px).
    for (const tab of screen.getAllByRole('tab'))
      expect(tab.className).toMatch(/before:-inset-y-2\.5/);
    expect(screen.getByRole('button', { name: 'Copy' }).className).toMatch(
      /before:-inset-2\.5(\s|$)/,
    );
  });

  it('copies the command exactly, placeholders included', async () => {
    const { user } = await renderUI(<SetupCodeHelp />);
    await user.click(screen.getByRole('tab', { name: 'Docker' }));
    const writeText = stubClipboard();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'docker logs <container> 2>&1 | grep "KEPT SETUP CODE"',
      ),
    );
  });

  it('moves with the arrow keys in reading order, mirrored in Arabic', async () => {
    const { user } = await renderUI(<SetupCodeHelp />, { locale: 'ar' });
    expect(document.documentElement.dir).toBe('rtl');
    await user.tab();
    expect(screen.getAllByRole('tab')[0]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    const tabs = screen.getAllByRole('tab');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    // Commands stay left to right inside the Arabic page.
    expect(screen.getByRole('tabpanel').querySelector('code')).toHaveAttribute('dir', 'ltr');
    expectLogicalOnly();
  });

  it('moves with ArrowRight in English', async () => {
    const { user } = await renderUI(<SetupCodeHelp />);
    await user.tab();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Kubernetes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
