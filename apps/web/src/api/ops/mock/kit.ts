/**
 * Mock handlers for the recovery kit (T9; D182, D193): its state with `downloadedAt` and
 * `stale`, and the download, which needs https and re-authentication (the mock's password, else
 * 403 `reauth_required` with `reauth: 'password'`, as the server says) and answers the kit as an attachment with `Cache-Control: no-store`.
 * The kit's text is invented placeholder content: it holds no key, no password and no credential.
 */
import { RecoveryKitDownloadInput } from '@kept/shared';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, route } from '../../mock/kit';
import { paths } from '../../paths';
import { opsPaths as p } from '../paths';
import { adminGate, httpsGate } from './guard';
import { ops } from './state';

const KIT_TEXT = [
  'Kept recovery kit (mock)',
  '',
  'This is the mock server: a real kit holds the secret keys, the backup repository,',
  'its password and its storage credentials, and the restore steps.',
  '',
].join('\n');

export function kitRoutes(state: MockState): MockRoute[] {
  const s = () => ops(state);
  return [
    route('GET', paths.admin.recoveryKit, () => adminGate(state) ?? s().kit),

    route('POST', p.recoveryKitDownload, ({ body }) => {
      const gate = adminGate(state) ?? httpsGate(state);
      if (gate) return gate;
      const parsed = RecoveryKitDownloadInput.safeParse(body ?? {});
      if (!parsed.success) return err(400, 'validation', 'The request is not valid.');
      if (parsed.data.password !== state.password) {
        return err(403, 'reauth_required', 'Confirm it is you to continue.', undefined, {
          reauth: 'password',
        });
      }
      const now = new Date().toISOString();
      s().kit = {
        acknowledgedAt: s().kit.acknowledgedAt ?? now,
        downloadedAt: now,
        stale: false,
      };
      state.admin.status.recoveryKitAcknowledged = true;
      const html = parsed.data.format === 'html';
      return new Response(
        html ? `<!doctype html><meta charset="utf-8"><pre>${KIT_TEXT}</pre>` : KIT_TEXT,
        {
          status: 200,
          headers: {
            'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
            'content-disposition': `attachment; filename="kept-recovery-kit.${html ? 'html' : 'txt'}"`,
            'cache-control': 'no-store',
          },
        },
      );
    }),
  ];
}
