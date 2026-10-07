/**
 * The export screens' shared words and helpers (plan T21): an export's state as a pill, why one
 * failed, whether a ready one has expired (the server keeps `done`; the web reads `expiresAt`),
 * the request errors in the reader's words, and the download itself: a fresh 5-minute link asked
 * for on each click (`GET /exports/:id`, the role checked again, D180), followed at once and never
 * kept in the page.
 */
import { useLingui } from '@lingui/react/macro';
import { isApiError } from '@/api/client';
import { portabilityApi } from '@/api/portability/queries';
import type { ExportRun } from '@/api/portability/types';
import { type PillTone, useErrorText } from '@/components/page';

export const isExpired = (run: ExportRun, now = Date.now()) =>
  run.status === 'done' && !!run.expiresAt && Date.parse(run.expiresAt) <= now;

export type ExportState = 'queued' | 'running' | 'ready' | 'expired' | 'failed' | 'cancelled';

export const stateOf = (run: ExportRun): ExportState =>
  run.status === 'done' ? (isExpired(run) ? 'expired' : 'ready') : run.status;

export const EXPORT_STATES: ExportState[] = [
  'running',
  'queued',
  'ready',
  'expired',
  'failed',
  'cancelled',
];

export const STATE_TONE: Record<ExportState, PillTone> = {
  queued: 'neutral',
  running: 'info',
  ready: 'ok',
  expired: 'neutral',
  failed: 'danger',
  cancelled: 'neutral',
};

export function useExportStateLabel() {
  const { t } = useLingui();
  const labels: Record<ExportState, string> = {
    queued: t`Waiting`,
    running: t`Exporting`,
    ready: t`Ready`,
    expired: t`Expired`,
    failed: t`Failed`,
    cancelled: t`Cancelled`,
  };
  return (s: ExportState) => labels[s];
}

/** Why an export failed, from its short code. */
export function useExportFailure() {
  const { t } = useLingui();
  return (code: string | undefined): string => {
    switch (code) {
      case 'no_space':
        return t`the server ran out of space`;
      case 'not_permitted':
        return t`you're no longer an owner or admin there`;
      case 'abandoned':
        return t`the server restarted while it ran`;
      default:
        return t`it stopped before the end`;
    }
  };
}

/** A failed export request in the reader's words. */
export function useExportErrorText() {
  const { t } = useLingui();
  const errorText = useErrorText();
  return (e: unknown): string => {
    if (isApiError(e)) {
      if (e.code === 'export_running') return t`An export of this location is already running.`;
      if (e.status === 429) return t`Five exports an hour at most. Try again a little later.`;
      if (e.code === 'recovery_kit_required')
        return t`Secrets leave Kept only once the recovery kit is saved. An instance admin saves it from the status page.`;
      if (e.code === 'passphrase_weak')
        return t`Use a passphrase of at least 12 characters, the same both times.`;
      // D181: an export is refused over plain HTTP (the shared wording says so).
      if (e.code === 'https_required') return errorText(e);
      if (e.status === 403)
        return t`Only owners and admins export a location; only its owner includes secrets.`;
      if (e.status === 404 || e.code === 'export_expired')
        return t`This export has expired. Export again for a new one.`;
    }
    return errorText(e);
  };
}

/** Follows a short-lived link without keeping it anywhere (an anchor made and dropped). */
export function followDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

/** Asks for a fresh link for a ready export and follows it. Resolves the run as it is now. */
export async function downloadExport(id: string): Promise<ExportRun> {
  const run = await portabilityApi.exportRun(id);
  if (run.fileUrl) followDownload(run.fileUrl);
  return run;
}
