/**
 * The spreadsheet view (D250) on the location page, against the mock server: offered from
 * 1024 px only, edit in place by keyboard behind "Save N changes", one Undo for the save, bulk
 * actions on a selection, a stale row kept staged (D156), viewers read-only, money hidden where
 * the gate hides it, and right to left.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths } from '@/api/inventory/paths';
import { IDS, type MockState, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const DESKTOP = ['(min-width: 768px)', '(min-width: 1024px)'];

/** jsdom has no matchMedia: list the queries that match. */
function media(matching: string[]) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: matching.includes(q),
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  localStorage.clear();
  media(DESKTOP);
});
afterEach(() => vi.unstubAllGlobals());

function asRole(role: 'viewer' | 'member', state: MockState = ownerScenario()) {
  const home = state.locations.find((l) => l.id === IDS.home);
  if (home) home.role = role;
  return state;
}

const T = INV_IDS.thing;
const sheetPath = `/loc/${IDS.home}?view=table`;

async function openSheet(opts: Parameters<typeof renderApp>[1] = {}) {
  const app = await renderApp(sheetPath, opts);
  const grid = await screen.findByRole('grid', { name: /^(Things in Home|.+)$/ });
  await within(grid).findByText('AA batteries');
  return { ...app, grid };
}

/** The cell of a row (by its name) in a column (by its header). */
function cellOf(grid: HTMLElement, rowName: string, header: string): HTMLElement {
  const headers = within(grid).getAllByRole('columnheader');
  const index = headers.findIndex((h) => h.textContent?.startsWith(header));
  const row = within(grid)
    .getAllByRole('row')
    .find((r) => within(r).queryByText(rowName));
  if (!row || index < 0) throw new Error(`no cell ${rowName} / ${header}`);
  return within(row).getAllByRole('gridcell')[index] as HTMLElement;
}

describe('where the sheet is offered', () => {
  it('is the fourth layout on a desktop, and not offered on a phone', async () => {
    await renderApp(`/loc/${IDS.home}`);
    await findHeading('Home');
    const layouts = await screen.findByRole('radiogroup', { name: 'Layout' });
    expect(
      within(layouts)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['List', 'Grid', 'Map', 'Table']);
  });

  it('shows the list on a phone, even with view=table in the address', async () => {
    media([]);
    await renderApp(sheetPath);
    await findHeading('Home');
    expect(await screen.findByRole('list', { name: 'Contents of Home' })).toBeInTheDocument();
    expect(screen.queryByRole('grid')).toBeNull();
    const layouts = screen.getByRole('radiogroup', { name: 'Layout' });
    expect(within(layouts).queryByText('Table')).toBeNull();
  });
});

describe('editing in place', () => {
  it('stages edits by keyboard, saves them row by row and undoes the save together', async () => {
    const { grid, user, mock } = await openSheet();
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      '',
      'Name',
      'Where',
      'Short ID',
      'Type',
      'Brand',
      'Model',
      'Serial number',
      'Quantity',
      'Tags',
      'Bought',
      'Price',
      'Warranty ends',
    ]);

    // Click the kettle's name, Enter to edit, type, Enter: staged, and the cell below is active.
    await user.click(cellOf(grid, 'Old kettle', 'Name'));
    await user.keyboard('{Enter}');
    const input = screen.getByRole('textbox', { name: 'Name: Old kettle' });
    await user.clear(input);
    await user.type(input, 'Kettle{Enter}');
    expect(document.activeElement?.textContent).toMatch(/^Samsung/);
    // Arrow to Model and type over it: typing opens the editor with that key.
    await user.keyboard('{ArrowUp}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    await user.keyboard('W1{Tab}');
    const bar = screen.getByRole('region', { name: 'Changes' });
    expect(bar).toHaveTextContent('2 changes · on 1 thing');

    await user.click(within(bar).getByRole('button', { name: 'Save 2 changes' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull());
    const sent = mock.lastCall('POST', inventoryPaths.thingsBulkEdit);
    expect(sent?.body).toEqual({
      edits: [
        { id: T.kettle, rowVersion: expect.any(Number), set: { name: 'Kettle', model: 'W1' } },
      ],
    });
    expect(cellOf(grid, 'Kettle', 'Model')).toHaveTextContent('W1');

    expect(await screen.findByText('Saved 2 changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mock.lastCall('POST', inventoryPaths.undoTogether)).toBeTruthy());
    const undone = mock.lastCall('POST', inventoryPaths.undoTogether)?.body as {
      eventIds: string[];
    };
    expect(undone.eventIds).toHaveLength(1);
    await waitFor(() => expect(cellOf(grid, 'Old kettle', 'Name')).toBeInTheDocument());
  });

  it('checks a cell as the thing form does, and Escape cancels an edit', async () => {
    const { grid, user } = await openSheet();
    await user.click(cellOf(grid, 'Old kettle', 'Quantity'));
    await user.keyboard('x{Enter}');
    const bad = cellOf(grid, 'Old kettle', 'Quantity');
    expect(bad).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('region', { name: 'Changes' })).toHaveTextContent('1 row needs a fix');
    await user.click(screen.getByRole('button', { name: 'Save 1 change' }));
    expect(await screen.findByText('Fix 1 row before saving')).toBeInTheDocument();

    await user.click(cellOf(grid, 'Old kettle', 'Model'));
    await user.keyboard('{Enter}');
    await user.type(screen.getByRole('textbox', { name: 'Model: Old kettle' }), 'Nope{Escape}');
    expect(cellOf(grid, 'Old kettle', 'Model')).not.toHaveTextContent('Nope');
  });

  it('keeps a row someone else changed staged, with keep mine or keep theirs (D156)', async () => {
    const { grid, user, mock } = await openSheet({
      setup: (m) =>
        m.on('POST', inventoryPaths.thingsBulkEdit, () => ({
          results: [
            {
              id: T.kettle,
              ok: false,
              status: 412,
              code: 'precondition_failed',
              conflicts: ['model'],
              rowVersion: 9,
              changedBy: { displayName: 'Alfred' },
            },
          ],
          rows: [],
          events: [],
        })),
    });
    await user.click(cellOf(grid, 'Old kettle', 'Model'));
    await user.keyboard('K2{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save 1 change' }));
    expect(await screen.findByText("1 row wasn't saved", { selector: 'span' })).toBeInTheDocument();
    await user.click(within(grid).getByRole('gridcell', { name: 'Not saved: Old kettle' }));
    const why = await screen.findByRole('dialog', { name: 'Not saved: Old kettle' });
    expect(why).toHaveTextContent('Alfred changed this since you opened it.');
    await user.click(within(why).getByRole('button', { name: 'Keep mine' }));
    // Mine again, on their version: the next save sends 9.
    await user.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await waitFor(() => {
      const body = mock.lastCall('POST', inventoryPaths.thingsBulkEdit)?.body as {
        edits: { rowVersion: number }[];
      };
      expect(body.edits[0]?.rowVersion).toBe(9);
    });
  });
});

describe('bulk actions', () => {
  it('selects by keyboard, stages tags on every row, and sends a selection to the Trash with Undo', async () => {
    const { grid, user, mock } = await openSheet();
    await user.click(cellOf(grid, 'AA batteries', 'Name'));
    await user.keyboard(' {Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    const bar = screen.getByRole('toolbar', { name: 'Selection' });
    expect(bar).toHaveTextContent('3 selected');
    expect(within(grid).getAllByRole('row', { selected: true })).toHaveLength(3);

    await user.click(within(bar).getByRole('button', { name: 'Tags…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tags of 3 things' });
    await user.click(within(dialog).getByRole('button', { name: /Tags/ }));
    await user.click(await screen.findByRole('option', { name: 'winter' }));
    await user.keyboard('{Escape}');
    await user.click(within(dialog).getByRole('button', { name: 'Add tags' }));
    expect(screen.getByRole('region', { name: 'Changes' })).toHaveTextContent(
      '3 changes · on 3 things',
    );
    expect(cellOf(grid, 'Box 3', 'Tags')).toHaveTextContent('winter');

    await user.click(within(bar).getByRole('button', { name: 'Send to Trash' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Send 3 things to the Trash?' });
    // Box 3 and the cable box hold things: what happens to what's inside is asked first.
    expect(within(confirm).getByRole('radio', { name: /Move what's inside out/ })).toBeChecked();
    await user.click(within(confirm).getByRole('button', { name: 'Send to Trash' }));
    expect(await screen.findByText('Sent 3 things to the Trash')).toBeInTheDocument();
    expect(mock.lastCall('POST', inventoryPaths.thingsBulkTrash)?.body).toEqual({
      thingIds: [T.batteries, T.box3, T.cableBox],
      contents: 'move',
    });
    // Their staged tags went with them.
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();
  });
});

describe('who sees what', () => {
  it('a viewer reads: no boxes, no editing, no price where money is hidden from viewers', async () => {
    const { grid, user, mock } = await openSheet({ state: asRole('viewer') });
    expect(grid).toHaveAttribute('aria-readonly', 'true');
    const headers = within(grid)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers[0]).toBe('Name');
    expect(headers).not.toContain('Price');
    await user.click(cellOf(grid, 'Old kettle', 'Name'));
    await user.keyboard('{Enter}x');
    expect(screen.queryByRole('textbox', { name: /Old kettle/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();
    expect(mock.lastCall('POST', inventoryPaths.thingsBulkEdit)).toBeUndefined();
  });

  it('remembers the columns a person picks', async () => {
    const { grid, user } = await openSheet();
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const dialog = await screen.findByRole('dialog', { name: 'Columns' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Notes' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Short ID' }));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    const headers = within(grid)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toContain('Notes');
    expect(headers).not.toContain('Short ID');
    expect(Object.keys(localStorage).some((k) => k.startsWith('kept.sheet.columns.'))).toBe(true);
  });

  it('sorts from a header, in the address', async () => {
    const { grid, user, router } = await openSheet();
    await user.click(within(grid).getByRole('button', { name: /Brand/ }));
    await waitFor(() =>
      expect((router.state.location.search as { sort?: string }).sort).toBe('brand'),
    );
    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /Brand/ })).toHaveAttribute(
        'aria-sort',
        'ascending',
      ),
    );
    expect(grid).toBeInTheDocument();
  });
});

describe('right to left', () => {
  it('moves the active cell the way the arrow points, with logical CSS only', async () => {
    const { grid, user } = await openSheet({ locale: 'ar' });
    const first = within(grid).getAllByRole('gridcell')[1] as HTMLElement;
    await user.click(first);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.getAttribute('data-cell')).toBe(
      first.getAttribute('data-cell')?.replace(/:1$/, ':2'),
    );
    expectLogicalOnly(grid);
  });
});
