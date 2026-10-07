/**
 * First-use hints (D138; plan T31; spike V18) with the real driver.js: shown once per person
 * (the server's `seen` is written when it shows, so a second render doesn't show it), skipped
 * for a module that's off, "Got it" records `dismissed` and puts focus back, one at a time.
 * The RTL placement is driver-kit.test.ts's.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inventoryPaths } from '@/api/inventory/paths';
import { inventoryKeys } from '@/api/inventory/queries';
import type { Hint } from '@/api/inventory/types';
import { keys } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { renderUI } from '@/test/render';
import type { FirstUseHint } from './hint-copy';
import { escapeHtml, physicalAlign, physicalSide } from './placement';
import { hintSlot, useHint } from './use-hint';

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const el of document.querySelectorAll('.driver-hint, .driver-popover')) el.remove();
});

function Probe({ hint }: { hint: FirstUseHint }) {
  const ref = useRef<HTMLButtonElement>(null);
  useHint(hint, ref);
  return (
    <button ref={ref} type="button">
      Target
    </button>
  );
}

function client(hints: Hint[], modules: string[] = ['labels', 'ai_capture']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(inventoryKeys.hints, { hints });
  qc.setQueryData(keys.locations, [{ id: 'home', modules } as unknown as LocationDetail]);
  return qc;
}

async function show(hint: FirstUseHint, qc: QueryClient) {
  return renderUI(
    <QueryClientProvider client={qc}>
      <Probe hint={hint} />
    </QueryClientProvider>,
  );
}

const puts = (key: string) =>
  calls.filter((c) => c.method === 'PUT' && c.url === inventoryPaths.hint(key)).map((c) => c.body);

describe('useHint', () => {
  it('shows once per person: seen is recorded, and a second render shows nothing', async () => {
    const qc = client([]);
    const first = await show('capture.mode_strip', qc);
    expect(
      await screen.findByRole('button', { name: "Pick what you're capturing" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(puts('capture.mode_strip')).toEqual([{ seen: true }]));
    first.unmount();
    expect(document.querySelector('.driver-hint')).toBeNull();
    expect(hintSlot.get()).toBeNull();

    await show('capture.mode_strip', qc);
    // Give a lazy import every chance to show it, then check it didn't.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole('button', { name: "Pick what you're capturing" })).toBeNull();
    expect(puts('capture.mode_strip')).toHaveLength(1);
  });

  it('never shows a hint the server already has', async () => {
    await show(
      'scan.first_open',
      client([{ key: 'scan.first_open', seenAt: '2026-09-01T10:00:00Z', dismissedAt: null }]),
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(document.querySelector('.driver-hint')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is skipped when its module is off in every location (D113)', async () => {
    await show('inbox.suggested', client([], ['labels']));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(document.querySelector('.driver-hint')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('opens from the keyboard, and "Got it" records it and puts focus back', async () => {
    const { user } = await show('labels.first_print', client([]));
    const beacon = await screen.findByRole('button', { name: 'Now stick one on and scan it' });
    beacon.focus();
    await user.keyboard('{Enter}');
    const popover = await screen.findByRole('dialog', { name: 'Now stick one on and scan it' });
    // Never modal: a hint doesn't block the page.
    expect(popover).not.toHaveAttribute('aria-modal', 'true');
    await user.click(within(popover).getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Target' }));
    await waitFor(() =>
      expect(puts('labels.first_print')).toEqual([{ seen: true }, { dismissed: true }]),
    );
    expect(hintSlot.get()).toBeNull();
  });

  it('only one hint at a time', async () => {
    const qc = client([]);
    await renderUI(
      <QueryClientProvider client={qc}>
        <Probe hint="capture.mode_strip" />
        <Probe hint="scan.first_open" />
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: "Pick what you're capturing" });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(document.querySelectorAll('.driver-hint')).toHaveLength(1);
  });
});

describe('placement (spike V18: driver.js is physical)', () => {
  it('swaps start and end, left and right, in RTL only', () => {
    expect(physicalAlign('end', false)).toBe('end');
    expect(physicalAlign('end', true)).toBe('start');
    expect(physicalAlign('start', true)).toBe('end');
    expect(physicalAlign('center', true)).toBe('center');
    expect(physicalSide('start', false)).toBe('left');
    expect(physicalSide('start', true)).toBe('right');
    expect(physicalSide('end', true)).toBe('left');
    expect(physicalSide('top', true)).toBe('top');
  });

  it('escapes what driver.js writes with innerHTML', () => {
    expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe(
      '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;',
    );
  });
});
