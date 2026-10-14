/**
 * Location settings → Email-in (1.4, D231): connecting a mailbox, a refused sign-in said in
 * words, the saved password never shown, the recent mail, and removing it with a confirmation.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { seedMailbox } from '@/api/mailin/mock';
import { mailinPaths } from '@/api/mailin/paths';
import { IDS, ownerScenario } from '@/api/mock/fixtures';
import { findHeading, renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

vi.setConfig({ testTimeout: 20_000 });

const PATH = `/settings/location/${IDS.home}/email-in`;

describe('Location settings → Email-in', () => {
  it('connects a mailbox; a refused sign-in says why and saves nothing', async () => {
    const { user, mock } = await renderApp(PATH);
    await findHeading('Email-in');
    expect(screen.getByRole('link', { name: 'Email-in' })).toHaveAttribute('aria-current', 'page');
    await user.type(await screen.findByRole('textbox', { name: /IMAP server/ }), 'fail.example');
    await user.type(screen.getByRole('textbox', { name: /User name/ }), 'receipts@home.example');
    await user.type(screen.getByLabelText(/^Password/), 'secret-pass');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(
      await screen.findByText('The mailbox refused the user name or password.'),
    ).toBeInTheDocument();
    expect(mock.lastCall('PUT', mailinPaths.mailbox(IDS.home))?.body).toMatchObject({
      host: 'fail.example',
      port: 993,
      security: 'tls',
      folder: 'Kept',
      password: 'secret-pass',
      allowedSenders: [],
    });

    const host = screen.getByRole('textbox', { name: /IMAP server/ });
    await user.clear(host);
    await user.type(host, 'imap.home.example');
    await user.click(screen.getByRole('radio', { name: 'STARTTLS (143)' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('heading', { name: 'Change the mailbox' });
    expect(mock.lastCall('PUT', mailinPaths.mailbox(IDS.home))?.body).toMatchObject({
      host: 'imap.home.example',
      port: 143,
      security: 'starttls',
    });
    // The saved password is never shown: the field is empty, and says so.
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
    expect(screen.getByText('Saved. Leave it empty to keep it.')).toBeInTheDocument();
    expect(screen.getByText('Not checked yet. Kept checks every 10 minutes.')).toBeInTheDocument();
    expectLogicalOnly();
  });

  it('lists the recent mail, checks now, and removes the mailbox after asking', async () => {
    const state = ownerScenario();
    seedMailbox(state, IDS.home, {
      password: 'x',
      mailbox: {
        id: '01926f00-0000-7000-8000-0000000ma001',
        host: 'imap.home.example',
        port: 993,
        security: 'tls',
        username: 'receipts@home.example',
        folder: 'Kept',
        allowedSenders: [],
        active: false,
        disabledReason: 'auth_failed',
        lastPolledAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        lastError: 'auth_failed',
        createdBy: { id: IDS.ibrahim, displayName: 'Ibrahim' },
      },
      recent: [
        {
          id: '01926f00-0000-7000-8000-0000000mm001',
          from: 'orders@shop.example',
          subject: 'Order 1042 confirmed',
          receivedAt: null,
          outcome: 'receipt',
          purchaseId: '01926f00-0000-7000-8000-0000000pp001',
          at: new Date().toISOString(),
        },
        {
          id: '01926f00-0000-7000-8000-0000000mm002',
          from: 'friend@example.com',
          subject: 'Lunch?',
          receivedAt: null,
          outcome: 'no_receipt',
          purchaseId: null,
          at: new Date().toISOString(),
        },
      ],
    });
    const { user, mock } = await renderApp(PATH, { state });
    await findHeading('Email-in');
    expect(await screen.findByText('Kept stopped checking this mailbox')).toBeInTheDocument();
    expect(screen.getByText(/refused the user name or password/)).toBeInTheDocument();
    const recent = screen
      .getByRole('heading', { name: 'Recent mail' })
      .closest('section') as HTMLElement;
    expect(within(recent).getByText('Order 1042 confirmed')).toBeInTheDocument();
    expect(within(recent).getByText('Draft receipt')).toBeInTheDocument();
    expect(within(recent).getByText('No receipt in it')).toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: 'Open the Inbox' })).toHaveAttribute(
      'href',
      '/inbox',
    );

    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('The mailbox works')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/The receipts it already made stay/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(mock.lastCall('DELETE', mailinPaths.mailbox(IDS.home))).toBeTruthy(),
    );
    expect(await screen.findByRole('heading', { name: 'Connect a mailbox' })).toBeInTheDocument();
  });

  it('is hidden from a member, and its page says who can change it', async () => {
    const state = ownerScenario();
    const home = state.locations.find((l) => l.id === IDS.home);
    if (home) home.role = 'member';
    await renderApp(PATH, { state });
    expect(await screen.findByText('Only the owner and admins change this')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Email-in' })).toBeNull();
  });
});
