import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as files from '@/lib/files';
import { expectLogicalOnly, renderUI } from '@/test/render';
import {
  fetchThingsCsv,
  ListExport,
  listThingIds,
  PRINT_MAX_THINGS,
  scopeOf,
} from './list-export.household';

// "Export view" and "Print" on a things list (step-7 T16, T22; D169).

const HOME = '0199aa00-0000-7000-8000-000000000001';
const TYPE_A = '0199aa00-0000-7000-8000-00000000000a';
const TYPE_B = '0199aa00-0000-7000-8000-00000000000b';
const RUN = '0199aa00-0000-7000-8000-0000000000ff';
const GARAGE = '0199aa00-0000-7000-8000-000000000002';
const ALFRED_HOUSE = '0199aa00-0000-7000-8000-000000000003';

type Call = { url: string; init?: RequestInit };

/** `fetch` answering GET /things with `total` things, 200 a page, and the CSV with a BOM. */
function stubServer(total: number) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      const u = new URL(String(url), 'http://kept.test');
      if (u.pathname === '/api/v1/reports/inventory')
        return Response.json({ id: RUN, status: 'queued', expiresAt: '' }, { status: 202 });
      if (u.pathname.startsWith('/api/v1/reports/'))
        return Response.json({
          id: RUN,
          status: 'queued',
          scope: { locationId: HOME },
          progress: { done: 0, total: 3 },
          createdAt: '2026-09-30T10:00:00Z',
          expiresAt: '2026-10-01T10:00:00Z',
        });
      if (u.pathname === '/api/v1/things.csv')
        return new Response('﻿short_id,name\r\n', {
          headers: { 'content-type': 'text/csv; charset=utf-8' },
        });
      const from = Number(u.searchParams.get('cursor') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 20);
      const items = Array.from({ length: Math.max(0, Math.min(limit, total - from)) }, (_, i) => ({
        id: `thing-${from + i}`,
        locationId: HOME,
      }));
      const next = from + limit < total ? String(from + limit) : null;
      return Response.json({ items, next_cursor: next });
    }),
  );
  return calls;
}

/** Inside a query client, as the app has one (the report's progress polls through it). */
function withQueries(ui: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the list CSV', () => {
  it('asks for exactly the list’s parameters, without paging', async () => {
    const calls = stubServer(0);
    const file = await fetchThingsCsv({
      locationId: HOME,
      typeId: [TYPE_A, TYPE_B],
      not: ['typeId'],
      q: 'مثقاب',
      sort: 'updated',
      dir: 'asc',
      importRunId: TYPE_A,
      limit: 20,
      cursor: 'abc',
    });
    const u = new URL(calls[0]?.url ?? '', 'http://kept.test');
    expect(u.pathname).toBe('/api/v1/things.csv');
    expect([...u.searchParams]).toEqual([
      ['locationId', HOME],
      ['typeId', TYPE_A],
      ['typeId', TYPE_B],
      ['not', 'typeId'],
      ['q', 'مثقاب'],
      ['sort', 'updated'],
      ['dir', 'asc'],
      ['importRunId', TYPE_A],
    ]);
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(file.name).toMatch(/^kept-things-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('reads the list’s ids page by page, stopping one past the limit', async () => {
    const calls = stubServer(5000);
    const ids = await listThingIds({ locationId: HOME }, PRINT_MAX_THINGS);
    expect(ids).toHaveLength(PRINT_MAX_THINGS + 1);
    expect(ids[0]).toEqual({ id: 'thing-0', locationId: HOME });
    expect(calls).toHaveLength(Math.ceil((PRINT_MAX_THINGS + 1) / 200));
    stubServer(3);
    expect(await listThingIds({ locationId: HOME }, PRINT_MAX_THINGS)).toHaveLength(3);
  });
});

describe('the report’s scope', () => {
  const locations = [
    { id: HOME, ownerAccountId: 'acct-ibrahim' },
    { id: GARAGE, ownerAccountId: 'acct-ibrahim' },
    { id: ALFRED_HOUSE, ownerAccountId: 'acct-alfred' },
  ];
  it('is the one location the things are in', () => {
    expect(scopeOf([{ id: 'a', locationId: GARAGE }], locations)).toEqual({ locationId: GARAGE });
  });
  it('is the account when they span its locations (a brand’s things)', () => {
    const rows = [
      { id: 'a', locationId: HOME },
      { id: 'b', locationId: GARAGE },
    ];
    expect(scopeOf(rows, locations)).toEqual({ accountId: 'acct-ibrahim' });
  });
  it('is none across two accounts, or for a location it doesn’t know', () => {
    expect(
      scopeOf(
        [
          { id: 'a', locationId: HOME },
          { id: 'b', locationId: ALFRED_HOUSE },
        ],
        locations,
      ),
    ).toBeNull();
    expect(
      scopeOf(
        [
          { id: 'a', locationId: HOME },
          { id: 'b', locationId: 'elsewhere' },
        ],
        locations,
      ),
    ).toBeNull();
  });
});

describe('ListExport', () => {
  it('saves the list as a CSV, whatever the reader’s role (a viewer exports too)', async () => {
    const calls = stubServer(0);
    vi.spyOn(files, 'downloadsWork').mockReturnValue(true);
    const save = vi.spyOn(files, 'saveFile').mockImplementation(() => undefined);
    const { user } = await renderUI(
      withQueries(<ListExport params={{ locationId: HOME, typeId: TYPE_A }} />),
    );
    await user.click(screen.getByRole('button', { name: 'Export or print this list' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export view/ }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const csv = calls.find((c) => c.url.includes('/api/v1/things.csv'));
    expect(csv?.url).toBe(`/api/v1/things.csv?locationId=${HOME}&typeId=${TYPE_A}`);
  });

  it('is disabled offline, saying why', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await renderUI(withQueries(<ListExport params={{ locationId: HOME }} />));
    const button = screen.getByRole('button', { name: 'Needs a connection' });
    expect(button).toBeDisabled();
  });

  it('won’t print more than 2,000 things, and says to narrow the list', async () => {
    stubServer(2500);
    const { user } = await renderUI(withQueries(<ListExport params={{ locationId: HOME }} />));
    await user.click(screen.getByRole('button', { name: 'Export or print this list' }));
    await user.click(await screen.findByRole('menuitem', { name: /Print/ }));
    await waitFor(() =>
      expect(screen.getByText('Narrow the list to 2,000 things to print it.')).toBeVisible(),
    );
  });

  it('prints exactly the list’s things', async () => {
    const calls = stubServer(3);
    const { user } = await renderUI(withQueries(<ListExport params={{ locationId: HOME }} />));
    await user.click(screen.getByRole('button', { name: 'Export or print this list' }));
    await user.click(await screen.findByRole('menuitem', { name: /Print/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/api/v1/reports/inventory'))).toBe(true),
    );
    const post = calls.find((c) => c.url.endsWith('/api/v1/reports/inventory'));
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      scope: { locationId: HOME },
      filters: { thingIds: ['thing-0', 'thing-1', 'thing-2'], includeEnded: true },
    });
  });

  it('reads right to left in Arabic, with logical sides only', async () => {
    stubServer(0);
    const { user } = await renderUI(withQueries(<ListExport params={{ locationId: HOME }} />), {
      locale: 'ar',
    });
    expect(document.documentElement.dir).toBe('rtl');
    await user.click(screen.getByRole('button'));
    await screen.findAllByRole('menuitem');
    expectLogicalOnly();
  });
});
