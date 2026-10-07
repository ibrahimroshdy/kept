/**
 * Download the recovery kit (D66, D182; step-8 T22, screens §8 and §10). "Download recovery kit"
 * opens the re-authentication sheet, which says what the kit holds and to keep it off this
 * server, and offers it as a text file or a printable page. The kit comes back as a Blob, saved
 * through a one-off object URL that is revoked straight after the download starts; it is never
 * put in TanStack Query, a store or React state. After a download the kit's state (acknowledged,
 * downloaded, stale) is fetched again, so the status page shows it as kept.
 */
import type { RecoveryKitFormat } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { opsApi } from '@/api/ops/queries';
import { keys } from '@/api/queries';
import { KeyIcon } from '@/components/icons';
import { Notice } from '@/components/page';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { toast } from '@/components/ui/toast';
import { ReauthSheet } from './reauth-sheet';

/** How long the object URL lives: long enough for the browser to start saving it (Safari starts
 * an `<a download>` after the click returns), no longer. */
export const KIT_URL_LIFETIME_MS = 1000;

/** `kept-recovery-kit-2026-10-06.txt`, as the server names it, in the browser's own day. */
export function kitFilename(format: RecoveryKitFormat, now = new Date()): string {
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((n) => String(n).padStart(2, '0'))
    .join('-');
  return `kept-recovery-kit-${day}.${format === 'html' ? 'html' : 'txt'}`;
}

/** Saves `blob` as `filename`, then revokes its URL: nothing of the kit stays on the page. */
export function saveKit(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), KIT_URL_LIFETIME_MS);
  }
}

function KitSheet({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const [format, setFormat] = useState<RecoveryKitFormat>('text');
  return (
    <ReauthSheet
      title={<Trans>Download the recovery kit</Trans>}
      submitLabel={<Trans>Download</Trans>}
      returnTo="/admin/status"
      onClose={onClose}
      onSubmit={async (password) => {
        const blob = await opsApi.downloadRecoveryKit({
          format,
          ...(password ? { password } : {}),
        });
        saveKit(blob, kitFilename(format));
        await qc.invalidateQueries({ queryKey: keys.admin.all });
        await qc.invalidateQueries({ queryKey: keys.me });
        toast({ title: t`Recovery kit downloaded. Keep it off this server.`, tone: 'ok' });
        onClose();
      }}
    >
      <p className="m-0 text-ink-2">
        <Trans>
          Everything needed to bring Kept back on a new server: the secret keys, the backup's
          location, its password and storage keys, and the restore steps.
        </Trans>
      </p>
      <Notice tone="warn" title={<Trans>Keep it off this server</Trans>}>
        <Trans>
          Print it or store it in a password manager. Anyone with it can read your backups.
        </Trans>
      </Notice>
      <Segmented
        label={t`Format`}
        value={format}
        onChange={setFormat}
        options={[
          { id: 'text', label: t`Text file` },
          { id: 'html', label: t`Printable page` },
        ]}
      />
    </ReauthSheet>
  );
}

/** The "Download recovery kit" button and its sheet. */
export function KitDownloadButton({
  children,
  ...props
}: Omit<ButtonProps, 'onPress' | 'children'> & { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button {...props} onPress={() => setOpen(true)}>
        <KeyIcon />
        {children ?? <Trans>Download recovery kit</Trans>}
      </Button>
      {open ? <KitSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}
