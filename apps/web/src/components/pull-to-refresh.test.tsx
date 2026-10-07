/**
 * Pull to refresh (D212): it must never cost a tap. Synthetic touches, as the lesson from another
 * of the maintainer's apps says to test it: a `touchmove` whose default is prevented is a tap the phone never delivers.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/app';
import {
  ARM_PX,
  attachPull,
  modalOpen,
  type PullOptions,
  pullsOn,
  saidAfter,
} from './pull-to-refresh';

function touch(target: Element, type: string, x: number, y: number, fingers = 1): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const touches =
    type === 'touchend' ? [] : Array.from({ length: fingers }, () => ({ clientX: x, clientY: y }));
  Object.defineProperty(e, 'touches', { value: touches });
  target.dispatchEvent(e);
  return e;
}

function page(over: Partial<PullOptions> = {}) {
  const main = document.createElement('main');
  main.innerHTML = `
    <header><h1>Home</h1></header>
    <ul><li><button type="button" data-row>Cordless drill</button></li></ul>
    <nav data-tab-bar><a href="/search">Search</a></nav>`;
  document.body.append(main);
  const opts = {
    canArm: () => true,
    scrollTop: () => 0,
    onPull: vi.fn(),
    onRelease: vi.fn(),
    ...over,
  };
  const detach = attachPull(main, opts);
  const row = main.querySelector('[data-row]') as HTMLElement;
  return { main, row, opts, detach };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the pull gesture', () => {
  it('a 20 px pull down at the top, then letting go, refreshes', () => {
    const { row, opts } = page();
    touch(row, 'touchstart', 100, 100);
    const move = touch(row, 'touchmove', 100, 120);
    expect(move.defaultPrevented).toBe(true);
    expect(opts.onPull).toHaveBeenCalled();
    touch(row, 'touchend', 100, 120);
    expect(opts.onRelease).toHaveBeenLastCalledWith(true);
  });

  it('a long pull refreshes too', () => {
    const { row, opts } = page();
    touch(row, 'touchstart', 100, 100);
    touch(row, 'touchmove', 100, 260);
    touch(row, 'touchend', 100, 260);
    expect(opts.onRelease).toHaveBeenLastCalledWith(true);
  });

  it('pushing back above 16 px before letting go calls it off', () => {
    const { row, opts } = page();
    touch(row, 'touchstart', 100, 100);
    touch(row, 'touchmove', 100, 130);
    touch(row, 'touchmove', 100, 105);
    touch(row, 'touchend', 100, 105);
    expect(opts.onRelease).toHaveBeenLastCalledWith(false);
  });

  it('a 6 px wobble then a lift is a tap: nothing prevented, and the row gets its click', () => {
    const { row, opts } = page();
    const clicked = vi.fn();
    row.addEventListener('click', clicked);
    const start = touch(row, 'touchstart', 100, 100);
    const wobble = touch(row, 'touchmove', 103, 106);
    const end = touch(row, 'touchend', 103, 106);
    expect([start, wobble, end].map((e) => e.defaultPrevented)).toEqual([false, false, false]);
    expect(opts.onPull).not.toHaveBeenCalled();
    expect(opts.onRelease).not.toHaveBeenCalled();
    row.click();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(ARM_PX).toBe(16);
  });

  it('never arms on the tab bar or the header', () => {
    const { main, opts } = page();
    for (const el of [
      main.querySelector('[data-tab-bar] a') as Element,
      main.querySelector('h1') as Element,
    ]) {
      touch(el, 'touchstart', 100, 100);
      const move = touch(el, 'touchmove', 100, 180);
      expect(move.defaultPrevented).toBe(false);
      touch(el, 'touchend', 100, 180);
    }
    expect(opts.onPull).not.toHaveBeenCalled();
  });

  it('a mostly sideways move never arms, even when it later goes down', () => {
    const { row, opts } = page();
    touch(row, 'touchstart', 100, 100);
    expect(touch(row, 'touchmove', 130, 110).defaultPrevented).toBe(false);
    expect(touch(row, 'touchmove', 130, 200).defaultPrevented).toBe(false);
    expect(opts.onPull).not.toHaveBeenCalled();
  });

  it('never arms scrolled down, with two fingers, or while a sheet is open', () => {
    for (const over of [{ scrollTop: () => 120 }, { canArm: () => false }]) {
      const { row, opts, detach } = page(over);
      touch(row, 'touchstart', 100, 100);
      expect(touch(row, 'touchmove', 100, 200).defaultPrevented).toBe(false);
      expect(opts.onPull).not.toHaveBeenCalled();
      detach();
    }
    const { row, opts } = page();
    touch(row, 'touchstart', 100, 100, 2);
    expect(touch(row, 'touchmove', 100, 200, 2).defaultPrevented).toBe(false);
    expect(opts.onPull).not.toHaveBeenCalled();
  });

  it('counts a sheet, a dialog, a menu and any open popover as modal, but not a list on the page', () => {
    const el = document.createElement('div');
    document.body.append(el);
    el.innerHTML = '<ul role="listbox"><li role="option">Cordless drill</li></ul>';
    expect(modalOpen()).toBe(false);
    for (const open of [
      '<div role="dialog"></div>',
      '<div role="alertdialog"></div>',
      '<div role="menu"></div>',
      // React Aria's non-modal popover (a combobox's list): no dialog role, only data-trigger.
      '<div data-trigger="ComboBox" data-placement="bottom"><div role="listbox"></div></div>',
    ]) {
      el.innerHTML = open;
      expect(modalOpen()).toBe(true);
    }
  });

  it('says Updated only when the sync went through', () => {
    expect(saidAfter(null, true)).toBe('updated');
    expect(saidAfter(null, false)).toBe('offline');
    expect(saidAfter('offline', true)).toBe('offline');
    for (const p of ['server', 'client_outdated', 'server_outdated', 'storage_full'] as const)
      expect(saidAfter(p, true)).toBe('failed');
  });

  it('pulls on the scrolling screens of D212 only', () => {
    for (const p of ['/', '/search', '/inbox', '/loc/x', '/p/x', '/t/AB3DEF', '/activity'])
      expect(pullsOn(p)).toBe(true);
    // Step 4 (plan T27).
    for (const p of [
      '/schedules',
      '/lending',
      '/paperwork',
      '/expiring',
      '/notifications',
      '/incidents',
      '/incidents/x',
      // Step 5 (plan T3).
      '/vehicles',
    ])
      expect(pullsOn(p)).toBe(true);
    for (const p of ['/capture', '/scan', '/settings/ai', '/labels/x', '/more'])
      expect(pullsOn(p)).toBe(false);
  });
});

describe('pull to refresh on a phone screen', () => {
  it('refetches what Home shows and says "Updated"', async () => {
    const { mock } = await renderApp('/');
    const main = await screen.findByRole('main');
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-pull'));
    const from = await waitFor(() => {
      const body = main.querySelector('[data-slot="page-body"]');
      if (!body) throw new Error('no page body yet');
      return body as HTMLElement;
    });
    const before = mock.calls.length;
    touch(from, 'touchstart', 100, 100);
    touch(from, 'touchmove', 100, 200);
    touch(from, 'touchmove', 100, 300);
    touch(from, 'touchend', 100, 300);
    expect(await screen.findByText('Updated')).toBeInTheDocument();
    expect(mock.calls.length).toBeGreaterThan(before);
  });

  // D212 on step 4's screens (plan T27): the same pull, the same "Updated", no tap lost.
  it.each(['/paperwork', '/expiring', '/notifications', '/incidents'])(
    'refetches what %s shows and says "Updated"',
    async (path) => {
      const { mock } = await renderApp(path);
      const main = await screen.findByRole('main');
      await waitFor(() => expect(document.documentElement).toHaveAttribute('data-pull'));
      const from = await waitFor(() => {
        const body = main.querySelector('[data-slot="page-body"]');
        if (!body) throw new Error('no page body yet');
        return body as HTMLElement;
      });
      const before = mock.calls.length;
      touch(from, 'touchstart', 100, 100);
      touch(from, 'touchmove', 100, 200);
      touch(from, 'touchmove', 100, 300);
      touch(from, 'touchend', 100, 300);
      expect(await screen.findByText('Updated')).toBeInTheDocument();
      expect(mock.calls.length).toBeGreaterThan(before);
    },
  );

  it('with reduced motion, the indicator stands still and does not spin', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === '(prefers-reduced-motion: reduce)',
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    await renderApp('/');
    const main = await screen.findByRole('main');
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-pull'));
    const from = await waitFor(() => {
      const body = main.querySelector('[data-slot="page-body"]');
      if (!body) throw new Error('no page body yet');
      return body as HTMLElement;
    });
    touch(from, 'touchstart', 100, 100);
    touch(from, 'touchmove', 100, 250);
    const pulling = await waitFor(() => {
      const el = document.querySelector('[data-pull-indicator]');
      if (!el) throw new Error('no indicator yet');
      return el as HTMLElement;
    });
    expect(pulling.style.transform).toBe('');
    expect((pulling.querySelector('svg') as SVGElement).style.transform).toBe('');
    act(() => {
      touch(from, 'touchend', 100, 250);
    });
    const spinner = document.querySelector('[data-pull-indicator] [role="status"] svg');
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute('class') ?? '').not.toMatch(/animate-spin/);
    expect(await screen.findByText('Updated')).toBeInTheDocument();
  });

  it('is off with a mouse', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === '(hover: hover) and (pointer: fine)',
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    await renderApp('/');
    await screen.findAllByRole('navigation', { name: 'Main' });
    expect(document.documentElement).not.toHaveAttribute('data-pull');
  });
});
