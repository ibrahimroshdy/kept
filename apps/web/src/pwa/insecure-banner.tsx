/**
 * Plain HTTP is explained, not refused (D31, D193): a persistent line above every signed-in page
 * saying what doesn't work, with the HTTPS setups behind "How". Capture falls back to picking
 * files, which works without HTTPS. localhost counts as secure, so development never shows it.
 */
import { Trans } from '@lingui/react/macro';
import { HttpsHowButton } from '@/components/home/checklist';
import { AlertIcon } from '@/components/icons';

export function isInsecure(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === false;
}

export function InsecureBanner({ insecure = isInsecure() }: { insecure?: boolean }) {
  if (!insecure) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 border-b border-warn bg-surface px-3.5 py-2 text-small text-ink-2 md:px-6"
    >
      <AlertIcon aria-hidden="true" className="size-[18px] shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        <Trans>Camera, offline capture and install need HTTPS.</Trans>
      </span>
      <HttpsHowButton />
    </div>
  );
}
