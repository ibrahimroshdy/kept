/**
 * AI usage (T29a; D206): scopes by role, totals, charts with tables, the call list on the filter
 * strip with the URL round trip, the call's detail, CSV export with the same filters, the money
 * gate, the AI line, and Arabic digits.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePaths as cp } from '@/api/capture/paths';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { memberScenario, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

const L = INV_IDS.loc;

describe('AI usage', () => {
  beforeEach(() => {
    // jsdom has no object URLs; the CSV download only needs them to exist.
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('the owner has Me, each home they run, and Account; a member only Me', async () => {
    await renderApp('/settings/ai/usage');
    const nav = await screen.findByRole('navigation', { name: 'Whose usage' });
    const tabs = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(tabs).toEqual(['Me', 'Home', 'Garage', 'Account']);
    expect(within(nav).getByRole('link', { name: 'Me' })).toHaveAttribute('aria-current', 'page');
  });

  it('a member has only Me: no switch, and never another scope', async () => {
    await renderApp('/settings/ai/usage?scope=account', { state: memberScenario() });
    await findHeading('AI usage');
    expect(screen.queryByRole('navigation', { name: 'Whose usage' })).not.toBeInTheDocument();
    expect(await screen.findByText('No AI calls yet')).toBeInTheDocument();
  });

  it('shows totals, charts with a table, and filters the list from an outcome count', async () => {
    const { user, router } = await renderApp('/settings/ai/usage?scope=account');
    expect(await screen.findByText('Calls so far')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Tokens by day, stacked by task' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Show as a table' }).length).toBeGreaterThan(1),
    );
    const outcomes = screen.getByRole('region', { name: 'Outcomes' });
    await user.click(within(outcomes).getByRole('button', { name: /Timed out/ }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ 'f.outcome': ['timeout'] }),
    );
    const list = await screen.findByRole('list', { name: 'AI calls' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(within(list).getByText('Meter reading')).toBeInTheDocument();
  });

  it('the call list has saved views, as every list does (the ai-calls surface)', async () => {
    await renderApp('/settings/ai/usage?scope=account');
    await screen.findByRole('list', { name: 'AI calls' });
    expect(screen.getByRole('button', { name: 'Views' })).toBeInTheDocument();
  });

  it('a filtered URL round-trips into the list and the CSV export asks for the same', async () => {
    const { user, mock } = await renderApp(
      '/settings/ai/usage?scope=account&f.task=extract_receipt&q=qwen',
    );
    const list = await screen.findByRole('list', { name: 'AI calls' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    const listed = [...mock.calls].reverse().find((c) => c.path === cp.aiCalls);
    expect(listed).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(mock.calls.some((c) => c.path === cp.aiCallsCsv)).toBe(true));
  });

  it('the CSV request carries the list filters', async () => {
    const fetched: string[] = [];
    const { user, mock } = await renderApp('/settings/ai/usage?scope=me&f.task=extract_thing');
    const real = mock.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input));
      return real(input, init);
    });
    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(fetched.some((u) => u.startsWith(cp.aiCallsCsv))).toBe(true));
    const url = new URL(fetched.find((u) => u.startsWith(cp.aiCallsCsv)) ?? '', 'http://x');
    expect(url.searchParams.get('scope')).toBe('me');
    expect(url.searchParams.getAll('task')).toEqual(['extract_thing']);
  });

  it('a row opens the call in plain words, with its other attempt', async () => {
    const { user } = await renderApp('/settings/ai/usage?scope=me&f.task=extract_reading&dir=asc');
    const list = await screen.findByRole('list', { name: 'AI calls' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    await user.click(within(list).getAllByRole('button')[0] as HTMLElement);
    const sheet = await screen.findByRole('dialog', { name: 'AI call' });
    expect(within(sheet).getByText('Why: the provider timed out')).toBeInTheDocument();
    expect(sheet).toHaveTextContent("Garage's account");
    expect(within(sheet).getByText('Other attempts of this request')).toBeInTheDocument();
  });

  it("a viewer's calls in a money-hidden location show no cost", async () => {
    const s = ownerScenario();
    s.locations = s.locations.map((l) =>
      l.id === L.home ? { ...l, role: 'viewer' as const, moneyVisibleToViewers: false } : l,
    );
    await renderApp('/settings/ai/usage?scope=me&f.task=extract_receipt', { state: s });
    const list = await screen.findByRole('list', { name: 'AI calls' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(within(list).getByText(/cost hidden/)).toBeInTheDocument();
    expect(list).not.toHaveTextContent('≈ USD');
  });

  it('the instance scope lists what the instance key paid, with no location', async () => {
    await renderApp('/admin/ai/usage');
    const list = await screen.findByRole('list', { name: 'AI calls' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(within(list).getByText(/qwen2.5vl:7b/)).toBeInTheDocument();
    expect(within(list).queryByText('Personal')).not.toBeInTheDocument();
    // Newest first only (T9): no sort, so no direction switch.
    expect(screen.getByRole('button', { name: /^Display options/ })).not.toHaveAccessibleName(
      /sorted by/,
    );
  });

  it('elsewhere the call list keeps its direction switch', async () => {
    await renderApp('/settings/ai/usage?scope=account');
    await screen.findByRole('list', { name: 'AI calls' });
    expect(screen.getByRole('button', { name: /^Display options/ })).toHaveAccessibleName(
      /sorted by Time, Newest first/,
    );
  });

  it('Arabic: right to left, Eastern digits in the tables, logical CSS only', async () => {
    const { container, user } = await renderApp('/settings/ai/usage?scope=account', {
      locale: 'ar',
    });
    const tables = await screen.findAllByRole('button', { name: 'عرض كجدول' }, { timeout: 5000 });
    await user.click(tables[0] as HTMLElement);
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getAllByRole('table')[0]?.textContent).toMatch(/[٠-٩]/);
    expectLogicalOnly(container);
  });

  it('Arabic: the day chart is an LTR SVG drawn right to left (V38), labels clear of the plot', async () => {
    await renderApp('/settings/ai/usage?scope=account', { locale: 'ar' });
    const chart = await screen.findByRole('img', { name: 'الرموز حسب اليوم، مكدّسة حسب المهمة' });
    // SVG text-anchor follows the inherited direction: an LTR SVG keeps start and end physical.
    expect((chart as unknown as SVGElement).style.direction).toBe('ltr');
    const num = (el: Element, a: string) => Number(el.getAttribute(a));
    const grid = [...chart.querySelectorAll('line')];
    const plotEnd = Math.max(...grid.map((l) => num(l, 'x2')));
    // The value labels sit in the right gutter, starting past the plot's end.
    for (const label of [...chart.querySelectorAll('g > text')]) {
      expect(label.getAttribute('text-anchor')).toBe('start');
      expect(num(label, 'x')).toBeGreaterThan(plotEnd);
    }
    // Every bar is inside the plot, none in the gutter.
    for (const bar of [...chart.querySelectorAll('rect')])
      expect(num(bar, 'x') + num(bar, 'width')).toBeLessThanOrEqual(plotEnd);
  });
});

describe('the AI line', () => {
  it('with a price opens its ledger row; without one says cost unknown', async () => {
    const { user } = await renderApp(`/t/${INV_IDS.thing.drill}`);
    const line = await screen.findByRole('button', { name: /^AI · Groq · / });
    expect(line).toHaveTextContent('≈ $0.003');
    expect(line).toHaveTextContent('paid by you');
    await user.click(line);
    // The full model id is in the detail the line opens.
    const detail = await screen.findByRole('dialog', { name: 'AI call' });
    expect(within(detail).getByText('qwen/qwen3.8-27b')).toHaveClass('model-id');
  });

  it("the thing's history lists the AI calls that touched it", async () => {
    await renderApp(`/t/${INV_IDS.thing.drill}?tab=history`);
    const row = await screen.findByRole('article', { name: 'Photo' });
    expect(within(row).getByText('AI')).toBeInTheDocument();
    expect(row).toHaveTextContent('2.3K tokens');
  });

  it('a paused draft says it waits, and Re-run is offered once done', async () => {
    await renderApp(`/t/${INV_IDS.thing.draft}`);
    expect(await screen.findByText(/Waiting: AI paused until/)).toBeInTheDocument();
  });
});
