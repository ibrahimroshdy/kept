/**
 * `/l/<code>` opened by the phone's own camera, a printed link, or the capture camera's "Open"
 * (plan T26; D120, D137; V6, V7). Signed in, it resolves the code exactly as the scanner does:
 * something you can see opens at once (and is marked seen, D40), in place of this page in the
 * history; anything else answers here, on the page. The URL carries only the code, never data.
 * An old Homebox label (`/a/…`, `/item/…`, `/location/…`, step-7 T20) is resolved the same way
 * from its whole URL (components/legacy/legacy-resolve.tsx).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { IdChip } from '@/components/id-chip';
import { LoadingRows, Page } from '@/components/page';
import { useOnline } from '@/lib/online';
import { AnswerFrame, ScanAnswer } from './outcome-sheet';
import {
  markSeen,
  openSearch,
  type Resolution,
  rememberPendingScan,
  resolveScan,
  type ScanTarget,
} from './resolve';
import { useKick, useScanStore } from './use-scan-store';

export function LabelLink({
  code,
  text = code,
  title,
}: {
  /** The Kept code on the label; null for an old label read from its whole URL (step-7 T20). */
  code: string | null;
  /** What is resolved: the code, or an old label's URL (`https://…/a/000-001`). */
  text?: string | null;
  title?: string;
}) {
  const { t } = useLingui();
  const store = useScanStore();
  const online = useOnline();
  const kick = useKick();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [res, setRes] = useState<Resolution | null>(null);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  const display = code?.toUpperCase() ?? null;

  const open = (target: ScanTarget, replace = true) => {
    if (target.kind === 'place')
      void navigate({ to: '/p/$id', params: { id: target.id }, replace });
    else
      void openSearch(target, store, qc).then((search) =>
        navigate({ to: '/t/$id', params: { id: target.id }, search, replace }),
      );
    void markSeen(target, { store, online }).then((r) => {
      if (r === 'queued') kick();
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolved once per visit, when the store is ready
  useEffect(() => {
    if (!store || started.current) return;
    started.current = true;
    void resolveScan({ text: text ?? '' }, { store, online })
      .then(async (r) => {
        if (r.outcome === 'not_on_phone') await rememberPendingScan(store, r.text);
        if (r.outcome === 'open') open(r.target);
        else setRes(r);
      })
      .catch(() => setFailed(true));
  }, [store, text, online]);

  return (
    <Page title={title ?? t`Label`}>
      {display ? (
        <div className="grid justify-items-center">
          <IdChip code={display} size="large" />
        </div>
      ) : null}
      {failed ? (
        <AnswerFrame label={t`Scan result`} onCamera={false}>
          <p className="m-0 text-ink-2">
            <Trans>Couldn't look that up. Try again.</Trans>
          </p>
        </AnswerFrame>
      ) : res && res.outcome !== 'open' ? (
        <ScanAnswer
          res={res}
          store={store}
          online={online}
          onCamera={false}
          onOpen={(target) => open(target, false)}
          onAgain={() => void navigate({ to: '/scan' })}
          onDone={() => void navigate({ to: '/' })}
          onQueued={kick}
        />
      ) : (
        <LoadingRows rows={2} label={t`Looking it up…`} />
      )}
    </Page>
  );
}
