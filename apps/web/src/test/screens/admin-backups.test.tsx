/**
 * Admin → Backups (T21; D64, D66, D181, D186, D193; frames 103–106) on the ops mock: the saved
 * settings, the form's write-only and locked fields, the recovery kit's gate, Test, Run now, the
 * runs list's filters in the URL, plain HTTP, a member, and Arabic.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { memberScenario, ownerScenario } from '@/api/mock/fixtures';
import { reply } from '@/api/mock/kit';
import { ops, setOpsScenario } from '@/api/ops/mock/state';
import { opsPaths } from '@/api/ops/paths';
import { renderApp } from '@/test/app';
import { expectLogicalOnly } from '@/test/render';

type PutBody = {
  target: Record<string, unknown>;
  password?: string;
  time: string;
  keep: Record<string, number>;
};

describe('Admin → Backups (T21)', () => {
  it('summarises the saved S3 target, and saves a change without sending any secret', async () => {
    const { user, mock } = await renderApp('/admin/backups');
    expect(await screen.findByText('Last good backup 4 hours ago')).toBeInTheDocument();
    expect(screen.getByText('S3-compatible')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText(/secret key saved/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    // Write-only fields: "Saved" with Replace, never their value.
    expect(screen.getAllByText('Saved, never shown again').length).toBe(1);
    expect(screen.getByText('Set, and in the recovery kit')).toBeInTheDocument();
    const bucket = screen.getByRole('textbox', { name: 'Bucket' });
    await user.clear(bucket);
    await user.type(bucket, 'kept-archive');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.lastCall('PUT', opsPaths.backup)).toBeTruthy());
    const call = mock.lastCall('PUT', opsPaths.backup);
    const body = call?.body as PutBody;
    expect(call?.headers['if-match']).toBe('7');
    expect(body.target).toMatchObject({ kind: 's3', bucket: 'kept-archive' });
    expect(body.target).not.toHaveProperty('secretAccessKey');
    expect(body).not.toHaveProperty('password');
    expect(await screen.findByText('Backup settings saved')).toBeInTheDocument();
  });

  it('sends a replaced secret key and a new password, and checks the password’s length first', async () => {
    const { user, mock } = await renderApp('/admin/backups');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const replaces = screen.getAllByRole('button', { name: 'Replace' });
    expect(replaces).toHaveLength(2);
    await user.click(replaces[0] as HTMLElement);
    await user.type(screen.getByLabelText('Secret access key'), 'new-secret-key');
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    await user.type(screen.getByLabelText('Backup password'), 'too short');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('At least 12 characters.')).toBeInTheDocument();
    expect(mock.lastCall('PUT', opsPaths.backup)).toBeUndefined();

    await user.type(screen.getByLabelText('Backup password'), ' but now long enough');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.lastCall('PUT', opsPaths.backup)).toBeTruthy());
    const body = mock.lastCall('PUT', opsPaths.backup)?.body as PutBody;
    expect(body.target.secretAccessKey).toBe('new-secret-key');
    expect(body.password).toBe('too short but now long enough');
  });

  it('shows what the environment sets as read-only, and names the variables', async () => {
    const state = ownerScenario();
    setOpsScenario(state, 'dir_same_disk');
    const { user } = await renderApp('/admin/backups', { state });
    expect(
      await screen.findByText('Backups are on the same disk as your data'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('radio', { name: 'S3-compatible' })).not.toBeInTheDocument();
    expect(screen.getAllByText("Set by the server's environment").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('/mnt/backup/kept')).toBeInTheDocument();
    expect(screen.getByText(/KEPT_BACKUP_DIR, KEPT_BACKUP_PASSWORD/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Backup password')).not.toBeInTheDocument();
  });

  it('starts with the form when nothing is set up, needs a password, and asks for the kit first', async () => {
    const state = ownerScenario();
    setOpsScenario(state, 'unconfigured');
    ops(state).kit.acknowledgedAt = null;
    const { user, mock } = await renderApp('/admin/backups', { state });
    expect(await screen.findByText('No backup configured')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'SFTP' }));
    await user.type(screen.getByRole('textbox', { name: 'Server' }), 'nas.lan');
    await user.type(screen.getByRole('textbox', { name: 'User' }), 'kept');
    await user.type(screen.getByRole('textbox', { name: 'Folder on the server' }), 'backups/kept');
    await user.type(
      screen.getByRole('textbox', { name: 'Host key' }),
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOq0ZcXcGv0rqk1E1Hb0bq3Gk5t8Lz1A2b3C4d5E6f7G',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Backups need a password: no password, no backup.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Backup password'), 'a long backup passphrase');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // 409 recovery_kit_required: the kit's download is offered right there.
    expect(await screen.findByText('Download the recovery kit first')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download recovery kit' })).toBeInTheDocument();
    const body = mock.lastCall('PUT', opsPaths.backup)?.body as PutBody;
    expect(body.target).toMatchObject({ kind: 'sftp', host: 'nas.lan', port: 22 });
  });

  it('tests the saved settings and says why it failed, in words', async () => {
    const { user, mock } = await renderApp('/admin/backups');
    await user.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Reached')).toBeInTheDocument();
    mock.on('POST', opsPaths.backupTest, () =>
      reply(200, { ok: false, initialised: false, error: 'wrong_password' }),
    );
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Wrong password')).toBeInTheDocument();
    expect(screen.getByText(/made with another password/)).toBeInTheDocument();
  });

  it('runs a backup now', async () => {
    const { user, mock } = await renderApp('/admin/backups');
    await user.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(mock.lastCall('POST', opsPaths.backupRun)).toBeTruthy());
    expect(
      await screen.findByText('Backup started. It shows in the runs below.'),
    ).toBeInTheDocument();
  });

  it('lists the runs grouped by day, and explains the bad ones in words', async () => {
    await renderApp('/admin/backups');
    const runs = await screen.findByRole('list', { name: 'Backup runs' });
    expect(within(runs).getByText(/much smaller than the last good one/)).toBeInTheDocument();
    expect(within(runs).getByText(/Couldn't reach the backup storage/)).toBeInTheDocument();
    expect(within(runs).getAllByText(/^Today · |^Yesterday · /).length).toBeGreaterThan(0);
  });

  it('filters the runs by status from the URL', async () => {
    await renderApp('/admin/backups?f.status=failed');
    const runs = await screen.findByRole('list', { name: 'Backup runs' });
    await waitFor(() => expect(within(runs).getAllByText('Failed')).toHaveLength(1));
    expect(within(runs).queryByText('Needs a look')).not.toBeInTheDocument();
  });

  it('lists the snapshots read-only, and says restoring is a command', async () => {
    await renderApp('/admin/backups');
    const list = await screen.findByRole('list', { name: 'Snapshots' });
    expect(within(list).getAllByText(/Nightly|Run now|Before upgrade/).length).toBeGreaterThan(0);
    expect(screen.getByText('kept admin restore')).toBeInTheDocument();
  });

  it('says why nothing can be changed over plain HTTP', async () => {
    const state = ownerScenario();
    ops(state).https = false;
    const { user } = await renderApp('/admin/backups', { state });
    expect(await screen.findByRole('button', { name: 'Test' })).toBeDisabled();
    expect(screen.getByText(/can only be changed over HTTPS/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('Admin → Settings switches the update check', async () => {
    const { user, mock } = await renderApp('/admin/settings');
    const toggle = await screen.findByRole('switch', { name: /Check for new versions/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() =>
      expect(mock.lastCall('PUT', '/api/v1/admin/settings')?.body).toEqual({ updateCheck: false }),
    );
  });

  it('Admin → Settings shows the update check locked by the environment', async () => {
    const state = ownerScenario();
    ops(state).updates = { ...ops(state).updates, locked: true };
    await renderApp('/admin/settings', { state });
    expect(await screen.findByRole('switch', { name: /Check for new versions/ })).toBeDisabled();
  });

  it('is for instance admins only', async () => {
    await renderApp('/admin/backups', { state: memberScenario() });
    expect(await screen.findByText('For instance admins')).toBeInTheDocument();
    expect(screen.queryByText('Runs')).not.toBeInTheDocument();
  });

  it('renders right to left in Arabic', async () => {
    await renderApp('/admin/backups', { locale: 'ar' });
    expect((await screen.findAllByRole('list')).length).toBeGreaterThan(0);
    expect(document.documentElement.dir).toBe('rtl');
    expectLogicalOnly();
  });
});
