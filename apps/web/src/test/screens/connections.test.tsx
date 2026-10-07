/**
 * Settings → Connections (step-6 plan T21; D58, D63, D124, D179, screens §5): personal tokens and
 * connected apps on one list, a new token shown once with Copy and the client configs (URL and
 * header only, never an invented settings file) and gone from the page once closed, D179's
 * second step, the scope stopping at the role, revoke with an in-app confirm, recent changes by
 * connections with undo and the refusal reason on the row, offline, Arabic, and the Shortcut
 * recipe in Help.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionsMock } from '@/api/connections/mock/state';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { inventoryPaths } from '@/api/inventory/paths';
import { type MockState, ownerScenario } from '@/api/mock/fixtures';
import { err } from '@/api/mock/kit';
import { findHeading, renderApp } from '../app';

const L = INV_IDS.loc;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Ibrahim, a viewer in Garage (D179's roles test). */
function viewerInGarage(): MockState {
  const s = ownerScenario();
  for (const l of s.locations) if (l.id === L.garage) l.role = 'viewer';
  return s;
}

describe('Connections', () => {
  it('lists personal tokens and connected apps apart, never a secret', async () => {
    await renderApp('/settings/connections');
    await findHeading('Connections');
    const list = await screen.findByRole('list', { name: 'Tokens and connected apps' });
    expect(within(list).getByText('Personal tokens')).toBeInTheDocument();
    expect(within(list).getByText('Connected apps (OAuth)')).toBeInTheDocument();
    expect(within(list).getByText('Garage dashboard')).toBeInTheDocument();
    expect(within(list).getByText('Claude Desktop')).toBeInTheDocument();
    expect(within(list).getByText('Claude')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/kpt_/);
  });

  it('filters by location from the URL', async () => {
    await renderApp(`/settings/connections?f.location=${L.garage}`);
    const list = await screen.findByRole('list', { name: 'Tokens and connected apps' });
    expect(within(list).getByText('Garage dashboard')).toBeInTheDocument();
    expect(within(list).queryByText('Claude Desktop')).toBeNull();
  });

  it('shows a new token once, with Copy and the URL and header, and drops it on close', async () => {
    const { user } = await renderApp('/settings/connections');
    await user.click(await screen.findByRole('button', { name: 'New token' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'New token' }));
    await user.type(sheet.getByRole('textbox', { name: 'Name' }), 'Laptop');
    // One location is pre-selected (D179).
    expect(sheet.getByRole('checkbox', { name: 'Home' })).toBeChecked();
    expect(sheet.getByRole('checkbox', { name: 'Garage' })).not.toBeChecked();
    await user.click(sheet.getByRole('button', { name: 'Make token' }));
    const done = within(await screen.findByRole('dialog', { name: 'Your new token' }));
    const secret = document.querySelector('[data-token-secret]')?.textContent ?? '';
    expect(secret).toMatch(/^kpt_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(done.getByText(/You won't see this again/)).toBeInTheDocument();
    expect(done.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(done.getByText(/\/mcp$/)).toBeInTheDocument();
    expect(done.getByText(`Bearer ${secret}`)).toBeInTheDocument();
    // No client settings file was sent, so none is drawn.
    expect(done.queryByText(/mcpServers/)).toBeNull();
    await user.click(done.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(secret);
    const list = screen.getByRole('list', { name: 'Tokens and connected apps' });
    expect(await within(list).findByText('Laptop')).toBeInTheDocument();
  });

  it('asks again before a write token for two locations (D179)', async () => {
    const { user, mock } = await renderApp('/settings/connections');
    await user.click(await screen.findByRole('button', { name: 'New token' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'New token' }));
    await user.type(sheet.getByRole('textbox', { name: 'Name' }), 'Both');
    await user.click(sheet.getByRole('checkbox', { name: 'Garage' }));
    await user.click(sheet.getByRole('radio', { name: 'Read and change' }));
    await user.click(sheet.getByRole('button', { name: 'Make token' }));
    expect(await screen.findByText('Different people use these locations')).toBeInTheDocument();
    expect(connectionsMock(mock.state).tokens.some((t) => t.name === 'Both')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Make it for all of them' }));
    expect(await screen.findByRole('dialog', { name: 'Your new token' })).toBeInTheDocument();
    const made = connectionsMock(mock.state).tokens.find((t) => t.name === 'Both');
    expect(made?.scope).toBe('write');
    expect(made?.locations.map((l) => l.id).sort()).toEqual([L.garage, L.home].sort());
  });

  it("stops the scope at the role: a viewer's location makes the token read only", async () => {
    const { user } = await renderApp('/settings/connections', { state: viewerInGarage() });
    await user.click(await screen.findByRole('button', { name: 'New token' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'New token' }));
    expect(sheet.getByRole('radio', { name: 'Read and change' })).not.toBeDisabled();
    await user.click(sheet.getByRole('checkbox', { name: /Garage/ }));
    expect(sheet.getByRole('radio', { name: 'Read and change' })).toBeDisabled();
    expect(sheet.getByRole('radio', { name: 'Read only' })).toBeChecked();
    expect(sheet.getByText(/you're a viewer in/)).toBeInTheDocument();
  });

  it('revokes a token after the in-app confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { user, mock } = await renderApp('/settings/connections');
    await user.click(await screen.findByRole('button', { name: 'Revoke: Garage dashboard' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    await user.click(dialog.getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(
        connectionsMock(mock.state).tokens.find((t) => t.name === 'Garage dashboard')?.revokedAt,
      ).toBeTruthy(),
    );
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('undoes a recent change by a connection', async () => {
    const { user, mock } = await renderApp('/settings/connections');
    const changes = await screen.findByRole('list', { name: 'Recent changes by connections' });
    expect(within(changes).getAllByRole('article')).toHaveLength(3);
    // Who made each change: the token's name, never "Kept" (UI review steps 6–8, M4).
    expect(within(changes).getAllByText('Claude Desktop', { selector: 'bdi' })).toHaveLength(3);
    expect(within(changes).queryByText('Kept', { selector: 'bdi' })).toBeNull();
    const undos = within(changes).getAllByRole('button', { name: 'Undo' });
    expect(undos).toHaveLength(2);
    await user.click(undos[0] as HTMLElement);
    expect(await screen.findByText('Undone')).toBeInTheDocument();
    expect(mock.calls.some((c) => c.method === 'POST' && /\/audit\/.+\/undo$/.test(c.path))).toBe(
      true,
    );
  });

  it('says on the row who changed it when undo is refused', async () => {
    const { user } = await renderApp('/settings/connections', {
      setup: (m) =>
        m.on('POST', inventoryPaths.undo(':id'), () =>
          err(409, 'undo_refused', 'Refused', undefined, {
            reason: 'changed_since',
            field: 'name',
            changedBy: { type: 'user', id: 'u-alfred', displayName: 'Alfred' },
          }),
        ),
    });
    const changes = await screen.findByRole('list', { name: 'Recent changes by connections' });
    await user.click(within(changes).getAllByRole('button', { name: 'Undo' })[0] as HTMLElement);
    expect(await within(changes).findByText(/Can't undo: Alfred changed/)).toBeInTheDocument();
    expect(within(changes).getByRole('link', { name: 'Open the thing' })).toBeInTheDocument();
  });

  it('offline, New token says it needs a connection', async () => {
    await renderApp('/settings/connections');
    const button = await screen.findByRole('button', { name: 'New token' });
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      window.dispatchEvent(new Event('offline'));
      await waitFor(() => expect(button).toBeDisabled());
      expect(screen.getAllByText('Needs a connection').length).toBeGreaterThan(0);
    } finally {
      offline.mockRestore();
      window.dispatchEvent(new Event('online'));
    }
  });
});

describe('Connections in Arabic', () => {
  it('reads right to left, with names isolated', async () => {
    await renderApp('/settings/connections', { locale: 'ar' });
    const list = await screen.findByRole('list', { name: 'الرموز والتطبيقات المتصلة' });
    expect(document.documentElement.dir).toBe('rtl');
    expect(within(list).getByText('الرموز الشخصية')).toBeInTheDocument();
    expect(within(list).getByText('Garage dashboard').tagName).toBe('BDI');
  });
});

describe('Help → the Shortcut recipe', () => {
  it("writes the real route with the car's meter, and says the token stays on the phone", async () => {
    const { user } = await renderApp('/help');
    await user.click(
      within(
        (await screen.findByText('Log your odometer from an iPhone Shortcut')).closest(
          'li',
        ) as HTMLElement,
      ).getByRole('button', { name: 'Show the recipe' }),
    );
    const sheet = within(
      await screen.findByRole('dialog', { name: 'Log your odometer from an iPhone Shortcut' }),
    );
    expect(
      await sheet.findByText(/\/api\/v1\/meters\/[0-9a-f-]{36}\/readings$/),
    ).toBeInTheDocument();
    expect(sheet.getByText('Authorization: Bearer <your token>')).toBeInTheDocument();
    expect(sheet.getByText('The token lives in the Shortcut')).toBeInTheDocument();
  });
});
