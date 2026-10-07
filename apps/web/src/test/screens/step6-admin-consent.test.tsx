/**
 * Step 6 T22–T24 on the mock: the OAuth consent page (D179, D180: the app's name isolated as it
 * calls itself, read or read-and-change, one location pre-selected and D179's warning for more,
 * Allow and Deny, signed out → sign in first), "Sign in with <name>" and its failures, Admin →
 * Status's OIDC, connector and embeddings rows with the source switch, location webhooks
 * (add with the secret once, test ping, deliveries, the creator-lost-role state, hidden from
 * members), and Search's "matched by meaning" and keyword-only notes.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instanceMock } from '@/api/connections/mock/instance';
import { connectionsMock } from '@/api/connections/mock/state';
import { connectionsPaths } from '@/api/connections/paths';
import { INV_IDS } from '@/api/inventory/mock/fixtures';
import { semanticMock } from '@/api/inventory/mock/semantic';
import { memberScenario, ownerScenario, signedOutScenario } from '@/api/mock/fixtures';
import { err } from '@/api/mock/kit';
import { leave } from '@/lib/leave';
import { findHeading, pathOf, renderApp } from '../app';

const L = INV_IDS.loc;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the OAuth consent page', () => {
  const at = '/oauth/consent?client_id=https%3A%2F%2Fclaude.ai%2Fmeta.json&state=abc';

  it('names the app as it calls itself, starts with one location, read only, and allows', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined);
    const { user, mock } = await renderApp(at);
    expect(await findHeading('Claude wants to use your Kept')).toBeInTheDocument();
    expect(screen.getByText(/the name the app gives itself/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Read only' })).toBeChecked();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.filter((b) => (b as HTMLInputElement).checked)).toHaveLength(1);
    await user.click(screen.getByRole('radio', { name: 'Read and change' }));
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(to).toHaveBeenCalledWith(expect.stringContaining('code=')));
    const body = mock.lastCall('POST', '/api/v1/oauth/consent')?.body as {
      accept: boolean;
      scope: string;
      locationIds: string[];
    };
    expect(body).toMatchObject({ accept: true, scope: 'write' });
    expect(body.locationIds).toHaveLength(1);
    expect(connectionsMock(mock.state).tokens[0]?.kind).toBe('oauth');
  });

  it('warns with more than one location (D179) and denies', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined);
    const { user } = await renderApp(at);
    await findHeading('Claude wants to use your Kept');
    const unchecked = screen
      .getAllByRole('checkbox')
      .find((b) => !(b as HTMLInputElement).checked) as HTMLElement;
    await user.click(unchecked);
    expect(screen.getByText('More than one location')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(to).toHaveBeenCalledWith(expect.stringContaining('access_denied')));
  });

  it("names the Personal location in the reader's language (UI review steps 6–8, M9)", async () => {
    await renderApp(at, { locale: 'ar' });
    await screen.findAllByRole('checkbox');
    const labels = screen.getAllByRole('checkbox').map((b) => b.closest('label')?.textContent);
    expect(labels.some((l) => l?.includes('شخصي'))).toBe(true);
    expect(labels.some((l) => l?.includes('Personal'))).toBe(false);
  });

  it('signed out, goes to sign in first and keeps the request', async () => {
    const { router } = await renderApp(at, { state: signedOutScenario() });
    await waitFor(() => expect(pathOf(router)).toBe('/signin'));
    expect(String(router.state.location.search.next ?? '')).toContain('/oauth/consent?');
  });
});

describe('Sign in with OIDC', () => {
  it('offers "Sign in with <name>" and opens the provider', async () => {
    const to = vi.spyOn(leave, 'to').mockImplementation(() => undefined);
    const { user, mock } = await renderApp('/signin', { state: signedOutScenario() });
    await user.click(await screen.findByRole('button', { name: 'Sign in with Home SSO' }));
    await waitFor(() =>
      expect(to).toHaveBeenCalledWith(expect.stringContaining('sso.example.net')),
    );
    expect(mock.lastCall('POST', '/api/v1/auth/sign-in/social')?.body).toMatchObject({
      provider: 'oidc',
      callbackURL: '/',
      errorCallbackURL: '/signin',
    });
  });

  it('explains invites when no account is linked (D127)', async () => {
    await renderApp('/signin?error=account_not_linked', { state: signedOutScenario() });
    expect(await screen.findByText('No Kept account uses that sign-in yet')).toBeInTheDocument();
    expect(screen.getByText(/open the invite/)).toBeInTheDocument();
  });

  it('is absent when OIDC is not configured', async () => {
    const state = signedOutScenario();
    instanceMock(state).oidc.configured = false;
    await renderApp('/signin', { state });
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('button', { name: /Sign in with Home SSO/ })).toBeNull();
  });
});

describe('Admin → Status, step 6', () => {
  it('shows OIDC, the MCP endpoint, connectors needing https, and indexing progress', async () => {
    await renderApp('/admin/status');
    expect(await screen.findByText('Sign-in with OIDC')).toBeInTheDocument();
    expect(screen.getByText(/\/api\/v1\/auth\/callback\/oidc$/)).toBeInTheDocument();
    expect(screen.getByText(/\/mcp$/)).toBeInTheDocument();
    expect(screen.getByText('Needs an https public URL')).toBeInTheDocument();
    expect(screen.getByText('Indexed 8,412 of 10,000 things')).toBeInTheDocument();
  });

  it('switches the source to the local model after saying what it costs', async () => {
    const { user, mock } = await renderApp('/admin/status');
    await user.click(await screen.findByRole('radio', { name: 'This server' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(/137 MB/)).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Use the local model' }));
    await waitFor(() => expect(instanceMock(mock.state).embeddings.source).toBe('local'));
    expect(await screen.findByText('Downloading the local model')).toBeInTheDocument();
  });

  it("doesn't offer the local model when the server hasn't got it", async () => {
    const state = ownerScenario();
    instanceMock(state).embeddings.local.available = false;
    await renderApp('/admin/status', { state });
    expect(await screen.findByRole('radio', { name: 'This server' })).toBeDisabled();
  });
});

describe('location webhooks', () => {
  const at = `/settings/location/${L.home}/webhooks`;

  it('lists the failing webhook and adds one, showing its secret once', async () => {
    const { user, mock } = await renderApp(at);
    expect(await screen.findByText(/Failing since/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add webhook' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'New webhook' }));
    await user.type(
      sheet.getByRole('textbox', { name: 'Send to' }),
      'https://hooks.example.net/kept',
    );
    await user.click(sheet.getByRole('button', { name: 'Add webhook' }));
    const done = within(await screen.findByRole('dialog', { name: 'Signing secret' }));
    const secret = document.querySelector('[data-webhook-secret]')?.textContent ?? '';
    expect(secret.length).toBeGreaterThan(20);
    expect(done.getByText(/Kept-Signature/)).toBeInTheDocument();
    await user.click(done.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(secret);
    expect(connectionsMock(mock.state).webhooks).toHaveLength(2);
  });

  it("says on the field when the server can't reach the address (UI review steps 6–8, M5)", async () => {
    const { user } = await renderApp(at, {
      setup: (m) =>
        m.on('POST', connectionsPaths.locationWebhooks(':id'), () =>
          err(
            400,
            'validation',
            'The request is not valid.',
            "url: hooks.invalid doesn't resolve to an address.",
          ),
        ),
    });
    await screen.findByText(/Failing since/);
    await user.click(screen.getByRole('button', { name: 'Add webhook' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'New webhook' }));
    await user.type(sheet.getByRole('textbox', { name: 'Send to' }), 'https://hooks.invalid/kept');
    await user.click(sheet.getByRole('button', { name: 'Add webhook' }));
    expect(
      await sheet.findByText("Kept can't reach that address. Check it for typos."),
    ).toBeInTheDocument();
    expect(sheet.queryByText(/Some of that isn't valid/)).toBeNull();
  });

  it('sends a test and lists deliveries', async () => {
    const { user } = await renderApp(at);
    await screen.findByText(/Failing since/);
    await user.click(screen.getByRole('button', { name: 'Send a test' }));
    expect(await screen.findByText('Test sent: your server answered 500')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Deliveries' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Deliveries' }));
    expect((await sheet.findAllByText(/attempt/)).length).toBeGreaterThan(0);
  });

  it("says when it's off because its maker lost the role (D180)", async () => {
    const state = ownerScenario();
    const hook = connectionsMock(state).webhooks[0];
    if (hook) {
      hook.active = false;
      hook.disabledReason = 'creator_lost_role';
    }
    await renderApp(at, { state });
    expect(
      await screen.findByText('Off: the person who made it is no longer an admin here.'),
    ).toBeInTheDocument();
  });

  it('is hidden from a member', async () => {
    await renderApp(`/settings/location/${L.home}/general`, { state: memberScenario() });
    await screen.findByText('Only the owner and admins change this');
    expect(screen.queryByRole('link', { name: 'Webhooks' })).toBeNull();
  });
});

describe('semantic search in Search', () => {
  it('marks a result found only by meaning', async () => {
    await renderApp(`/search?q=${encodeURIComponent('the thing for the TV')}`);
    expect(await screen.findAllByText('matched by meaning')).not.toHaveLength(0);
  });

  it('says when results are keyword only', async () => {
    const state = ownerScenario();
    semanticMock(state).state = { state: 'keyword_only' };
    await renderApp('/search?q=hdmi', { state });
    expect(
      await screen.findByText('Keyword search only here (no embeddings model)'),
    ).toBeInTheDocument();
  });

  it('says when semantic search is paused', async () => {
    const state = ownerScenario();
    semanticMock(state).state = { state: 'paused' };
    await renderApp('/search?q=hdmi', { state });
    expect(await screen.findByText('Semantic search paused · keyword results')).toBeInTheDocument();
  });
});
