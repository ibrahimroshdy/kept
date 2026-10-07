/**
 * The update line (D65; plan T21, frame 107): "Kept 1.3.0 is available", what this server runs,
 * and "What's new", a link out to the release page the check returned. Shown at the top of the
 * instance admin's pages (admin.tsx), so it is on the status page and the admin index alike, and
 * only while the opt-in check found a newer release. Nothing is downloaded or installed.
 */
import { Trans } from '@lingui/react/macro';
import { useOpsStatus } from '@/api/ops/queries';
import { Notice } from '@/components/page';

export function UpdateLine() {
  const status = useOpsStatus();
  const updates = status.data?.updates;
  const latest = updates?.enabled ? updates.latest : null;
  if (!latest) return null;
  const version = latest.version;
  const current = status.data?.release?.version ?? status.data?.version ?? '';
  return (
    <Notice
      tone="info"
      title={
        <Trans>
          Kept <span className="ltr">{version}</span> is available
        </Trans>
      }
      action={
        <a
          href={latest.url}
          target="_blank"
          rel="noreferrer"
          className="w-fit text-small text-ink-2 underline underline-offset-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-info"
        >
          <Trans>What's new</Trans>
        </a>
      }
    >
      {current ? (
        <Trans>
          This server runs <span className="ltr">{current}</span>. Upgrading is the release notes'
          steps; Kept never updates itself.
        </Trans>
      ) : null}
    </Notice>
  );
}
